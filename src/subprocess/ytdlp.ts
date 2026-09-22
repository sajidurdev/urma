import type { UrmaConfig } from "../config.js";
import { UrmaError } from "../core/errors.js";
import { stableJson, type CandidateKey, type RemoteIdentity } from "../core/ids.js";
import path from "node:path";
import { assertRemoteTargetAllowed } from "../remote/egress.js";
import { videoCodecForFormat } from "../remote/formats.js";
import { ensureRemoteProxy, type RemoteOperationContext } from "../remote/worker.js";
import type { RemoteAcquisitionLease } from "../remote/lease.js";
import { candidateKeyForFormat } from "../sources/candidates.js";
import type { FormatSummary, ResolvedSource } from "../sources/types.js";
import { remoteIdentityForResolution } from "../remote/normalize.js";
import { type ProcessResult, runChecked, type RunOptions } from "./runner.js";
import { verifyRuntimeTool } from "../distribution/integrity.js";

export type YtDlpRunner = (
  executable: string,
  args: readonly string[],
  options?: RunOptions,
) => Promise<ProcessResult>;

/** Keep raw metadata process-local; never persist or log it */
export type ExactFormatSnapshot = Readonly<{
  metadata: Readonly<Record<string, unknown>>;
  selected: Readonly<Record<string, unknown>>;
  candidateKey: CandidateKey;
  formatId: string;
}>;

export function nodeRuntimeArgs(
  nodeExecutable: string = process.execPath,
): readonly ["--js-runtimes", string] {
  if (
    !nodeExecutable ||
    nodeExecutable.includes("\0") ||
    !path.isAbsolute(nodeExecutable)
  ) {
    throw new TypeError(
      "The pinned Node.js executable path must be absolute, non-empty, and contain no null bytes",
    );
  }
  return ["--js-runtimes", `node:${nodeExecutable}`];
}

const CALLER_SECURITY_FLAGS = new Set([
  "--add-headers",
  "--config-locations",
  "--cookies",
  "--cookies-from-browser",
  "--cache-dir",
  "--downloader",
  "--downloader-args",
  "--exec",
  "--exec-before-download",
  "--external-downloader",
  "--external-downloader-args",
  "--ffmpeg-location",
  "--js-engine",
  "--js-runtimes",
  "--netrc-cmd",
  "--netrc-location",
  "--netrc",
  "--no-netrc",
  "--no-cache-dir",
  "--no-config-locations",
  "--no-cookies",
  "--no-cookies-from-browser",
  "--no-exec",
  "--no-js-runtimes",
  "--no-plugin-dirs",
  "--no-remote-components",
  "--no-check-certificates",
  "--plugin-dirs",
  "--prefer-insecure",
  "--proxy",
  "--postprocessor-args",
  "--remote-components",
  "--socket-timeout",
  "--retries",
  "--fragment-retries",
  "--extractor-retries",
  "--concurrent-fragments",
  "--dump-pages",
  "--write-pages",
  "--update",
  "--user-agent",
  "--referer",
]);

const GENERIC_CLOUDFLARE_CHALLENGE_SIGNATURES = [
  /\[generic\]/u,
  /\bHTTP Error 403\b/u,
  /Cloudflare anti-bot challenge/u,
  /try again with\s+--extractor-args\s+["']generic:impersonate["']/u,
] as const;

function isGenericCloudflareChallenge(error: unknown): boolean {
  return error instanceof UrmaError &&
    error.code === "SOURCE_UNAVAILABLE" &&
    GENERIC_CLOUDFLARE_CHALLENGE_SIGNATURES.every((signature) =>
      signature.test(error.message)
    );
}

/** Flags verified against pinned yt-dlp 2026.08.19 */
export function hermeticYtDlpArgs(
  args: readonly string[],
  nodeExecutable: string = process.execPath,
  proxyUrl?: string,
  internalArgs: readonly string[] = [],
): string[] {
  for (const argument of args) {
    const flag = argument.split("=", 1)[0] ?? argument;
    if (CALLER_SECURITY_FLAGS.has(flag)) {
      throw new UrmaError(
        "INVALID_SOURCE",
        `yt-dlp security option ${JSON.stringify(flag)} is controlled by Urma and cannot be supplied by an acquisition caller`,
      );
    }
  }
  const remoteArgs = proxyUrl === undefined
    ? []
    : [
      "--proxy",
      proxyUrl,
      "--downloader-args",
      `ffmpeg_i:-http_proxy ${proxyUrl} -protocol_whitelist http,https,tcp,tls,httpproxy`,
      "--postprocessor-args",
      `FFmpeg_i:-http_proxy ${proxyUrl} -protocol_whitelist http,https,tcp,tls,httpproxy`,
      "--postprocessor-args",
      `FFprobe_i:-http_proxy ${proxyUrl} -protocol_whitelist http,https,tcp,tls,httpproxy`,
    ];
  return [
    "--ignore-config",
    "--no-config-locations",
    "--no-plugin-dirs",
    "--no-cookies",
    "--no-cookies-from-browser",
    "--no-exec",
    "--no-cache-dir",
    "--no-remote-components",
    "--no-js-runtimes",
    ...nodeRuntimeArgs(nodeExecutable),
    "--no-playlist",
    "--default-search",
    "error",
    "--no-wait-for-video",
    "--no-mark-watched",
    "--no-update",
    "--socket-timeout",
    "10",
    "--retries",
    "1",
    "--fragment-retries",
    "1",
    "--extractor-retries",
    "1",
    "--concurrent-fragments",
    "1",
    ...remoteArgs,
    ...internalArgs,
    ...args,
  ];
}

export class YtDlp {
  constructor(
    readonly config: UrmaConfig,
    readonly runner: YtDlpRunner = runChecked,
    readonly remoteContext: RemoteOperationContext | null = null,
  ) {}
  async version(signal?: AbortSignal): Promise<string> {
    const result = await this.run(["--version"], {
      signal,
      timeoutMs: 10_000,
    });
    return result.stdout.toString("utf8").trim();
  }
  async metadata(
    url: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const metadataArgs = [
      "--dump-single-json",
      "--skip-download",
      "--no-warnings",
      url,
    ];
    const runMetadata = (internalArgs: readonly string[] = []) => this.run(
      metadataArgs,
      {
        signal,
        timeoutMs: this.config.limits.metadataTimeoutMs,
        remote: true,
        internalArgs,
      },
    );
    let result: ProcessResult;
    try {
      result = await runMetadata();
    } catch (error) {
      if (!isGenericCloudflareChallenge(error)) throw error;
      result = await runMetadata([
        "--extractor-args",
        "generic:impersonate",
      ]);
    }
    try {
      const parsed = JSON.parse(result.stdout.toString("utf8")) as unknown;
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        throw new Error("not an object");
      }
      const info = parsed as Record<string, unknown>;
      const resultType = typeof info._type === "string" ? info._type : null;
      const entries = info.entries;
      if (Array.isArray(entries) || (entries !== undefined && entries !== null)) {
        throw new UrmaError(
          "UNSUPPORTED_SOURCE",
          "yt-dlp resolved a multi-entry source; playlists, channels, searches, and collections are not supported",
        );
      }
      if (
        resultType !== null &&
        resultType !== "video"
      ) {
        throw new UrmaError(
          "UNSUPPORTED_SOURCE",
          `yt-dlp resolved result class ${JSON.stringify(resultType)}; only one finite video result is supported`,
        );
      }
      if (
        info.is_live === true ||
        info.live_status === "is_live" ||
        info.live_status === "is_upcoming" ||
        info.live_status === "post_live"
      ) {
        throw new UrmaError(
          "UNSUPPORTED_SOURCE",
          "Live and upcoming streams are not supported as immutable finite investigations",
        );
      }
      return info;
    } catch (error) {
      if (error instanceof UrmaError) throw error;
      throw new UrmaError(
        "METADATA_UNAVAILABLE",
        "yt-dlp returned malformed metadata JSON; update yt-dlp and retry",
        { retryable: true, cause: error },
      );
    }
  }

  /** Read one resolver-selected manifest for finite-timeline validation */
  async manifestText(
    url: string,
    signal?: AbortSignal,
  ): Promise<string> {
    assertRemoteTargetAllowed({ url, purpose: "manifest" });
    const result = await this.run(
      [
        "--skip-download",
        "--no-warnings",
        url,
      ],
      {
        signal,
        timeoutMs: this.config.limits.metadataTimeoutMs,
        remote: true,
        internalArgs: ["--dump-pages"],
      },
    );
    const output = result.stdout.toString("utf8");
    for (const line of output.split(/\r?\n/u)) {
      const candidate = line.trim();
      if (
        candidate.length < 8 ||
        candidate.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]+={0,2}$/u.test(candidate)
      ) continue;
      let decoded: string;
      try {
        decoded = Buffer.from(candidate, "base64").toString("utf8");
      } catch {
        continue;
      }
      const normalized = decoded.replace(/^\uFEFF/u, "").trimStart();
      if (
        normalized.startsWith("#EXTM3U") ||
        /^<\?xml\b/iu.test(normalized) ||
        /^<MPD\b/iu.test(normalized)
      ) {
        if (Buffer.byteLength(decoded, "utf8") > this.config.limits.maxNavigationCopyBytes) {
          throw new UrmaError(
            "SOURCE_UNAVAILABLE",
            "Remote manifest exceeded the bounded timeline-validation budget",
            { detail: { timelineValidation: "budget" } },
          );
        }
        return decoded;
      }
    }
    throw new UrmaError(
      "SOURCE_UNAVAILABLE",
      "yt-dlp did not return a typed finite-media manifest for timeline validation",
      { retryable: true, detail: { timelineValidation: "manifest-output" } },
    );
  }

  /** Re-resolve and verify one snapshot-bound format for this operation */
  async exactFormatSnapshot(
    source: Pick<ResolvedSource, "sourceRef" | "revision" | "canonicalLocator" | "identity">,
    format: FormatSummary,
    signal?: AbortSignal,
  ): Promise<ExactFormatSnapshot> {
    const info = await this.metadata(source.canonicalLocator, signal);
    let freshIdentity: RemoteIdentity;
    try {
      if (source.identity === null) {
        throw new TypeError("The pinned remote source has no logical identity");
      }
      freshIdentity = remoteIdentityForResolution(info, source.canonicalLocator);
    } catch (error) {
      throw new UrmaError(
        "SOURCE_UNAVAILABLE",
        "yt-dlp could not establish the pinned remote source identity; refresh is required",
        {
          retryable: true,
          detail: { refreshRequired: true, reason: "identity-unavailable" },
          cause: error,
        },
      );
    }
    if (stableJson(freshIdentity) !== stableJson(source.identity)) {
      throw new UrmaError(
        "SOURCE_UNAVAILABLE",
        "yt-dlp resolved a different logical remote source identity; refresh is required",
        {
          retryable: true,
          detail: { refreshRequired: true, reason: "identity-mismatch" },
        },
      );
    }
    const rawFormats = Array.isArray(info.formats)
      ? info.formats.filter((value): value is Record<string, unknown> =>
        typeof value === "object" && value !== null && !Array.isArray(value)
      )
      : [];
    const selected = rawFormats.find((value) =>
      String(value.format_id ?? "") === (format.formatId ?? format.id)
    );
    if (!selected) {
      throw new UrmaError(
        "SOURCE_UNAVAILABLE",
        `Snapshot candidate ${format.candidateKey ?? "unknown"} is no longer present in yt-dlp output; refresh is required`,
        { retryable: true, detail: { refreshRequired: true } },
      );
    }
    const selectedDeliveryUrl = typeof selected.url === "string"
      ? selected.url
      : typeof selected.manifest_url === "string"
      ? selected.manifest_url
      : null;
    if (selectedDeliveryUrl !== null) {
      assertRemoteTargetAllowed({ url: selectedDeliveryUrl, purpose: "input" });
    }
    const id = String(selected.format_id ?? "");
    const normalized: FormatSummary = {
      id,
      formatId: id,
      ext: typeof selected.ext === "string" ? selected.ext : null,
      protocol: typeof selected.protocol === "string" ? selected.protocol : null,
      width: typeof selected.width === "number" ? selected.width : null,
      height: typeof selected.height === "number" ? selected.height : null,
      fps: typeof selected.fps === "number" ? selected.fps : null,
      videoCodec: videoCodecForFormat(selected),
      audioCodec: typeof selected.acodec === "string" ? selected.acodec : null,
      estimatedBytes: typeof selected.filesize === "number"
        ? selected.filesize
        : typeof selected.filesize_approx === "number"
        ? selected.filesize_approx
        : null,
      rows: typeof selected.rows === "number" ? selected.rows : null,
      columns: typeof selected.columns === "number" ? selected.columns : null,
    };
    const currentCandidate = candidateKeyForFormat(
      source.sourceRef,
      source.revision,
      normalized,
    );
    const expectedCandidate = candidateKeyForFormat(
      source.sourceRef,
      source.revision,
      format,
    );
    if (currentCandidate !== expectedCandidate) {
      throw new UrmaError(
        "SOURCE_UNAVAILABLE",
        `Snapshot candidate ${expectedCandidate} changed in yt-dlp output; refresh is required`,
        {
          retryable: true,
          detail: { refreshRequired: true, candidateKey: expectedCandidate },
        },
      );
    }
    return {
      metadata: info,
      selected,
      candidateKey: expectedCandidate,
      formatId: format.id,
    };
  }

  /** Bind one ephemeral delivery lease to an immutable snapshot */
  async lease(
    source: Pick<ResolvedSource, "sourceRef" | "revision" | "canonicalLocator" | "identity">,
    format: FormatSummary,
    signal?: AbortSignal,
  ): Promise<RemoteAcquisitionLease> {
    const snapshot = await this.exactFormatSnapshot(source, format, signal);
    const selected = snapshot.selected;
    const expectedCandidate = snapshot.candidateKey;
    // Prefer the selector-specific URL; use manifest_url when it is absent
    const deliveryUrl = typeof selected.url === "string"
      ? selected.url
      : typeof selected.manifest_url === "string"
      ? selected.manifest_url
      : null;
    if (!deliveryUrl) {
      throw new UrmaError(
        "SOURCE_UNAVAILABLE",
        `Snapshot candidate ${expectedCandidate} has no ephemeral delivery locator; refresh is required`,
        { retryable: true, detail: { refreshRequired: true } },
      );
    }
    assertRemoteTargetAllowed({ url: deliveryUrl, purpose: "manifest" });
    return {
      snapshotRef: { sourceRef: source.sourceRef, revision: source.revision },
      sourceRef: source.sourceRef,
      candidateKey: expectedCandidate,
      formatId: format.id,
      deliveryUrl,
      expiresAtMs: Date.now() + this.config.limits.maxRemoteAcquisitionWallMs,
    };
  }
  async run(
    args: readonly string[],
    options: {
      signal?: AbortSignal | undefined;
      timeoutMs?: number | undefined;
      cwd?: string | undefined;
      remote?: boolean | undefined;
      /** Internal yt-dlp flags; callers cannot set them */
      internalArgs?: readonly string[] | undefined;
    } = {},
  ): Promise<ProcessResult> {
    await verifyRuntimeTool(this.config, "ytdlp");
    const containsRemoteUrl = args.some((argument) => /^https?:\/\//iu.test(argument));
    if (containsRemoteUrl && options.remote === false) {
      throw new UrmaError(
        "INVALID_SOURCE",
        "yt-dlp cannot disable the Safe Proxy for an HTTP(S) operation",
      );
    }
    const remote = options.remote ?? containsRemoteUrl;
    const proxyUrl = remote ? await ensureRemoteProxy(this.remoteContext) : undefined;
    const nodeExecutable = this.config.runtime?.nodeExecutable ?? process.execPath;
    return await this.runner(
      this.config.ytdlp,
      hermeticYtDlpArgs(
        args,
        nodeExecutable,
        proxyUrl,
        ["--ffmpeg-location", path.dirname(this.config.ffmpeg), ...(options.internalArgs ?? [])],
      ),
      {
        signal: options.signal,
        timeoutMs: options.timeoutMs ??
          this.config.limits.maxRemoteAcquisitionWallMs,
        cwd: options.cwd,
        maxStdoutBytes: this.config.limits.subprocessStdoutBytes,
        maxStderrBytes: this.config.limits.subprocessStderrBytes,
        debug: this.config.debug,
        label: "yt-dlp",
        diagnosticRole: "yt-dlp-acquisition",
      },
    );
  }
}
