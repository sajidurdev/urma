import type { UrmaConfig } from "../config.js";
import { runChecked } from "./runner.js";
import { verifyRuntimeTool, type RuntimeToolKind } from "../distribution/integrity.js";

export type BinaryVersions = Readonly<{
  ffmpegVersion: string | null;
  ffprobeVersion: string | null;
  ytdlpVersion: string | null;
}>;

const successful = new Map<string, Promise<string>>();

async function cachedVersion(
  config: UrmaConfig,
  executable: string,
  args: readonly string[],
  signal?: AbortSignal,
  debug = false,
  label = "subprocess",
  kind?: RuntimeToolKind,
): Promise<string | null> {
  const key = JSON.stringify([executable, ...args]);
  let pending = successful.get(key);
  if (!pending) {
    pending = (kind === undefined ? Promise.resolve() : verifyRuntimeTool(config, kind)).then(() => runChecked(executable, args, {
      timeoutMs: 10_000,
      maxStdoutBytes: 256 * 1024,
      maxStderrBytes: 256 * 1024,
      signal,
      debug,
      label,
    })).then(
      (result) =>
        result.stdout.toString("utf8").split(/\r?\n/, 1)[0]?.trim() ||
        "unknown",
    );
    successful.set(key, pending);
  }
  try {
    return await pending;
  } catch {
    if (successful.get(key) === pending) successful.delete(key);
    return null;
  }
}

export async function collectBinaryVersions(
  config: UrmaConfig,
  needed: readonly ("ffmpeg" | "ffprobe" | "ytdlp")[],
  signal?: AbortSignal,
): Promise<BinaryVersions> {
  const selected = new Set(needed);
  const [ffmpegVersion, ffprobeVersion, ytdlpVersion] = await Promise.all([
    selected.has("ffmpeg")
      ? cachedVersion(
        config,
        config.ffmpeg,
        ["-version"],
        signal,
        config.debug,
        "ffmpeg",
        "ffmpeg",
      )
      : null,
    selected.has("ffprobe")
      ? cachedVersion(
        config,
        config.ffprobe,
        ["-version"],
        signal,
        config.debug,
        "ffprobe",
        "ffprobe",
      )
      : null,
    selected.has("ytdlp")
      ? cachedVersion(
        config,
        config.ytdlp,
        ["--version"],
        signal,
        config.debug,
        "yt-dlp",
        "ytdlp",
      )
      : null,
  ]);
  return { ffmpegVersion, ffprobeVersion, ytdlpVersion };
}

export function unknownBinaryVersions(): BinaryVersions {
  return { ffmpegVersion: null, ffprobeVersion: null, ytdlpVersion: null };
}
