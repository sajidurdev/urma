import { copyFile, mkdir, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { UrmaConfig } from "../config.js";
import {
  currentExactFrameDiagnosticTrace,
  diagnosticLog,
  measureDiagnosticAsync,
} from "../core/diagnostics.js";
import { normalizeError, UrmaError } from "../core/errors.js";
import type { InvestigationRef } from "../core/ids.js";
import type { ArtifactKind } from "../core/model.js";
import { deterministicRequestKey } from "../core/request-key.js";
import type { FormatSummary, ResolvedSource } from "../sources/types.js";
import { candidateKeyForSourceFormat, safeFormatDescription } from "../sources/candidates.js";
import { Ffprobe } from "../subprocess/ffprobe.js";
import { subprocessMediaInput } from "../subprocess/remote-media.js";
import { runChecked, type ProcessResult } from "../subprocess/runner.js";
import { YtDlp } from "../subprocess/ytdlp.js";
import type { RemoteAcquisitionLease } from "../remote/lease.js";
import { assertRemoteTargetAllowed } from "../remote/egress.js";
import { verifyRuntimeTool } from "../distribution/integrity.js";
import {
  type BinaryVersions,
  collectBinaryVersions,
} from "../subprocess/versions.js";
import type { RemoteOperationContext } from "../remote/operation-context.js";
import { BlobStore } from "../store/blob-store.js";
import type { StoredArtifact, UrmaStore } from "../store/store.js";
import { URMA_VERSION } from "../version.js";
import {
  assertExpectedRemoteBytes,
  assertRemoteDirectoryWithinBudget,
  withRemoteAcquisitionDirectory,
} from "./remote-budget.js";
import { type AcquisitionHandle, startAcquisition } from "./records.js";
import {
  isTimestampCovered,
  parseStoredBoundedVideoCoverage,
  parseStoredVideoCoverage,
  parseVideoStreamCoverage,
  serializeVideoPtsCoverage,
  type VideoPtsCoverage,
} from "./video-timing.js";

type Downloader = Pick<YtDlp, "run"> &
  Partial<Pick<YtDlp, "lease" | "manifestText">>;
type DownloadSpec = Readonly<{
  operation: string;
  kind: ArtifactKind;
  startMs: number;
  endMs: number;
  format: FormatSummary;
  args: string[];
  version: string;
  params: Record<string, unknown>;
}>;
type AcquiredMedia = Readonly<{
  artifact: StoredArtifact;
  path: string;
  cacheHit: boolean;
}>;

type SourceFirstFrameProof = Readonly<{
  version: 1;
  candidateKey: string;
  frameSha256: string;
  sourceVideoDelayMs: number;
  sectionVideoDelayMs: number;
}>;

type AcquisitionDeadline = Readonly<{
  signal: AbortSignal;
  remainingMs(): number;
  assertActive(cause?: unknown): void;
  dispose(): void;
}>;

export type SectionBatchRequirement = Readonly<{
  source: ResolvedSource;
  investigationRef: InvestigationRef;
  startMs: number;
  endMs: number;
}>;
export type SectionAcquisitionOutcome =
  | Readonly<{
    requirement: SectionBatchRequirement;
    status: "fulfilled";
    value: AcquiredMedia;
  }>
  | Readonly<{
    requirement: SectionBatchRequirement;
    status: "rejected";
    reason: unknown;
  }>;
type SectionAcquisitionResult =
  | Readonly<{ status: "fulfilled"; value: AcquiredMedia }>
  | Readonly<{ status: "rejected"; reason: unknown }>;

type SectionEmission = Readonly<{
  sectionStartMs: number;
  sectionEndMs: number;
  filepath: string;
}>;
type BatchAttempt = Readonly<{
  values: ReadonlyMap<string, AcquiredMedia>;
  failures: ReadonlyMap<string, unknown>;
  unresolved: ReadonlySet<string>;
  invoked: boolean;
  requested: number;
  valid: number;
  invalid: number;
  missingUnmapped: number;
  elapsedMs: number;
}>;
type BatchDiagnostics = {
  logicalSectionRequirements: number;
  uniqueSectionRequirements: number;
  compatibleBatchCount: number;
  sectionsPerBatch: number[];
  outerYtDlpInvocations: number;
  multiSectionYtDlpInvocations: number;
  singleSectionInvocations: number;
  singleSectionFallbackInvocations: number;
  batchSectionsRequested: number;
  batchSectionsValid: number;
  batchSectionsInvalid: number;
  batchSectionsMissingUnmapped: number;
  fallbackSectionsRequested: number;
  fallbackSectionsSuccessful: number;
  fallbackSectionsFailed: number;
  batchElapsedMs: number;
  fallbackElapsedMs: number;
  cacheHits: number;
};

const SECTION_PREFIX = "URMA_SECTION\t";
const SECTION_OUTPUT_TEMPLATE =
  "media-%(section_start)010.3f-%(section_end)010.3f.%(ext)s";
// yt-dlp sections use seconds; Urma identities use integer milliseconds
const SECTION_METADATA_TOLERANCE_MS = 1;
const SOURCE_FIRST_FRAME_PROOF_VERSION = 1;
const SOURCE_FIRST_FRAME_MANIFEST_MAX_BYTES = 1_048_576;
const SOURCE_FIRST_FRAME_MANIFEST_MAX_LINES = 8_192;

function acquisitionDeadline(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): AcquisitionDeadline {
  const expiresAt = performance.now() + timeoutMs;
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort(parent?.reason);
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref();
  return {
    signal: controller.signal,
    remainingMs() {
      this.assertActive();
      return Math.max(1, Math.floor(expiresAt - performance.now()));
    },
    assertActive(cause?: unknown) {
      if (parent?.aborted) {
        throw new UrmaError(
          "CANCELLED",
          "Bounded media acquisition was cancelled",
          { ...(cause === undefined ? {} : { cause }) },
        );
      }
      if (timedOut || performance.now() >= expiresAt) {
        timedOut = true;
        controller.abort();
        throw new UrmaError(
          "MEDIA_ACQUISITION_TIMEOUT",
          "Bounded media acquisition exceeded its shared wall-time limit",
          { retryable: true, ...(cause === undefined ? {} : { cause }) },
        );
      }
    },
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abortFromParent);
    },
  };
}

function errorAfterDeadline(
  deadline: AcquisitionDeadline | null,
  error: unknown,
): unknown {
  if (deadline === null) return error;
  try {
    deadline.assertActive(error);
    return error;
  } catch (normalized) {
    return normalized;
  }
}

function firstHlsMediaSegmentUri(manifest: string): string | null {
  if (
    Buffer.byteLength(manifest, "utf8") > SOURCE_FIRST_FRAME_MANIFEST_MAX_BYTES
  ) return null;
  const lines = manifest.replace(/^\uFEFF/u, "").split(/\r?\n/u);
  if (
    lines.length > SOURCE_FIRST_FRAME_MANIFEST_MAX_LINES ||
    lines[0]?.trim() !== "#EXTM3U"
  ) return null;
  let sequence = 0;
  let expectingSegment = false;
  let firstSegment: string | null = null;
  let endList = false;
  for (const rawLine of lines.slice(1)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (line.startsWith("#")) {
      if (line.startsWith("#EXT-X-TWITCH-ELAPSED-SECS:")) {
        const value = line.slice("#EXT-X-TWITCH-ELAPSED-SECS:".length);
        if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/u.test(value) || Number(value) !== 0) {
          return null;
        }
        continue;
      }
      if (line.startsWith("#EXT-X-TWITCH-TOTAL-SECS:")) {
        const value = line.slice("#EXT-X-TWITCH-TOTAL-SECS:".length);
        if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/u.test(value) ||
            !Number.isFinite(Number(value)) || Number(value) <= 0) {
          return null;
        }
        continue;
      }
      if (
        line.startsWith("#EXT-X-START:") ||
        line.startsWith("#EXT-X-STREAM-INF:") ||
        line.startsWith("#EXT-X-I-FRAME-STREAM-INF:") ||
        line.startsWith("#EXT-X-MEDIA:") ||
        line.startsWith("#EXT-X-DISCONTINUITY-SEQUENCE:") ||
        line.startsWith("#EXT-X-GAP") ||
        line.startsWith("#EXT-X-SKIP:") ||
        line.startsWith("#EXT-X-BYTERANGE:") ||
        line.startsWith("#EXT-X-MAP:") ||
        line.startsWith("#EXT-X-PART:") ||
        line.startsWith("#EXT-X-PRELOAD-HINT:") ||
        line.startsWith("#EXT-X-RENDITION-REPORT:") ||
        line.startsWith("#EXT-X-SERVER-CONTROL:") ||
        line.startsWith("#EXT-X-KEY:") && !/^#EXT-X-KEY:METHOD=NONE(?:,|$)/u.test(line)
      ) return null;
      if (firstSegment === null) {
        if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
          const value = line.slice("#EXT-X-MEDIA-SEQUENCE:".length);
          if (!/^0+$/u.test(value)) return null;
          sequence = 0;
        } else if (line.startsWith("#EXT-X-DISCONTINUITY")) {
          return null;
        } else if (line.startsWith("#EXTINF:")) {
          if (expectingSegment) return null;
          const value = line.slice("#EXTINF:".length).split(",", 1)[0] ?? "";
          if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/u.test(value) || Number(value) <= 0) {
            return null;
          }
          expectingSegment = true;
        } else if (line === "#EXT-X-ENDLIST") {
          return null;
        } else if (
          line.startsWith("#EXT-X-VERSION:") ||
          line.startsWith("#EXT-X-TARGETDURATION:") ||
          line.startsWith("#EXT-X-PLAYLIST-TYPE:") ||
          line === "#EXT-X-INDEPENDENT-SEGMENTS"
        ) {
          continue;
        } else if (line.startsWith("#EXT-X-")) {
          return null;
        }
      } else if (line === "#EXT-X-ENDLIST") {
        endList = true;
      }
      continue;
    }
    if (firstSegment !== null) continue;
    if (!expectingSegment) return null;
    firstSegment = line;
    expectingSegment = false;
  }
  if (sequence !== 0 || !endList || firstSegment === null) return null;
  if (expectingSegment) return null;
  return firstSegment;
}

function safeFirstSegmentUrl(
  lease: RemoteAcquisitionLease,
  uri: string,
): string | null {
  try {
    const base = new URL(lease.deliveryUrl);
    if (
      !["http:", "https:"].includes(base.protocol) ||
      base.username.length > 0 ||
      base.password.length > 0 ||
      uri.length > 8_192
    ) return null;
    const segment = new URL(uri, base);
    if (
      !["http:", "https:"].includes(segment.protocol) ||
      segment.username.length > 0 ||
      segment.password.length > 0 ||
      segment.hash.length > 0
    ) return null;
    assertRemoteTargetAllowed({ url: segment.href, purpose: "fragment" });
    return segment.href;
  } catch {
    return null;
  }
}

function firstFrameGeometryKey(
  stream: Readonly<Record<string, unknown>>,
): string | null {
  const width = stream.width;
  const height = stream.height;
  if (
    typeof width !== "number" || !Number.isSafeInteger(width) || width <= 0 ||
    typeof height !== "number" || !Number.isSafeInteger(height) || height <= 0
  ) return null;
  let normalizedSar: string | null;
  if (stream.sample_aspect_ratio === undefined || stream.sample_aspect_ratio === null) {
    normalizedSar = null;
  } else {
    const sar = typeof stream.sample_aspect_ratio === "string"
      ? /^(\d+):(\d+)$/u.exec(stream.sample_aspect_ratio.trim())
      : null;
    if (!sar) return null;
    const sarWidth = Number(sar[1]);
    const sarHeight = Number(sar[2]);
    if (
      !Number.isSafeInteger(sarWidth) || sarWidth <= 0 ||
      !Number.isSafeInteger(sarHeight) || sarHeight <= 0
    ) return null;
    const divisor = (left: number, right: number): number => {
      let a = left;
      let b = right;
      while (b !== 0) [a, b] = [b, a % b];
      return a;
    };
    normalizedSar = `${sarWidth / divisor(sarWidth, sarHeight)}:${
      sarHeight / divisor(sarWidth, sarHeight)
    }`;
  }
  const rotation = (value: unknown): number | null | undefined => {
    if (value === undefined || value === null) return null;
    const degrees = typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length <= 32
      ? Number(value.trim())
      : Number.NaN;
    if (!Number.isFinite(degrees)) return undefined;
    return Math.round((((degrees % 360) + 360) % 360) * 1_000) / 1_000;
  };
  const tags = typeof stream.tags === "object" && stream.tags !== null &&
      !Array.isArray(stream.tags)
    ? stream.tags as Record<string, unknown>
    : {};
  const tagRotation = rotation(tags.rotate);
  if (tagRotation === undefined) return null;
  const sideData = Array.isArray(stream.side_data_list)
    ? stream.side_data_list as unknown[]
    : [];
  const display: Array<{ matrix: string | null; rotation: number | null }> = [];
  for (const rawItem of sideData) {
    if (
      typeof rawItem !== "object" || rawItem === null ||
      Array.isArray(rawItem)
    ) continue;
    const item = rawItem as Record<string, unknown>;
    if (item.side_data_type !== "Display Matrix") continue;
    const matrix = typeof item.displaymatrix === "string"
      ? item.displaymatrix.trim().replace(/\s+/gu, " ")
      : null;
    const displayRotation = rotation(item.rotation);
    if (displayRotation === undefined) return null;
    if (matrix === null && displayRotation === null) return null;
    display.push({ matrix, rotation: displayRotation });
  }
  return JSON.stringify({
    width,
    height,
    sampleAspectRatio: normalizedSar,
    tagRotation,
    display,
  });
}

async function firstDecodedRgbFrameSha256(
  config: UrmaConfig,
  file: string,
  remoteContext: RemoteOperationContext | null,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<string | null> {
  await verifyRuntimeTool(config, "ffmpeg");
  const mediaInput = await subprocessMediaInput(file, remoteContext);
  const result = await runChecked(
    config.ffmpeg,
    [
      ...mediaInput.args,
      "-v",
      "error",
      "-i",
      mediaInput.input,
      "-map",
      "0:v:0",
      "-frames:v",
      "1",
      "-vf",
      "format=rgb24",
      "-f",
      "hash",
      "-hash",
      "sha256",
      "pipe:1",
    ],
    {
      signal,
      timeoutMs,
      maxStdoutBytes: 1_024,
      maxStderrBytes: Math.min(config.limits.subprocessStderrBytes, 64 * 1024),
      inputFile: mediaInput.inputFile,
      debug: config.debug,
      label: "ffmpeg",
      diagnosticRole: "hls-source-first-frame-check",
    },
  );
  return /^SHA256=([a-f0-9]{64})\s*$/imu.exec(
    result.stdout.toString("utf8"),
  )?.[1] ?? null;
}

function targetedDerivativeUnavailable(
  message: string,
  detail: Readonly<Record<string, unknown>> = {},
): UrmaError {
  return new UrmaError("TARGETED_MEDIA_UNAVAILABLE", message, {
    detail,
  });
}

function videoFormats(source: ResolvedSource): FormatSummary[] {
  return source.formats.filter(
    (item) =>
      item.videoCodec !== null &&
      item.videoCodec !== "none" &&
      item.ext !== "mhtml",
  );
}
function navFormat(source: ResolvedSource): FormatSummary | null {
  const formats = videoFormats(source);
  return (
    [...formats.filter((item) => (item.height ?? Infinity) <= 144)].sort(
      (a, b) =>
        (b.height ?? 0) - (a.height ?? 0) ||
        (a.estimatedBytes ?? Infinity) - (b.estimatedBytes ?? Infinity),
    )[0] ??
      [...formats].sort(
        (a, b) =>
          (a.height ?? Infinity) - (b.height ?? Infinity) ||
          (a.estimatedBytes ?? Infinity) - (b.estimatedBytes ?? Infinity),
      )[0] ??
      null
  );
}
function evidenceFormats(
  source: ResolvedSource,
  hls: boolean,
): FormatSummary[] {
  return [
    ...videoFormats(source)
      .filter((item) => !hls || item.protocol?.startsWith("m3u8"))
      .filter((item) => (item.height ?? 0) <= 1080),
  ].sort(
    (a, b) =>
      (b.height ?? 0) - (a.height ?? 0) ||
      (a.estimatedBytes ?? Infinity) - (b.estimatedBytes ?? Infinity),
  );
}
function evidenceFormat(
  source: ResolvedSource,
  hls: boolean,
): FormatSummary | null {
  return evidenceFormats(source, hls)[0] ?? null;
}

function formatIdentity(
  source: ResolvedSource,
  format: FormatSummary | null,
): Readonly<Record<string, unknown>> {
  return format === null ? { candidateKey: null, id: null } : {
    candidateKey: candidateKeyForSourceFormat(source, format),
    id: format.id,
    ...safeFormatDescription(format),
  };
}

/** Describe the selected exact-frame transport representation without acquiring media */
export function frameEvidenceRepresentation(
  config: UrmaConfig,
  source: ResolvedSource,
): Readonly<Record<string, unknown>> {
  if (source.kind === "local") return { mode: "local-direct" };
  const bounded = evidenceFormat(source, true);
  if (bounded !== null) {
    return {
      mode: "hls-bounded-section",
      format: formatIdentity(source, bounded),
    };
  }
  const formats = evidenceFormats(source, false);
  const reusable = formats.find(
    (item) =>
      item.estimatedBytes === null ||
      Math.ceil(item.estimatedBytes) <=
        config.limits.maxReusableEvidenceMediaBytes,
  ) ??
    formats[0] ??
    null;
  return {
    mode: "reusable-evidence",
    format: formatIdentity(source, reusable),
  };
}
function mimeTypeFor(file: string): string {
  switch (path.extname(file).toLowerCase()) {
    case ".mp4":
    case ".m4v":
      return "video/mp4";
    case ".webm":
      return "video/webm";
    case ".mkv":
      return "video/x-matroska";
    case ".mov":
      return "video/quicktime";
    default:
      return "application/octet-stream";
  }
}
function sectionArgument(startMs: number, endMs: number): string {
  return `*${(startMs / 1_000).toFixed(3)}-${(endMs / 1_000).toFixed(3)}`;
}

function withoutFormatSelector(
  args: readonly string[],
  formatId: string,
): string[] {
  const output: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "-f" && args[index + 1] === formatId) {
      index += 1;
      continue;
    }
    output.push(args[index]!);
  }
  return output;
}

async function leaseFor(
  downloader: Downloader,
  source: ResolvedSource,
  format: FormatSummary,
  signal?: AbortSignal,
): Promise<RemoteAcquisitionLease | null> {
  if (source.kind !== "remote") return null;
  if (typeof downloader.lease !== "function") return null;
  return await downloader.lease(source, format, signal);
}

function sectionSpec(
  source: ResolvedSource,
  startMs: number,
  endMs: number,
): DownloadSpec {
  const format = evidenceFormat(source, true);
  if (!format) {
    throw new UrmaError(
      "TARGETED_MEDIA_UNAVAILABLE",
      "Source has no targetable HLS video format; use reusable evidence media",
    );
  }
  return {
    operation: "media-section",
    kind: "media_section",
    startMs,
    endMs,
    format,
    args: [
      "--download-sections",
      sectionArgument(startMs, endMs),
      "-f",
      format.id,
    ],
    version: "bounded-section",
    params: {
      candidateKey: candidateKeyForSourceFormat(source, format),
      formatId: format.id,
      fidelity: "evidence",
      requestedStartMs: startMs,
      requestedEndMs: endMs,
      ...(startMs === 0
        ? { sourceFirstFrameProofVersion: SOURCE_FIRST_FRAME_PROOF_VERSION }
        : {}),
    },
  };
}

function needsSourceFirstFrameProof(
  artifact: StoredArtifact,
  startMs: number,
): boolean {
  if (
    startMs !== 0 ||
    artifact.producer.validatedSourceFirstFrame !== undefined
  ) return false;
  const coverage = parseStoredBoundedVideoCoverage(artifact.producer);
  return coverage !== null &&
    !isTimestampCovered(coverage, 0) &&
    isTimestampCovered(coverage, 0, true);
}

function sectionRequestKey(requirement: SectionBatchRequirement): string {
  const spec = sectionSpec(
    requirement.source,
    requirement.startMs,
    requirement.endMs,
  );
  return deterministicRequestKey(
    requirement.source.revision,
    spec.operation,
    { startMs: spec.startMs, endMs: spec.endMs, ...spec.params },
    spec.version,
  );
}
function sectionRequirementIdentity(
  requirement: SectionBatchRequirement,
): string {
  return JSON.stringify([
    requirement.source.sourceRef,
    requirement.source.revision,
    requirement.investigationRef,
    sectionRequestKey(requirement),
  ]);
}
function compatibilityKey(
  config: UrmaConfig,
  requirement: SectionBatchRequirement,
): string {
  const format = evidenceFormat(requirement.source, true);
  return JSON.stringify([
    requirement.investigationRef,
    requirement.source.sourceRef,
    requirement.source.revision,
    requirement.source.canonicalLocator,
    config.ytdlp,
    "bounded-section",
    format === null
      ? null
      : candidateKeyForSourceFormat(requirement.source, format),
    format?.id ?? null,
    format?.protocol ?? null,
    format?.height ?? null,
    "evidence",
  ]);
}

/** Group section requests by the effective bounded-section acquisition key */
export function groupCompatibleSectionRequirements(
  config: UrmaConfig,
  requirements: readonly SectionBatchRequirement[],
): SectionBatchRequirement[][] {
  const groups = new Map<string, SectionBatchRequirement[]>();
  for (const requirement of requirements) {
    const key = compatibilityKey(config, requirement);
    const group = groups.get(key);
    if (group) group.push(requirement);
    else groups.set(key, [requirement]);
  }
  return [...groups.values()];
}

function milliseconds(seconds: unknown): number | null {
  const parsed = Number(seconds);
  return Number.isFinite(parsed) ? Math.round(parsed * 1_000) : null;
}
function parseSectionEmissions(stdout: Buffer): SectionEmission[] {
  const emissions: SectionEmission[] = [];
  for (const line of stdout.toString("utf8").split(/\r?\n/u)) {
    if (!line.startsWith(SECTION_PREFIX)) continue;
    const fields = line.slice(SECTION_PREFIX.length).split("\t");
    if (fields.length !== 3) continue;
    try {
      const sectionStartMs = milliseconds(JSON.parse(fields[0]!));
      const sectionEndMs = milliseconds(JSON.parse(fields[1]!));
      const filepath = JSON.parse(fields[2]!) as unknown;
      if (
        sectionStartMs !== null &&
        sectionEndMs !== null &&
        typeof filepath === "string"
      ) {
        emissions.push({ sectionStartMs, sectionEndMs, filepath });
      }
    } catch {
    }
  }
  return emissions;
}
async function scanSectionEmissions(
  directory: string,
): Promise<SectionEmission[]> {
  const emissions: SectionEmission[] = [];
  for (const name of await readdir(directory)) {
    const match = /^media-([0-9]+\.[0-9]{3})-([0-9]+\.[0-9]{3})\.[^.]+$/u.exec(
      name,
    );
    if (!match) continue;
    const sectionStartMs = milliseconds(match[1]);
    const sectionEndMs = milliseconds(match[2]);
    if (sectionStartMs !== null && sectionEndMs !== null) {
      emissions.push({
        sectionStartMs,
        sectionEndMs,
        filepath: path.join(directory, name),
      });
    }
  }
  return emissions;
}
function matchingRequirements(
  requirements: readonly SectionBatchRequirement[],
  emission: SectionEmission,
): SectionBatchRequirement[] {
  return requirements.filter(
    (requirement) =>
      Math.abs(requirement.startMs - emission.sectionStartMs) <=
        SECTION_METADATA_TOLERANCE_MS &&
      Math.abs(requirement.endMs - emission.sectionEndMs) <=
        SECTION_METADATA_TOLERANCE_MS,
  );
}
function uniqueCandidateMap(
  directory: string,
  requirements: readonly SectionBatchRequirement[],
  emissions: readonly SectionEmission[],
): Map<string, SectionEmission[]> {
  const mapped = new Map<string, SectionEmission[]>();
  const seen = new Set<string>();
  for (const emission of emissions) {
    const matches = matchingRequirements(requirements, emission);
    if (matches.length !== 1) continue;
    const identity = sectionRequirementIdentity(matches[0]!);
    const resolvedPath = path.resolve(directory, emission.filepath);
    const candidateIdentity = JSON.stringify([
      identity,
      emission.sectionStartMs,
      emission.sectionEndMs,
      resolvedPath,
    ]);
    if (seen.has(candidateIdentity)) continue;
    seen.add(candidateIdentity);
    const candidates = mapped.get(identity);
    if (candidates) candidates.push(emission);
    else mapped.set(identity, [emission]);
  }
  return mapped;
}

export function mediaBudgetBytes(
  config: UrmaConfig,
  kind: ArtifactKind,
): number {
  if (kind === "media_section") return config.limits.maxTargetedMediaBytes;
  if (kind === "navigation_media") return config.limits.maxNavigationCopyBytes;
  if (kind === "evidence_media") {
    return config.limits.maxReusableEvidenceMediaBytes;
  }
  throw new RangeError(`Artifact kind ${kind} has no remote media budget`);
}
export function expectedMediaBytes(
  source: ResolvedSource,
  spec: Pick<DownloadSpec, "kind" | "startMs" | "endMs" | "format">,
): number | null {
  const expected = spec.format.estimatedBytes;
  if (expected === null) return null;
  if (spec.kind !== "media_section") return Math.ceil(expected);
  const requested = Math.max(0, spec.endMs - spec.startMs);
  if (source.durationMs < 1 || requested < 1) return null;
  return Math.ceil(expected * Math.min(1, requested / source.durationMs));
}

export class MediaAcquirer {
  readonly downloader: Downloader;
  constructor(
    readonly config: UrmaConfig,
    readonly store: UrmaStore,
    readonly blobs: BlobStore,
    downloader?: Downloader,
    readonly remoteContext: RemoteOperationContext | null = null,
  ) {
    this.downloader = downloader ?? new YtDlp(config, undefined, remoteContext);
  }

  async navigation(
    source: ResolvedSource,
    ref: InvestigationRef,
    signal?: AbortSignal,
  ): Promise<AcquiredMedia> {
    const format = navFormat(source);
    if (!format) {
      throw new UrmaError(
        "TARGETED_MEDIA_UNAVAILABLE",
        "Source has no usable video format for a navigation copy",
      );
    }
    return await this.#download(
      source,
      ref,
      {
        operation: "navigation-copy",
        kind: "navigation_media",
        startMs: 0,
        endMs: source.durationMs,
        format,
        args: ["-f", format.id],
        version: "navigation-copy",
        params: {
          candidateKey: candidateKeyForSourceFormat(source, format),
          formatId: format.id,
          fidelity: "navigation",
        },
      },
      signal,
    );
  }
  async reusableEvidence(
    source: ResolvedSource,
    ref: InvestigationRef,
    signal?: AbortSignal,
  ): Promise<AcquiredMedia> {
    const formats = evidenceFormats(source, false);
    const format = formats.find(
      (item) =>
        item.estimatedBytes === null ||
        Math.ceil(item.estimatedBytes) <=
          this.config.limits.maxReusableEvidenceMediaBytes,
    ) ??
      formats[0] ??
      null;
    if (!format) {
      throw new UrmaError(
        "TARGETED_MEDIA_UNAVAILABLE",
        "Source has no usable evidence-fidelity video format",
      );
    }
    return await this.#download(
      source,
      ref,
      {
        operation: "evidence-copy",
        kind: "evidence_media",
        startMs: 0,
        endMs: source.durationMs,
        format,
        args: ["-f", format.id],
        version: "evidence-copy",
        params: {
          candidateKey: candidateKeyForSourceFormat(source, format),
          formatId: format.id,
          fidelity: "evidence",
        },
      },
      signal,
    );
  }
  async section(
    source: ResolvedSource,
    ref: InvestigationRef,
    startMs: number,
    endMs: number,
    signal?: AbortSignal,
  ): Promise<AcquiredMedia> {
    const requirement: SectionBatchRequirement = {
      source,
      investigationRef: ref,
      startMs,
      endMs,
    };
    const cached = await this.#cachedSection(requirement);
    if (cached) {
      return needsSourceFirstFrameProof(cached.artifact, startMs)
        ? await this.#verifyCachedSection(requirement, cached, signal)
        : cached;
    }
    return await this.#download(
      source,
      ref,
      sectionSpec(source, startMs, endMs),
      signal,
    );
  }

  async sections(
    requirements: readonly SectionBatchRequirement[],
    signal?: AbortSignal,
  ): Promise<SectionAcquisitionOutcome[]> {
    if (requirements.length === 0) return [];
    const diagnostics: BatchDiagnostics = {
      logicalSectionRequirements: requirements.length,
      uniqueSectionRequirements: 0,
      compatibleBatchCount: 0,
      sectionsPerBatch: [],
      outerYtDlpInvocations: 0,
      multiSectionYtDlpInvocations: 0,
      singleSectionInvocations: 0,
      singleSectionFallbackInvocations: 0,
      batchSectionsRequested: 0,
      batchSectionsValid: 0,
      batchSectionsInvalid: 0,
      batchSectionsMissingUnmapped: 0,
      fallbackSectionsRequested: 0,
      fallbackSectionsSuccessful: 0,
      fallbackSectionsFailed: 0,
      batchElapsedMs: 0,
      fallbackElapsedMs: 0,
      cacheHits: 0,
    };
    const outcomes = new Map<string, SectionAcquisitionResult>();
    const unique = new Map<string, SectionBatchRequirement>();
    for (const requirement of requirements) {
      unique.set(sectionRequirementIdentity(requirement), requirement);
    }
    diagnostics.uniqueSectionRequirements = unique.size;
    try {
      for (
        const group of groupCompatibleSectionRequirements(this.config, [
          ...unique.values(),
        ])
      ) {
        const missing: SectionBatchRequirement[] = [];
        for (const requirement of group) {
          let cached = await this.#cachedSection(requirement);
          if (cached) {
            if (needsSourceFirstFrameProof(cached.artifact, requirement.startMs)) {
              cached = await this.#verifyCachedSection(
                requirement,
                cached,
                signal,
              );
            }
            diagnostics.cacheHits += 1;
            outcomes.set(sectionRequirementIdentity(requirement), {
              status: "fulfilled",
              value: cached,
            });
          } else missing.push(requirement);
        }
        if (missing.length === 0) continue;
        if (missing.length === 1) {
          await this.#acquireOneSection(
            missing[0]!,
            outcomes,
            diagnostics,
            false,
            signal,
          );
          continue;
        }
        const attempted = await this.#acquireBatch(missing, signal);
        if (attempted.invoked) {
          diagnostics.compatibleBatchCount += 1;
          diagnostics.sectionsPerBatch.push(attempted.requested);
          diagnostics.outerYtDlpInvocations += 1;
          if (attempted.requested > 1) {
            diagnostics.multiSectionYtDlpInvocations += 1;
          } else diagnostics.singleSectionInvocations += 1;
        }
        diagnostics.batchSectionsRequested += attempted.requested;
        diagnostics.batchSectionsValid += attempted.valid;
        diagnostics.batchSectionsInvalid += attempted.invalid;
        diagnostics.batchSectionsMissingUnmapped += attempted.missingUnmapped;
        diagnostics.batchElapsedMs += attempted.elapsedMs;
        for (const [identity, value] of attempted.values) {
          outcomes.set(identity, { status: "fulfilled", value });
        }
        for (const requirement of missing) {
          const identity = sectionRequirementIdentity(requirement);
          if (attempted.values.has(identity)) continue;
          const batchFailure = attempted.failures.get(identity);
          const batchFailureCode = batchFailure === undefined
            ? null
            : normalizeError(batchFailure).code;
          if (batchFailureCode === "CANCELLED") throw batchFailure;
          if (
            batchFailureCode === "MEDIA_BUDGET_EXCEEDED" ||
            batchFailureCode === "MEDIA_ACQUISITION_TIMEOUT"
          ) {
            outcomes.set(identity, {
              status: "rejected",
              reason: batchFailure,
            });
            continue;
          }
          if (!attempted.unresolved.has(identity)) {
            outcomes.set(identity, {
              status: "rejected",
              reason: batchFailure ?? new UrmaError(
                "TARGETED_MEDIA_UNAVAILABLE",
                `Batched bounded section [${requirement.startMs},${requirement.endMs}) was validated but unavailable`,
              ),
            });
            continue;
          }
          await this.#acquireOneSection(
            requirement,
            outcomes,
            diagnostics,
            true,
            signal,
          );
        }
      }
    } finally {
      diagnosticLog(this.config.debug, "bounded-section-batching", {
        logicalSectionRequirements: diagnostics.logicalSectionRequirements,
        uniqueSectionRequirements: diagnostics.uniqueSectionRequirements,
        compatibleBatchCount: diagnostics.compatibleBatchCount,
        sectionsPerBatch: diagnostics.sectionsPerBatch.join(","),
        outerYtDlpInvocations: diagnostics.outerYtDlpInvocations,
        multiSectionYtDlpInvocations: diagnostics.multiSectionYtDlpInvocations,
        singleSectionInvocations: diagnostics.singleSectionInvocations,
        singleSectionFallbackInvocations:
          diagnostics.singleSectionFallbackInvocations,
        batchSectionsRequested: diagnostics.batchSectionsRequested,
        batchSectionsValid: diagnostics.batchSectionsValid,
        batchSectionsInvalid: diagnostics.batchSectionsInvalid,
        batchSectionsMissingUnmapped: diagnostics.batchSectionsMissingUnmapped,
        fallbackSectionsRequested: diagnostics.fallbackSectionsRequested,
        fallbackSectionsSuccessful: diagnostics.fallbackSectionsSuccessful,
        fallbackSectionsFailed: diagnostics.fallbackSectionsFailed,
        batchElapsedMs: Math.round(diagnostics.batchElapsedMs),
        fallbackElapsedMs: Math.round(diagnostics.fallbackElapsedMs),
        cacheHits: diagnostics.cacheHits,
      });
    }
    return requirements.map((requirement) => {
      const outcome = outcomes.get(sectionRequirementIdentity(requirement));
      return outcome
        ? ({ requirement, ...outcome } as SectionAcquisitionOutcome)
        : {
          requirement,
          status: "rejected",
          reason: new UrmaError(
            "TARGETED_MEDIA_UNAVAILABLE",
            `Bounded section [${requirement.startMs},${requirement.endMs}) was not resolved by batching or fallback`,
          ),
        };
    });
  }

  async #cachedSection(
    requirement: SectionBatchRequirement,
  ): Promise<AcquiredMedia | null> {
    const trace = currentExactFrameDiagnosticTrace();
    const started = performance.now();
    try {
      const existing = this.store.getArtifactByRequest(
        sectionRequestKey(requirement),
      );
      if (
        !existing ||
        existing.kind !== "media_section" ||
        parseStoredBoundedVideoCoverage(existing.producer) === null
      ) {
        return null;
      }
      try {
        return {
          artifact: existing,
          path: await this.blobs.verify(existing.artifactId, existing.blobPath),
          cacheHit: true,
        };
      } catch {
        return null;
      }
    } finally {
      const elapsedMs = performance.now() - started;
      trace?.addStage("artifactCacheLookupMs", elapsedMs);
      trace?.addStage("boundedArtifactCacheLookupMs", elapsedMs);
    }
  }

  async #verifyCachedSection(
    requirement: SectionBatchRequirement,
    cached: AcquiredMedia,
    signal?: AbortSignal,
  ): Promise<AcquiredMedia> {
    const spec = sectionSpec(
      requirement.source,
      requirement.startMs,
      requirement.endMs,
    );
    const coverage = parseStoredBoundedVideoCoverage(cached.artifact.producer);
    if (
      requirement.startMs !== 0 ||
      cached.artifact.sourceRef !== requirement.source.sourceRef ||
      cached.artifact.sourceRevision !== requirement.source.revision ||
      cached.artifact.startMs !== 0 ||
      cached.artifact.endMs !== requirement.endMs ||
      cached.artifact.params.candidateKey !== spec.params.candidateKey ||
      cached.artifact.producer.candidateKey !== spec.params.candidateKey ||
      cached.artifact.params.formatId !== spec.format.id ||
      cached.artifact.producer.formatId !== spec.format.id ||
      cached.artifact.producer.validatedSourceFirstFrame !== undefined ||
      coverage === null ||
      isTimestampCovered(coverage, 0) ||
      !isTimestampCovered(coverage, 0, true)
    ) return cached;
    const budget = this.config.limits.maxTargetedMediaBytes;
    const deadline = acquisitionDeadline(
      signal,
      this.config.limits.maxRemoteAcquisitionWallMs,
    );
    const trace = currentExactFrameDiagnosticTrace();
    const remoteStarted = performance.now();
    trace?.markRemoteAcquisition("media_section");
    try {
      return await withRemoteAcquisitionDirectory(
        this.config,
        "media-prefix-verification",
        budget,
        deadline.signal,
        async (temporary, remoteSignal) => {
          const cachedInfo = await stat(cached.path);
          if (cachedInfo.size > budget) {
            throw new UrmaError(
              "MEDIA_BUDGET_EXCEEDED",
              "Cached bounded section exceeds the first-frame verification byte budget",
            );
          }
          const sectionFile = path.join(temporary, "cached-section.bin");
          await copyFile(cached.path, sectionFile);
          const sectionProbe = await new Ffprobe(
            this.config,
            this.remoteContext,
          ).inspect(sectionFile, remoteSignal);
          deadline.assertActive();
          const streams = Array.isArray(sectionProbe.streams)
            ? sectionProbe.streams as Array<Record<string, unknown>>
            : [];
          const sectionVideoStream = streams.find((item) =>
            item.codec_type === "video"
          );
          const sectionFormat = typeof sectionProbe.format === "object" &&
              sectionProbe.format !== null
            ? sectionProbe.format as Record<string, unknown>
            : {};
          const measuredCoverage = sectionVideoStream === undefined
            ? null
            : parseVideoStreamCoverage(
              sectionVideoStream,
              sectionFormat.start_time,
            );
          if (
            sectionVideoStream === undefined ||
            measuredCoverage === null ||
            JSON.stringify(serializeVideoPtsCoverage(coverage)) !==
              JSON.stringify(serializeVideoPtsCoverage(measuredCoverage))
          ) return cached;
          const lease = await leaseFor(
            this.downloader,
            requirement.source,
            spec.format,
            remoteSignal,
          );
          deadline.assertActive();
          const proof = await this.#verifiedSourceFirstFrame(
            requirement.source,
            spec,
            lease,
            sectionFile,
            measuredCoverage,
            sectionVideoStream,
            temporary,
            budget,
            budget,
            remoteSignal,
            deadline,
          );
          deadline.assertActive();
          if (proof === null) return cached;
          await assertRemoteDirectoryWithinBudget(
            temporary,
            budget,
            "cached bounded section and first HLS source segment",
          );
          const artifact: StoredArtifact = {
            ...cached.artifact,
            producer: {
              ...cached.artifact.producer,
              validatedSourceFirstFrame: proof,
            },
          };
          this.store.putArtifact(artifact, {
            requestKey: sectionRequestKey(requirement),
            operation: "media-section",
          });
          return { artifact, path: cached.path, cacheHit: true };
        },
        budget,
      );
    } catch (error) {
      const failure = errorAfterDeadline(deadline, error);
      const code = normalizeError(failure).code;
      if (
        code === "CANCELLED" ||
        code === "MEDIA_BUDGET_EXCEEDED" ||
        code === "MEDIA_ACQUISITION_TIMEOUT"
      ) throw failure;
      return cached;
    } finally {
      deadline.dispose();
      trace?.addStage(
        "remoteBoundedAcquisitionMs",
        performance.now() - remoteStarted,
      );
    }
  }
  async #acquireOneSection(
    requirement: SectionBatchRequirement,
    outcomes: Map<string, SectionAcquisitionResult>,
    diagnostics: BatchDiagnostics,
    fallback: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    const identity = sectionRequirementIdentity(requirement);
    const started = performance.now();
    if (fallback) diagnostics.fallbackSectionsRequested += 1;
    try {
      const value = await this.#download(
        requirement.source,
        requirement.investigationRef,
        sectionSpec(requirement.source, requirement.startMs, requirement.endMs),
        signal,
        () => {
          diagnostics.outerYtDlpInvocations += 1;
          if (fallback) diagnostics.singleSectionFallbackInvocations += 1;
          else diagnostics.singleSectionInvocations += 1;
        },
      );
      outcomes.set(identity, { status: "fulfilled", value });
      if (fallback) diagnostics.fallbackSectionsSuccessful += 1;
    } catch (error) {
      outcomes.set(identity, { status: "rejected", reason: error });
      if (fallback) diagnostics.fallbackSectionsFailed += 1;
      if (normalizeError(error).code === "CANCELLED") throw error;
    } finally {
      if (fallback) {
        diagnostics.fallbackElapsedMs += performance.now() - started;
      }
    }
  }

  async #acquireBatch(
    requirements: readonly SectionBatchRequirement[],
    signal?: AbortSignal,
  ): Promise<BatchAttempt> {
    const started = performance.now();
    const trace = currentExactFrameDiagnosticTrace();
    const values = new Map<string, AcquiredMedia>();
    const failures = new Map<string, unknown>();
    const unresolved = new Set<string>();
    const handles = new Map<string, AcquisitionHandle>();
    const eligible: SectionBatchRequirement[] = [];
    const perSectionBudget = this.config.limits.maxTargetedMediaBytes;
    for (const requirement of requirements) {
      const identity = sectionRequirementIdentity(requirement);
      const spec = sectionSpec(
        requirement.source,
        requirement.startMs,
        requirement.endMs,
      );
      const handle = startAcquisition(this.store, {
        sourceRef: requirement.source.sourceRef,
        sourceRevision: requirement.source.revision,
        investigationRef: requirement.investigationRef,
        operation: "acquire-media-section",
        requestKey: sectionRequestKey(requirement),
        method: "yt-dlp-bounded-section",
        debug: this.config.debug,
      });
      handles.set(identity, handle);
      try {
        assertExpectedRemoteBytes(
          expectedMediaBytes(requirement.source, spec),
          perSectionBudget,
          spec.operation,
        );
        eligible.push(requirement);
      } catch (error) {
        handle.fail(error);
        failures.set(identity, error);
      }
    }
    let invalid = 0;
    let missingUnmapped = 0;
    let invoked = false;
    if (eligible.length > 0) {
      const source = eligible[0]!.source;
      const spec = sectionSpec(
        source,
        eligible[0]!.startMs,
        eligible[0]!.endMs,
      );
      const totalBudget = perSectionBudget * eligible.length;
      const deadline = eligible.some((requirement) => requirement.startMs === 0)
        ? acquisitionDeadline(
          signal,
          this.config.limits.maxRemoteAcquisitionWallMs,
        )
        : null;
      try {
        const remoteStarted = performance.now();
        try {
          await withRemoteAcquisitionDirectory(
            this.config,
            "media-batch",
            totalBudget,
            deadline?.signal ?? signal,
            async (temporary, remoteSignal) => {
              let result: ProcessResult | null = null;
              let processError: unknown = null;
              let lease: RemoteAcquisitionLease | null = null;
              try {
                invoked = true;
                trace?.markRemoteAcquisition("media_section");
                lease = await leaseFor(
                  this.downloader,
                  source,
                  spec.format,
                  remoteSignal,
                );
                deadline?.assertActive();
                result = await this.downloader.run(
                  [
                    ...eligible.flatMap((requirement) => [
                      "--download-sections",
                      sectionArgument(requirement.startMs, requirement.endMs),
                    ]),
                    ...(lease ? [] : ["-f", spec.format.id]),
                    "--paths",
                    temporary,
                    "-o",
                    SECTION_OUTPUT_TEMPLATE,
                    "--print",
                    `after_move:${SECTION_PREFIX}%(section_start)j\t%(section_end)j\t%(filepath)j`,
                    lease?.deliveryUrl ?? source.canonicalLocator,
                  ],
                  {
                    signal: remoteSignal,
                    timeoutMs: deadline?.remainingMs() ??
                      this.config.limits.maxRemoteAcquisitionWallMs,
                  },
                );
                if (result.code !== 0) {
                  processError = new UrmaError(
                    "SOURCE_UNAVAILABLE",
                    `yt-dlp batch exited with code ${result.code}; independently valid bounded sections were preserved and unresolved sections will use single-section fallback`,
                    { retryable: true, detail: { exitCode: result.code } },
                  );
                }
              } catch (error) {
                processError = error;
              }
              if (remoteSignal.aborted) {
                const aborted = processError ??
                  new UrmaError(
                    "CANCELLED",
                    "Bounded-section batch was cancelled before outputs could be validated",
                  );
                deadline?.assertActive(aborted);
                for (const requirement of eligible) {
                  const identity = sectionRequirementIdentity(requirement);
                  failures.set(identity, aborted);
                  handles.get(identity)!.fail(aborted);
                }
                return;
              }
              await assertRemoteDirectoryWithinBudget(
                temporary,
                totalBudget,
                "media-section batch",
                perSectionBudget,
              );
              const emissions = [
                ...(result ? parseSectionEmissions(result.stdout) : []),
                ...(await scanSectionEmissions(temporary)),
              ];
              const candidates = uniqueCandidateMap(
                temporary,
                eligible,
                emissions,
              );
              const versions = await collectBinaryVersions(
                this.config,
                ["ytdlp", "ffprobe"],
                remoteSignal,
              );
              const canonicalTemporary = await realpath(temporary);
              for (const requirement of eligible) {
                const identity = sectionRequirementIdentity(requirement);
                const mapped = candidates.get(identity) ?? [];
                if (mapped.length !== 1) {
                  missingUnmapped += 1;
                  unresolved.add(identity);
                  const error = processError ??
                    new UrmaError(
                      "TARGETED_MEDIA_UNAVAILABLE",
                      `Batched bounded section [${requirement.startMs},${requirement.endMs}) had ${mapped.length} unambiguous emitted artifacts; single-section fallback is required`,
                      { retryable: true },
                    );
                  failures.set(identity, error);
                  handles.get(identity)!.fail(error);
                  continue;
                }
                try {
                  const candidate = await this.#validateBatchCandidate(
                    canonicalTemporary,
                    mapped[0]!,
                    requirement,
                    perSectionBudget,
                    remoteSignal,
                    lease,
                    totalBudget,
                    deadline,
                  );
                  const normalizedProcessError = processError === null
                    ? null
                    : normalizeError(processError);
                  const errorExitCode = normalizedProcessError &&
                      typeof normalizedProcessError.detail.exitCode === "number"
                    ? normalizedProcessError.detail.exitCode
                    : null;
                  const value = await this.#promoteDownloaded(
                    requirement.source,
                    sectionSpec(
                      requirement.source,
                      requirement.startMs,
                      requirement.endMs,
                    ),
                    candidate.file,
                    candidate.durationSeconds,
                    versions,
                    handles.get(identity)!,
                    {
                      batch: true,
                      batchSize: eligible.length,
                      processExitCode: result?.code ?? errorExitCode,
                    },
                    candidate.coverage,
                    candidate.sourceFirstFrameProof,
                  );
                  values.set(identity, value);
                } catch (error) {
                  const failure = errorAfterDeadline(deadline, error);
                  invalid += 1;
                  failures.set(identity, failure);
                  handles.get(identity)!.fail(failure);
                }
              }
              deadline?.assertActive();
            },
            perSectionBudget,
          );
        } catch (error) {
          const failure = errorAfterDeadline(deadline, error);
          for (const requirement of eligible) {
            const identity = sectionRequirementIdentity(requirement);
            if (values.has(identity) || failures.has(identity)) continue;
            unresolved.add(identity);
            failures.set(identity, failure);
            handles.get(identity)!.fail(failure);
          }
        } finally {
          deadline?.dispose();
          trace?.addStage(
            "remoteBoundedAcquisitionMs",
            performance.now() - remoteStarted,
          );
        }
      } catch (error) {
        const failure = errorAfterDeadline(deadline, error);
        for (const requirement of eligible) {
          const identity = sectionRequirementIdentity(requirement);
          if (values.has(identity) || failures.has(identity)) continue;
          unresolved.add(identity);
          failures.set(identity, failure);
          handles.get(identity)!.fail(failure);
        }
      }
    }
    return {
      values,
      failures,
      unresolved,
      invoked,
      requested: eligible.length,
      valid: values.size,
      invalid,
      missingUnmapped: missingUnmapped +
        Math.max(0, eligible.length - values.size - invalid - missingUnmapped),
      elapsedMs: performance.now() - started,
    };
  }

  async #validateBatchCandidate(
    canonicalTemporary: string,
    emission: SectionEmission,
    requirement: SectionBatchRequirement,
    budgetBytes: number,
    signal?: AbortSignal,
    lease: RemoteAcquisitionLease | null = null,
    directoryBudgetBytes = budgetBytes,
    deadline: AcquisitionDeadline | null = null,
  ): Promise<{
    file: string;
    durationSeconds: number;
    coverage: VideoPtsCoverage;
    videoStream: Record<string, unknown>;
    sourceFirstFrameProof: SourceFirstFrameProof | null;
  }> {
    const trace = currentExactFrameDiagnosticTrace();
    const file = await measureDiagnosticAsync(
      trace,
      "artifactValidationMs",
      async () =>
        await realpath(path.resolve(canonicalTemporary, emission.filepath)),
    );
    const relative = path.relative(canonicalTemporary, file);
    if (
      relative.length === 0 ||
      relative.startsWith("..") ||
      path.isAbsolute(relative)
    ) {
      throw new UrmaError(
        "MEDIA_INVALID",
        `Batched bounded section [${requirement.startMs},${requirement.endMs}) emitted a file outside its isolated staging directory`,
      );
    }
    const info = await measureDiagnosticAsync(
      trace,
      "artifactValidationMs",
      async () => await stat(file),
    );
    if (!info.isFile() || info.size < 1) {
      throw targetedDerivativeUnavailable(
        `Batched bounded section [${requirement.startMs},${requirement.endMs}) did not emit a non-empty regular media file`,
        { reason: "empty-or-nonregular-output" },
      );
    }
    if (info.size > budgetBytes) {
      throw new UrmaError(
        "MEDIA_BUDGET_EXCEEDED",
        `Batched bounded section [${requirement.startMs},${requirement.endMs}) emitted ${info.size} bytes, exceeding its ${budgetBytes}-byte hard acquisition budget`,
      );
    }
    const validated = await measureDiagnosticAsync(
      trace,
      "mediaProbeTimingValidationMs",
      async () => {
        const probe = await new Ffprobe(this.config, this.remoteContext).inspect(file, signal);
        const streams = Array.isArray(probe.streams)
          ? (probe.streams as Array<Record<string, unknown>>)
          : [];
        const videoStream = streams.find((item) => item.codec_type === "video");
        if (!videoStream) {
          throw targetedDerivativeUnavailable(
            `Batched bounded section [${requirement.startMs},${requirement.endMs}) has no video stream; the bounded target is unavailable`,
            { reason: "zero-video-stream" },
          );
        }
        const format = typeof probe.format === "object" && probe.format !== null
          ? (probe.format as Record<string, unknown>)
          : {};
        const coverage = parseVideoStreamCoverage(
          videoStream,
          format.start_time,
        );
        if (!coverage) {
          throw targetedDerivativeUnavailable(
            `Batched bounded section [${requirement.startMs},${requirement.endMs}) has no valid finite video PTS coverage or container start time; the bounded target is unavailable`,
            { reason: "invalid-video-pts-coverage" },
          );
        }
        const durationSeconds = Number(format.duration);
        if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
          throw targetedDerivativeUnavailable(
            `Batched bounded section [${requirement.startMs},${requirement.endMs}) has no positive finite container duration; the bounded target is unavailable`,
            { reason: "invalid-container-duration" },
          );
        }
        this.#assertBoundedDuration(
          requirement.startMs,
          requirement.endMs,
          durationSeconds,
        );
        return { durationSeconds, coverage, videoStream };
      },
    );
    return {
      file,
      durationSeconds: validated.durationSeconds,
      coverage: validated.coverage,
      videoStream: validated.videoStream,
      sourceFirstFrameProof: await this.#verifiedSourceFirstFrame(
        requirement.source,
        sectionSpec(
          requirement.source,
          requirement.startMs,
          requirement.endMs,
        ),
        lease,
        file,
        validated.coverage,
        validated.videoStream,
        canonicalTemporary,
        directoryBudgetBytes,
        budgetBytes,
        signal ?? deadline?.signal,
        deadline,
      ),
    };
  }

  async #verifiedSourceFirstFrame(
    source: ResolvedSource,
    spec: DownloadSpec,
    lease: RemoteAcquisitionLease | null,
    sectionFile: string,
    sectionCoverage: VideoPtsCoverage,
    sectionVideoStream: Readonly<Record<string, unknown>>,
    temporary: string,
    directoryBudgetBytes: number,
    perFileBudgetBytes: number,
    signal: AbortSignal | undefined,
    deadline: AcquisitionDeadline | null,
  ): Promise<SourceFirstFrameProof | null> {
    if (
      spec.kind !== "media_section" ||
      spec.startMs !== 0 ||
      spec.params.sourceFirstFrameProofVersion !==
        SOURCE_FIRST_FRAME_PROOF_VERSION ||
      isTimestampCovered(sectionCoverage, 0)
    ) return null;
    let sourceSegmentBytes = 0;
    const report = (
      result: "verified" | "unavailable",
      reason: string,
      timing?: Readonly<{
        sourceVideoDelayMs: number;
        sectionVideoDelayMs: number;
      }>,
    ) => {
      diagnosticLog(this.config.debug, "bounded-source-first-frame-proof", {
        result,
        reason,
        sourceSegmentBytes,
        ...(timing ?? {}),
      });
    };
    if (!isTimestampCovered(sectionCoverage, 0, true)) {
      report("unavailable", "zero-not-covered-by-first-frame");
      return null;
    }
    if (lease === null || deadline === null) {
      report("unavailable", "missing-lease-or-deadline");
      return null;
    }
    if (typeof this.downloader.manifestText !== "function") {
      report("unavailable", "manifest-reader-unavailable");
      return null;
    }
    const operationSignal = signal ?? deadline.signal;
    const candidateKey = candidateKeyForSourceFormat(source, spec.format);
    if (
      lease.candidateKey !== candidateKey ||
      lease.sourceRef !== source.sourceRef ||
      lease.snapshotRef.revision !== source.revision ||
      lease.formatId !== spec.format.id ||
      lease.expiresAtMs <= Date.now()
    ) {
      report("unavailable", "lease-candidate-mismatch");
      return null;
    }

    try {
      const manifest = await this.downloader.manifestText(
        lease.deliveryUrl,
        operationSignal,
        { timeoutMs: deadline.remainingMs() },
      );
      deadline.assertActive();
      const firstUri = firstHlsMediaSegmentUri(manifest);
      if (firstUri === null) {
        report("unavailable", "unsupported-playlist");
        return null;
      }
      const segmentUrl = safeFirstSegmentUrl(lease, firstUri);
      if (segmentUrl === null) {
        report("unavailable", "segment-url-rejected");
        return null;
      }
      const extension = path.extname(new URL(segmentUrl).pathname).toLowerCase();
      const segmentExtension = /^\.[a-z0-9]{1,8}$/u.test(extension)
        ? extension
        : ".bin";
      const prefixDirectory = path.join(temporary, "source-prefix");
      await mkdir(prefixDirectory, { recursive: true });
      const firstSegmentFile = path.join(
        prefixDirectory,
        `first-segment${segmentExtension}`,
      );
      const segmentResult = await this.downloader.run(
        ["-o", firstSegmentFile, segmentUrl],
        {
          signal: operationSignal,
          timeoutMs: deadline.remainingMs(),
          cwd: temporary,
        },
      );
      deadline.assertActive();
      if (segmentResult.code !== 0) {
        throw new UrmaError(
          "SOURCE_UNAVAILABLE",
          "The first HLS source segment could not be acquired for source-start verification",
          { retryable: true },
        );
      }
      sourceSegmentBytes = (await stat(firstSegmentFile)).size;
      await assertRemoteDirectoryWithinBudget(
        temporary,
        directoryBudgetBytes,
        "bounded section and first HLS source segment",
        perFileBudgetBytes,
      );
      const sourceProbe = await new Ffprobe(
        this.config,
        this.remoteContext,
      ).inspect(firstSegmentFile, operationSignal);
      deadline.assertActive();
      const sourceStreams = Array.isArray(sourceProbe.streams)
        ? sourceProbe.streams as Array<Record<string, unknown>>
        : [];
      const sourceVideo = sourceStreams.find((item) => item.codec_type === "video");
      if (sourceVideo === undefined) {
        report("unavailable", "source-video-timing-unavailable");
        return null;
      }
      const sourceFormat = typeof sourceProbe.format === "object" &&
          sourceProbe.format !== null
        ? sourceProbe.format as Record<string, unknown>
        : {};
      const sourceCoverage = parseVideoStreamCoverage(
        sourceVideo,
        sourceFormat.start_time,
      );
      if (sourceCoverage === null) {
        report("unavailable", "source-video-timing-unavailable");
        return null;
      }
      const sourceVideoDelayMs =
        (sourceCoverage.startSeconds - sourceCoverage.containerStartSeconds) *
          1_000;
      const sectionVideoDelayMs =
        (sectionCoverage.startSeconds - sectionCoverage.containerStartSeconds) *
          1_000;
      if (
        !Number.isFinite(sourceVideoDelayMs) ||
        !Number.isFinite(sectionVideoDelayMs) ||
        sourceVideoDelayMs <= 0 ||
        sectionVideoDelayMs <= 0 ||
        Math.abs(sourceVideoDelayMs - sectionVideoDelayMs) >
          SECTION_METADATA_TOLERANCE_MS
      ) {
        report("unavailable", "video-delay-mismatch", {
          sourceVideoDelayMs: Number(sourceVideoDelayMs.toFixed(3)),
          sectionVideoDelayMs: Number(sectionVideoDelayMs.toFixed(3)),
        });
        return null;
      }
      const sourceGeometry = firstFrameGeometryKey(sourceVideo);
      const sectionGeometry = firstFrameGeometryKey(sectionVideoStream);
      if (sourceGeometry === null || sourceGeometry !== sectionGeometry) {
        report("unavailable", "first-frame-geometry-mismatch", {
          sourceVideoDelayMs: Number(sourceVideoDelayMs.toFixed(3)),
          sectionVideoDelayMs: Number(sectionVideoDelayMs.toFixed(3)),
        });
        return null;
      }
      const sourceFrameSha256 = await firstDecodedRgbFrameSha256(
        this.config,
        firstSegmentFile,
        this.remoteContext,
        operationSignal,
        deadline.remainingMs(),
      );
      deadline.assertActive();
      const sectionFrameSha256 = await firstDecodedRgbFrameSha256(
        this.config,
        sectionFile,
        this.remoteContext,
        operationSignal,
        deadline.remainingMs(),
      );
      deadline.assertActive();
      if (
        sourceFrameSha256 === null ||
        sourceFrameSha256 !== sectionFrameSha256
      ) {
        report("unavailable", "first-frame-mismatch", {
          sourceVideoDelayMs: Number(sourceVideoDelayMs.toFixed(3)),
          sectionVideoDelayMs: Number(sectionVideoDelayMs.toFixed(3)),
        });
        return null;
      }
      report("verified", "identity-and-timing-match", {
        sourceVideoDelayMs: Number(sourceVideoDelayMs.toFixed(3)),
        sectionVideoDelayMs: Number(sectionVideoDelayMs.toFixed(3)),
      });
      return {
        version: SOURCE_FIRST_FRAME_PROOF_VERSION,
        candidateKey,
        frameSha256: sourceFrameSha256,
        sourceVideoDelayMs: Number(sourceVideoDelayMs.toFixed(3)),
        sectionVideoDelayMs: Number(sectionVideoDelayMs.toFixed(3)),
      };
    } catch (error) {
      let normalized = normalizeError(error);
      try {
        deadline.assertActive(error);
      } catch (deadlineError) {
        normalized = normalizeError(deadlineError);
      }
      const code = normalized.code;
      if (
        code === "CANCELLED" ||
        code === "MEDIA_BUDGET_EXCEEDED" ||
        code === "MEDIA_ACQUISITION_TIMEOUT"
      ) {
        report("unavailable", code.toLowerCase());
        throw normalized;
      }
      report("unavailable", "verification-failed");
      return null;
    }
  }

  #assertBoundedDuration(
    startMs: number,
    endMs: number,
    durationSeconds: number,
  ): void {
    const requestedSeconds = (endMs - startMs) / 1_000;
    const maximumSeconds = Math.max(
      requestedSeconds * 3,
      requestedSeconds + 30,
    );
    if (durationSeconds > maximumSeconds) {
      throw new UrmaError(
        "MEDIA_INVALID",
        `Bounded section returned ${durationSeconds.toFixed(3)} seconds for a ${
          requestedSeconds.toFixed(3)
        }-second request; the accidental full download was rejected`,
      );
    }
  }

  async #promoteDownloaded(
    source: ResolvedSource,
    spec: DownloadSpec,
    file: string,
    durationSeconds: number,
    versions: BinaryVersions,
    acquisition: AcquisitionHandle,
    acquisitionMetadata: Readonly<Record<string, unknown>> = {},
    coverage: VideoPtsCoverage | null = null,
    sourceFirstFrameProof: SourceFirstFrameProof | null = null,
  ): Promise<AcquiredMedia> {
    const trace = currentExactFrameDiagnosticTrace();
    const started = performance.now();
    try {
      if (
        (spec.kind === "media_section" || spec.kind === "evidence_media") &&
        coverage === null
      ) {
        throw new RangeError(
          "Exact media promotion requires validated video PTS coverage",
        );
      }
      const blob = await this.blobs.putFile(file);
      const requestKey = deterministicRequestKey(
        source.revision,
        spec.operation,
        { startMs: spec.startMs, endMs: spec.endMs, ...spec.params },
        spec.version,
      );
      const artifact: StoredArtifact = {
        artifactId: blob.artifactId,
        sourceRef: source.sourceRef,
        sourceRevision: source.revision,
        kind: spec.kind,
        role: "transport",
        mimeType: mimeTypeFor(file),
        sha256: blob.sha256,
        byteSize: blob.byteSize,
        blobPath: blob.relativePath,
        startMs: spec.startMs,
        endMs: spec.endMs,
        params: spec.params,
        producer: {
          version: spec.version,
          urmaVersion: URMA_VERSION,
          ...versions,
          formatId: spec.format.id,
          candidateKey: candidateKeyForSourceFormat(source, spec.format),
          height: spec.format.height,
          protocol: spec.format.protocol,
          validatedDurationMs: Math.round(durationSeconds * 1_000),
          ...(spec.kind === "media_section"
            ? { requestedStartMs: spec.startMs, requestedEndMs: spec.endMs }
            : {}),
          ...(spec.kind === "evidence_media"
            ? { validatedSourcePrefix: "complete" }
            : {}),
          ...(sourceFirstFrameProof === null
            ? {}
            : { validatedSourceFirstFrame: sourceFirstFrameProof }),
          ...(coverage === null ? {} : serializeVideoPtsCoverage(coverage)),
        },
        createdAt: new Date().toISOString(),
      };
      this.store.putArtifact(artifact, {
        requestKey,
        operation: spec.operation,
      });
      acquisition.succeed({
        networkBytes: null,
        networkAccountingComplete: false,
        metadata: {
          artifactId: artifact.artifactId,
          ...versions,
          ...acquisitionMetadata,
        },
      });
      trace?.addNewTransportArtifactBytes(artifact.byteSize);
      return { artifact, path: blob.absolutePath, cacheHit: false };
    } finally {
      trace?.addStage("mediaArtifactCommitMs", performance.now() - started);
    }
  }

  async #download(
    source: ResolvedSource,
    ref: InvestigationRef,
    spec: DownloadSpec,
    signal?: AbortSignal,
    onInvoke?: () => void,
  ): Promise<AcquiredMedia> {
    const trace = currentExactFrameDiagnosticTrace();
    const requestKey = deterministicRequestKey(
      source.revision,
      spec.operation,
      { startMs: spec.startMs, endMs: spec.endMs, ...spec.params },
      spec.version,
    );
    const cacheStarted = performance.now();
    let existing: StoredArtifact | null = null;
    try {
      existing = this.store.getArtifactByRequest(requestKey);
      const cachedCoverage = existing === null
        ? null
        : spec.kind === "media_section"
        ? parseStoredBoundedVideoCoverage(existing.producer)
        : spec.kind === "evidence_media"
        ? parseStoredVideoCoverage(existing.producer)
        : true;
      if (
        existing &&
        cachedCoverage !== null
      ) {
        try {
          return {
            artifact: existing,
            path: await this.blobs.verify(
              existing.artifactId,
              existing.blobPath,
            ),
            cacheHit: true,
          };
        } catch {
        }
      }
    } finally {
      const elapsedMs = performance.now() - cacheStarted;
      trace?.addStage("artifactCacheLookupMs", elapsedMs);
      trace?.addStage(
        spec.kind === "media_section"
          ? "boundedArtifactCacheLookupMs"
          : "reusableArtifactCacheLookupMs",
        elapsedMs,
      );
    }
    const acquisition = startAcquisition(this.store, {
      sourceRef: source.sourceRef,
      sourceRevision: source.revision,
      investigationRef: ref,
      operation: `acquire-${spec.operation}`,
      requestKey,
      method: spec.kind === "media_section"
        ? "yt-dlp-bounded-section"
        : "yt-dlp-reusable-media",
      debug: this.config.debug,
    });
    const budget = mediaBudgetBytes(this.config, spec.kind);
    const deadline = spec.kind === "media_section" && spec.startMs === 0
      ? acquisitionDeadline(
        signal,
        this.config.limits.maxRemoteAcquisitionWallMs,
      )
      : null;
    try {
      assertExpectedRemoteBytes(
        expectedMediaBytes(source, spec),
        budget,
        spec.operation,
      );
      const remoteStarted = performance.now();
      try {
        return await withRemoteAcquisitionDirectory(
          this.config,
          "media",
          budget,
          deadline?.signal ?? signal,
          async (temporary, remoteSignal) => {
            onInvoke?.();
            if (
              spec.kind === "media_section" || spec.kind === "evidence_media"
            ) {
              trace?.markRemoteAcquisition(spec.kind);
            }
            const lease = await leaseFor(
              this.downloader,
              source,
              spec.format,
              remoteSignal,
            );
            deadline?.assertActive();
            await this.downloader.run(
              [
                ...(lease
                  ? [
                    ...withoutFormatSelector(spec.args, spec.format.id),
                    "-o",
                    "media.%(ext)s",
                  ]
                  : spec.args),
                "--paths",
                temporary,
                lease?.deliveryUrl ?? source.canonicalLocator,
              ],
              {
                signal: remoteSignal,
                timeoutMs: deadline?.remainingMs() ??
                  this.config.limits.maxRemoteAcquisitionWallMs,
                cwd: temporary,
              },
            );
            deadline?.assertActive();
            const validated = await measureDiagnosticAsync(
              trace,
              "artifactValidationMs",
              async () => {
                await assertRemoteDirectoryWithinBudget(
                  temporary,
                  budget,
                  spec.operation,
                );
                const names = (await readdir(temporary)).filter((item) =>
                  !item.endsWith(".part") &&
                  !item.endsWith(".ytdl") &&
                  /^[A-Za-z0-9_.-]{1,200}$/u.test(item) &&
                  [
                    ".mp4",
                    ".m4v",
                    ".webm",
                    ".mkv",
                    ".mov",
                    ".ts",
                    ".m2ts",
                    ".avi",
                  ].includes(path.extname(item).toLowerCase())
                );
                if (names.length !== 1) {
                  throw targetedDerivativeUnavailable(
                    names.length === 0
                      ? `yt-dlp completed ${spec.operation} without a typed media artifact`
                      : `yt-dlp completed ${spec.operation} with ambiguous typed media outputs`,
                    { reason: names.length === 0 ? "missing-targeted-output" : "ambiguous-targeted-output" },
                  );
                }
                const file = path.join(temporary, names[0]!);
                const media = await measureDiagnosticAsync(
                  trace,
                  "mediaProbeTimingValidationMs",
                  async () => {
                    const probe = await new Ffprobe(this.config, this.remoteContext).inspect(
                      file,
                      remoteSignal,
                    );
                    const streams = Array.isArray(probe.streams)
                      ? (probe.streams as Array<Record<string, unknown>>)
                      : [];
                    const videoStream = streams.find(
                      (item) => item.codec_type === "video",
                    );
                    if (!videoStream) {
                      if (spec.kind === "media_section") {
                        throw targetedDerivativeUnavailable(
                          `${spec.operation} artifact has no video stream; the bounded target is unavailable`,
                          { reason: "zero-video-stream" },
                        );
                      }
                      throw new UrmaError(
                        "MEDIA_INVALID",
                        `${spec.operation} artifact has no video stream; retry with an updated yt-dlp`,
                      );
                    }
                    const format = typeof probe.format === "object" &&
                        probe.format !== null
                      ? (probe.format as Record<string, unknown>)
                      : {};
                    const requiresExactTiming =
                      spec.kind === "media_section" ||
                      spec.kind === "evidence_media";
                    const coverage = requiresExactTiming
                      ? parseVideoStreamCoverage(videoStream, format.start_time)
                      : null;
                    if (coverage === null && requiresExactTiming) {
                      if (spec.kind === "media_section") {
                        throw targetedDerivativeUnavailable(
                          `${spec.operation} artifact has no valid finite video PTS coverage or container start time; the bounded target is unavailable`,
                          { reason: "invalid-video-pts-coverage" },
                        );
                      }
                      throw new UrmaError(
                        "MEDIA_INVALID",
                        `${spec.operation} artifact has no valid finite video PTS coverage or container start time; exact frames are unavailable`,
                        { detail: { reason: "invalid-video-pts-coverage" } },
                      );
                    }
                    const durationSeconds = Number(format.duration);
                    if (
                      !Number.isFinite(durationSeconds) ||
                      durationSeconds <= 0
                    ) {
                      if (spec.kind === "media_section") {
                        throw targetedDerivativeUnavailable(
                          `${spec.operation} artifact has no positive finite duration; the bounded target is unavailable`,
                          { reason: "invalid-container-duration" },
                        );
                      }
                      throw new UrmaError(
                        "MEDIA_INVALID",
                        `${spec.operation} artifact has no positive finite duration; retry with an updated yt-dlp`,
                      );
                    }
                    if (spec.kind === "media_section") {
                      this.#assertBoundedDuration(
                        spec.startMs,
                        spec.endMs,
                        durationSeconds,
                      );
                    }
                    return { file, durationSeconds, coverage, videoStream };
                  },
                );
                await assertRemoteDirectoryWithinBudget(
                  temporary,
                  budget,
                  spec.operation,
                );
                const sourceFirstFrameProof = media.coverage === null
                  ? null
                  : await this.#verifiedSourceFirstFrame(
                    source,
                    spec,
                    lease,
                    media.file,
                    media.coverage,
                    media.videoStream,
                    temporary,
                    budget,
                    budget,
                    remoteSignal,
                    deadline,
                  );
                await assertRemoteDirectoryWithinBudget(
                  temporary,
                  budget,
                  spec.operation,
                );
                return { ...media, sourceFirstFrameProof };
              },
            );
            const versions = await collectBinaryVersions(
              this.config,
              ["ytdlp", "ffprobe"],
              remoteSignal,
            );
            deadline?.assertActive();
            return await this.#promoteDownloaded(
              source,
              spec,
              validated.file,
              validated.durationSeconds,
              versions,
              acquisition,
              {},
              validated.coverage,
              validated.sourceFirstFrameProof,
            );
          },
        );
      } finally {
        trace?.addStage(
          spec.kind === "media_section"
            ? "remoteBoundedAcquisitionMs"
            : "remoteReusableAcquisitionMs",
          performance.now() - remoteStarted,
        );
      }
    } catch (error) {
      const failure = errorAfterDeadline(deadline, error);
      acquisition.fail(failure);
      throw failure;
    } finally {
      deadline?.dispose();
    }
  }
}
