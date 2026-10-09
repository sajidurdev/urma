import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryBase = path.resolve(process.env.RUNNER_TEMP ?? os.tmpdir());
const diagnosticsDirectory = path.resolve(
  process.env.URMA_DIAGNOSTICS_DIR ?? path.join(temporaryBase, "urma-arm64-diagnostics"),
);
const ownerFileName = ".urma-arm64-diagnostic-owner";
const ownerToken = randomUUID();
const CHILD_ENV_KEYS = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "TEMP",
  "TMP",
  "ComSpec",
  "SystemDrive",
  "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS",
  "LANG",
  "LC_ALL",
  "TZ",
];
const RUNTIME_MARKERS = [
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
];

function allowlistedEnvironment(input = process.env) {
  const output = {};
  for (const key of CHILD_ENV_KEYS) {
    const value = input[key];
    if (value !== undefined) output[key] = value;
  }
  return output;
}

function exitFields(code) {
  if (!Number.isInteger(code)) return { exitCode: code ?? null, exitCodeUnsigned: null, exitHex: null };
  const unsigned = code >>> 0;
  return {
    exitCode: code,
    exitCodeUnsigned: unsigned,
    exitHex: `0x${unsigned.toString(16).padStart(8, "0")}`,
  };
}

function errorText(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function safeLabel(value) {
  return value.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "") || "command";
}

function selectedRunnerEnvironment() {
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

const originalEnvironment = { ...process.env };
const report = {
  status: "NOT RUN",
  target: "windows-arm64",
  environment: {
    runner: selectedRunnerEnvironment(),
    os: {
      platform: process.platform,
      type: os.type(),
      version: os.version(),
      kernel: os.release(),
      arch: os.arch(),
      machine: typeof os.machine === "function" ? os.machine() : null,
      cpuModel: os.cpus()[0]?.model ?? null,
      cpuCount: os.cpus().length,
    },
    node: {
      version: process.versions.node,
      processArch: process.arch,
      execPath: process.execPath,
      versions: process.versions,
    },
    productionChildEnvironment: null,
    ordinaryChildEnvironment: null,
    unicodeCwd: null,
    asciiCwd: null,
  },
  manifest: null,
  setupPhases: [],
  setup: null,
  focusedDiagnostics: [],
  qualification: { status: "NOT RUN", checks: [] },
  commands: [],
  cleanup: "NOT RUN",
  failure: null,
};

let tempRoot;
let logOrdinal = 0;

function restoreOriginalEnvironment() {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnvironment)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(originalEnvironment)) process.env[key] = value;
}

async function saveCommand(label, details, stdout, stderr, resultFields = {}) {
  logOrdinal += 1;
  const prefix = `${String(logOrdinal).padStart(3, "0")}-${safeLabel(label)}`;
  const stdoutLog = `${prefix}.stdout.log`;
  const stderrLog = `${prefix}.stderr.log`;
  await writeFile(path.join(diagnosticsDirectory, stdoutLog), stdout, "utf8");
  await writeFile(path.join(diagnosticsDirectory, stderrLog), stderr, "utf8");
  const record = {
    label,
    ...details,
    ...resultFields,
    stdoutBytes: Buffer.byteLength(stdout, "utf8"),
    stderrBytes: Buffer.byteLength(stderr, "utf8"),
    stdoutLog,
    stderrLog,
  };
  report.commands.push(record);
  return record;
}

function invocationDetails(mode, executable, args, options = {}) {
  const environment = options.env ?? process.env;
  return {
    mode,
    executable,
    args: [...args],
    cwd: options.cwd ?? process.cwd(),
    forwardedEnvironment: allowlistedEnvironment(environment),
    inputFile: options.inputFile ?? null,
    windowsHide: true,
    shell: false,
  };
}

async function runProduction(label, executable, args, options = {}) {
  const details = invocationDetails("production-runProcess", executable, args, options);
  try {
    const { runProcess } = await import(pathToFileURL(path.join(workspaceRoot, "dist", "src", "subprocess", "runner.js")).href);
    const result = await runProcess(executable, args, options);
    const record = await saveCommand(
      label,
      details,
      result.stdout.toString("utf8"),
      result.stderr.toString("utf8"),
      { ...exitFields(result.code), wallMs: result.wallMs },
    );
    return { record, result };
  } catch (error) {
    const record = await saveCommand(label, details, "", "", { error: errorText(error) });
    return { record, result: null };
  }
}

async function runOrdinary(label, executable, args, options = {}) {
  const childEnvironment = allowlistedEnvironment(options.env ?? originalEnvironment);
  const details = invocationDetails("ordinary-node-spawn-allowlisted-host-PATH", executable, args, {
    ...options,
    env: childEnvironment,
  });
  const maxOutputBytes = 2 * 1024 * 1024;
  const timeoutMs = 120_000;
  const startedAt = Date.now();
  let timedOut = false;
  let outputLimited = false;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const stdout = [];
  const stderr = [];
  let child;
  try {
    const result = await new Promise((resolve) => {
      child = spawn(executable, [...args], {
        cwd: options.cwd,
        env: childEnvironment,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stop = () => {
        try {
          child.kill();
        } catch {
          // Preserve the initial timeout/output-limit result.
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, timeoutMs);
      child.stdout.on("data", (chunk) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > maxOutputBytes) {
          outputLimited = true;
          stop();
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderrBytes += chunk.length;
        if (stderrBytes > maxOutputBytes) {
          outputLimited = true;
          stop();
          return;
        }
        stderr.push(chunk);
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        resolve({ code: null, signal: null, error: errorText(error) });
      });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal, error: null });
      });
    });
    const output = Buffer.concat(stdout).toString("utf8");
    const errorOutput = Buffer.concat(stderr).toString("utf8");
    const resultFields = {
      ...exitFields(result.code),
      signal: result.signal,
      wallMs: Date.now() - startedAt,
      error: result.error ?? (timedOut ? `timed out after ${timeoutMs} ms` : outputLimited ? `exceeded ${maxOutputBytes} output bytes` : undefined),
    };
    const record = await saveCommand(label, details, output, errorOutput, resultFields);
    return { record, stdout: output, stderr: errorOutput };
  } catch (error) {
    const record = await saveCommand(label, details, "", "", {
      exitCode: null,
      exitCodeUnsigned: null,
      exitHex: null,
      wallMs: Date.now() - startedAt,
      error: errorText(error),
    });
    return { record, stdout: "", stderr: "" };
  }
}

function fixtureArguments(outputFile, disableCpuFlags = false) {
  return [
    "-v",
    "error",
    ...(disableCpuFlags ? ["-cpuflags", "0"] : []),
    "-f",
    "lavfi",
    "-i",
    "color=c=black:s=160x90:d=1:r=24",
    "-c:v",
    "mpeg4",
    "-q:v",
    "5",
    "-f",
    "nut",
    "-y",
    outputFile,
  ];
}

function accessViolation(record) {
  return record.exitHex === "0xc0000005";
}

async function runFocusedComparisons(context, asciiCwd) {
  const { ffmpeg } = context;
  const unicodeFixture = path.join(context.generationDir, "qualification-fixture", "fixture.nut");
  const asciiFixtureRoot = path.join(asciiCwd, "qualification-fixture");
  await mkdir(path.dirname(unicodeFixture), { recursive: true });
  await mkdir(asciiFixtureRoot, { recursive: true });

  const unicodeVersionProduction = await runProduction("unicode-production-version", ffmpeg, ["-version"]);
  const unicodeFixtureProduction = await runProduction(
    "unicode-production-first-fixture",
    ffmpeg,
    fixtureArguments(unicodeFixture),
  );
  const unicodeVersionOrdinary = await runOrdinary("unicode-ordinary-version", ffmpeg, ["-version"]);
  const unicodeFixtureOrdinary = await runOrdinary(
    "unicode-ordinary-first-fixture",
    ffmpeg,
    fixtureArguments(unicodeFixture),
  );

  let asciiVersionProduction;
  let asciiFixtureProduction;
  try {
    const sourceTools = path.join(context.generationDir, "tools", "ffmpeg");
    const asciiTools = path.join(asciiCwd, "tools", "ffmpeg");
    await cp(sourceTools, asciiTools, { recursive: true, errorOnExist: true, force: false });
    const relativeFfmpeg = path.relative(sourceTools, ffmpeg);
    const asciiFfmpeg = path.join(asciiTools, relativeFfmpeg);
    asciiVersionProduction = await runProduction(
      "ascii-production-version",
      asciiFfmpeg,
      ["-version"],
      { cwd: asciiCwd },
    );
    asciiFixtureProduction = await runProduction(
      "ascii-production-first-fixture",
      asciiFfmpeg,
      fixtureArguments(path.join(asciiFixtureRoot, "fixture.nut")),
      { cwd: asciiCwd },
    );
  } catch (error) {
    const record = await saveCommand(
      "ascii-path-preparation",
      { mode: "diagnostic-setup", cwd: asciiCwd },
      "",
      "",
      { error: errorText(error) },
    );
    asciiVersionProduction = { record, result: null };
    asciiFixtureProduction = { record, result: null };
  }

  const fixtureRecords = [
    unicodeFixtureProduction.record,
    unicodeFixtureOrdinary.record,
    asciiFixtureProduction.record,
  ];
  let cpuFlagsResult = null;
  if (fixtureRecords.every(accessViolation)) {
    let cpuFlagsExecutable = ffmpeg;
    let cpuFlagsOutput = unicodeFixture;
    let cpuFlagsOptions = {};
    if (asciiVersionProduction.result !== null && asciiFixtureProduction.result !== null) {
      cpuFlagsExecutable = asciiFixtureProduction.record.executable;
      cpuFlagsOutput = path.join(asciiFixtureRoot, "fixture-cpuflags-zero.nut");
      cpuFlagsOptions = { cwd: asciiCwd };
    }
    cpuFlagsResult = await runProduction(
      "conditional-cpuflags-zero-first-fixture",
      cpuFlagsExecutable,
      fixtureArguments(cpuFlagsOutput, true),
      cpuFlagsOptions,
    );
  }

  report.focusedDiagnostics = [
    { label: "unicode-production-version", command: unicodeVersionProduction.record.label, exitHex: unicodeVersionProduction.record.exitHex ?? null },
    { label: "unicode-production-first-fixture", command: unicodeFixtureProduction.record.label, exitHex: unicodeFixtureProduction.record.exitHex ?? null },
    { label: "unicode-ordinary-version", command: unicodeVersionOrdinary.record.label, exitHex: unicodeVersionOrdinary.record.exitHex ?? null },
    { label: "unicode-ordinary-first-fixture", command: unicodeFixtureOrdinary.record.label, exitHex: unicodeFixtureOrdinary.record.exitHex ?? null },
    { label: "ascii-production-version", command: asciiVersionProduction.record.label, exitHex: asciiVersionProduction.record.exitHex ?? null },
    { label: "ascii-production-first-fixture", command: asciiFixtureProduction.record.label, exitHex: asciiFixtureProduction.record.exitHex ?? null },
    ...(cpuFlagsResult === null
      ? []
      : [{ label: "conditional-cpuflags-zero-first-fixture", command: cpuFlagsResult.record.label, exitHex: cpuFlagsResult.record.exitHex ?? null }]),
  ];
}

async function loggedQualificationRunner(executable, args, options = {}) {
  const { runProcess } = await import(pathToFileURL(path.join(workspaceRoot, "dist", "src", "subprocess", "runner.js")).href);
  const label = `qualification-${path.basename(executable)}-${String(args[0] ?? "command")}`;
  const details = invocationDetails("production-qualification-runner", executable, args, options);
  let result;
  try {
    result = await runProcess(executable, args, options);
  } catch (error) {
    await saveCommand(label, details, "", "", { error: errorText(error) });
    throw error;
  }
  await saveCommand(
    label,
    details,
    result.stdout.toString("utf8"),
    result.stderr.toString("utf8"),
    { ...exitFields(result.code), wallMs: result.wallMs },
  );
  if (result.code !== 0) {
    const output = result.stderr.toString("utf8").trim().slice(-4_000) ||
      result.stdout.toString("utf8").trim().slice(-4_000) || "no diagnostic output";
    const { UrmaError } = await import(pathToFileURL(path.join(workspaceRoot, "dist", "src", "core", "errors.js")).href);
    const { redactArgs, redactText } = await import(pathToFileURL(path.join(workspaceRoot, "dist", "src", "subprocess", "redaction.js")).href);
    throw new UrmaError(
      "SOURCE_UNAVAILABLE",
      `${executable} failed with exit code ${String(result.code)}: ${redactText(output) || "no diagnostic output"}`,
      {
        retryable: true,
        detail: { executable, args: redactArgs(args), exitCode: result.code },
      },
    );
  }
  return result;
}

async function removeOwnedTemporaryRoot(root) {
  if (!root) return;
  const baseReal = await realpath(temporaryBase);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error(`Diagnostic temporary root is no longer a real directory: ${root}`);
  }
  const rootReal = await realpath(root);
  const relative = path.relative(baseReal, rootReal);
  if (
    relative === "" ||
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.dirname(rootReal) !== baseReal ||
    !path.basename(rootReal).startsWith("urma-arm64-setup-")
  ) {
    throw new Error(`Diagnostic cleanup target escaped its dedicated temporary directory: ${rootReal}`);
  }
  const marker = await readFile(path.join(rootReal, ownerFileName), "utf8");
  if (marker !== ownerToken) throw new Error(`Diagnostic cleanup ownership marker changed: ${rootReal}`);
  await rm(rootReal, { recursive: true, force: false });
}

async function main() {
  await mkdir(diagnosticsDirectory, { recursive: true });
  if (process.platform !== "win32" || process.arch !== "arm64") {
    throw new Error(`This diagnostic requires native Windows ARM64; received ${process.platform}-${process.arch}`);
  }
  const expectedNodeVersion = (await readFile(path.join(workspaceRoot, ".node-version"), "utf8")).trim();
  if (process.versions.node !== expectedNodeVersion) {
    throw new Error(`Runner Node ${process.versions.node} does not match .node-version ${expectedNodeVersion}`);
  }

  tempRoot = await mkdtemp(path.join(temporaryBase, "urma-arm64-setup-"));
  await writeFile(path.join(tempRoot, ownerFileName), ownerToken, { encoding: "utf8", flag: "wx" });
  const setupRoot = path.join(tempRoot, "Urma install root — spaces — 数据");
  const unicodeCwd = path.join(tempRoot, "npm bootstrap — 世界", "node_modules", "urma-mcp");
  const asciiCwd = path.join(tempRoot, "ascii-diagnostic");
  await mkdir(unicodeCwd, { recursive: true });
  await mkdir(asciiCwd, { recursive: true });
  if (![...asciiCwd].every((character) => character.codePointAt(0) <= 0x7f)) {
    throw new Error(`RUNNER_TEMP is not an ASCII path, so an ASCII differential cannot be run: ${asciiCwd}`);
  }
  report.environment.unicodeCwd = unicodeCwd;
  report.environment.asciiCwd = asciiCwd;

  const dataLocalRoot = path.join(setupRoot, "local evidence — 日本");
  const productEnvironment = { ...process.env, PATH: "" };
  for (const marker of RUNTIME_MARKERS) delete productEnvironment[marker];
  productEnvironment.URMA_DATA_DIR = setupRoot;
  productEnvironment.URMA_LOCAL_ROOTS = dataLocalRoot;
  productEnvironment.URMA_FFMPEG = "system-ffmpeg-must-not-be-used";
  productEnvironment.URMA_FFPROBE = "system-ffprobe-must-not-be-used";
  productEnvironment.URMA_YTDLP = "system-yt-dlp-must-not-be-used";
  for (const [key, value] of Object.entries(productEnvironment)) process.env[key] = value;
  for (const key of Object.keys(process.env)) {
    if (!(key in productEnvironment)) delete process.env[key];
  }
  report.environment.productionChildEnvironment = allowlistedEnvironment(process.env);
  report.environment.ordinaryChildEnvironment = allowlistedEnvironment(originalEnvironment);

  process.chdir(unicodeCwd);
  const [{ getReleaseManifest }, { setup }, { qualifyNativeTools }, { sha256File }] = await Promise.all([
    import(pathToFileURL(path.join(workspaceRoot, "dist", "src", "distribution", "manifest.js")).href),
    import(pathToFileURL(path.join(workspaceRoot, "dist", "src", "distribution", "installer.js")).href),
    import(pathToFileURL(path.join(workspaceRoot, "dist", "src", "distribution", "qualification.js")).href),
    import(pathToFileURL(path.join(workspaceRoot, "dist", "src", "distribution", "integrity.js")).href),
  ]);
  const manifest = getReleaseManifest("windows-arm64");
  report.manifest = {
    target: manifest.target,
    ffmpeg: {
      version: manifest.ffmpeg.upstreamVersion,
      release: manifest.ffmpeg.upstreamRelease,
      url: manifest.ffmpeg.url,
      archiveBytes: manifest.ffmpeg.archiveBytes,
      archiveSha256: manifest.ffmpeg.archiveSha256,
      executable: manifest.ffmpeg.executable,
    },
    ffprobe: { executable: manifest.ffprobe.executable },
    ytdlp: {
      version: manifest.ytdlp.upstreamVersion,
      url: manifest.ytdlp.url,
      archiveBytes: manifest.ytdlp.archiveBytes,
      archiveSha256: manifest.ytdlp.archiveSha256,
      executable: manifest.ytdlp.executable,
    },
  };

  try {
    const setupResult = await setup({
      target: "windows-arm64",
      dataRoot: setupRoot,
      onPhase: async (phase) => {
        report.setupPhases.push(phase);
      },
      qualifyNative: async (context) => {
        report.setup = {
          target: "windows-arm64",
          generationDir: context.generationDir,
          ffmpeg: context.ffmpeg,
          ffprobe: context.ffprobe,
          ytdlp: context.ytdlp,
          ffmpegSha256: await sha256File(context.ffmpeg),
          ffprobeSha256: await sha256File(context.ffprobe),
          ytdlpSha256: await sha256File(context.ytdlp),
          artifactAcquisition: "existing installer path; pinned archive bytes and SHA-256 verified before extraction",
        };
        await runFocusedComparisons(context, asciiCwd);
        const result = await qualifyNativeTools({ ...context, runner: loggedQualificationRunner });
        report.qualification = { status: "PASSED", checks: [...result.checks] };
        return result;
      },
    });
    report.status = "SETUP PASSED";
    report.setupResult = {
      target: setupResult.target,
      generation: setupResult.generation,
      installId: setupResult.installId,
      isolatedDataRoot: setupRoot,
    };
  } catch (error) {
    report.status = "SETUP FAILED";
    report.failure = { message: errorText(error) };
    if (report.qualification.status === "NOT RUN") {
      report.qualification = {
        status: report.setup ? "FAILED" : "NOT REACHED",
        checks: [],
      };
    }
  } finally {
    process.chdir(workspaceRoot);
    restoreOriginalEnvironment();
    try {
      await removeOwnedTemporaryRoot(tempRoot);
      report.cleanup = "removed dedicated temporary setup root";
    } catch (error) {
      report.cleanup = `failed: ${errorText(error)}`;
      report.failure ??= { message: errorText(error) };
      report.status = "DIAGNOSTIC CLEANUP FAILED";
    }
    try {
      await writeFile(path.join(diagnosticsDirectory, "diagnostics.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    } catch (error) {
      report.failure ??= { message: errorText(error) };
    }
  }

  process.stdout.write(`Windows ARM64 setup diagnostic: ${report.status}\n`);
  process.stdout.write(`Diagnostics: ${diagnosticsDirectory}\n`);
  if (report.failure) {
    process.stderr.write(`Diagnostic failure: ${report.failure.message}\n`);
    process.exitCode = 1;
  }
}

await main().catch(async (error) => {
  report.status = "DIAGNOSTIC FAILED";
  report.failure = { message: errorText(error) };
  process.chdir(workspaceRoot);
  restoreOriginalEnvironment();
  try {
    if (tempRoot) {
      await removeOwnedTemporaryRoot(tempRoot);
      report.cleanup = "removed dedicated temporary setup root";
    }
  } catch (cleanupError) {
    report.cleanup = `failed: ${errorText(cleanupError)}`;
  }
  try {
    await mkdir(diagnosticsDirectory, { recursive: true });
    await writeFile(path.join(diagnosticsDirectory, "diagnostics.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  } catch {
    // The workflow still runs the packed qualification and artifact upload steps.
  }
  process.stderr.write(`Diagnostic failure: ${errorText(error)}\n`);
  process.exitCode = 1;
});
