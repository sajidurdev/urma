import { readFile, rm, stat } from "node:fs/promises";
import type { UrmaConfig } from "../config.js";
import { UrmaError } from "../core/errors.js";
import { frameCropGeometry, validateFrameCrop, type FrameCrop, type FrameCropGeometry } from "../core/frame-crop.js";
import type { RemoteOperationContext } from "../remote/operation-context.js";
import { runChecked, type ProcessResult, type RunOptions } from "./runner.js";
import { subprocessMediaInput } from "./remote-media.js";
import { verifyRuntimeTool } from "../distribution/integrity.js";
import type { AnalysisDimensions } from "../core/visual-delta.js";

export type RgbFrame = Readonly<{ rgb: Buffer; presentationTimeMs: number; keyframe: boolean; sceneScore: number }>;

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
    crop?: FrameCrop,
  ): Promise<FrameCropGeometry | void> {
    if (crop) crop = validateFrameCrop(crop);
    await verifyRuntimeTool(this.config, "ffmpeg");
    await rm(output, { force: true });
    const mediaInput = await subprocessMediaInput(media, this.remoteContext);
    const result = await this.runner(
      this.config.ffmpeg,
      [
        ...mediaInput.args,
        "-v",
        crop ? "info" : "error",
        "-ss",
        (atMs / 1000).toFixed(9),
        "-i",
        mediaInput.input,
        ...(crop ? [
          "-map", "0:v:0",
          "-vf",
          // Autorotation precedes this graph. Correct SAR before interpreting percentages.
          "setsar='if(gt(sar,0),sar,1)':max=2147483647,scale=w='if(lte(iw*max(sar,1),32768)*lte(ih*max(1/sar,1),32768)*lte(iw*ih*max(sar,1/sar),67108864),max(1,round(iw*max(sar,1))),nan)':h='max(1,round(ih*max(1/sar,1)))',setsar=1,showinfo,format=yuv444p," +
          `crop=w='max(1,min(iw,ceil(iw*${crop.x + crop.w}/100))-min(iw-1,floor(iw*${crop.x}/100)))':` +
          `h='max(1,min(ih,ceil(ih*${crop.y + crop.h}/100))-min(ih-1,floor(ih*${crop.y}/100)))':` +
          `x='min(iw-1,floor(iw*${crop.x}/100))':y='min(ih-1,floor(ih*${crop.y}/100))':exact=1`,
        ] : []),
        "-frames:v",
        "1",
        "-pix_fmt",
        crop ? "yuvj444p" : "yuvj420p",
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
        inputFile: mediaInput.inputFile,
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
    if (crop) {
      const size = /\[Parsed_showinfo_[^\]]+\].*?\bn:\s*0\b.*?\bs:(\d+)x(\d+)\b/u.exec(result.stderr.toString("utf8"));
      if (!size) {
        throw new UrmaError("MEDIA_INVALID", "Crop extraction omitted displayed-source geometry; retry from validated source media");
      }
      return frameCropGeometry(crop, Number(size[1]), Number(size[2]));
    }
  }
  /** Bounded RGB24 output, with PTS retained relative to this input's container origin. */
  async rgbFrames(
    media: string,
    dimensions: AnalysisDimensions,
    options: Readonly<{ seekMs: number; endMs: number; maxFrames: number; keyframes?: boolean; scene?: boolean; sceneThreshold?: number; timeoutMs: number }>,
    signal?: AbortSignal,
  ): Promise<RgbFrame[]> {
    const { width, height } = dimensions;
    if (!Number.isSafeInteger(options.maxFrames) || options.maxFrames < 1 || options.maxFrames > 240 ||
      ![width, height].every((value) => Number.isSafeInteger(value) && value >= 4 && value % 4 === 0) || width > 256 || height > 144 ||
      !Number.isFinite(options.seekMs) || options.seekMs < 0 || !Number.isFinite(options.endMs) || options.endMs <= options.seekMs ||
      !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 15_000 ||
      (options.sceneThreshold !== undefined && (!Number.isFinite(options.sceneThreshold) || options.sceneThreshold <= 0 || options.sceneThreshold > 100))) {
      throw new UrmaError("INVALID_SOURCE", "RGB analysis requires a 4px grid within 256x144, 1-240 frames, ordered finite seek bounds and a 1-15000 ms timeout");
    }
    await verifyRuntimeTool(this.config, "ffmpeg");
    const mediaInput = await subprocessMediaInput(media, this.remoteContext);
    const frameBytes = width * height * 3;
    const result = await this.runner(this.config.ffmpeg, [
      ...mediaInput.args, "-v", "info", "-copyts", "-start_at_zero",
      "-max_alloc", "67108864",
      "-threads", "1", "-filter_threads", "1", "-max_pixels", "8388608",
      ...(options.keyframes ? ["-skip_frame", "nokey"] : []),
      ...(options.seekMs > 0 ? ["-ss", (options.seekMs / 1000).toFixed(9)] : []),
      "-i", mediaInput.input, "-map", "0:v:0", "-an", "-sn", "-dn",
      "-to", (options.endMs / 1000).toFixed(9),
      "-vf", `scale=${width}:${height}:flags=area,setsar=1,format=rgb24,${options.scene ? `scdet=threshold=${options.sceneThreshold ?? 10},metadata=mode=print:key=lavfi.scd.score,` : ""}showinfo`,
      "-frames:v", String(options.maxFrames), "-fps_mode", "passthrough",
      "-threads", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
    ], {
      timeoutMs: options.timeoutMs, signal, inputFile: mediaInput.inputFile,
      maxStdoutBytes: frameBytes * options.maxFrames,
      maxStderrBytes: Math.min(this.config.limits.subprocessStderrBytes, 512 * 1024),
      debug: this.config.debug, label: "ffmpeg", diagnosticRole: "ffmpeg-visual-analysis",
    });
    const stderr = result.stderr.toString("utf8");
    const timebase = /^\[Parsed_showinfo_[^\]]+\] config in time_base:\s*(\d+)\/(\d+)/mu.exec(stderr);
    const records = [...stderr.matchAll(/^\[Parsed_showinfo_[^\]]+\].*?\bn:\s*(\d+)\s+pts:\s*(-?\d+)\s+pts_time:[^\r\n]*?\bs:(\d+)x(\d+).*?\biskey:(\d+)/gmu)];
    const count = result.stdout.length / frameBytes;
    if (!Number.isInteger(count) || count > options.maxFrames ||
      (count > 0 && (!timebase || ![Number(timebase[1]), Number(timebase[2])].every((value) => Number.isSafeInteger(value) && value > 0) || records.length < count))) {
      throw new UrmaError("MEDIA_INVALID", "RGB output did not match its frame geometry or measured timestamp records");
    }
    const scores = [...stderr.matchAll(/^\[Parsed_metadata_[^\]]+\] lavfi\.scd\.score=([0-9.]+)/gmu)].map((match) => Number(match[1]));
    return Array.from({ length: count }, (_, index) => {
      const record = records[index]!;
      const presentationTimeMs = Number(record[2]) * Number(timebase![1]) * 1000 / Number(timebase![2]);
      if (Number(record[1]) !== index || !Number.isSafeInteger(Number(record[2])) || Number(record[3]) !== width || Number(record[4]) !== height ||
        !Number.isFinite(presentationTimeMs) || Math.abs(presentationTimeMs) > Number.MAX_SAFE_INTEGER ||
        (options.scene && (!Number.isFinite(scores[index]) || scores[index]! < 0 || scores[index]! > 100))) {
        throw new UrmaError("MEDIA_INVALID", "RGB frame timestamps, scene scores or display geometry changed during analysis");
      }
      return { rgb: result.stdout.subarray(index * frameBytes, (index + 1) * frameBytes),
        presentationTimeMs, keyframe: record[5] === "1", sceneScore: scores[index] ?? 0 };
    });
  }

  async textSubtitles(media: string, streamIndex: number, signal?: AbortSignal): Promise<Buffer> {
    if (!Number.isSafeInteger(streamIndex) || streamIndex < 0) throw new UrmaError("INVALID_SOURCE", "Embedded subtitle stream index must be a nonnegative safe integer");
    if (signal?.aborted) throw new UrmaError("CANCELLED", "Embedded subtitle extraction was cancelled");
    await verifyRuntimeTool(this.config, "ffmpeg");
    const input = await subprocessMediaInput(media, null);
    const result = await this.runner(this.config.ffmpeg, [
      ...input.args, "-v", "error", "-copyts", "-start_at_zero", "-max_alloc", "67108864", "-threads", "1",
      "-i", input.input, "-map", `0:${streamIndex}`, "-an", "-vn", "-dn", "-c:s", "webvtt", "-f", "webvtt", "pipe:1",
    ], { signal, inputFile: input.inputFile, timeoutMs: Math.min(15_000, this.config.limits.mediaTimeoutMs),
      maxStdoutBytes: this.config.limits.resourceBytes, maxStderrBytes: this.config.limits.subprocessStderrBytes,
      debug: this.config.debug, label: "ffmpeg", diagnosticRole: "ffmpeg-embedded-subtitles" });
    return result.stdout;
  }

  async cropJpeg(
    image: string,
    crop: { width: number; height: number; x: number; y: number },
    output: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await verifyRuntimeTool(this.config, "ffmpeg");
    const mediaInput = await subprocessMediaInput(image, this.remoteContext);
    await this.runner(
      this.config.ffmpeg,
      [
        ...mediaInput.args,
        "-v",
        "error",
        "-i",
        mediaInput.input,
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
        inputFile: mediaInput.inputFile,
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
