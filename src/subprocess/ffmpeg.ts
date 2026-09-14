import { readFile, rm, stat } from "node:fs/promises";
import type { UrmaConfig } from "../config.js";
import { UrmaError } from "../core/errors.js";
import type { RemoteOperationContext } from "../remote/worker.js";
import { runChecked, type ProcessResult, type RunOptions } from "./runner.js";
import { remoteMediaInputArgs } from "./remote-media.js";
import { verifyRuntimeTool } from "../distribution/integrity.js";

export class Ffmpeg {
  constructor(
    readonly config: UrmaConfig,
    readonly remoteContext: RemoteOperationContext | null = null,
    readonly runner: (
      executable: string,
      args: readonly string[],
      options?: RunOptions,
    ) => Promise<ProcessResult> = runChecked,
  ) {}
  async version(signal?: AbortSignal): Promise<string> {
    await verifyRuntimeTool(this.config, "ffmpeg");
    const result = await this.runner(this.config.ffmpeg, ["-version"], {
      timeoutMs: 10_000,
      maxStdoutBytes: 256 * 1024,
      maxStderrBytes: 256 * 1024,
      signal,
      debug: this.config.debug,
      label: "ffmpeg",
      diagnosticRole: "binary-version",
    });
    return result.stdout.toString("utf8").split(/\r?\n/, 1)[0] ?? "unknown";
  }
  async extractJpeg(
    media: string,
    atMs: number,
    output: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await verifyRuntimeTool(this.config, "ffmpeg");
    await rm(output, { force: true });
    const remoteArgs = await remoteMediaInputArgs(media, this.remoteContext);
    await this.runner(
      this.config.ffmpeg,
      [
        ...remoteArgs,
        "-v",
        "error",
        "-ss",
        (atMs / 1000).toFixed(3),
        "-i",
        media,
        "-frames:v",
        "1",
        "-pix_fmt",
        "yuvj420p",
        "-q:v",
        "2",
        "-y",
        output,
      ],
      {
        timeoutMs: this.config.limits.mediaTimeoutMs,
        maxStdoutBytes: 512 * 1024,
        maxStderrBytes: this.config.limits.subprocessStderrBytes,
        signal,
        debug: this.config.debug,
        label: "ffmpeg",
        diagnosticRole: "ffmpeg-exact-frame",
      },
    );
    try {
      const info = await stat(output);
      if (!info.isFile() || info.size < 1) throw new Error("empty output");
    } catch (error) {
      if (error instanceof UrmaError) throw error;
      throw new UrmaError(
        "FRAME_EXTRACTION_FAILED",
        "ffmpeg completed without producing a JPEG frame; verify that the requested timestamp is present in the media",
        { retryable: true, cause: error },
      );
    }
  }
  async cropJpeg(
    image: string,
    crop: { width: number; height: number; x: number; y: number },
    output: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await verifyRuntimeTool(this.config, "ffmpeg");
    const remoteArgs = await remoteMediaInputArgs(image, this.remoteContext);
    await this.runner(
      this.config.ffmpeg,
      [
        ...remoteArgs,
        "-v",
        "error",
        "-i",
        image,
        "-vf",
        `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`,
        "-frames:v",
        "1",
        "-pix_fmt",
        "yuvj420p",
        "-q:v",
        "2",
        "-y",
        output,
      ],
      {
        timeoutMs: this.config.limits.mediaTimeoutMs,
        maxStdoutBytes: 512 * 1024,
        maxStderrBytes: this.config.limits.subprocessStderrBytes,
        signal,
        debug: this.config.debug,
        label: "ffmpeg",
        diagnosticRole: "ffmpeg-panel",
      },
    );
  }
  async validateJpeg(file: string): Promise<void> {
    let bytes: Buffer;
    try {
      bytes = await readFile(file);
    } catch (error) {
      if (
        error instanceof Error && "code" in error && error.code === "ENOENT"
      ) {
        throw new UrmaError(
          "FRAME_EXTRACTION_FAILED",
          "Expected JPEG output was not produced by ffmpeg; verify that the requested timestamp is present in the media",
          { retryable: true, cause: error },
        );
      }
      throw error;
    }
    if (
      bytes.length < 4 ||
      bytes[0] !== 0xff ||
      bytes[1] !== 0xd8 ||
      bytes.at(-2) !== 0xff ||
      bytes.at(-1) !== 0xd9
    ) {
      throw new UrmaError(
        "MEDIA_INVALID",
        `Extracted JPEG failed marker validation; retry acquisition from source media`,
      );
    }
  }
}
