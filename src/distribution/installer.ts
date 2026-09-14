import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import { UrmaError } from "../core/errors.js";
import { loadConfig } from "../config.js";
import { runChecked } from "../subprocess/runner.js";
import { collectBinaryVersions } from "../subprocess/versions.js";
import { SCHEMA_VERSION } from "../store/schema.js";
import { URMA_VERSION, SUPPORTED_NODE_RANGE } from "../version.js";
import {
  commitActive,
  nextGenerationNumber,
  readActive,
  selectionForUpdate,
  type ActiveSelection,
} from "./active.js";
import { extractArchive } from "./archive.js";
import { downloadAndVerifyArtifact } from "./download.js";
import { acquireInstallationLock } from "./lock.js";
import {
  getReleaseManifest,
  manifestIdentity,
  validateReleaseManifest,
  type ArtifactSpec,
  type TargetReleaseManifest,
} from "./manifest.js";
import {
  assertUserOwnedDataRoot,
  distributionPaths,
  ensureDistributionLayout,
  installationPath,
  chooseDataRoot,
  stagingPath,
  validateInstallId,
  type DistributionPaths,
} from "./paths.js";
import { detectTargetPlatform, nodeVersionIsSupported, type TargetPlatform } from "./platform.js";
import { persistedRuntimeMcpSmoke, qualifyNativeTools, type QualificationContext, type QualificationResult } from "./qualification.js";
import { writeReceipt, type InstallationReceipt } from "./receipt.js";
import { copyNpmRuntime, hashNodeExecutable, type CopiedRuntime } from "./runtime.js";
import { notRequestedHostRegistration, registerGenericMcpHost, type HostRegistrationResult } from "./host-registration.js";
import { sha256File } from "./integrity.js";

export type SetupPhase =
  | "runtime-copied"
  | "artifacts-acquired"
  | "native-qualified"
  | "receipt-written"
  | "mcp-qualified"
  | "published"
  | "final-launch-checked"
  | "active-committed";

export type SetupOptions = Readonly<{
  dataRoot?: string;
  nodeExecutable?: string;
  target?: TargetPlatform;
  manifest?: TargetReleaseManifest;
  downloadArtifact?: (artifact: ArtifactSpec, destination: string) => Promise<void>;
  qualifyNative?: (context: QualificationContext) => Promise<QualificationResult>;
  mcpSmoke?: (
    context: QualificationContext,
    hashes: Readonly<{ ffmpeg: string; ffprobe: string; ytdlp: string }>,
  ) => Promise<readonly string[]>;
  probeVersions?: (config: ReturnType<typeof loadConfig>) => Promise<Readonly<{
    ffmpegVersion: string;
    ffprobeVersion: string;
    ytdlpVersion: string;
  }>>;
  onPhase?: (phase: SetupPhase) => Promise<void> | void;
  client?: "generic" | undefined;
  clientConfig?: string | undefined;
  minimumFreeBytes?: number | undefined;
}>;

export type SetupResult = Readonly<{
  runtimeInstallation: "healthy";
  installId: string;
  target: TargetPlatform;
  generation: number;
  launcherPath: string;
  nodeExecutable: string;
  hostRegistration: HostRegistrationResult;
}>;

const DEFAULT_MIN_FREE_BYTES = 1024 * 1024 * 1024;

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function phase(options: SetupOptions, value: SetupPhase): Promise<void> {
  await options.onPhase?.(value);
}

async function preflightDisk(root: string, minimumFreeBytes: number): Promise<void> {
  if (!Number.isSafeInteger(minimumFreeBytes) || minimumFreeBytes < 1) throw new UrmaError("SETUP_FAILED", "Installer free-space threshold is invalid");
  try {
    const info = await statfs(root);
    const freeBytes = Number(info.bavail) * Number(info.bsize);
    if (!Number.isSafeInteger(freeBytes) || freeBytes < minimumFreeBytes) throw new UrmaError("SETUP_FAILED", `Urma needs at least ${String(minimumFreeBytes)} bytes free on the installation filesystem; only ${String(freeBytes)} are available`);
  } catch (error) {
    if (error instanceof UrmaError) throw error;
    throw new UrmaError("SETUP_FAILED", `Could not preflight free space on ${root}`, { cause: error });
  }
}

async function validateArchiveFile(artifact: ArtifactSpec, file: string): Promise<void> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new UrmaError("ARTIFACT_DOWNLOAD_FAILED", `Downloaded ${artifact.kind} artifact is not a regular file`);
  if (artifact.archiveBytes > 0 && info.size !== artifact.archiveBytes) throw new UrmaError("ARTIFACT_DOWNLOAD_FAILED", `Downloaded ${artifact.kind} artifact size ${String(info.size)} does not match pinned size ${String(artifact.archiveBytes)}`);
  const actual = await sha256File(file);
  if (actual !== artifact.archiveSha256) throw new UrmaError("ARTIFACT_HASH_MISMATCH", `Downloaded ${artifact.kind} artifact hash mismatch; expected ${artifact.archiveSha256}, received ${actual}`);
}

async function mergeTree(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true, mode: 0o700 });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isSymbolicLink()) throw new UrmaError("ARCHIVE_INVALID", `Extracted artifact contains a symlink: ${from}`);
    if (entry.isDirectory()) {
      try {
        const existing = await lstat(to);
        if (existing.isSymbolicLink() || !existing.isDirectory()) throw new UrmaError("ARCHIVE_INVALID", `Artifact distributions collide at ${to}`);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        await mkdir(to, { mode: 0o700 });
      }
      await mergeTree(from, to);
    } else if (entry.isFile()) {
      try {
        await lstat(to);
        throw new UrmaError("ARCHIVE_INVALID", `Artifact distributions contain duplicate files at ${to}`);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      await copyFile(from, to);
    } else {
      throw new UrmaError("ARCHIVE_INVALID", `Artifact distribution contains an unsupported filesystem entry: ${from}`);
    }
  }
}

async function materializeTools(
  stage: string,
  manifest: TargetReleaseManifest,
  options: SetupOptions,
): Promise<Readonly<{ ffmpeg: string; ffprobe: string; ytdlp: string }>> {
  const work = path.join(stage, "artifact-work");
  const tools = path.join(stage, "tools");
  const ffmpegDirectory = path.join(tools, "ffmpeg");
  const ytdlpDirectory = path.join(tools, "yt-dlp");
  await mkdir(work, { recursive: true, mode: 0o700 });
  await mkdir(ffmpegDirectory, { recursive: true, mode: 0o700 });
  await mkdir(ytdlpDirectory, { recursive: true, mode: 0o700 });
  const artifacts = [manifest.ffmpeg, manifest.ffprobe, manifest.ytdlp];
  const downloaded = new Map<string, string>();
  const extracted = new Map<string, string>();
  const merged = new Set<string>();
  for (const artifact of artifacts) {
    // Identical content hashes can be shared between ffmpeg/ffprobe entries
    // for one qualified build, regardless of their metadata URL spelling.
    const key = `${artifact.archiveSha256}\0${artifact.archiveFormat}`;
    const keyToken = createHash("sha256").update(key).digest("hex").slice(0, 16);
    let archive = downloaded.get(key);
    if (archive === undefined) {
      archive = path.join(work, `archive-${keyToken}-${artifact.archiveSha256}.${artifact.archiveFormat === "tar.xz" ? "tar.xz" : "zip"}`);
      if (options.downloadArtifact === undefined) await downloadAndVerifyArtifact(artifact, archive);
      else await options.downloadArtifact(artifact, archive);
      await validateArchiveFile(artifact, archive);
      downloaded.set(key, archive);
    }
    let extraction = extracted.get(key);
    if (extraction === undefined) {
      extraction = path.join(work, `extract-${keyToken}`);
      await extractArchive(archive, artifact.archiveFormat, extraction);
      extracted.set(key, extraction);
    }
    for (const expected of artifact.expectedFiles) {
      const expectedPath = path.resolve(extraction, ...expected.split("/"));
      const relative = path.relative(extraction, expectedPath);
      if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) throw new UrmaError("ARCHIVE_INVALID", `Manifest expected file escapes extraction root: ${expected}`);
      const info = await lstat(expectedPath);
      if (!info.isFile() || info.isSymbolicLink()) throw new UrmaError("ARCHIVE_INVALID", `Pinned ${artifact.kind} archive is missing expected regular file ${expected}`);
    }
    const target = artifact.kind === "ytdlp" ? ytdlpDirectory : ffmpegDirectory;
    if (!merged.has(`${key}\0${artifact.kind === "ytdlp" ? "ytdlp" : "ffmpeg"}`)) {
      await mergeTree(extraction, target);
      merged.add(`${key}\0${artifact.kind === "ytdlp" ? "ytdlp" : "ffmpeg"}`);
    }
  }
  const ffmpeg = path.resolve(ffmpegDirectory, ...manifest.ffmpeg.executable.split("/"));
  const ffprobe = path.resolve(ffmpegDirectory, ...manifest.ffprobe.executable.split("/"));
  const ytdlp = path.resolve(ytdlpDirectory, ...manifest.ytdlp.executable.split("/"));
  for (const [kind, file] of [["ffmpeg", ffmpeg], ["ffprobe", ffprobe], ["ytdlp", ytdlp]] as const) {
    const relative = path.relative(stage, file);
    if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) throw new UrmaError("ARCHIVE_INVALID", `Manifest ${kind} executable escapes the staged generation`);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new UrmaError("ARCHIVE_INVALID", `Staged ${kind} executable is not a regular file`);
  }
  await rm(work, { recursive: true, force: true });
  return { ffmpeg, ffprobe, ytdlp };
}

async function makeExecutable(file: string): Promise<void> {
  if (process.platform !== "win32") {
    const { chmod } = await import("node:fs/promises");
    await chmod(file, 0o755);
  }
}

function noticeText(kind: string, artifact: ArtifactSpec): string {
  return [
    `Urma v1 bundled ${kind} notice`,
    `provider: ${artifact.provider}`,
    `version: ${artifact.upstreamVersion}`,
    `release: ${artifact.upstreamRelease}`,
    `license: ${artifact.licensing.license}`,
    `build: ${artifact.licensing.buildConfiguration}`,
    "notice and license references:",
    ...artifact.licensing.noticeUrls.map((url) => `- ${url}`),
    kind === "ytdlp"
      ? "The complete official standalone distribution, including its bundled third-party notices, is retained under tools/yt-dlp."
      : "The complete upstream distribution is retained under tools/ffmpeg; do not remove its accompanying files.",
    "",
  ].join("\n");
}

async function writeGenerationLicenses(stage: string, manifest: TargetReleaseManifest): Promise<void> {
  const directory = path.join(stage, "licenses");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const artifacts = [
    ["ffmpeg", manifest.ffmpeg],
    ["ffprobe", manifest.ffprobe],
    ["yt-dlp", manifest.ytdlp],
  ] as const;
  for (const [name, artifact] of artifacts) {
    await writeFile(path.join(directory, `${name}.txt`), noticeText(name, artifact), { encoding: "utf8", mode: 0o600, flag: "wx" });
  }
  const references = new Set<string>([...manifest.licensing.notices]);
  for (const artifact of [manifest.ffmpeg, manifest.ffprobe, manifest.ytdlp]) {
    for (const url of artifact.licensing.noticeUrls) references.add(url);
  }
  await writeFile(
    path.join(directory, "THIRD-PARTY-NOTICES.txt"),
    [
      "Urma v1 third-party distribution notices",
      "",
      "This generation contains complete upstream distributions under tools/.",
      "The per-component records below preserve provider, release, license, build, and notice identity.",
      "",
      ...artifacts.map(([name]) => `licenses/${name}.txt`),
      "",
      "Additional reference URLs:",
      ...[...references].map((url) => `- ${url}`),
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
}

async function probeToolVersions(config: ReturnType<typeof loadConfig>): Promise<Readonly<{ ffmpegVersion: string; ffprobeVersion: string; ytdlpVersion: string }>> {
  const versions = await collectBinaryVersions(config, ["ffmpeg", "ffprobe", "ytdlp"]);
  if (!versions.ffmpegVersion || !versions.ffprobeVersion || !versions.ytdlpVersion) throw new UrmaError("REQUIRED_BINARY_UNSUPPORTED", "A pinned native tool did not return a usable version during setup qualification");
  return { ffmpegVersion: versions.ffmpegVersion, ffprobeVersion: versions.ffprobeVersion, ytdlpVersion: versions.ytdlpVersion };
}

async function copyLauncher(packageRoot: string, paths: DistributionPaths): Promise<void> {
  const source = path.join(packageRoot, "launcher-v1.mjs");
  const next = path.join(paths.root, "launcher-v1.mjs.next");
  await rm(next, { force: true });
  await copyFile(source, next);
  await renameLauncher(next, paths.launcher);
}

async function renameLauncher(next: string, destination: string): Promise<void> {
  const { rename } = await import("node:fs/promises");
  await rename(next, destination);
}

async function finalLocationLaunchCheck(
  nodeExecutable: string,
  generationDir: string,
  entry: string,
): Promise<void> {
  const result = await runChecked(nodeExecutable, [entry, "--version"], {
    cwd: generationDir,
    timeoutMs: 30_000,
    maxStdoutBytes: 128 * 1024,
    maxStderrBytes: 128 * 1024,
    label: "final-location-launch-check",
  });
  if (result.stdout.toString("utf8").trim() !== URMA_VERSION) throw new UrmaError("SETUP_FAILED", "The staged Urma runtime did not return its expected version from the final location");
}

function receiptFor(
  stage: string,
  installId: string,
  target: TargetPlatform,
  manifest: TargetReleaseManifest,
  runtime: CopiedRuntime,
  nodeExecutable: string,
  nodeHash: string | undefined,
  toolPaths: Readonly<{ ffmpeg: string; ffprobe: string; ytdlp: string }>,
  toolVersions: Readonly<{ ffmpegVersion: string; ffprobeVersion: string; ytdlpVersion: string }>,
  binaryHashes: Readonly<{ ffmpeg: string; ffprobe: string; ytdlp: string }>,
  qualification: QualificationResult,
): InstallationReceipt {
  const relative = (file: string) => path.relative(stage, file).replaceAll(path.sep, "/");
  const binary = (artifact: ArtifactSpec, file: string, version: string) => ({
    provider: artifact.provider,
    version,
    release: artifact.upstreamRelease,
    archiveSha256: artifact.archiveSha256,
    binarySha256: binaryHashes[artifact.kind],
    relativePath: relative(file),
    buildConfiguration: artifact.kind === "ffmpeg"
      ? qualification.ffmpegBuildConfiguration ?? artifact.licensing.buildConfiguration
      : artifact.kind === "ffprobe"
      ? qualification.ffprobeBuildConfiguration ?? artifact.licensing.buildConfiguration
      : artifact.licensing.buildConfiguration,
  });
  return {
    schema: 1,
    installId,
    target,
    createdAt: new Date().toISOString(),
    urma: { version: URMA_VERSION, payloadSha256: runtime.payloadSha256 },
    manifest: { identity: manifestIdentity(manifest), target },
    node: {
      execPath: nodeExecutable,
      version: process.versions.node,
      executionArchitecture: `${process.platform}-${process.arch}`,
      ...(nodeHash === undefined ? {} : { sha256: nodeHash }),
    },
    tools: {
      ffmpeg: binary(manifest.ffmpeg, toolPaths.ffmpeg, toolVersions.ffmpegVersion),
      ffprobe: binary(manifest.ffprobe, toolPaths.ffprobe, toolVersions.ffprobeVersion),
      ytdlp: binary(manifest.ytdlp, toolPaths.ytdlp, toolVersions.ytdlpVersion),
    },
    policy: { invocationProfileVersion: manifest.ytdlpProfile.version, flags: manifest.ytdlpProfile.flags },
    runtime: { entry: relative(runtime.entry), stateSchemaVersion: SCHEMA_VERSION },
    qualification: {
      status: "passed",
      fixtureVersion: qualification.fixtureVersion,
      checks: [...qualification.checks],
    },
    notices: [
      "licenses/THIRD-PARTY-NOTICES.txt",
      ...new Set([
        ...manifest.licensing.notices,
        ...manifest.ffmpeg.licensing.noticeUrls,
        ...manifest.ffprobe.licensing.noticeUrls,
        ...manifest.ytdlp.licensing.noticeUrls,
      ]),
    ],
  };
}

function hostFailure(error: unknown): HostRegistrationResult {
  return { requested: true, status: "failure", detail: errorMessage(error) };
}

export async function setup(options: SetupOptions = {}): Promise<SetupResult> {
  const nodeExecutable = path.resolve(options.nodeExecutable ?? process.execPath);
  if (!path.isAbsolute(nodeExecutable) || nodeExecutable.includes("\0")) throw new UrmaError("SETUP_FAILED", "Setup requires an absolute existing Node executable");
  let nodeInfo;
  try {
    // The external Node installation may be exposed through a user-owned
    // symlink (common with version managers); validate the resolved target
    // while retaining process.execPath in the receipt and host config.
    nodeInfo = await stat(nodeExecutable);
  } catch (error) {
    throw new UrmaError("SETUP_FAILED", `Node executable ${nodeExecutable} does not exist; rerun setup with supported Node 24`, { cause: error });
  }
  if (!nodeInfo.isFile()) throw new UrmaError("SETUP_FAILED", `Node executable ${nodeExecutable} is not a regular file`);
  if (!nodeVersionIsSupported(process.versions.node, SUPPORTED_NODE_RANGE)) throw new UrmaError("REQUIRED_BINARY_UNSUPPORTED", `Urma setup requires Node 24 LTS (${SUPPORTED_NODE_RANGE}); current Node is ${process.versions.node}`);
  const detected = detectTargetPlatform();
  if (options.target !== undefined && options.target !== detected) throw new UrmaError("UNSUPPORTED_PLATFORM", `Requested target ${options.target} does not match the native executing Node target ${detected}`);
  const target = options.target ?? detected;
  const manifest = options.manifest ?? getReleaseManifest(target);
  validateReleaseManifest(manifest);
  if (manifest.target !== target) throw new UrmaError("SETUP_FAILED", "Release manifest target does not match executing platform");
  const root = await assertUserOwnedDataRoot(options.dataRoot ?? chooseDataRoot());
  const paths = distributionPaths(root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lock = await acquireInstallationLock(paths);
  let stage: string | undefined;
  let published: string | undefined;
  let committed = false;
  try {
    await ensureDistributionLayout(paths);
    await preflightDisk(root, options.minimumFreeBytes ?? DEFAULT_MIN_FREE_BYTES);
    let current: ActiveSelection | null = null;
    let selectorCorrupt = false;
    try {
      current = await readActive(paths);
    } catch (error) {
      if (errorCode(error) !== "INSTALLATION_CORRUPT") throw error;
      // A healthy new generation can repair a malformed selector. The old
      // bytes remain untouched until the final atomic selector commit.
      selectorCorrupt = true;
      current = null;
    }
    const installId = validateInstallId(`install-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
    stage = stagingPath(paths, installId);
    await mkdir(stage, { recursive: false, mode: 0o700 });
    const runtime = await copyNpmRuntime(stage);
    await phase(options, "runtime-copied");
    const toolPaths = await materializeTools(stage, manifest, options);
    await phase(options, "artifacts-acquired");
    await Promise.all([makeExecutable(toolPaths.ffmpeg), makeExecutable(toolPaths.ffprobe), makeExecutable(toolPaths.ytdlp)]);
    await writeGenerationLicenses(stage, manifest);
    const qualificationContext: QualificationContext = {
      root,
      installationId: installId,
      generationDir: stage,
      ffmpeg: toolPaths.ffmpeg,
      ffprobe: toolPaths.ffprobe,
      ytdlp: toolPaths.ytdlp,
      nodeExecutable,
      manifest,
    };
    const qualification = await (options.qualifyNative ?? qualifyNativeTools)(qualificationContext);
    await phase(options, "native-qualified");
    const runtimeConfig = loadConfig({
      URMA_DATA_DIR: root,
      URMA_FFMPEG: toolPaths.ffmpeg,
      URMA_FFPROBE: toolPaths.ffprobe,
      URMA_YTDLP: toolPaths.ytdlp,
    });
    const toolVersions = await (options.probeVersions ?? probeToolVersions)(runtimeConfig);
    const nodeHash = await hashNodeExecutable(nodeExecutable);
    const [ffmpegHash, ffprobeHash, ytdlpHash] = await Promise.all([sha256File(toolPaths.ffmpeg), sha256File(toolPaths.ffprobe), sha256File(toolPaths.ytdlp)]);
    let receipt = receiptFor(stage, installId, target, manifest, runtime, nodeExecutable, nodeHash, toolPaths, toolVersions, { ffmpeg: ffmpegHash, ffprobe: ffprobeHash, ytdlp: ytdlpHash }, qualification);
    const receiptFile = path.join(stage, "receipt.json");
    await writeReceipt(receiptFile, receipt);
    await phase(options, "receipt-written");
    const mcpChecks = await (options.mcpSmoke ?? persistedRuntimeMcpSmoke)(qualificationContext, {
      ffmpeg: receipt.tools.ffmpeg.binarySha256,
      ffprobe: receipt.tools.ffprobe.binarySha256,
      ytdlp: receipt.tools.ytdlp.binarySha256,
    });
    if (mcpChecks.length === 0) throw new UrmaError("REQUIRED_BINARY_UNSUPPORTED", "Persisted runtime MCP smoke test returned no checks");
    await rm(receiptFile, { force: true });
    receipt = {
      ...receipt,
      qualification: { ...receipt.qualification, checks: [...qualification.checks, ...mcpChecks] },
    };
    await writeReceipt(receiptFile, receipt);
    await phase(options, "mcp-qualified");
    const finalDir = installationPath(paths, installId);
    await (async () => {
      try {
        await stat(finalDir);
        throw new UrmaError("SETUP_FAILED", `Installation id collision at ${finalDir}`);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    })();
    await rename(stage, finalDir);
    published = finalDir;
    stage = undefined;
    await phase(options, "published");
    const finalEntry = path.join(finalDir, "runtime", "src", "cli", "main.js");
    await finalLocationLaunchCheck(nodeExecutable, finalDir, finalEntry);
    await phase(options, "final-launch-checked");
    await copyLauncher(runtime.packageRoot, paths);
    const selection = selectionForUpdate(current, installId);
    await commitActive(paths, selection, { preserveBackup: !selectorCorrupt });
    committed = true;
    await phase(options, "active-committed");
    let hostRegistration = notRequestedHostRegistration();
    if (options.client === "generic") {
      if (!options.clientConfig) hostRegistration = hostFailure(new UrmaError("HOST_REGISTRATION_FAILED", "--client generic requires --config <absolute-json-path>"));
      else {
        try {
          hostRegistration = await registerGenericMcpHost(options.clientConfig, nodeExecutable, paths.launcher, paths.root);
        } catch (error) {
          hostRegistration = hostFailure(error);
        }
      }
    }
    return {
      runtimeInstallation: "healthy",
      installId,
      target,
      generation: selection.generation,
      launcherPath: paths.launcher,
      nodeExecutable,
      hostRegistration,
    };
  } catch (error) {
    if (!committed && published !== undefined) await rm(published, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof UrmaError) throw error;
    throw new UrmaError("SETUP_FAILED", `Urma setup failed: ${errorMessage(error)}`, { cause: error });
  } finally {
    if (stage !== undefined) await rm(stage, { recursive: true, force: true }).catch(() => undefined);
    await lock.release();
  }
}
