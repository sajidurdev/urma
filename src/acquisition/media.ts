import { readdir, realpath, stat } from "node:fs/promises";
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
import type { ProcessResult } from "../subprocess/runner.js";
import { YtDlp } from "../subprocess/ytdlp.js";
import type { RemoteAcquisitionLease } from "../remote/lease.js";
import {
  type BinaryVersions,
  collectBinaryVersions,
} from "../subprocess/versions.js";
import type { RemoteOperationContext } from "../remote/worker.js";
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
  parseStoredBoundedVideoCoverage,
  parseStoredVideoCoverage,
  parseVideoStreamCoverage,
  serializeVideoPtsCoverage,
  type VideoPtsCoverage,
} from "./video-timing.js";

type Downloader = Pick<YtDlp, "run"> & Partial<Pick<YtDlp, "lease">>;
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
    },
  };
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
          const cached = await this.#cachedSection(requirement);
          if (cached) {
            diagnostics.cacheHits += 1;
            outcomes.set(sectionRequirementIdentity(requirement), {
              status: "fulfilled",
              value: cached,
            });
          } else missing.push(requirement);
        }
        if (missing.length === 0) continue;
        if (missing.length === 1) {
          await this.#acquireSingleIntoOutcomes(
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
          if (batchFailureCode === "MEDIA_BUDGET_EXCEEDED") {
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
          await this.#acquireSingleIntoOutcomes(
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
  async #acquireSingleIntoOutcomes(
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
      try {
        const remoteStarted = performance.now();
        try {
          await withRemoteAcquisitionDirectory(
            this.config,
            "media-batch",
            totalBudget,
            signal,
            async (temporary, remoteSignal) => {
              let result: ProcessResult | null = null;
              let processError: unknown = null;
              try {
                invoked = true;
                trace?.markRemoteAcquisition("media_section");
                const lease = await leaseFor(
                  this.downloader,
                  source,
                  spec.format,
                  remoteSignal,
                );
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
                    timeoutMs: this.config.limits.maxRemoteAcquisitionWallMs,
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
                  );
                  values.set(identity, value);
                } catch (error) {
                  invalid += 1;
                  failures.set(identity, error);
                  handles.get(identity)!.fail(error);
                }
              }
            },
            perSectionBudget,
          );
        } finally {
          trace?.addStage(
            "remoteBoundedAcquisitionMs",
            performance.now() - remoteStarted,
          );
        }
      } catch (error) {
        for (const requirement of eligible) {
          const identity = sectionRequirementIdentity(requirement);
          if (values.has(identity) || failures.has(identity)) continue;
          unresolved.add(identity);
          failures.set(identity, error);
          handles.get(identity)!.fail(error);
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
  ): Promise<{
    file: string;
    durationSeconds: number;
    coverage: VideoPtsCoverage;
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
        const coverage = parseVideoStreamCoverage(videoStream);
        if (!coverage) {
          throw targetedDerivativeUnavailable(
            `Batched bounded section [${requirement.startMs},${requirement.endMs}) has no valid finite video PTS coverage; the bounded target is unavailable`,
            { reason: "invalid-video-pts-coverage" },
          );
        }
        const format = typeof probe.format === "object" && probe.format !== null
          ? (probe.format as Record<string, unknown>)
          : {};
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
        return { durationSeconds, coverage };
      },
    );
    return {
      file,
      durationSeconds: validated.durationSeconds,
      coverage: validated.coverage,
    };
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
          signal,
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
                timeoutMs: this.config.limits.maxRemoteAcquisitionWallMs,
                cwd: temporary,
              },
            );
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
                    const requiresExactTiming =
                      spec.kind === "media_section" || spec.kind === "evidence_media";
                    const coverage = requiresExactTiming
                      ? parseVideoStreamCoverage(videoStream)
                      : null;
                    if (coverage === null && requiresExactTiming) {
                      if (spec.kind === "media_section") {
                        throw targetedDerivativeUnavailable(
                          `${spec.operation} artifact has no valid finite video PTS coverage; the bounded target is unavailable`,
                          { reason: "invalid-video-pts-coverage" },
                        );
                      }
                      throw new UrmaError(
                        "MEDIA_INVALID",
                        `${spec.operation} artifact has no valid finite video PTS coverage; exact frames are unavailable`,
                        { detail: { reason: "invalid-video-pts-coverage" } },
                      );
                    }
                    const format =
                      typeof probe.format === "object" && probe.format !== null
                        ? (probe.format as Record<string, unknown>)
                        : {};
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
                    return { file, durationSeconds, coverage };
                  },
                );
                await assertRemoteDirectoryWithinBudget(
                  temporary,
                  budget,
                  spec.operation,
                );
                return media;
              },
            );
            const versions = await collectBinaryVersions(
              this.config,
              ["ytdlp", "ffprobe"],
              remoteSignal,
            );
            return await this.#promoteDownloaded(
              source,
              spec,
              validated.file,
              validated.durationSeconds,
              versions,
              acquisition,
              {},
              validated.coverage,
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
      acquisition.fail(error);
      throw error;
    }
  }
}
