import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const EXPECTED_MCP_TOOLS = [
  "inspect_video",
  "search_transcript",
  "read_transcript",
  "get_overview",
  "get_frames",
];

const EXPECTED_QUALIFICATION_CHECKS = [
  "generated-local-fixture",
  "ffprobe-container-and-stream-inspection",
  "ffmpeg-seek-decode-jpeg",
  "ffmpeg-scale-crop-tile",
  "ffprobe-seek-and-timing",
  "ffmpeg-build-configuration-redistributable",
  "ffprobe-build-configuration-redistributable",
  "ytdlp-hermetic-cli-profile",
  "ytdlp-standalone-start-and-node-runtime",
  "persisted-runtime-mcp-initialize",
  "persisted-runtime-all-five-tools",
  "persisted-runtime-local-inspect",
];

const TARGETS = {
  "windows-x64": {
    platform: "win32",
    processArch: "x64",
    binaryArch: "x86_64",
    binaryFormat: "PE",
  },
  "windows-arm64": {
    platform: "win32",
    processArch: "arm64",
    binaryArch: "arm64",
    binaryFormat: "PE",
  },
  "macos-x64": {
    platform: "darwin",
    processArch: "x64",
    binaryArch: "x86_64",
    binaryFormat: "Mach-O",
  },
  "macos-arm64": {
    platform: "darwin",
    processArch: "arm64",
    binaryArch: "arm64",
    binaryFormat: "Mach-O",
  },
  "linux-x64-glibc": {
    platform: "linux",
    processArch: "x64",
    binaryArch: "x86_64",
    binaryFormat: "ELF",
  },
  "linux-arm64-glibc": {
    platform: "linux",
    processArch: "arm64",
    binaryArch: "arm64",
    binaryFormat: "ELF",
  },
};

const TOOL_KINDS = ["ffmpeg", "ffprobe", "ytdlp"];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function asRecord(value, label) {
  assert(
    typeof value === "object" && value !== null && !Array.isArray(value),
    `${label} must be an object`,
  );
  return value;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function tail(value, max = 2_000) {
  return value.length <= max ? value : value.slice(-max);
}

function safeSlug(value) {
  return value.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "") || "command";
}

function npmInvocation() {
  if (process.platform !== "win32") return { executable: "npm", args: [] };
  const npmExecPath = process.env.npm_execpath;
  if (typeof npmExecPath === "string" && path.isAbsolute(npmExecPath)) {
    return { executable: process.execPath, args: [npmExecPath] };
  }
  return {
    executable: process.execPath,
    args: [path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")],
  };
}

function contained(root, child) {
  const relative = path.relative(path.resolve(root), path.resolve(child));
  return relative !== "" &&
    !path.isAbsolute(relative) &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`);
}

function samePath(left, right) {
  return process.platform === "win32"
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);
}

async function readJson(file, label) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`Could not read ${label} at ${file}`, { cause: error });
  }
}

async function sha256File(file) {
  const digest = createHash("sha256");
  const stream = (await import("node:fs")).createReadStream(file);
  for await (const chunk of stream) digest.update(chunk);
  return digest.digest("hex");
}

async function regularFile(file, label) {
  const info = await lstat(file);
  assert(info.isFile() && !info.isSymbolicLink(), `${label} is not a regular file: ${file}`);
  return info;
}

function processResultError(result) {
  return result.error === undefined
    ? undefined
    : errorMessage(result.error);
}

async function runProcess(
  executable,
  args,
  {
    cwd = process.cwd(),
    env = process.env,
    timeoutMs = 10 * 60_000,
    maxOutputBytes = 32 * 1024 * 1024,
  } = {},
) {
  return await new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let spawnError;
    let outputLimitError;
    let timeoutError;
    let timer;
    let settled = false;

    let child;
    try {
      child = spawn(executable, args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({
        executable,
        args: [...args],
        exitCode: null,
        signal: null,
        stdout,
        stderr,
        error,
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    const stop = () => {
      try {
        child.kill();
      } catch {
        // Keep the original process failure when close follows an error
      }
    };

    const append = (current, chunk) => {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next, "utf8") > maxOutputBytes) {
        outputLimitError ??= new Error(`${executable} exceeded the ${String(maxOutputBytes)}-byte output limit`);
        stop();
        return current;
      }
      return next;
    };

    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.once("error", (error) => {
      spawnError = error;
    });
    timer = setTimeout(() => {
      timeoutError = new Error(`${executable} timed out after ${String(timeoutMs)} ms`);
      stop();
    }, timeoutMs);
    timer.unref?.();
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        executable,
        args: [...args],
        exitCode,
        signal,
        stdout,
        stderr,
        error: timeoutError ?? outputLimitError ?? spawnError,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

async function runLogged(report, resultDir, label, executable, args, options = {}) {
  const result = await runProcess(executable, args, options);
  const ordinal = String(report.commands.length + 1).padStart(3, "0");
  const stem = `${ordinal}-${safeSlug(label)}`;
  const stdoutLog = `${stem}.stdout.log`;
  const stderrLog = `${stem}.stderr.log`;
  await writeFile(path.join(resultDir, stdoutLog), result.stdout, "utf8");
  await writeFile(path.join(resultDir, stderrLog), result.stderr, "utf8");
  report.commands.push({
    label,
    executable,
    args: [...args],
    exitCode: result.exitCode,
    signal: result.signal,
    durationMs: result.durationMs,
    error: processResultError(result),
    stdoutLog,
    stderrLog,
  });
  return result;
}

function requireSuccess(result, label) {
  assert(
    result.error === undefined && result.exitCode === 0,
    `${label} failed with exit code ${String(result.exitCode)}${result.signal ? ` and signal ${result.signal}` : ""}: ${tail(result.stderr || result.stdout)}`,
  );
}

function outputText(result) {
  return `${result.stdout}\n${result.stderr}`.trim();
}

function firstOutputLine(result, label) {
  const line = outputText(result).split(/\r?\n/u).find((value) => value.trim().length > 0)?.trim() ?? "";
  assert(line.length > 0, `${label} returned no version text`);
  return line;
}

function readU32(buffer, offset, littleEndian) {
  return littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
}

function readI32(buffer, offset, littleEndian) {
  return littleEndian ? buffer.readInt32LE(offset) : buffer.readInt32BE(offset);
}

function machCpuName(value) {
  if (value === 0x01000007) return "x86_64";
  if (value === 0x0100000c) return "arm64";
  if (value === 7) return "x86";
  if (value === 12) return "arm";
  return `cpu-${value.toString(16)}`;
}

function inspectBinaryBytes(buffer, label) {
  if (
    buffer.length >= 64 &&
    buffer[0] === 0x4d &&
    buffer[1] === 0x5a
  ) {
    const peOffset = buffer.readUInt32LE(0x3c);
    assert(peOffset + 6 <= buffer.length, `${label} has an invalid PE header offset`);
    assert(buffer.subarray(peOffset, peOffset + 4).toString("ascii") === "PE\0\0", `${label} has no PE signature`);
    const machine = buffer.readUInt16LE(peOffset + 4);
    const architectures = machine === 0x8664
      ? ["x86_64"]
      : machine === 0xaa64
      ? ["arm64"]
      : [`machine-0x${machine.toString(16)}`];
    return { format: "PE", architectures, machine: `0x${machine.toString(16)}` };
  }

  if (
    buffer.length >= 20 &&
    buffer[0] === 0x7f &&
    buffer[1] === 0x45 &&
    buffer[2] === 0x4c &&
    buffer[3] === 0x46
  ) {
    const littleEndian = buffer[5] === 1;
    const machine = readU32(buffer, 18, littleEndian) & 0xffff;
    const architecture = machine === 0x3e
      ? "x86_64"
      : machine === 0xb7
      ? "arm64"
      : `machine-0x${machine.toString(16)}`;
    return {
      format: "ELF",
      bits: buffer[4] === 2 ? 64 : buffer[4] === 1 ? 32 : buffer[4],
      architectures: [architecture],
      machine: `0x${machine.toString(16)}`,
      endian: littleEndian ? "little" : "big",
    };
  }

  const magicLe = buffer.length >= 4 ? buffer.readUInt32LE(0) : 0;
  const magicBe = buffer.length >= 4 ? buffer.readUInt32BE(0) : 0;
  const thinMachMagic = new Set([0xfeedface, 0xfeedfacf]);
  if (thinMachMagic.has(magicLe) || thinMachMagic.has(magicBe)) {
    const littleEndian = thinMachMagic.has(magicLe);
    const magic = littleEndian ? magicLe : magicBe;
    const cpu = readI32(buffer, 4, littleEndian);
    return {
      format: "Mach-O",
      bits: magic === 0xfeedfacf ? 64 : 32,
      architectures: [machCpuName(cpu)],
      magic: `0x${magic.toString(16)}`,
      endian: littleEndian ? "little" : "big",
    };
  }

  const fatLittle = magicLe === 0xcafebabe || magicLe === 0xcafebabf;
  const fatBig = magicBe === 0xcafebabe || magicBe === 0xcafebabf;
  if (fatLittle || fatBig) {
    const littleEndian = fatLittle;
    const fatMagic = littleEndian ? magicLe : magicBe;
    const count = readU32(buffer, 4, littleEndian);
    assert(count <= 32, `${label} has an unreasonable Mach-O fat architecture count`);
    const entrySize = fatMagic === 0xcafebabf ? 32 : 20;
    const architectures = [];
    for (let index = 0; index < count; index += 1) {
      const offset = 8 + index * entrySize;
      assert(offset + entrySize <= buffer.length, `${label} has a truncated Mach-O fat header`);
      architectures.push(machCpuName(readI32(buffer, offset, littleEndian)));
    }
    return {
      format: "Mach-O",
      bits: "fat",
      architectures,
      magic: `0x${fatMagic.toString(16)}`,
      endian: littleEndian ? "little" : "big",
    };
  }

  return { format: "unknown", architectures: [] };
}

async function inspectBinary(file, label) {
  return inspectBinaryBytes(await readFile(file), label);
}

function glibcVersion() {
  try {
    const value = process.report?.getReport?.().header?.glibcVersionRuntime;
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function selectedEnvironment() {
  const names = [
    "RUNNER_OS",
    "RUNNER_ARCH",
    "ImageOS",
    "ImageVersion",
    "RUNNER_ENVIRONMENT",
    "GITHUB_ACTIONS",
    "GITHUB_WORKFLOW",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT",
    "GITHUB_SHA",
  ];
  return Object.fromEntries(names.map((name) => [name, process.env[name] ?? null]));
}

function clearRuntimeMarkers(environment) {
  for (const name of [
    "URMA_DATA_DIR",
    "URMA_FFMPEG",
    "URMA_FFPROBE",
    "URMA_YTDLP",
    "URMA_RUNTIME_ROOT_V1",
    "URMA_RUNTIME_GENERATION_V1",
    "URMA_RUNTIME_GENERATION_DIR_V1",
    "URMA_RUNTIME_DATA_DIR_V1",
    "URMA_RUNTIME_NODE_V1",
    "URMA_RUNTIME_FFMPEG_V1",
    "URMA_RUNTIME_FFPROBE_V1",
    "URMA_RUNTIME_YTDLP_V1",
    "URMA_RUNTIME_FFMPEG_HASH_V1",
    "URMA_RUNTIME_FFPROBE_HASH_V1",
    "URMA_RUNTIME_YTDLP_HASH_V1",
    "URMA_DEV_DIRECT_START",
  ]) delete environment[name];
}

function hermeticEnvironment(dataRoot, localRoot, xdgHome) {
  const environment = { ...process.env, PATH: "" };
  clearRuntimeMarkers(environment);
  environment.URMA_LOCAL_ROOTS = localRoot;
  environment.URMA_FFMPEG = "system-ffmpeg-must-not-be-used";
  environment.URMA_FFPROBE = "system-ffprobe-must-not-be-used";
  environment.URMA_YTDLP = "system-yt-dlp-must-not-be-used";
  if (process.platform === "linux") {
    environment.XDG_DATA_HOME = xdgHome;
    delete environment.URMA_DATA_DIR;
  } else {
    environment.URMA_DATA_DIR = dataRoot;
  }
  return environment;
}

function basicActive(value) {
  const item = asRecord(value, "ACTIVE.json");
  assert(item.schema === 1, "ACTIVE.json has an unexpected schema");
  assert(Number.isSafeInteger(item.generation) && item.generation >= 1, "ACTIVE.json has an invalid generation");
  assert(typeof item.active === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(item.active), "ACTIVE.json has an invalid active id");
  assert(item.previous === null || typeof item.previous === "string", "ACTIVE.json has an invalid previous id");
  return item;
}

function receiptTool(receipt, kind) {
  const tools = asRecord(receipt.tools, "receipt.tools");
  return asRecord(tools[kind], `receipt.tools.${kind}`);
}

async function managedTools(dataRoot, active, receipt, targetConfig) {
  const generationDir = path.resolve(dataRoot, "installs", active.active);
  const realGeneration = await realpath(generationDir);
  const tools = {};
  for (const kind of TOOL_KINDS) {
    const item = receiptTool(receipt, kind);
    assert(typeof item.relativePath === "string" && item.relativePath.length > 0, `${kind} receipt path is missing`);
    assert(!path.isAbsolute(item.relativePath), `${kind} receipt path is absolute`);
    const executable = path.resolve(generationDir, ...item.relativePath.split(/[\\/]/u));
    assert(contained(generationDir, executable), `${kind} receipt path escapes the generation`);
    const info = await regularFile(executable, `managed ${kind}`);
    if (process.platform !== "win32") assert((info.mode & 0o111) !== 0, `managed ${kind} is not executable`);
    const realExecutable = await realpath(executable);
    assert(contained(realGeneration, realExecutable), `managed ${kind} resolves outside the generation`);
    const binary = await inspectBinary(executable, `managed ${kind}`);
    assert(binary.format === targetConfig.binaryFormat, `managed ${kind} is ${binary.format}, expected ${targetConfig.binaryFormat}`);
    assert(binary.architectures.includes(targetConfig.binaryArch), `managed ${kind} architecture ${binary.architectures.join(", ")} does not include native ${targetConfig.binaryArch}`);
    tools[kind] = {
      executable: path.resolve(executable),
      realExecutable,
      relativePath: item.relativePath,
      receipt: item,
      binary,
      mode: info.mode & 0o777,
    };
  }
  return { generationDir, realGeneration, tools };
}

function validateReceipt(receipt, active, target, packageVersion) {
  assert(receipt.schema === 1, "installation receipt schema is not v1");
  assert(receipt.installId === active.active, "receipt install id does not match ACTIVE.json");
  assert(receipt.target === target && receipt.manifest?.target === target, "receipt target does not match the native target");
  assert(receipt.urma?.version === packageVersion, "receipt Urma version does not match the packed npm package");
  assert(
    typeof receipt.node?.execPath === "string" && samePath(receipt.node.execPath, process.execPath),
    `receipt Node path ${String(receipt.node?.execPath)} does not match process.execPath ${process.execPath}`,
  );
  assert(receipt.node?.version === process.versions.node, "receipt Node version does not match the executing Node version");
  assert(receipt.node?.executionArchitecture === `${process.platform}-${process.arch}`, "receipt Node execution architecture does not match the current process");
  assert(receipt.qualification?.status === "passed", "receipt does not record passed installer qualification");
  const checks = new Set(receipt.qualification.checks ?? []);
  for (const check of EXPECTED_QUALIFICATION_CHECKS) assert(checks.has(check), `receipt is missing qualification check ${check}`);
}

function artifactReport(manifest, managed, kind) {
  const artifact = manifest[kind === "ytdlp" ? "ytdlp" : kind];
  const item = managed.tools[kind].receipt;
  return {
    kind,
    provider: artifact.provider,
    upstreamVersion: artifact.upstreamVersion,
    upstreamRelease: artifact.upstreamRelease,
    url: artifact.url,
    archiveFormat: artifact.archiveFormat,
    archiveSizeBytes: artifact.archiveBytes,
    archiveSizeSource: "pinned manifest; installer exact-size check passed before extraction",
    archiveSha256: item.archiveSha256,
    archiveSha256Pinned: artifact.archiveSha256,
    archiveVerification: "verified by the packed installer before extraction and execution",
    expectedFiles: [...artifact.expectedFiles],
    executable: artifact.executable,
    executablePath: managed.tools[kind].executable,
    binarySha256: item.binarySha256,
    binarySha256Observed: null,
    actualReportedVersion: null,
    actualBuildConfiguration: item.buildConfiguration,
    licensing: artifact.licensing,
  };
}

async function runManagedToolChecks(report, resultDir, packageRoot, managed, manifest, environment) {
  const artifactReports = {};
  const versionResults = {};
  for (const kind of TOOL_KINDS) {
    const tool = managed.tools[kind];
    const versionArgs = kind === "ytdlp" ? ["--version"] : ["-version"];
    const result = await runLogged(
      report,
      resultDir,
      `managed-${kind}-version`,
      tool.executable,
      versionArgs,
      { cwd: managed.generationDir, env: environment, timeoutMs: 60_000 },
    );
    requireSuccess(result, `managed ${kind} version`);
    versionResults[kind] = firstOutputLine(result, `managed ${kind}`);
    const actualHash = await sha256File(tool.executable);
    assert(actualHash === tool.receipt.binarySha256, `managed ${kind} hash changed after installer qualification`);
    const item = artifactReport(manifest, managed, kind);
    item.binarySha256Observed = actualHash;
    item.actualReportedVersion = versionResults[kind];
    artifactReports[kind] = item;
  }

  for (const kind of ["ffmpeg", "ffprobe"]) {
    const tool = managed.tools[kind];
    const result = await runLogged(
      report,
      resultDir,
      `managed-${kind}-buildconf`,
      tool.executable,
      ["-hide_banner", "-buildconf"],
      { cwd: managed.generationDir, env: environment, timeoutMs: 60_000 },
    );
    requireSuccess(result, `managed ${kind} build configuration`);
    const text = outputText(result);
    assert(!/--enable-nonfree(?:[=\s]|$)/imu.test(text), `managed ${kind} reports a nonfree FFmpeg build`);
    artifactReports[kind].actualBuildConfigurationOutput = text;
  }

  const ytdlpModule = await import(pathToFileURL(path.join(packageRoot, "dist", "src", "subprocess", "ytdlp.js")).href);
  const hermeticArgs = ytdlpModule.hermeticYtDlpArgs(
    ["--help"],
    process.execPath,
    undefined,
    ["--ffmpeg-location", path.dirname(managed.tools.ffmpeg.executable)],
  );
  const help = await runLogged(
    report,
    resultDir,
    "managed-ytdlp-hermetic-help",
    managed.tools.ytdlp.executable,
    hermeticArgs,
    { cwd: managed.generationDir, env: environment, timeoutMs: 60_000 },
  );
  requireSuccess(help, "managed yt-dlp hermetic help");
  const helpText = outputText(help);
  for (const flag of manifest.ytdlpProfile.flags) assert(helpText.includes(flag), `yt-dlp help does not advertise pinned flag ${flag}`);
  for (const flag of manifest.ytdlpProfile.unsupportedFlags) assert(!helpText.includes(flag), `yt-dlp help advertises unsupported flag ${flag}`);
  const ytdlpVersion = await runLogged(
    report,
    resultDir,
    "managed-ytdlp-hermetic-version",
    managed.tools.ytdlp.executable,
    ytdlpModule.hermeticYtDlpArgs(
      ["--version"],
      process.execPath,
      undefined,
      ["--ffmpeg-location", path.dirname(managed.tools.ffmpeg.executable)],
    ),
    { cwd: managed.generationDir, env: environment, timeoutMs: 60_000 },
  );
  requireSuccess(ytdlpVersion, "managed yt-dlp hermetic version");
  report.artifacts = artifactReports;
  report.nativeExecution = {
    managedToolPaths: Object.fromEntries(TOOL_KINDS.map((kind) => [kind, managed.tools[kind].executable])),
    versions: versionResults,
    architecture: Object.fromEntries(TOOL_KINDS.map((kind) => [kind, managed.tools[kind].binary])),
    executableModes: Object.fromEntries(TOOL_KINDS.map((kind) => [kind, managed.tools[kind].mode])),
    ytdlpHermeticProfile: {
      helpLog: "managed-ytdlp-hermetic-help.stdout.log",
      nodeRuntime: `node:${process.execPath}`,
      ffmpegLocation: path.dirname(managed.tools.ffmpeg.executable),
      noConfigOrPluginFallback: true,
      noRemoteComponents: true,
      noPython: true,
    },
    archiveExtraction: "setup succeeded with PATH empty; tar/xz/Python were not discoverable or resolved through PATH and were not required by the exercised setup/runtime path",
  };
}

async function generateLocalFixture(report, resultDir, managed, environment, localRoot) {
  const fixture = path.join(localRoot, "fixture — 日本.nut");
  const result = await runLogged(
    report,
    resultDir,
    "generate-managed-ffmpeg-local-fixture",
    managed.tools.ffmpeg.executable,
    [
      "-v", "error",
      "-f", "lavfi",
      "-i", "color=c=black:s=160x90:d=1:r=24",
      "-c:v", "mpeg4",
      "-q:v", "5",
      "-f", "nut",
      "-y", fixture,
    ],
    { cwd: managed.generationDir, env: environment, timeoutMs: 60_000 },
  );
  requireSuccess(result, "managed FFmpeg local fixture generation");
  await regularFile(fixture, "generated local video fixture");
  return fixture;
}

class McpSession {
  constructor(report, resultDir, launcher, environment, cwd) {
    this.report = report;
    this.resultDir = resultDir;
    this.launcher = launcher;
    this.environment = environment;
    this.cwd = cwd;
    this.child = spawn(process.execPath, [launcher], {
      cwd,
      env: environment,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.buffer = "";
    this.rawStdout = "";
    this.stderr = "";
    this.messages = new Map();
    this.waiters = new Map();
    this.outputError = null;
    this.closeError = null;
    this.closed = new Promise((resolve) => {
      this.child.once("close", (exitCode, signal) => {
        this.exitCode = exitCode;
        this.signal = signal;
        this.closeError = exitCode === 0 || exitCode === null
          ? null
          : new Error(`persistent launcher exited with code ${String(exitCode)}`);
        for (const waiter of this.waiters.values()) waiter.reject(this.closeError ?? new Error("persistent launcher closed before its MCP response"));
        this.waiters.clear();
        resolve({ exitCode, signal });
      });
    });
    this.child.once("error", (error) => {
      this.outputError = error;
      for (const waiter of this.waiters.values()) waiter.reject(error);
      this.waiters.clear();
    });
    this.child.stdout.on("data", (chunk) => this.onStdout(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString("utf8");
      if (Buffer.byteLength(this.stderr, "utf8") > 8 * 1024 * 1024) this.stderr = this.stderr.slice(-8 * 1024 * 1024);
    });
  }

  onStdout(chunk) {
    const text = chunk.toString("utf8");
    this.rawStdout += text;
    if (Buffer.byteLength(this.rawStdout, "utf8") > 32 * 1024 * 1024) {
      this.outputError ??= new Error("persistent launcher exceeded the MCP stdout audit limit");
      try { this.child.kill(); } catch {}
      return;
    }
    this.buffer += text;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let parsed;
      try {
        parsed = asRecord(JSON.parse(line), "MCP response");
      } catch (error) {
        this.outputError ??= error;
        for (const waiter of this.waiters.values()) waiter.reject(error);
        this.waiters.clear();
        return;
      }
      if (parsed.id !== undefined) {
        this.messages.set(parsed.id, parsed);
        const waiter = this.waiters.get(parsed.id);
        if (waiter) {
          this.waiters.delete(parsed.id);
          clearTimeout(waiter.timer);
          waiter.resolve(parsed);
        }
      }
    }
  }

  notify(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async request(id, message) {
    const existing = this.messages.get(id);
    if (existing) return existing;
    assert(this.outputError === null, `persistent MCP output failed: ${errorMessage(this.outputError)}`);
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`persistent MCP request ${String(id)} timed out`));
      }, 30_000);
      timer.unref?.();
      this.waiters.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  async close() {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.stdin.end();
    const result = await Promise.race([
      this.closed,
      new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 30_000)),
    ]);
    if (result.timeout === true) {
      try { this.child.kill(); } catch {}
      await this.closed;
    }
    const ordinal = String(this.report.commands.length + 1).padStart(3, "0");
    const stem = `${ordinal}-persistent-mcp`;
    const stdoutLog = `${stem}.stdout.log`;
    const stderrLog = `${stem}.stderr.log`;
    await writeFile(path.join(this.resultDir, stdoutLog), this.rawStdout, "utf8");
    await writeFile(path.join(this.resultDir, stderrLog), this.stderr, "utf8");
    this.report.commands.push({
      label: "persistent-mcp-launcher",
      executable: process.execPath,
      args: [this.launcher],
      exitCode: this.exitCode,
      signal: this.signal,
      error: this.outputError ? errorMessage(this.outputError) : this.closeError ? errorMessage(this.closeError) : null,
      stdoutLog,
      stderrLog,
    });
    return result;
  }
}

function rpcResult(response, label) {
  const item = asRecord(response, `${label} response`);
  assert(item.error === undefined, `${label} returned a JSON-RPC error: ${JSON.stringify(item.error)}`);
  const result = asRecord(item.result, `${label} result`);
  assert(result.isError !== true, `${label} returned an MCP tool error: ${JSON.stringify(result.structuredContent ?? result.content)}`);
  return result;
}

async function runMcpQualification(report, resultDir, launcher, environment, localRoot, fixture) {
  const session = new McpSession(report, resultDir, launcher, environment, localRoot);
  const evidence = { launcher, pathMode: "absolute Node + absolute launcher", pathEnvironment: "PATH=", localRoot, fixture };
  try {
    const initialized = rpcResult(await session.request(1, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "urma-native-distribution-qualification", version: "1.0.0" },
      },
    }), "MCP initialize");
    assert(initialized.serverInfo?.name === "urma", "MCP initialize did not return the Urma server identity");
    session.notify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

    const listed = rpcResult(await session.request(2, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }), "MCP tools/list");
    const tools = Array.isArray(listed.tools) ? listed.tools : [];
    const names = tools.map((tool) => asRecord(tool, "MCP tool").name);
    assert(JSON.stringify(names) === JSON.stringify(EXPECTED_MCP_TOOLS), `MCP tool surface was ${JSON.stringify(names)}, expected ${JSON.stringify(EXPECTED_MCP_TOOLS)}`);

    const inspected = rpcResult(await session.request(3, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "inspect_video", arguments: { source: fixture, freshness: "refresh" } },
    }), "MCP inspect_video");
    const inspectedContent = asRecord(inspected.structuredContent, "inspect_video structured content");
    const investigationRef = inspectedContent.investigationRef;
    assert(typeof investigationRef === "string" && /^urma:investigation:[0-9a-f]{32}$/u.test(investigationRef), "inspect_video did not return a valid investigation reference");
    assert(asRecord(inspectedContent.source, "inspect_video source").kind === "local", "representative MCP source was not local");

    const overview = rpcResult(await session.request(4, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "get_overview", arguments: { investigationRef } },
    }), "MCP get_overview");
    const overviewContent = asRecord(overview.structuredContent, "get_overview structured content");
    assert(overviewContent.sparse === true && Number(overviewContent.actualCount) >= 1, "get_overview did not return sparse local evidence");
    assert(Array.isArray(overview.content) && overview.content.some((item) => asRecord(item, "overview content").type === "resource_link"), "get_overview did not present a resource link");

    const frames = rpcResult(await session.request(5, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "get_frames",
        arguments: { investigationRef, presentation: "panel", request: { kind: "points", timesMs: [0] } },
      },
    }), "MCP get_frames");
    const frameContent = asRecord(frames.structuredContent, "get_frames structured content");
    assert(Array.isArray(frames.content) && frames.content.some((item) => asRecord(item, "frame content").type === "resource_link"), "get_frames did not present a resource link");
    assert(frameContent.presentation === "panel" || Array.isArray(frameContent.frames) || Array.isArray(frameContent.cells), "get_frames returned an unexpected evidence shape");
    evidence.initialize = "passed";
    evidence.tools = names;
    evidence.inspectVideo = { status: "passed", investigationRef };
    evidence.overview = { status: "passed", actualCount: overviewContent.actualCount, artifact: overviewContent.artifact };
    evidence.frames = { status: "passed", presentation: frameContent.presentation ?? "individual" };
    report.mcp = evidence;
    report.evidenceOperation = "local inspect_video followed by get_overview and get_frames through the persistent launcher";
  } finally {
    await session.close();
  }
}

function symbolVersions(text) {
  return [...new Set(text.match(/GLIBC_[0-9.]+/gu) ?? [])].sort();
}

async function linuxDiagnostics(report, resultDir, managed) {
  const ldd = {};
  const readelf = {};
  for (const kind of TOOL_KINDS) {
    const executable = managed.tools[kind].executable;
    const lddResult = await runLogged(report, resultDir, `linux-ldd-${kind}`, "ldd", [executable], { env: process.env, cwd: managed.generationDir, timeoutMs: 60_000 });
    assert(lddResult.error === undefined, `Linux ldd could not inspect ${kind}: ${processResultError(lddResult)}`);
    const lddText = outputText(lddResult);
    assert(!/\bnot found\b/iu.test(lddText), `Linux ${kind} has an unresolved loader dependency: ${lddText}`);
    ldd[kind] = { exitCode: lddResult.exitCode, output: lddText, glibcSymbols: symbolVersions(lddText) };
    const programHeaders = await runLogged(report, resultDir, `linux-readelf-program-${kind}`, "readelf", ["-W", "-l", executable], { env: process.env, cwd: managed.generationDir, timeoutMs: 60_000 });
    requireSuccess(programHeaders, `Linux readelf program headers for ${kind}`);
    const versions = await runLogged(report, resultDir, `linux-readelf-version-${kind}`, "readelf", ["--version-info", executable], { env: process.env, cwd: managed.generationDir, timeoutMs: 60_000 });
    requireSuccess(versions, `Linux readelf symbol versions for ${kind}`);
    const versionText = outputText(versions);
    readelf[kind] = {
      programHeaders: outputText(programHeaders),
      hasInterpreter: /\bINTERP\b/u.test(outputText(programHeaders)),
      symbolVersions: symbolVersions(versionText),
      versionInfo: versionText,
    };
  }
  let osRelease = null;
  try { osRelease = await readFile("/etc/os-release", "utf8"); } catch { /* the runner may expose release data elsewhere */ }
  report.platformFindings = {
    linux: {
      osRelease,
      glibcVersion: glibcVersion(),
      kernelVersion: os.release(),
      loaderDependencies: ldd,
      requiredSymbolVersions: readelf,
      executablePermissions: Object.fromEntries(TOOL_KINDS.map((kind) => [kind, managed.tools[kind].mode])),
      pathContract: { xdgDataHome: process.env.XDG_DATA_HOME ?? null, installationRoot: managed.generationDir.split(`${path.sep}installs${path.sep}`)[0] ?? null },
      hiddenTarXzOrPython: "tar/xz/Python were not discoverable or resolved through PATH and were not required by the exercised setup/runtime path",
      extraPackages: "none required by the exercised setup/runtime path",
    },
  };
}

async function macDiagnostics(report, resultDir, managed, target) {
  const codesign = {};
  const xattrs = {};
  for (const kind of TOOL_KINDS) {
    const executable = managed.tools[kind].executable;
    const display = await runLogged(report, resultDir, `macos-codesign-display-${kind}`, "/usr/bin/codesign", ["--display", "--verbose=4", executable], { env: process.env, cwd: managed.generationDir, timeoutMs: 60_000 });
    const verify = await runLogged(report, resultDir, `macos-codesign-verify-${kind}`, "/usr/bin/codesign", ["--verify", "--verbose=2", executable], { env: process.env, cwd: managed.generationDir, timeoutMs: 60_000 });
    const attrs = await runLogged(report, resultDir, `macos-xattr-${kind}`, "/usr/bin/xattr", ["-l", executable], { env: process.env, cwd: managed.generationDir, timeoutMs: 60_000 });
    codesign[kind] = { display: outputText(display), verify: outputText(verify), verifyExitCode: verify.exitCode };
    xattrs[kind] = { output: outputText(attrs), exitCode: attrs.exitCode };
  }
  const security = {};
  for (const [label, executable, args] of [
    ["spctl", "/usr/sbin/spctl", ["--status"]],
    ["sip", "/usr/bin/csrutil", ["status"]],
  ]) {
    const result = await runLogged(report, resultDir, `macos-security-${label}`, executable, args, { env: process.env, cwd: managed.generationDir, timeoutMs: 60_000 });
    security[label] = { output: outputText(result), exitCode: result.exitCode, error: processResultError(result) };
  }
  let rosetta = null;
  if (target === "macos-arm64") {
    const result = await runLogged(report, resultDir, "macos-rosetta-check", "/usr/sbin/sysctl", ["-in", "sysctl.proc_translated"], { env: process.env, cwd: managed.generationDir, timeoutMs: 60_000 });
    const value = outputText(result);
    assert(value.trim() !== "1", "Apple Silicon qualification detected Rosetta translation");
    rosetta = { output: value, exitCode: result.exitCode, native: value.trim() === "0" };
  }
  report.platformFindings = {
    macos: {
      nativeArchitecture: process.arch,
      noHomebrewOrPathFallback: "setup and persistent runtime were exercised with PATH empty; only absolute managed tools were invoked",
      codesign,
      xattrs,
      normalSecurity: security,
      rosetta,
      upstreamSignatureState: "observed after extraction; no quarantine removal, re-signing, notarization, or Mach-O alteration performed",
    },
  };
}

async function windowsDiagnostics(report, resultDir, managed) {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const whoami = path.join(systemRoot, "System32", "whoami.exe");
  const identity = await runLogged(report, resultDir, "windows-whoami", whoami, ["/user"], { env: process.env, cwd: managed.generationDir, timeoutMs: 60_000 });
  const groups = await runLogged(report, resultDir, "windows-whoami-groups", whoami, ["/groups"], { env: process.env, cwd: managed.generationDir, timeoutMs: 60_000 });
  report.platformFindings = {
    windows: {
      nativeArchitecture: process.arch,
      peArchitecture: Object.fromEntries(TOOL_KINDS.map((kind) => [kind, managed.tools[kind].binary.architectures])),
      dllLoadBehavior: "FFmpeg, ffprobe, and yt-dlp version commands succeeded by absolute path with PATH empty",
      standardUserObservation: { identity: outputText(identity), groups: outputText(groups), runnerUser: process.env.USERNAME ?? null },
      lockedFileBehavior: "not repeated in this lane; common locked-file and interruption coverage is retained in repository integration tests",
      consumerDefenderSmartAppControl: "not established by a GitHub-hosted runner",
    },
  };
}

function markdownValue(value) {
  if (value === null || value === undefined || value === "") return "—";
  return String(value).replaceAll("|", "\\|").replaceAll("\n", "<br>");
}

function reportMarkdown(report) {
  const lines = [
    `# Urma native distribution qualification — ${report.target}`,
    "",
    `STATUS: **${report.status}**`,
    "",
    "## Runner/environment",
    "",
    `- Runner label: ${markdownValue(report.environment?.runnerLabel)}`,
    `- Runner metadata: ${markdownValue(JSON.stringify(report.environment?.runner))}`,
    `- OS/version: ${markdownValue(`${report.environment?.os?.type ?? ""} ${report.environment?.os?.version ?? ""}`)}`,
    `- Kernel: ${markdownValue(report.environment?.os?.kernel)}`,
    `- Architecture: platform=${markdownValue(report.environment?.os?.platform)}, process.arch=${markdownValue(report.environment?.node?.processArch)}`,
    `- Node: ${markdownValue(report.environment?.node?.version)}`,
    `- process.execPath: ${markdownValue(report.environment?.node?.execPath)}`,
    `- glibc: ${markdownValue(report.environment?.os?.glibc)}`,
    `- Urma package: ${markdownValue(report.package?.version)}; packed tarball SHA-256=${markdownValue(report.package?.tarballSha256)}`,
    `- Install root: ${markdownValue(report.environment?.installationRoot)}`,
    "",
    "## Artifacts",
    "",
    "| Kind | Provider | Version/release | URL | Archive bytes | Archive SHA-256 | Binary SHA-256 | Reported version |",
    "| --- | --- | --- | --- | ---: | --- | --- | --- |",
  ];
  for (const kind of TOOL_KINDS) {
    const item = report.artifacts?.[kind];
    lines.push(`| ${kind} | ${markdownValue(item?.provider)} | ${markdownValue(`${item?.upstreamVersion ?? ""} / ${item?.upstreamRelease ?? ""}`)} | ${markdownValue(item?.url)} | ${markdownValue(item?.archiveSizeBytes)} | ${markdownValue(item?.archiveSha256)} | ${markdownValue(item?.binarySha256Observed)} | ${markdownValue(item?.actualReportedVersion)} |`);
  }
  lines.push(
    "",
    "## Installer",
    "",
    `- Packed release install: ${markdownValue(report.package?.install)}.`,
    `- Archive verification: ${markdownValue(report.nativeExecution?.archiveExtraction)}.`,
    `- Native qualification checks: ${markdownValue(report.installer?.qualificationChecks?.join(", "))}.`,
    `- Absolute managed paths only: ${markdownValue(JSON.stringify(report.nativeExecution?.managedToolPaths))}.`,
    `- PATH fallback: ${markdownValue(report.installer?.pathFallback)}.`,
    "",
    "## Native execution",
    "",
    `- Node binary: ${markdownValue(JSON.stringify(report.nativeExecution?.nodeBinary))}.`,
    `- Managed binary inventory: ${markdownValue(JSON.stringify(report.nativeExecution?.architecture))}.`,
    `- yt-dlp hermetic profile: ${markdownValue(JSON.stringify(report.nativeExecution?.ytdlpHermeticProfile))}.`,
    "",
    "## MCP",
    "",
    `- ${markdownValue(JSON.stringify(report.mcp))}.`,
    "",
    "## Evidence operation",
    "",
    `- ${markdownValue(report.evidenceOperation)}.`,
    `- Restart from persistent install: ${markdownValue(report.restart?.status)}${report.restart?.detail ? ` — ${markdownValue(report.restart.detail)}` : ""}.`,
    "",
    "## Platform-specific findings",
    "",
    `- ${markdownValue(JSON.stringify(report.platformFindings))}.`,
    "",
    "## Required changes",
    "",
    `- ${markdownValue(report.requiredChanges)}.`,
    "",
    "## Extended lifecycle",
    "",
    "- Expensive second-generation/fault lifecycle was not duplicated in this native lane. The repository integration suite already covers update publication, interruption atomicity, rollback, tamper/missing-generation detection, and concurrent setup with fault-injection fixtures; this matrix keeps its main path on real upstream artifacts.",
    "",
    "## Remaining release boundaries",
    "",
    "- Windows consumer Defender/Smart App Control qualification remains separate from GitHub-hosted runner execution.",
    "- Provider retention, availability, signature policy, and upstream artifact continuity remain release-time obligations.",
    "- This report proves only the runner/image and exact artifacts recorded above.",
  );
  if (report.failure) lines.push("", "## Failure", "", `- ${markdownValue(report.failure.message)}.`);
  return `${lines.join("\n")}\n`;
}

async function main() {
  const target = process.env.URMA_EXPECTED_TARGET;
  const targetConfig = TARGETS[target];
  assert(targetConfig, `URMA_EXPECTED_TARGET must be one of ${Object.keys(TARGETS).join(", ")}`);
  const expectedNodeVersion = process.env.URMA_QUALIFY_NODE_VERSION;
  assert(expectedNodeVersion, "URMA_QUALIFY_NODE_VERSION is required so the lane records an exact Node version");
  const packageTarballInput = process.env.URMA_PACKAGE_TARBALL;
  assert(packageTarballInput, "URMA_PACKAGE_TARBALL is required");
  const resultDir = path.resolve(process.env.URMA_RESULT_DIR ?? path.join("qualification-results", target));
  await mkdir(resultDir, { recursive: true, mode: 0o700 });
  const report = {
    status: "NOT QUALIFIED",
    target,
    environment: {
      runnerLabel: process.env.URMA_RUNNER_LABEL ?? null,
      runner: selectedEnvironment(),
      os: {
        platform: process.platform,
        type: os.type(),
        version: os.version(),
        kernel: os.release(),
        arch: os.arch(),
        glibc: glibcVersion(),
      },
      node: {
        version: process.versions.node,
        processArch: process.arch,
        execPath: process.execPath,
        versions: process.versions,
      },
      installationRoot: null,
    },
    package: null,
    installer: null,
    artifacts: null,
    nativeExecution: null,
    mcp: null,
    restart: null,
    platformFindings: null,
    commands: [],
    requiredChanges: "No changes demonstrated by this lane.",
    failure: null,
  };

  let tempRoot;
  try {
    assert(process.platform === targetConfig.platform, `runner process.platform ${process.platform} does not match target ${target}`);
    assert(process.arch === targetConfig.processArch, `runner process.arch ${process.arch} does not match native target ${target}`);
    assert(process.versions.node === expectedNodeVersion, `runner Node ${process.versions.node} is not the required exact ${expectedNodeVersion}`);
    assert((process.platform !== "linux") || glibcVersion(), "Linux qualification requires a glibc Node runtime");

    const packageTarball = path.resolve(packageTarballInput);
    const tarballInfo = await regularFile(packageTarball, "packed npm release");
    const tarballSha256 = await sha256File(packageTarball);
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "urma-native-qualification-"));
    const bootstrapRoot = path.join(tempRoot, "npm bootstrap — 世界");
    const xdgHome = path.join(tempRoot, "XDG data — 数据");
    const dataRoot = process.platform === "linux"
      ? path.join(xdgHome, "urma")
      : path.join(tempRoot, "Urma install root — spaces — 数据");
    const localRoot = path.join(dataRoot, "local evidence — 日本");
    await mkdir(bootstrapRoot, { recursive: true, mode: 0o700 });
    await mkdir(localRoot, { recursive: true, mode: 0o700 });
    report.environment.installationRoot = dataRoot;
    report.environment.xdgDataHome = process.platform === "linux" ? xdgHome : null;
    report.package = {
      tarball: packageTarball,
      tarballBytes: tarballInfo.size,
      tarballSha256,
      install: "npm install from the uploaded packed tarball into an isolated bootstrap directory",
    };

    const npmEnvironment = { ...process.env, npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false" };
    const npm = npmInvocation();
    const npmInstall = await runLogged(
      report,
      resultDir,
      "install-packed-npm-release",
      npm.executable,
      [...npm.args, "install", "--no-save", "--no-package-lock", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", bootstrapRoot, packageTarball],
      { cwd: tempRoot, env: npmEnvironment, timeoutMs: 10 * 60_000 },
    );
    requireSuccess(npmInstall, "npm install of packed release");
    const packageRoot = path.join(bootstrapRoot, "node_modules", "urma-mcp");
    const packageJson = await readJson(path.join(packageRoot, "package.json"), "installed packed package metadata");
    const repositoryUrl = typeof packageJson.repository === "object" && packageJson.repository !== null
      ? packageJson.repository.url
      : undefined;
    assert(
      packageJson.name === "urma-mcp" && repositoryUrl === "https://github.com/sajidurdev/urma.git",
      "bootstrap did not install the expected urma-mcp package metadata from the packed tarball",
    );
    assert(typeof packageJson.version === "string" && packageJson.version.length > 0, "packed package has no version");
    await regularFile(path.join(packageRoot, "launcher-v1.mjs"), "packed launcher");
    await regularFile(path.join(packageRoot, "dist", "src", "cli", "main.js"), "packed CLI");
    assert(contained(tempRoot, packageRoot), "qualification accidentally selected a package outside the isolated npm bootstrap");

    const manifestModule = await import(pathToFileURL(path.join(packageRoot, "dist", "src", "distribution", "manifest.js")).href);
    const platformModule = await import(pathToFileURL(path.join(packageRoot, "dist", "src", "distribution", "platform.js")).href);
    const detectedTarget = platformModule.detectTargetPlatform();
    assert(detectedTarget === target, `packed Urma detected ${detectedTarget}, expected ${target}`);
    const manifest = manifestModule.getReleaseManifest(target);
    manifestModule.validateReleaseManifest(manifest);

    const setupEnvironment = hermeticEnvironment(dataRoot, localRoot, xdgHome);
    const setupEntry = path.join(packageRoot, "dist", "src", "cli", "main.js");
    const setupArgs = [setupEntry, "setup"];
    if (process.platform !== "linux") setupArgs.push("--data-dir", dataRoot);
    const setupResult = await runLogged(report, resultDir, "packed-setup", process.execPath, setupArgs, { cwd: packageRoot, env: setupEnvironment, timeoutMs: 30 * 60_000 });
    requireSuccess(setupResult, "packed setup path");

    const active = basicActive(await readJson(path.join(dataRoot, "ACTIVE.json"), "ACTIVE.json"));
    const generationDir = path.join(dataRoot, "installs", active.active);
    const receipt = await readJson(path.join(generationDir, "receipt.json"), "installation receipt");
    validateReceipt(receipt, active, target, packageJson.version);
    const managed = await managedTools(dataRoot, active, receipt, targetConfig);
    assert(receipt.manifest.identity === manifestModule.manifestIdentity(manifest), "receipt manifest identity does not match the packed release manifest");
    const nodeBinary = await inspectBinary(process.execPath, "executing Node");
    assert(nodeBinary.format === targetConfig.binaryFormat, `executing Node is ${nodeBinary.format}, expected ${targetConfig.binaryFormat}`);
    assert(nodeBinary.architectures.includes(targetConfig.binaryArch), `executing Node architecture ${nodeBinary.architectures.join(", ")} is not native ${targetConfig.binaryArch}`);
    report.nativeExecution = { nodeBinary, processArch: process.arch, processExecPath: process.execPath };
    report.installer = {
      qualificationChecks: [...receipt.qualification.checks],
      pathFallback: "blocked by absolute managed paths, receipt containment checks, and PATH= during this lane",
      active: { generation: active.generation, active: active.active, previous: active.previous },
      immutableGeneration: generationDir,
    };

    const runtimeEnvironment = hermeticEnvironment(dataRoot, localRoot, xdgHome);
    const fixture = await generateLocalFixture(report, resultDir, managed, runtimeEnvironment, localRoot);
    await runManagedToolChecks(report, resultDir, packageRoot, managed, manifest, runtimeEnvironment);
    if (process.platform === "linux") await linuxDiagnostics(report, resultDir, managed);
    else if (process.platform === "darwin") await macDiagnostics(report, resultDir, managed, target);
    else await windowsDiagnostics(report, resultDir, managed);

    const retiredBootstrapRoot = `${bootstrapRoot}.after-setup`;
    try {
      await access(retiredBootstrapRoot);
      throw new Error(`Temporary package retirement path already exists: ${retiredBootstrapRoot}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await rename(bootstrapRoot, retiredBootstrapRoot);

    const launcher = path.join(dataRoot, "launcher-v1.mjs");
    await regularFile(launcher, "persistent launcher");
    const launcherVersion = await runLogged(report, resultDir, "persistent-launcher-version", process.execPath, [launcher, "--version"], { cwd: dataRoot, env: runtimeEnvironment, timeoutMs: 60_000 });
    requireSuccess(launcherVersion, "persistent launcher version");
    assert(launcherVersion.stdout.trim() === packageJson.version, "persistent launcher did not return the packed package version");
    await runMcpQualification(report, resultDir, launcher, runtimeEnvironment, localRoot, fixture);

    const restart = new McpSession(report, resultDir, launcher, runtimeEnvironment, localRoot);
    try {
      rpcResult(await restart.request(1, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "urma-native-restart-qualification", version: "1.0.0" } },
      }), "restart MCP initialize");
      restart.notify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
      const listed = rpcResult(await restart.request(2, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }), "restart MCP tools/list");
      const names = (Array.isArray(listed.tools) ? listed.tools : []).map((tool) => asRecord(tool, "restart MCP tool").name);
      assert(JSON.stringify(names) === JSON.stringify(EXPECTED_MCP_TOOLS), "restart MCP tools/list did not expose all expected tools");
      const inspected = rpcResult(await restart.request(3, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "inspect_video", arguments: { source: fixture, freshness: "reuse" } },
      }), "restart MCP inspect_video");
      assert(typeof asRecord(inspected.structuredContent, "restart inspect_video").investigationRef === "string", "restart MCP local operation did not return an investigation");
      report.restart = { status: "passed", detail: "absolute launcher restarted with PATH empty, initialized MCP, rediscovered all tools, and completed local inspect_video" };
    } finally {
      await restart.close();
    }
    report.status = "QUALIFIED";
  } catch (error) {
    report.status = "NOT QUALIFIED";
    report.failure = { message: errorMessage(error) };
    report.requiredChanges = `Investigate and correct the demonstrated qualification failure: ${errorMessage(error)}`;
  } finally {
    await writeFile(path.join(resultDir, "qualification.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await writeFile(path.join(resultDir, "qualification.md"), reportMarkdown(report), "utf8");
    if (tempRoot !== undefined) await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
  process.stdout.write(`Urma native distribution qualification ${target}: ${report.status}\n`);
  process.stdout.write(`Results: ${resultDir}\n`);
  if (report.failure) {
    process.stderr.write(`Qualification failure: ${report.failure.message}\n`);
    process.exitCode = 1;
  }
}

await main();
