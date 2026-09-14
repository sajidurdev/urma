import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { UrmaError } from "../core/errors.js";
import { hermeticYtDlpArgs } from "../subprocess/ytdlp.js";
import { runChecked, type ProcessResult } from "../subprocess/runner.js";
import type { TargetReleaseManifest } from "./manifest.js";

export type QualificationContext = Readonly<{
  root: string;
  installationId: string;
  generationDir: string;
  ffmpeg: string;
  ffprobe: string;
  ytdlp: string;
  nodeExecutable: string;
  manifest: TargetReleaseManifest;
  runner?: (
    executable: string,
    args: readonly string[],
    options?: Parameters<typeof runChecked>[2],
  ) => Promise<ProcessResult>;
}>;

export type QualificationResult = Readonly<{
  fixtureVersion: string;
  checks: readonly string[];
  ffmpegBuildConfiguration?: string;
  ffprobeBuildConfiguration?: string;
}>;

function command(
  context: QualificationContext,
  executable: string,
  args: readonly string[],
  timeoutMs = 60_000,
): Promise<ProcessResult> {
  return (context.runner ?? runChecked)(executable, args, {
    timeoutMs,
    maxStdoutBytes: 8 * 1024 * 1024,
    maxStderrBytes: 8 * 1024 * 1024,
    label: "installation-qualification",
  });
}

function parsedJson(result: ProcessResult, label: string): Record<string, unknown> {
  try {
    const value = JSON.parse(result.stdout.toString("utf8")) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object");
    return value as Record<string, unknown>;
  } catch (error) {
    throw new UrmaError("REQUIRED_BINARY_UNSUPPORTED", `${label} did not return valid JSON during offline qualification`, { cause: error });
  }
}

function videoDimensions(value: Record<string, unknown>, label: string): { width: number; height: number } {
  const streams = Array.isArray(value.streams) ? value.streams : [];
  const stream = streams.find((item) => typeof item === "object" && item !== null && (item as Record<string, unknown>).codec_type === "video") as Record<string, unknown> | undefined;
  const width = stream?.width;
  const height = stream?.height;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || (width as number) < 1 || (height as number) < 1) throw new UrmaError("REQUIRED_BINARY_UNSUPPORTED", `${label} returned no valid video dimensions during offline qualification`);
  return { width: width as number, height: height as number };
}

async function assertFile(file: string, label: string): Promise<void> {
  const info = await stat(file);
  if (!info.isFile() || info.size < 4) throw new UrmaError("REQUIRED_BINARY_UNSUPPORTED", `${label} did not produce a non-empty file`);
}

function assertJpeg(bytes: Buffer, label: string): void {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) throw new UrmaError("REQUIRED_BINARY_UNSUPPORTED", `${label} is not a valid JPEG`);
}

export function parseFfmpegBuildConfiguration(result: ProcessResult, label: string): string {
  const lines = `${result.stdout.toString("utf8")}\n${result.stderr.toString("utf8")}`.split(/\r?\n/u);
  const start = lines.findIndex((line) => /^\s*configuration:\s*$/iu.test(line));
  if (start < 0) throw new UrmaError("REQUIRED_BINARY_UNSUPPORTED", `${label} did not expose an FFmpeg build configuration`);
  const end = lines.findIndex((line, index) => index > start && /^\s*Exiting with exit code\b/iu.test(line));
  const configuration = lines.slice(start, end < 0 ? lines.length : end).join("\n").trim();
  if (configuration.length === 0) throw new UrmaError("REQUIRED_BINARY_UNSUPPORTED", `${label} returned an empty FFmpeg build configuration`);
  if (/--enable-nonfree(?:[=\s]|$)/imu.test(configuration)) throw new UrmaError("REQUIRED_BINARY_UNSUPPORTED", `${label} uses --enable-nonfree; Urma only accepts redistributable nonfree-disabled FFmpeg builds`);
  return configuration;
}

export async function qualifyNativeTools(context: QualificationContext): Promise<QualificationResult> {
  const fixtureRoot = path.join(context.generationDir, "qualification-fixture");
  await mkdir(fixtureRoot, { recursive: true, mode: 0o700 });
  const video = path.join(fixtureRoot, "fixture.nut");
  const jpeg = path.join(fixtureRoot, "frame.jpg");
  const cropped = path.join(fixtureRoot, "crop.jpg");
  const checks: string[] = [];
  try {
    await command(context, context.ffmpeg, [
      "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=160x90:d=1:r=24",
      "-c:v", "mpeg4", "-q:v", "5", "-f", "nut", "-y", video,
    ]);
    await assertFile(video, "FFmpeg fixture");
    checks.push("generated-local-fixture");

    const inspected = parsedJson(await command(context, context.ffprobe, [
      "-v", "error", "-show_format", "-show_streams", "-of", "json", video,
    ]), "ffprobe");
    const dimensions = videoDimensions(inspected, "ffprobe fixture inspection");
    if (dimensions.width !== 160 || dimensions.height !== 90) throw new UrmaError("REQUIRED_BINARY_UNSUPPORTED", `ffprobe reported ${String(dimensions.width)}x${String(dimensions.height)}, expected 160x90`);
    checks.push("ffprobe-container-and-stream-inspection");

    await command(context, context.ffmpeg, [
      "-v", "error", "-ss", "0.250", "-i", video,
      "-frames:v", "1", "-vf", "scale=160:90", "-pix_fmt", "yuvj420p", "-q:v", "2", "-f", "image2", "-y", jpeg,
    ]);
    await assertFile(jpeg, "FFmpeg JPEG seek/decode");
    assertJpeg(await readFile(jpeg), "FFmpeg JPEG seek/decode");
    const jpegInfo = videoDimensions(parsedJson(await command(context, context.ffprobe, ["-v", "error", "-show_streams", "-of", "json", jpeg]), "ffprobe JPEG inspection"), "ffprobe JPEG inspection");
    if (jpegInfo.width !== 160 || jpegInfo.height !== 90) throw new UrmaError("REQUIRED_BINARY_UNSUPPORTED", "FFmpeg JPEG dimensions did not survive qualification");
    checks.push("ffmpeg-seek-decode-jpeg");

    await command(context, context.ffmpeg, [
      "-v", "error", "-i", jpeg,
      "-vf", "scale=120:90,crop=80:60:0:0,tile=1x1",
      "-frames:v", "1", "-pix_fmt", "yuvj420p", "-q:v", "2", "-f", "image2", "-y", cropped,
    ]);
    await assertFile(cropped, "FFmpeg scale/crop/tile operation");
    assertJpeg(await readFile(cropped), "FFmpeg scale/crop/tile operation");
    const cropInfo = videoDimensions(parsedJson(await command(context, context.ffprobe, ["-v", "error", "-show_streams", "-of", "json", cropped]), "ffprobe cropped JPEG inspection"), "ffprobe cropped JPEG inspection");
    if (cropInfo.width !== 80 || cropInfo.height !== 60) throw new UrmaError("REQUIRED_BINARY_UNSUPPORTED", `FFmpeg crop output was ${String(cropInfo.width)}x${String(cropInfo.height)}, expected 80x60`);
    checks.push("ffmpeg-scale-crop-tile");

    const timing = parsedJson(await command(context, context.ffprobe, ["-v", "error", "-read_intervals", "%+#2", "-show_frames", "-of", "json", video]), "ffprobe timing inspection");
    if (!Array.isArray(timing.frames) || timing.frames.length < 1) throw new UrmaError("REQUIRED_BINARY_UNSUPPORTED", "ffprobe returned no decoded timing frames");
    checks.push("ffprobe-seek-and-timing");

    const ffmpegBuildConfiguration = parseFfmpegBuildConfiguration(
      await command(context, context.ffmpeg, ["-hide_banner", "-buildconf"], 30_000),
      "ffmpeg",
    );
    checks.push("ffmpeg-build-configuration-redistributable");
    const ffprobeBuildConfiguration = parseFfmpegBuildConfiguration(
      await command(context, context.ffprobe, ["-hide_banner", "-buildconf"], 30_000),
      "ffprobe",
    );
    checks.push("ffprobe-build-configuration-redistributable");

    const helpArgs = hermeticYtDlpArgs(
      ["--help"],
      context.nodeExecutable,
      undefined,
      ["--ffmpeg-location", path.dirname(context.ffmpeg)],
    );
    const help = await command(context, context.ytdlp, helpArgs, 30_000);
    const helpText = `${help.stdout.toString("utf8")}\n${help.stderr.toString("utf8")}`;
    for (const flag of ["--js-runtimes", "--no-config-locations", "--no-plugin-dirs", "--no-remote-components", "--ffmpeg-location"]) {
      if (!helpText.includes(flag)) throw new UrmaError("REQUIRED_BINARY_UNSUPPORTED", `yt-dlp does not advertise required hermetic flag ${flag}`);
    }
    for (const flag of context.manifest.ytdlpProfile.flags) {
      if (!helpText.includes(flag)) throw new UrmaError("REQUIRED_BINARY_UNSUPPORTED", `yt-dlp ${context.manifest.ytdlpProfile.version} does not advertise pinned invocation flag ${flag}`);
    }
    for (const flag of context.manifest.ytdlpProfile.unsupportedFlags) {
      if (helpText.includes(flag)) throw new UrmaError("REQUIRED_BINARY_UNSUPPORTED", `yt-dlp ${context.manifest.ytdlpProfile.version} unexpectedly advertises a flag marked unsupported: ${flag}`);
    }
    checks.push("ytdlp-hermetic-cli-profile");
    await command(context, context.ytdlp, hermeticYtDlpArgs(["--version"], context.nodeExecutable, undefined, ["--ffmpeg-location", path.dirname(context.ffmpeg)]), 30_000);
    checks.push("ytdlp-standalone-start-and-node-runtime");
    return { fixtureVersion: "v1-video-evidence-fixture-1", checks, ffmpegBuildConfiguration, ffprobeBuildConfiguration };
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

type JsonMessage = Record<string, unknown>;

function spawnEnvironment(
  context: QualificationContext,
  dataDir: string,
  localRoot: string,
  hashes: Readonly<{ ffmpeg: string; ffprobe: string; ytdlp: string }>,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    URMA_DATA_DIR: dataDir,
    URMA_LOCAL_ROOTS: localRoot,
    URMA_RUNTIME_ROOT_V1: context.root,
    URMA_RUNTIME_GENERATION_V1: context.installationId,
    URMA_RUNTIME_GENERATION_DIR_V1: context.generationDir,
    URMA_RUNTIME_DATA_DIR_V1: dataDir,
    URMA_RUNTIME_NODE_V1: context.nodeExecutable,
    URMA_RUNTIME_FFMPEG_V1: context.ffmpeg,
    URMA_RUNTIME_FFPROBE_V1: context.ffprobe,
    URMA_RUNTIME_YTDLP_V1: context.ytdlp,
    URMA_RUNTIME_FFMPEG_HASH_V1: hashes.ffmpeg,
    URMA_RUNTIME_FFPROBE_HASH_V1: hashes.ffprobe,
    URMA_RUNTIME_YTDLP_HASH_V1: hashes.ytdlp,
  };
}

async function mcpExchange(
  child: ChildProcessWithoutNullStreams,
  messages: JsonMessage[],
  id: number,
  message: JsonMessage,
): Promise<JsonMessage> {
  const existing = messages.find((item) => item.id === id);
  if (existing) return existing;
  return await new Promise<JsonMessage>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new UrmaError("REQUIRED_BINARY_UNSUPPORTED", `Persisted runtime MCP smoke test timed out waiting for response ${String(id)}`));
    }, 30_000);
    timer.unref();
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as JsonMessage;
          messages.push(parsed);
          if (parsed.id === id) {
            cleanup();
            resolve(parsed);
            return;
          }
        } catch (error) {
          cleanup();
          reject(new UrmaError("REQUIRED_BINARY_UNSUPPORTED", "Persisted runtime wrote non-JSON MCP output during smoke test", { cause: error }));
          return;
        }
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(new UrmaError("REQUIRED_BINARY_UNSUPPORTED", "Persisted runtime MCP smoke process failed", { cause: error }));
    };
    const onClose = () => {
      cleanup();
      reject(new UrmaError("REQUIRED_BINARY_UNSUPPORTED", "Persisted runtime MCP smoke process exited before its response", {
        detail: { responseId: id },
      }));
    };
    let buffer = "";
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("error", onError);
      child.off("close", onClose);
    };
    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("close", onClose);
    child.stdin.write(`${JSON.stringify(message)}\n`);
  });
}

export async function persistedRuntimeMcpSmoke(
  context: QualificationContext,
  hashes: Readonly<{ ffmpeg: string; ffprobe: string; ytdlp: string }>,
): Promise<readonly string[]> {
  const smokeRoot = path.join(context.generationDir, "mcp-smoke");
  await mkdir(smokeRoot, { recursive: true, mode: 0o700 });
  const fixture = path.join(smokeRoot, "local-fixture.nut");
  const dataDir = path.join(smokeRoot, "data");
  const child = spawn(context.nodeExecutable, [path.join(context.generationDir, "runtime", "src", "cli", "main.js")], {
    cwd: context.generationDir,
    env: spawnEnvironment(context, dataDir, smokeRoot, hashes),
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages: JsonMessage[] = [];
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  try {
    await command(context, context.ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=160x90:d=1:r=24", "-c:v", "mpeg4", "-q:v", "5", "-f", "nut", "-y", fixture]);
    const initialized = await mcpExchange(child, messages, 1, {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "urma-installer-smoke", version: "1.0.0" } },
    });
    if (initialized.error !== undefined) throw new UrmaError("REQUIRED_BINARY_UNSUPPORTED", "Persisted runtime MCP initialize returned an error");
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
    const listed = await mcpExchange(child, messages, 2, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const tools = (listed.result as { tools?: unknown } | undefined)?.tools;
    if (!Array.isArray(tools) || !tools.some((item) => typeof item === "object" && item !== null && (item as Record<string, unknown>).name === "inspect_video")) throw new UrmaError("REQUIRED_BINARY_UNSUPPORTED", "Persisted runtime MCP tools/list did not expose inspect_video");
    const local = await mcpExchange(child, messages, 3, {
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "inspect_video", arguments: { source: fixture, freshness: "refresh" } },
    });
    if (local.error !== undefined || (local.result as { isError?: unknown } | undefined)?.isError === true) throw new UrmaError("REQUIRED_BINARY_UNSUPPORTED", `Persisted runtime local inspect_video operation failed${stderr ? `: ${stderr.slice(-500)}` : ""}`);
    return ["persisted-runtime-mcp-initialize", "persisted-runtime-tools-list", "persisted-runtime-local-inspect"];
  } catch (error) {
    if (error instanceof UrmaError) throw error;
    throw new UrmaError("REQUIRED_BINARY_UNSUPPORTED", "Persisted runtime MCP smoke test failed", { cause: error });
  } finally {
    if (child.exitCode === null) child.kill();
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once("close", () => resolve());
    });
    await rm(smokeRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}
