import type { UrmaConfig } from "../config.js";
import { UrmaError } from "../core/errors.js";
import type { RemoteOperationContext } from "../remote/worker.js";
import { runChecked, type ProcessResult, type RunOptions } from "./runner.js";
import { remoteMediaInputArgs } from "./remote-media.js";
import { verifyRuntimeTool } from "../distribution/integrity.js";

export class Ffprobe {
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
    await verifyRuntimeTool(this.config, "ffprobe");
    const result = await this.runner(this.config.ffprobe, ["-version"], {
      timeoutMs: 10_000,
      maxStdoutBytes: 256 * 1024,
      maxStderrBytes: 256 * 1024,
      signal,
      debug: this.config.debug,
      label: "ffprobe",
      diagnosticRole: "binary-version",
    });
    return result.stdout.toString("utf8").split(/\r?\n/, 1)[0] ?? "unknown";
  }
  async inspect(
    media: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    await verifyRuntimeTool(this.config, "ffprobe");
    const remoteArgs = await remoteMediaInputArgs(media, this.remoteContext);
    const result = await this.runner(
      this.config.ffprobe,
      [
        ...remoteArgs,
        "-v",
        "error",
        "-show_format",
        "-show_streams",
        "-of",
        "json",
        media,
      ],
      {
        timeoutMs: this.config.limits.metadataTimeoutMs,
        maxStdoutBytes: this.config.limits.subprocessStdoutBytes,
        maxStderrBytes: this.config.limits.subprocessStderrBytes,
        signal,
        debug: this.config.debug,
        label: "ffprobe",
        diagnosticRole: "ffprobe-media-probe",
      },
    );
    try {
      const parsed = JSON.parse(result.stdout.toString("utf8")) as unknown;
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        throw new Error("not an object");
      }
      return parsed as Record<string, unknown>;
    } catch (error) {
      throw new UrmaError(
        "MEDIA_INVALID",
        `ffprobe returned invalid JSON for the requested media; verify the source is a supported video`,
        { cause: error },
      );
    }
  }
}
