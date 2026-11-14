import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  FrameAcquirer,
  exactFrameRequestKey,
  type FrameTargetOutcome,
} from "../acquisition/frames.js";
import { FramePanelAcquirer } from "../acquisition/frame-panel.js";
import { DiscoveryAcquirer, DISCOVERY_VERSION, type DiscoveryRequest, type DiscoveryResult } from "../acquisition/discovery.js";
import { VisualAnalyzer, FRAME_DEDUPLICATION_VERSION } from "../acquisition/visual-analysis.js";
import { frameEvidenceRepresentation } from "../acquisition/media.js";
import { OverviewAcquirer } from "../acquisition/overview.js";
import { startAcquisition } from "../acquisition/records.js";
import { Singleflight } from "../acquisition/singleflight.js";
import { selectTrack, TranscriptAcquirer } from "../acquisition/transcript.js";
import type { UrmaConfig } from "../config.js";
import {
  assertInterval,
  assertMs,
  OVERVIEW_CELL_COUNT,
  summarizeSamplingGaps,
  uniformPointsMs,
  refineGapPoints,
} from "../core/coverage.js";
import { validateFrameCrop, type FrameCrop, type FrameCropGeometry } from "../core/frame-crop.js";
import {
  currentExactFrameDiagnosticTrace,
  withExactFrameDiagnostics,
} from "../core/diagnostics.js";
import { normalizeError, UrmaError } from "../core/errors.js";
import {
  createInvestigationRef,
  investigationArtifactUri,
  sha256,
  type InvestigationRef,
  stableJson,
} from "../core/ids.js";
import {
  type FixedCadenceSchedule,
  fixedCadenceTargetCount,
  fixedCadenceTargets,
  FRAME_SCHEDULE_POLICY_VERSION,
  FRAME_SELECTION_CONTRACT_VERSION,
  FRAME_TIMELINE_VERSION,
} from "../core/frame-schedule.js";
import { deterministicRequestKey } from "../core/request-key.js";
import {
  DEFAULT_TRANSCRIPT_SEARCH_RESULTS,
  MAX_TRANSCRIPT_BATCH_CHARACTERS,
  MAX_TRANSCRIPT_BATCH_HITS,
  MAX_TRANSCRIPT_BATCH_QUERIES,
  MAX_TRANSCRIPT_QUERY_CHARACTERS,
  MAX_TRANSCRIPT_SEARCH_CANDIDATES,
  MAX_TRANSCRIPT_SEARCH_RESULTS,
  MAX_TRANSCRIPT_SEARCH_SEGMENTS,
} from "../core/search-limits.js";
import {
  OVERVIEW_CONTRACT_ID,
  type OverviewSampleReuse,
} from "../core/model.js";
import {
  materializeResolvedSource,
  SourceResolver,
  type Freshness,
} from "../sources/resolver.js";
import type { RemoteOperationContext } from "../remote/operation-context.js";
import type { CaptionTrackSummary, ResolvedSource } from "../sources/types.js";
import { BlobStore } from "../store/blob-store.js";
import type {
  StoredArtifact,
  StoredPresentation,
  StoredSegment,
  UrmaStore,
} from "../store/store.js";
import {
  collectBinaryVersions,
  unknownBinaryVersions,
} from "../subprocess/versions.js";
import { compactState, deriveInvestigationState } from "./state.js";
import { redactModelText } from "../subprocess/redaction.js";

const MAX_TRANSCRIPT_SEGMENTS = 200;
const MAX_TRANSCRIPT_CHARACTERS = 16_000;
const MAX_CACHE_INTERVAL_SUMMARY = 20;
const MAX_INSPECT_TRACKS = 100;

type RefineRequest = Readonly<{
  kind: "refine"; startMs?: number | undefined; endMs?: number | undefined; budget: number; basis?: "visual" | "exact" | undefined;
}>;
// Keep optional frames access in service types without adding it to panel responses.
type FrameResult<T> = T extends { frames: unknown } ? T : T & { frames?: never };
type FramesInput = {
  investigationRef: InvestigationRef;
  request?:
    | { kind: "points"; timesMs: readonly number[] }
    | { kind: "burst"; startMs: number; endMs: number; count: number }
    | { kind: "cadence"; startMs: number; endMs: number; cadenceMs: number };
  cursor?: string; pageSize?: number; maxTargets?: number;
  presentation?: "individual" | "panel";
  crop?: FrameCrop; rulers?: boolean;
  diffHints?: boolean;
  deduplicate?: boolean;
  discovery?: DiscoveryResult;
  refinement?: Readonly<{ policy: "largest-gap-midpoint-v1"; startMs: number; endMs: number; budget: number; basis: "visual" | "exact" }>;
};

function cropFields(artifact: StoredArtifact): { crop?: FrameCropGeometry } {
  return artifact.params.crop ? { crop: artifact.producer.crop as FrameCropGeometry } : {};
}

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
function publicTrack(track: CaptionTrackSummary) {
  return {
    trackRef: track.trackRef,
    language: track.language,
    kind: track.kind,
    displayName: track.displayName,
    providerTrackId: track.providerTrackId,
    ...(track.embedded ? { embedded: track.embedded } : {}),
  };
}
function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
function priorOverviewPresentations(
  store: UrmaStore,
  ref: InvestigationRef,
): StoredPresentation[] {
  return store
    .listPresentations(ref)
    .filter(
      (entry) =>
        entry.evidenceKind === "sparse" &&
        entry.metadata.overviewContractId === OVERVIEW_CONTRACT_ID,
    );
}
function presentationSampleIds(entry: StoredPresentation): string[] | null {
  const value = entry.metadata.sampleIds;
  return Array.isArray(value) &&
      value.every((item): item is string => typeof item === "string")
    ? [...value]
    : null;
}
function presentationSourceArtifactId(
  entry: StoredPresentation,
): string | null | undefined {
  const value = entry.metadata.sourceArtifactId;
  return value === null || typeof value === "string" ? value : undefined;
}
function overviewSourceArtifactId(
  cells: readonly Readonly<{
    provenance: { sourceArtifactId: string | null };
  }>[],
): string | null {
  for (const cell of cells) {
    if (cell.provenance.sourceArtifactId !== null) {
      return cell.provenance.sourceArtifactId;
    }
  }
  return null;
}
function overviewSampleReuse(
  store: UrmaStore,
  ref: InvestigationRef,
  durationMs: number,
  startMs: number,
  endMs: number,
  overview: {
    cacheHit: boolean;
    materialCacheHit: boolean;
    source: "native-storyboard" | "navigation-media";
    cells: readonly Readonly<{
      provenance: { sampleId: string; sourceArtifactId: string | null };
    }>[];
  },
): OverviewSampleReuse {
  if (startMs === 0 && endMs === durationMs) {
    return {
      relation: "not-scoped",
      reusedUnderlyingSamples: overview.source === "native-storyboard"
        ? overview.materialCacheHit
        : overview.cacheHit,
    };
  }
  const currentIds = overview.cells.map((cell) => cell.provenance.sampleId);
  const previous = priorOverviewPresentations(store, ref);
  const same = previous.some((entry) => {
    const ids = presentationSampleIds(entry);
    return ids !== null && sameStrings(ids, currentIds);
  });
  if (same) return { relation: "same-samples", reusedUnderlyingSamples: true };
  if (overview.source === "native-storyboard") {
    const currentSourceArtifactId = overviewSourceArtifactId(overview.cells);
    const reusedStoryboard = previous.some(
      (entry) =>
        entry.metadata.source === "native-storyboard" &&
        currentSourceArtifactId !== null &&
        presentationSourceArtifactId(entry) === currentSourceArtifactId,
    );
    if (reusedStoryboard) {
      return { relation: "different-subset", reusedUnderlyingSamples: true };
    }
    return {
      relation: "no-prior-overview",
      reusedUnderlyingSamples: overview.materialCacheHit,
    };
  }
  if (overview.cacheHit) {
    return { relation: "no-prior-overview", reusedUnderlyingSamples: true };
  }
  return {
    relation: previous.length > 0 ? "new-decoded-samples" : "no-prior-overview",
    reusedUnderlyingSamples: false,
  };
}
function adjacentSpacingMs(pointsMs: readonly number[]): number[] {
  return pointsMs.slice(1).map((point, index) => point - pointsMs[index]!);
}
function resolvedFromInvestigation(
  store: UrmaStore,
  ref: InvestigationRef,
): ResolvedSource {
  const investigation = store.getInvestigation(ref);
  if (!investigation) {
    throw new UrmaError(
      "INVALID_SOURCE",
      `Investigation ${ref} is unknown; call inspect_video first`,
    );
  }
  const source = store.getSource(investigation.sourceRef);
  if (!source) {
    throw new UrmaError(
      "INTERNAL_ERROR",
      `Investigation ${ref} refers to a missing source`,
    );
  }
  const snapshot = store.getSnapshot(
    investigation.sourceRef,
    investigation.sourceRevision,
  );
  if (!snapshot) {
    throw new UrmaError(
      "INTERNAL_ERROR",
      `Investigation ${ref} refers to a missing immutable source snapshot`,
    );
  }
  if (snapshot.durationMs !== investigation.durationMs) {
    throw new UrmaError(
      "INTERNAL_ERROR",
      `Investigation ${ref} duration conflicts with its pinned source snapshot`,
    );
  }
  return materializeResolvedSource(store, source, snapshot);
}
function cursor(
  trackId: string,
  ordinal: number,
  startMs: number,
  endMs: number,
): string {
  return Buffer.from(
    JSON.stringify({ v: 1, trackId, ordinal, startMs, endMs }),
  ).toString("base64url");
}
function parseCursor(
  value: string | undefined,
  trackId: string,
  startMs: number,
  endMs: number,
): number {
  if (!value) return 0;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (
      parsed.v !== 1 ||
      parsed.trackId !== trackId ||
      parsed.startMs !== startMs ||
      parsed.endMs !== endMs ||
      !Number.isSafeInteger(parsed.ordinal) ||
      Number(parsed.ordinal) < 0
    ) {
      throw new Error("mismatch");
    }
    return Number(parsed.ordinal);
  } catch (error) {
    throw new UrmaError(
      "INVALID_SOURCE",
      "Transcript cursor is invalid or does not belong to this track and interval; restart read_transcript without a cursor",
      { cause: error },
    );
  }
}

const FRAME_SCHEDULE_CURSOR_SECRET = randomBytes(32);

type FrameScheduleCursorPayload = Readonly<{
  v: 1 | 2;
  kind: "fixed-cadence";
  investigationRef: string;
  sourceRef: string;
  sourceRevision: string;
  durationMs: number;
  representation?: string;
  representationDigest?: string;
  timeline: string;
  selection: string;
  policy: string;
  startMs: number;
  endMs: number;
  cadenceMs: number;
  totalTargets: number;
  nextIndex: number;
  crop?: FrameCrop;
}>;

type NewFrameScheduleCursorPayload = Omit<
  FrameScheduleCursorPayload,
  "v" | "representation" | "representationDigest"
> & { representation: string };

function scheduleCursor(payload: NewFrameScheduleCursorPayload): string {
  const { representation, ...cursorFields } = payload;
  const compactPayload: FrameScheduleCursorPayload = {
    ...cursorFields,
    v: 2,
    representationDigest: sha256(representation),
  };
  const encoded = Buffer.from(JSON.stringify(compactPayload), "utf8").toString(
    "base64url",
  );
  const mac = createHmac("sha256", FRAME_SCHEDULE_CURSOR_SECRET)
    .update(encoded)
    .digest("base64url");
  return `${encoded}.${mac}`;
}

function parseScheduleCursor(value: string): FrameScheduleCursorPayload {
  try {
    const parts = value.split(".");
    if (parts.length !== 2 || parts.some((part) => part.length === 0)) {
      throw new Error("malformed envelope");
    }
    const [encoded, suppliedMac] = parts as [string, string];
    const expectedMac = createHmac("sha256", FRAME_SCHEDULE_CURSOR_SECRET)
      .update(encoded)
      .digest("base64url");
    // Compare encoded tags directly; base64url has alternate decoded spellings
    const supplied = Buffer.from(suppliedMac, "utf8");
    const expected = Buffer.from(expectedMac, "utf8");
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      throw new Error("invalid integrity tag");
    }
    const parsed = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as unknown;
    if (
      typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
    ) {
      throw new Error("invalid payload");
    }
    return parsed as FrameScheduleCursorPayload;
  } catch (error) {
    throw new UrmaError(
      "INVALID_SOURCE",
      "Cadence cursor is invalid or incompatible with this evidence; restart the schedule without a cursor",
      { cause: error },
    );
  }
}

type SearchInput = Readonly<{
  investigationRef: InvestigationRef;
  query?: string;
  queries?: readonly string[];
  trackRef?: string;
  mode?: "phrase" | "terms";
  limit?: number;
}>;
type SearchHit = Readonly<{
  startMs: number;
  endMs: number;
  text: string;
  context: readonly Readonly<{
    startMs: number;
    endMs: number;
    text: string;
  }>[];
}>;
type BatchCandidate = {
  startMs: number;
  endMs: number;
  text: string;
  segmentIds: Set<number>;
  queryIndexes: Set<number>;
  firstOrder: number;
};
type SearchPlan = Readonly<{ normalized: string; tokens: readonly string[] }>;
type SearchSegmentsResult = Readonly<{
  matches: StoredSegment[];
  complete: boolean;
}>;
type ExactFrameResult = Readonly<{
  atMs: number;
  artifact: StoredArtifact;
  cacheHit: boolean;
}>;

function validateQuery(value: unknown): string {
  if (typeof value !== "string") {
    throw new UrmaError("INVALID_SOURCE", "Transcript query must be a string");
  }
  const query = value.trim();
  if (!query || query.length > MAX_TRANSCRIPT_QUERY_CHARACTERS) {
    throw new UrmaError(
      "OUTPUT_LIMIT_EXCEEDED",
      `Transcript query must contain 1-${MAX_TRANSCRIPT_QUERY_CHARACTERS} characters; received ${query.length}`,
    );
  }
  return query;
}
function normalizeSearchInput(input: Pick<SearchInput, "query" | "queries">): {
  batch: boolean;
  queries: string[];
} {
  const hasQuery = input.query !== undefined;
  const hasQueries = input.queries !== undefined;
  if (hasQuery === hasQueries) {
    throw new UrmaError(
      "INVALID_SOURCE",
      "Transcript search requires exactly one of query or queries",
    );
  }
  if (hasQuery) return { batch: false, queries: [validateQuery(input.query)] };
  if (!Array.isArray(input.queries)) {
    throw new UrmaError(
      "INVALID_SOURCE",
      "Transcript queries must be an array of strings",
    );
  }
  if (
    input.queries.length < 1 ||
    input.queries.length > MAX_TRANSCRIPT_BATCH_QUERIES
  ) {
    throw new UrmaError(
      "OUTPUT_LIMIT_EXCEEDED",
      `Transcript batch requires 1-${MAX_TRANSCRIPT_BATCH_QUERIES} queries; received ${input.queries.length}`,
    );
  }
  const queries: string[] = [];
  const seen = new Set<string>();
  for (const value of input.queries) {
    const query = validateQuery(value);
    if (!seen.has(query)) {
      seen.add(query);
      queries.push(query);
    }
  }
  return { batch: true, queries };
}
function searchPlan(query: string): SearchPlan {
  const normalized = normalize(query);
  const tokens = [...new Set(normalized.split(" ").filter(Boolean))];
  if (!normalized) {
    throw new UrmaError(
      "INVALID_SOURCE",
      "Transcript query must contain searchable letters or numbers",
    );
  }
  return { normalized, tokens };
}
// Keep the scan bounded so a truncated miss is not presented as complete.
function searchSegments(
  segments: readonly StoredSegment[],
  query: string,
  mode: "phrase" | "terms",
  candidateLimit: number,
  normalizedBodies?: Array<string | undefined>,
): SearchSegmentsResult {
  const plan = searchPlan(query);
  const matches: StoredSegment[] = [];
  const scanLimit = Math.min(segments.length, MAX_TRANSCRIPT_SEARCH_SEGMENTS);
  for (let index = 0; index < scanLimit; index += 1) {
    const segment = segments[index]!;
    const body = normalizedBodies
      ? (normalizedBodies[index] ??= normalize(segment.text))
      : normalize(segment.text);
    const matched = mode === "phrase"
      ? body.includes(plan.normalized)
      : plan.tokens.every((token) => body.includes(token));
    if (!matched) continue;
    matches.push(segment);
    if (matches.length > candidateLimit) {
      return { matches: matches.slice(0, candidateLimit), complete: false };
    }
  }
  return { matches, complete: scanLimit === segments.length };
}
function hitForSegment(
  all: readonly StoredSegment[],
  match: StoredSegment,
): SearchHit {
  const index = all.findIndex((segment) => segment.id === match.id);
  const context = all.slice(
    Math.max(0, index < 0 ? 0 : index - 1),
    Math.min(all.length, index < 0 ? 2 : index + 2),
  );
  return {
    startMs: match.startMs,
    endMs: match.endMs,
    text: match.text,
    context: context.map(({ startMs, endMs, text }) => ({
      startMs,
      endMs,
      text,
    })),
  };
}
function spansOverlap(
  left: Pick<BatchCandidate, "startMs" | "endMs">,
  right: Pick<StoredSegment, "startMs" | "endMs">,
): boolean {
  return (
    (left.startMs === right.startMs && left.endMs === right.endMs) ||
    (left.startMs < right.endMs && right.startMs < left.endMs)
  );
}
function joinCandidateText(left: string, right: string): string {
  if (left === right) return left;
  return `${left}\n${right}`;
}
function addBatchCandidate(
  candidates: BatchCandidate[],
  segment: StoredSegment,
  queryIndex: number,
  order: number,
): void {
  let target = candidates.find((candidate) => spansOverlap(candidate, segment));
  if (!target) {
    candidates.push({
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.text,
      segmentIds: new Set([segment.id]),
      queryIndexes: new Set([queryIndex]),
      firstOrder: order,
    });
    return;
  }
  if (target.segmentIds.has(segment.id)) {
    target.queryIndexes.add(queryIndex);
    return;
  }
  const joined = joinCandidateText(target.text, segment.text);
  target.startMs = Math.min(target.startMs, segment.startMs);
  target.endMs = Math.max(target.endMs, segment.endMs);
  target.text = joined;
  target.segmentIds.add(segment.id);
  target.queryIndexes.add(queryIndex);
  target.firstOrder = Math.min(target.firstOrder, order);
  for (let index = candidates.length - 1; index >= 0; index--) {
    const candidate = candidates[index]!;
    if (candidate === target || !spansOverlap(target, candidate)) continue;
    const merged = joinCandidateText(target.text, candidate.text);
    target.startMs = Math.min(target.startMs, candidate.startMs);
    target.endMs = Math.max(target.endMs, candidate.endMs);
    target.text = merged;
    for (const id of candidate.segmentIds) target.segmentIds.add(id);
    for (const matched of candidate.queryIndexes) {
      target.queryIndexes.add(matched);
    }
    target.firstOrder = Math.min(target.firstOrder, candidate.firstOrder);
    candidates.splice(index, 1);
  }
}
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function batchHits(
  matches: readonly Readonly<{
    segment: StoredSegment;
    queryIndex: number;
    order: number;
  }>[],
  queries: readonly string[],
): {
  hits: Array<{
    startMs: number;
    endMs: number;
    text: string;
    matchedQueries: string[];
  }>;
  candidateHitCount: number;
  omittedHits: number;
  returnedCharacters: number;
  duplicateSpansEliminated: number;
} {
  const candidates: BatchCandidate[] = [];
  for (const match of matches) {
    addBatchCandidate(candidates, match.segment, match.queryIndex, match.order);
  }
  const sorted = [...candidates].sort(
    (left, right) =>
      left.startMs - right.startMs ||
      left.endMs - right.endMs ||
      left.firstOrder - right.firstOrder ||
      compareText(left.text, right.text),
  );
  const hits: Array<{
    startMs: number;
    endMs: number;
    text: string;
    matchedQueries: string[];
  }> = [];
  let returnedCharacters = 0;
  let omittedHits = 0;
  for (const candidate of sorted) {
    if (
      hits.length >= MAX_TRANSCRIPT_BATCH_HITS ||
      returnedCharacters + candidate.text.length >
        MAX_TRANSCRIPT_BATCH_CHARACTERS
    ) {
      omittedHits += 1;
      continue;
    }
    returnedCharacters += candidate.text.length;
    hits.push({
      startMs: candidate.startMs,
      endMs: candidate.endMs,
      text: candidate.text,
      matchedQueries: queries.filter((_, index) =>
        candidate.queryIndexes.has(index)
      ),
    });
  }
  return {
    hits,
    candidateHitCount: candidates.length,
    omittedHits,
    returnedCharacters,
    duplicateSpansEliminated: matches.length - candidates.length,
  };
}

export class EvidenceService {
  readonly resolver: SourceResolver;
  readonly transcripts: TranscriptAcquirer;
  readonly overviews: OverviewAcquirer;
  readonly frames: FrameAcquirer;
  readonly framePanels: FramePanelAcquirer;
  readonly visualAnalyzer: VisualAnalyzer;
  readonly discovery: DiscoveryAcquirer;
  readonly singleflight = new Singleflight();
  readonly #pendingRefinements = new Map<InvestigationRef, Set<number>>();

  constructor(
    readonly config: UrmaConfig,
    readonly store: UrmaStore,
    readonly blobs: BlobStore,
    remoteContext: RemoteOperationContext | null = null,
  ) {
    this.resolver = new SourceResolver(config, store, remoteContext, null, blobs);
    this.transcripts = new TranscriptAcquirer(config, store, blobs, remoteContext);
    this.overviews = new OverviewAcquirer(config, store, blobs, remoteContext);
    this.frames = new FrameAcquirer(config, store, blobs, undefined, remoteContext);
    this.framePanels = new FramePanelAcquirer(config, store, blobs);
    this.visualAnalyzer = new VisualAnalyzer(config, blobs);
    this.discovery = new DiscoveryAcquirer(config, store, this.frames, this.visualAnalyzer);
  }

  /** Record shared frame artifacts under this investigation's source. */
  #admitFrameArtifacts(
    source: Pick<ResolvedSource, "sourceRef" | "revision" | "kind">,
    frames: readonly ExactFrameResult[],
    crop?: FrameCrop,
  ): ExactFrameResult[] {
    return frames.map((frame) => {
      const artifact: StoredArtifact = {
        ...frame.artifact,
        sourceRef: source.sourceRef,
        sourceRevision: source.revision,
      };
      this.store.putArtifact(
        artifact,
        {
          requestKey: exactFrameRequestKey(source, frame.atMs, crop),
          operation: "frame",
        },
      );
      return { ...frame, artifact };
    });
  }

  #admitFrameOutcomes(
    source: Pick<ResolvedSource, "sourceRef" | "revision" | "kind">,
    outcomes: readonly FrameTargetOutcome[],
    crop?: FrameCrop,
  ): FrameTargetOutcome[] {
    return outcomes.map((outcome) => {
      if (outcome.status !== "success") return outcome;
      const [admitted] = this.#admitFrameArtifacts(source, [outcome], crop);
      return { ...outcome, artifact: admitted!.artifact };
    });
  }

  async inspectVideo(
    input: { source: string; freshness?: Freshness | undefined },
    signal?: AbortSignal,
  ) {
    const startedMonotonic = performance.now();
    const startedAt = new Date().toISOString();
    const resolved = await this.resolver.resolve(
      input.source,
      signal,
      input.freshness ?? "reuse",
    );
    const investigationRef = createInvestigationRef();
    const now = new Date().toISOString();
    this.store.createInvestigation({
      investigationRef,
      sourceRef: resolved.source.sourceRef,
      sourceRevision: resolved.source.revision,
      durationMs: resolved.source.durationMs,
      createdAt: now,
      updatedAt: now,
    });
    const call = startAcquisition(this.store, {
      sourceRef: resolved.source.sourceRef,
      sourceRevision: resolved.source.revision,
      investigationRef,
      operation: "tool:inspect_video",
      requestKey: deterministicRequestKey(
        resolved.source.revision,
        "inspect_video",
        {},
        "evidence-api",
      ),
      method: resolved.cacheHit
        ? "cache"
        : resolved.source.kind === "remote"
        ? "yt-dlp-metadata"
        : "local-file",
      startedMonotonic,
      startedAt,
      debug: this.config.debug,
    });
    const versions = resolved.cacheHit
      ? unknownBinaryVersions()
      : await collectBinaryVersions(
        this.config,
        resolved.source.kind === "remote" ? ["ytdlp"] : ["ffprobe"],
        signal,
      );
    call.succeed({
      networkBytes: resolved.cacheHit || resolved.source.kind === "local"
        ? 0
        : null,
      networkAccountingComplete: resolved.cacheHit ||
        resolved.source.kind === "local",
      metadata: { cacheHit: resolved.cacheHit, ...versions },
    });
    const state = deriveInvestigationState(this.store, investigationRef);
    const intervals = state.cache.continuousMediaIntervals;
    const safe = resolved.source.safeMetadata;
    const tracks = resolved.source.captionTracks;
    return {
      sourceRef: resolved.source.sourceRef,
      investigationRef,
      source: {
        kind: resolved.source.kind,
        observedAt: resolved.source.observedAt,
        snapshotRevision: resolved.source.revision,
        metadataDurationMs: resolved.source.metadataDurationMs,
        timeline: resolved.source.timeline,
        extractor: resolved.source.extractor,
        extractorKey: resolved.source.extractorKey,
        safeOrigins: resolved.source.safeOrigins,
        title: resolved.source.title,
        titlePartial: safe.titlePartial === true,
        durationMs: resolved.source.durationMs,
        chapters: resolved.source.chapters,
        chapterCount: typeof safe.chapterCount === "number"
          ? safe.chapterCount
          : resolved.source.chapters.length,
        chaptersPartial: safe.chaptersPartial === true,
      },
      capabilities: resolved.source.capabilities,
      captionTracks: tracks.slice(0, MAX_INSPECT_TRACKS).map(publicTrack),
      captionTrackCount: tracks.length,
      captionTracksPartial: tracks.length > MAX_INSPECT_TRACKS,
      cache: {
        transcriptTracks: state.cache.transcriptTracks,
        storyboard: state.cache.storyboard,
        navigationCopy: state.cache.navigationCopy,
        continuousMediaIntervalCount: intervals.length,
        continuousMediaIntervals: intervals.slice(-MAX_CACHE_INTERVAL_SUMMARY),
        partial: intervals.length > MAX_CACHE_INTERVAL_SUMMARY,
        reusableArtifacts: state.cache.reusableArtifacts,
      },
      stateSummary: compactState(state),
      stateResource: compactState(state).stateResource,
    };
  }

  async searchTranscript(input: SearchInput, signal?: AbortSignal) {
    const source = resolvedFromInvestigation(
      this.store,
      input.investigationRef,
    );
    const selected = selectTrack(source, input.trackRef);
    const requested = normalizeSearchInput(input);
    const limit = input.limit ?? DEFAULT_TRANSCRIPT_SEARCH_RESULTS;
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_TRANSCRIPT_SEARCH_RESULTS
    ) {
      throw new UrmaError(
        "OUTPUT_LIMIT_EXCEEDED",
        `Transcript search limit must be an integer from 1 to ${MAX_TRANSCRIPT_SEARCH_RESULTS}; received ${
          String(limit)
        }`,
      );
    }
    const mode = input.mode ?? "phrase";
    const candidateLimit = Math.min(
      MAX_TRANSCRIPT_SEARCH_CANDIDATES,
      Math.max(100, limit * 10),
    );
    const requestParameters = requested.batch
      ? { queries: requested.queries, trackRef: selected.trackRef, mode, limit }
      : {
        query: requested.queries[0]!,
        trackRef: selected.trackRef,
        mode,
        limit,
      };
    const call = startAcquisition(this.store, {
      sourceRef: source.sourceRef,
      sourceRevision: source.revision,
      investigationRef: input.investigationRef,
      operation: "tool:search_transcript",
      requestKey: deterministicRequestKey(
        source.revision,
        "search_transcript",
        requestParameters,
        "evidence-api",
      ),
      method: "cache",
      debug: this.config.debug,
    });
    try {
      const transcript = await this.singleflight.run(
        `transcript:${source.revision}:${selected.trackRef}`,
        signal,
        (sharedSignal) =>
          this.transcripts.ensure(
            source,
            input.investigationRef,
            selected.trackRef,
            sharedSignal,
          ),
      );
      const all = transcript.segments;
      if (!requested.batch) {
        const query = requested.queries[0]!;
        const search = searchSegments(all, query, mode, candidateLimit);
        const candidates = search.matches;
        const hits = candidates
          .slice(0, limit)
          .map((match) => hitForSegment(all, match));
        const candidateHitCount = candidates.length;
        const candidateCountComplete = search.complete;
        const omittedHits = search.complete
          ? Math.max(0, candidateHitCount - hits.length)
          : null;
        const partial = !search.complete ||
          (omittedHits !== null && omittedHits > 0);
        this.store.addPresentation({
          id: randomUUID(),
          investigationRef: input.investigationRef,
          artifactId: transcript.artifact.artifactId,
          modality: "transcript",
          evidenceKind: "transcript_search",
          startMs: hits.length
            ? Math.min(...hits.map((hit) => hit.startMs))
            : null,
          endMs: hits.length ? Math.max(...hits.map((hit) => hit.endMs)) : null,
          pointsMs: null,
          metadata: {
            query,
            mode,
            trackId: transcript.track.id,
            trackRef: selected.trackRef,
            language: selected.language,
            kind: selected.kind,
            displayName: selected.displayName,
            providerTrackId: selected.providerTrackId,
            ...(selected.embedded ? { embedded: selected.embedded } : {}),
            hitCount: hits.length,
            candidateHitCount,
            candidateCountComplete,
            omittedHits,
            partial,
            scope: "selected-caption-track",
            searchIndex: "normalized-literal-scan",
          },
          presentedAt: new Date().toISOString(),
        });
        const output = {
          query,
          mode,
          scope: "selected-caption-track" as const,
          track: publicTrack(selected),
          hits,
          candidateHitCount,
          candidateCountComplete,
          omittedHits,
          partial,
          matchSemantics:
            "NFKC-normalized, lowercased literal substring matching over caption cue text",
          missMeaning: hits.length === 0
            ? partial
              ? "No match was surfaced by the bounded search of the selected caption track; completeness was not established."
              : "No match was found in the selected caption track; this does not establish absence from the video."
            : null,
          stateSummary: compactState(
            deriveInvestigationState(this.store, input.investigationRef),
          ),
        };
        call.succeed({
          networkBytes: 0,
          networkAccountingComplete: true,
          metadata: {
            batch: false,
            trackRef: selected.trackRef,
            hitCount: hits.length,
            candidateHitCount,
            omittedHits,
            logicalQueries: 1,
            uniqueHits: hits.length,
            resultCharacters: hits.reduce(
              (sum, hit) =>
                sum +
                hit.text.length +
                hit.context.reduce(
                  (nested, context) => nested + context.text.length,
                  0,
                ),
              0,
            ),
            resultBytes: Buffer.byteLength(JSON.stringify(output)),
            cacheHit: transcript.cacheHit,
            partial,
          },
        });
        return output;
      }
      const matches: Array<{
        segment: StoredSegment;
        queryIndex: number;
        order: number;
      }> = [];
      let order = 0;
      let candidateCountComplete = true;
      const normalizedBodies: Array<string | undefined> | undefined =
        requested.queries.length > 1 ? [] : undefined;
      for (const [queryIndex, query] of requested.queries.entries()) {
        const search = searchSegments(all, query, mode, candidateLimit, normalizedBodies);
        candidateCountComplete &&= search.complete &&
          search.matches.length <= limit;
        const seen = new Set<number>();
        for (const segment of search.matches.slice(0, limit)) {
          if (seen.has(segment.id)) continue;
          seen.add(segment.id);
          matches.push({ segment, queryIndex, order });
          order += 1;
        }
      }
      const merged = batchHits(matches, requested.queries);
      const hits = merged.hits;
      const omittedHits = candidateCountComplete ? merged.omittedHits : null;
      const partial = !candidateCountComplete || merged.omittedHits > 0;
      this.store.addPresentation({
        id: randomUUID(),
        investigationRef: input.investigationRef,
        artifactId: transcript.artifact.artifactId,
        modality: "transcript",
        evidenceKind: "transcript_search",
        startMs: hits.length
          ? Math.min(...hits.map((hit) => hit.startMs))
          : null,
        endMs: hits.length ? Math.max(...hits.map((hit) => hit.endMs)) : null,
        pointsMs: null,
        metadata: {
          queries: requested.queries,
          mode,
          trackId: transcript.track.id,
          trackRef: selected.trackRef,
          language: selected.language,
          kind: selected.kind,
          displayName: selected.displayName,
          providerTrackId: selected.providerTrackId,
          ...(selected.embedded ? { embedded: selected.embedded } : {}),
          hitCount: hits.length,
          candidateHitCount: merged.candidateHitCount,
          candidateCountComplete,
          omittedHits,
          partial,
          duplicateSpansEliminated: merged.duplicateSpansEliminated,
          scope: "selected-caption-track",
          searchIndex: "normalized-literal-scan",
        },
        presentedAt: new Date().toISOString(),
      });
      const output = {
        queries: requested.queries,
        mode,
        scope: "selected-caption-track" as const,
        track: publicTrack(selected),
        hits,
        candidateHitCount: merged.candidateHitCount,
        candidateCountComplete,
        omittedHits,
        returnedCharacters: merged.returnedCharacters,
        partial,
        matchSemantics:
          "NFKC-normalized, lowercased literal substring matching over caption cue text; overlapping spans merged",
        missMeaning: hits.length === 0
          ? partial
            ? "No match was surfaced by the bounded search of the selected caption track; completeness was not established."
            : "No match was found for any query in the selected caption track; this does not establish absence from the video."
          : null,
        stateSummary: compactState(
          deriveInvestigationState(this.store, input.investigationRef),
        ),
      };
      call.succeed({
        networkBytes: 0,
        networkAccountingComplete: true,
        metadata: {
          batch: true,
          trackRef: selected.trackRef,
          hitCount: hits.length,
          candidateHitCount: merged.candidateHitCount,
          omittedHits,
          duplicateSpansEliminated: merged.duplicateSpansEliminated,
          logicalQueries: requested.queries.length,
          uniqueHits: hits.length,
          resultCharacters: merged.returnedCharacters,
          resultBytes: Buffer.byteLength(JSON.stringify(output)),
          cacheHit: transcript.cacheHit,
          partial,
        },
      });
      return output;
    } catch (error) {
      call.fail(error);
      throw error;
    }
  }

  async readTranscript(
    input: {
      investigationRef: InvestigationRef;
      startMs: number;
      endMs: number;
      trackRef?: string;
      cursor?: string;
    },
    signal?: AbortSignal,
  ) {
    const source = resolvedFromInvestigation(
      this.store,
      input.investigationRef,
    );
    assertInterval(input.startMs, input.endMs, source.durationMs);
    const selected = selectTrack(source, input.trackRef);
    const call = startAcquisition(this.store, {
      sourceRef: source.sourceRef,
      sourceRevision: source.revision,
      investigationRef: input.investigationRef,
      operation: "tool:read_transcript",
      requestKey: deterministicRequestKey(
        source.revision,
        "read_transcript",
        {
          startMs: input.startMs,
          endMs: input.endMs,
          trackRef: selected.trackRef,
          cursor: input.cursor ?? null,
        },
        "evidence-api",
      ),
      method: "cache",
      debug: this.config.debug,
    });
    try {
      const transcript = await this.singleflight.run(
        `transcript:${source.revision}:${selected.trackRef}`,
        signal,
        (sharedSignal) =>
          this.transcripts.ensure(
            source,
            input.investigationRef,
            selected.trackRef,
            sharedSignal,
          ),
      );
      const startOrdinal = parseCursor(
        input.cursor,
        transcript.track.id,
        input.startMs,
        input.endMs,
      );
      const candidates = transcript.segments.filter(
        (segment) =>
          segment.ordinal >= startOrdinal &&
          segment.endMs > input.startMs &&
          segment.startMs < input.endMs,
      );
      const returned: StoredSegment[] = [];
      let characters = 0;
      for (const segment of candidates) {
        if (
          returned.length >= MAX_TRANSCRIPT_SEGMENTS ||
          characters + segment.text.length > MAX_TRANSCRIPT_CHARACTERS
        ) {
          break;
        }
        returned.push(segment);
        characters += segment.text.length;
      }
      const last = returned.at(-1);
      const partial = returned.length < candidates.length;
      const nextCursor = partial && last
        ? cursor(
          transcript.track.id,
          last.ordinal + 1,
          input.startMs,
          input.endMs,
        )
        : null;
      if (partial && !nextCursor) {
        throw new UrmaError(
          "OUTPUT_LIMIT_EXCEEDED",
          `A caption segment exceeds the ${MAX_TRANSCRIPT_CHARACTERS}-character response ceiling and cannot be represented safely`,
        );
      }
      if (returned.length) {
        this.store.addPresentation({
          id: randomUUID(),
          investigationRef: input.investigationRef,
          artifactId: transcript.artifact.artifactId,
          modality: "transcript",
          evidenceKind: "transcript_range",
          startMs: returned[0]!.startMs,
          endMs: last!.endMs,
          pointsMs: null,
          metadata: {
            trackId: transcript.track.id,
            trackRef: selected.trackRef,
            language: selected.language,
            kind: selected.kind,
            displayName: selected.displayName,
            providerTrackId: selected.providerTrackId,
            ...(selected.embedded ? { embedded: selected.embedded } : {}),
            requestedStartMs: input.startMs,
            requestedEndMs: input.endMs,
            partial,
          },
          presentedAt: new Date().toISOString(),
        });
      }
      call.succeed({
        networkBytes: 0,
        networkAccountingComplete: true,
        metadata: {
          trackRef: selected.trackRef,
          segments: returned.length,
          partial,
        },
      });
      return {
        requestedRange: { startMs: input.startMs, endMs: input.endMs },
        returnedRange: returned.length
          ? { startMs: returned[0]!.startMs, endMs: last!.endMs }
          : null,
        track: publicTrack(selected),
        segments: returned.map(({ startMs, endMs, text }) => ({
          startMs,
          endMs,
          text,
        })),
        partial,
        nextCursor,
        stateSummary: compactState(
          deriveInvestigationState(this.store, input.investigationRef),
        ),
      };
    } catch (error) {
      call.fail(error);
      throw error;
    }
  }

  async getOverview(
    input: {
      investigationRef: InvestigationRef;
      startMs?: number;
      endMs?: number;
      rulers?: boolean;
    },
    signal?: AbortSignal,
  ) {
    const source = resolvedFromInvestigation(
      this.store,
      input.investigationRef,
    );
    const startMs = input.startMs ?? 0;
    const endMs = input.endMs ?? source.durationMs;
    assertInterval(startMs, endMs, source.durationMs);
    const call = startAcquisition(this.store, {
      sourceRef: source.sourceRef,
      sourceRevision: source.revision,
      investigationRef: input.investigationRef,
      operation: "tool:get_overview",
      requestKey: deterministicRequestKey(
        source.revision,
        "get_overview",
        { startMs, endMs, ...(input.rulers ? { rulers: true } : {}) },
        "evidence-api",
      ),
      method: "ffmpeg-panel",
      debug: this.config.debug,
    });
    try {
      const key = deterministicRequestKey(
        source.revision,
        "overview",
        { startMs, endMs, count: OVERVIEW_CELL_COUNT, ...(input.rulers ? { rulers: true } : {}) },
        OVERVIEW_CONTRACT_ID,
      );
      const overview = await this.singleflight.run(
        `overview:${key}`,
        signal,
        (sharedSignal) =>
          this.overviews.get(
            source,
            input.investigationRef,
            startMs,
            endMs,
            sharedSignal,
            input.rulers === true,
          ),
      );
      const artifactResource = investigationArtifactUri(
        input.investigationRef,
        overview.artifact.artifactId,
      );
      const cells = overview.cells.map((cell) => ({
        ...cell,
        artifactId: overview.artifact.artifactId,
        resource: artifactResource,
      }));
      const sampleReuse = overviewSampleReuse(
        this.store,
        input.investigationRef,
        source.durationMs,
        startMs,
        endMs,
        overview,
      );
      const spacingMs = adjacentSpacingMs(overview.pointsMs);
      const observedCoverage = {
        kind: "sample-points-only" as const,
        continuous: false as const,
        sampleTimestampsMs: overview.pointsMs,
        adjacentSpacingMs: spacingMs,
      };
      this.store.addPresentation({
        id: randomUUID(),
        investigationRef: input.investigationRef,
        artifactId: overview.artifact.artifactId,
        modality: "visual",
        evidenceKind: "sparse",
        startMs,
        endMs,
        pointsMs: overview.pointsMs,
        metadata: {
          role: "locator",
          source: overview.source,
          overviewContractId: OVERVIEW_CONTRACT_ID,
          requestedCount: OVERVIEW_CELL_COUNT,
          actualCount: overview.pointsMs.length,
          requestedPointsMs: overview.requestedPointsMs,
          sampleIds: overview.cells.map((cell) => cell.provenance.sampleId),
          sourceArtifactId: overviewSourceArtifactId(overview.cells),
          cells: overview.cells,
          sampleReuse,
          observedCoverage,
        },
        presentedAt: new Date().toISOString(),
      });
      call.succeed({
        networkBytes: 0,
        networkAccountingComplete: true,
        metadata: {
          artifactId: overview.artifact.artifactId,
          cacheHit: overview.cacheHit,
          requestedImageCount: OVERVIEW_CELL_COUNT,
          imageCount: overview.pointsMs.length,
          imageBytes: overview.artifact.byteSize,
          reusedUnderlyingSamples: sampleReuse.reusedUnderlyingSamples,
          samplingRelation: sampleReuse.relation,
        },
      });
      const stateSummary = compactState(
        deriveInvestigationState(this.store, input.investigationRef),
      );
      return {
        role: "locator" as const,
        sparse: true,
        continuousInspection: false,
        requestedCount: OVERVIEW_CELL_COUNT,
        actualCount: overview.pointsMs.length,
        interval: { startMs, endMs },
        requestedInterval: { startMs, endMs },
        timebase: "source-global" as const,
        observedCoverage,
        samplingGaps: summarizeSamplingGaps(
          startMs, endMs, overview.pointsMs, "nominal",
        ),
        sampling: {
          requestedCount: OVERVIEW_CELL_COUNT,
          requestedPointsMs: overview.requestedPointsMs,
          returnedCount: overview.pointsMs.length,
          adjacentSpacingMs: spacingMs,
          resolutionMs: null,
          sampleReuse,
        },
        cells,
        source: overview.source,
        artifact: {
          artifactId: overview.artifact.artifactId,
          mimeType: overview.artifact.mimeType,
          byteSize: overview.artifact.byteSize,
          resource: artifactResource,
        },
        cacheHit: overview.cacheHit,
        ...(input.rulers ? { rulers: true as const } : {}),
        stateSummary,
      };
    } catch (error) {
      call.fail(error);
      throw error;
    }
  }

  async #getCadenceFrames(
    input: {
      investigationRef: InvestigationRef;
      request?: {
        kind: "cadence";
        startMs: number;
        endMs: number;
        cadenceMs: number;
      };
      cursor?: string;
      pageSize?: number;
      maxTargets?: number;
      presentation: "individual" | "panel";
      crop?: FrameCrop;
      rulers?: boolean;
      diffHints?: boolean;
      deduplicate?: boolean;
    },
    source: ResolvedSource,
    signal?: AbortSignal,
  ) {
    const trace = currentExactFrameDiagnosticTrace();
    const invalidCadence = (message: string, cause?: unknown): never => {
      throw new UrmaError("INVALID_SOURCE", message, { cause });
    };
    const invalidCursor = (cause?: unknown): never =>
      invalidCadence(
        "Cadence cursor is invalid or incompatible with this evidence; restart the schedule without a cursor",
        cause,
      );
    const numberField = (
      payload: FrameScheduleCursorPayload,
      field: keyof FrameScheduleCursorPayload,
    ): number => {
      const value = payload[field];
      if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        return invalidCursor(new Error(`invalid cursor field ${field}`));
      }
      return value;
    };

    let schedule: FixedCadenceSchedule;
    let totalTargets: number;
    let nextIndex = 0;
    let cursorPayload: FrameScheduleCursorPayload | null = null;
    if (input.cursor !== undefined) {
      if (input.request !== undefined) invalidCursor();
      cursorPayload = parseScheduleCursor(input.cursor);
      if (input.crop !== undefined && stableJson(input.crop) !== stableJson(cursorPayload.crop ?? null)) invalidCursor();
      if (cursorPayload.crop !== undefined) input = { ...input, crop: validateFrameCrop(cursorPayload.crop) };
      if (
        (cursorPayload.v !== 1 && cursorPayload.v !== 2) ||
        cursorPayload.kind !== "fixed-cadence" ||
        cursorPayload.investigationRef !== input.investigationRef
      ) {
        invalidCursor();
      }
      schedule = {
        startMs: numberField(cursorPayload, "startMs"),
        endMs: numberField(cursorPayload, "endMs"),
        cadenceMs: numberField(cursorPayload, "cadenceMs"),
      };
      try {
        totalTargets = fixedCadenceTargetCount(schedule, source.durationMs);
      } catch (error) {
        return invalidCursor(error);
      }
      nextIndex = numberField(cursorPayload, "nextIndex");
      if (
        numberField(cursorPayload, "totalTargets") !== totalTargets ||
        nextIndex < 0 ||
        nextIndex >= totalTargets
      ) {
        invalidCursor();
      }
    } else {
      if (input.request === undefined) {
        return invalidCadence("Cadence requires a schedule definition");
      }
      schedule = input.request;
      try {
        totalTargets = fixedCadenceTargetCount(schedule, source.durationMs);
      } catch (error) {
        return invalidCadence(
          `Cadence schedule is invalid: ${
            error instanceof Error ? error.message : String(error)
          }`,
          error,
        );
      }
    }

    const serverPageMaximum = this.config.limits.maxFrameSchedulePageTargets;
    const pageSize = input.pageSize ?? serverPageMaximum;
    if (
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > serverPageMaximum
    ) {
      throw new UrmaError(
        "OUTPUT_LIMIT_EXCEEDED",
        `Cadence pageSize must be an integer from 1 to ${serverPageMaximum}; received ${
          String(pageSize)
        }`,
        { detail: { requestedPageSize: pageSize, maximum: serverPageMaximum } },
      );
    }

    const serverTotalMaximum = this.config.limits.maxFrameScheduleTargets;
    if (
      input.maxTargets !== undefined &&
      (!Number.isSafeInteger(input.maxTargets) || input.maxTargets < 1)
    ) {
      throw new UrmaError(
        "INVALID_SOURCE",
        `Cadence maxTargets must be a positive safe integer; received ${
          String(input.maxTargets)
        }`,
      );
    }
    const applicableMaximum = Math.min(
      serverTotalMaximum,
      input.maxTargets ?? serverTotalMaximum,
    );
    if (totalTargets > applicableMaximum) {
      throw new UrmaError(
        "OUTPUT_LIMIT_EXCEEDED",
        `Cadence schedule contains ${totalTargets} targets; maximum admitted is ${applicableMaximum}`,
        {
          detail: {
            computedTargetCount: totalTargets,
            applicableMaximum,
            serverMaximum: serverTotalMaximum,
            callerMaximum: input.maxTargets ?? null,
          },
        },
      );
    }

    const representation = stableJson(
      input.crop
        ? { representation: frameEvidenceRepresentation(this.config, source), crop: input.crop }
        : frameEvidenceRepresentation(this.config, source),
    );
    const representationDigest = sha256(representation);
    if (cursorPayload !== null) {
      const cursorRepresentation = cursorPayload.v === 1
        ? cursorPayload.representation
        : cursorPayload.representationDigest;
      if (
        cursorPayload.sourceRef !== source.sourceRef ||
        cursorPayload.sourceRevision !== source.revision ||
        cursorPayload.durationMs !== source.durationMs ||
        cursorRepresentation !==
          (cursorPayload.v === 1 ? representation : representationDigest) ||
        cursorPayload.timeline !== FRAME_TIMELINE_VERSION ||
        cursorPayload.selection !== FRAME_SELECTION_CONTRACT_VERSION ||
        cursorPayload.policy !== FRAME_SCHEDULE_POLICY_VERSION ||
        cursorPayload.startMs !== schedule.startMs ||
        cursorPayload.endMs !== schedule.endMs ||
        cursorPayload.cadenceMs !== schedule.cadenceMs
      ) {
        invalidCursor();
      }
    }

    const pageEnd = Math.min(totalTargets, nextIndex + pageSize);
    const timesMs = fixedCadenceTargets(
      schedule,
      nextIndex,
      pageEnd,
      source.durationMs,
    );
    trace?.setSource(source.sourceRef, source.durationMs);
    trace?.setRequestedTimestamps(timesMs);
    const call = startAcquisition(this.store, {
      sourceRef: source.sourceRef,
      sourceRevision: source.revision,
      investigationRef: input.investigationRef,
      operation: "tool:get_frames",
      requestKey: deterministicRequestKey(
        source.revision,
        "get_frames",
        {
          schedule,
          pageStartIndex: nextIndex,
          pageSize,
          presentation: input.presentation,
          ...(input.crop ? { crop: input.crop } : {}),
          ...(input.rulers ? { rulers: true } : {}),
        },
        "evidence-api",
      ),
      method: input.presentation === "panel" ? "ffmpeg-panel" : "ffmpeg-decode",
      debug: this.config.debug,
    });
    try {
      const key = deterministicRequestKey(
        source.revision,
        "frames",
        { timesMs, ...(input.crop ? { crop: input.crop } : {}) },
        "frame-batch",
      );
      const sharedOutcomes = await this.singleflight.run(
        `frames:schedule:${key}`,
        signal,
        (sharedSignal) =>
          this.frames.getOutcomes(
            source,
            input.investigationRef,
            timesMs,
            sharedSignal,
            input.crop,
          ),
      );
      const outcomes = this.#admitFrameOutcomes(source, sharedOutcomes, input.crop);
      const indexedFrames = outcomes.flatMap((outcome, index) => outcome.status === "success" ? [{ ...outcome, index: nextIndex + index }] : []);
      const grouping = input.deduplicate ? await this.#groupFrames(source, input.investigationRef, indexedFrames, signal) : undefined;
      const representativeIndices = new Set(grouping?.groups.map((group) => group.representativeIndex));
      const displayedFrames = grouping ? indexedFrames.filter((frame) => representativeIndices.has(frame.index)) : indexedFrames;
      const deltaHints = input.diffHints ? await this.#analyzeHints(source, input.investigationRef,
        indexedFrames, signal) : undefined;
      const previews = await this.#framePreviews(source, input.investigationRef,
        displayedFrames,
        input.rulers === true && (input.presentation === "individual" || outcomes.some((outcome) => outcome.status !== "success")), signal);
      const slots = outcomes.map((outcome, offset) => {
        const index = nextIndex + offset;
        const timing = {
          requestedAtMs: outcome.atMs,
          selectedPresentationTimeMs: null,
          status: "unavailable" as const,
        };
        if (outcome.status === "success") {
          return {
            index,
            requestedAtMs: outcome.atMs,
            status: "success" as const,
            timing,
            artifactId: outcome.artifact.artifactId,
            mimeType: outcome.artifact.mimeType,
            byteSize: outcome.artifact.byteSize,
            resource: investigationArtifactUri(
              input.investigationRef,
              outcome.artifact.artifactId,
            ),
            cacheHit: outcome.cacheHit,
            ...cropFields(outcome.artifact),
            ...(previews.get(outcome.atMs) ? { preview: previews.get(outcome.atMs)! } : {}),
          };
        }
        if (outcome.status === "error") {
          const normalized = normalizeError(outcome.error);
          if (normalized.code !== "CANCELLED") {
            return {
              index,
              requestedAtMs: outcome.atMs,
              status: "error" as const,
              timing,
              error: {
                code: normalized.code,
                retryable: normalized.retryable,
                detail: redactModelText(normalized.message),
              },
            };
          }
        }
        return {
          index,
          requestedAtMs: outcome.atMs,
          status: "unfinished" as const,
          timing,
        };
      });
      let frontier = nextIndex;
      for (const slot of slots) {
        if (slot.status === "unfinished") break;
        frontier = slot.index + 1;
      }
      const successfulOutcomes = outcomes.filter(
        (
          outcome,
        ): outcome is Extract<FrameTargetOutcome, { status: "success" }> =>
          outcome.status === "success",
      );
      const allTerminal = slots.every((slot) => slot.status !== "unfinished");
      const panel = input.presentation === "panel" && allTerminal &&
          successfulOutcomes.length === slots.length
        ? await this.framePanels.get(
          source,
          displayedFrames.map((outcome) => ({
            atMs: outcome.atMs,
            artifact: outcome.artifact,
          })),
          signal,
          { rulers: input.rulers === true },
        )
        : null;
      if (grouping && panel) grouping.groups.forEach((group, index) => { group.panelIndex = index + 1; });
      const presentationArtifactIds = [
        ...(panel ? [panel.artifact.artifactId] : []),
        ...[...previews.values()].map((preview) => preview.artifactId),
      ];
      let presentedSuccesses = 0;
      for (const [offset, outcome] of outcomes.entries()) {
        if (outcome.status !== "success") continue;
        this.store.addPresentation({
          id: randomUUID(),
          investigationRef: input.investigationRef,
          artifactId: outcome.artifact.artifactId,
          modality: "visual",
          evidenceKind: "point",
          startMs: outcome.atMs,
          endMs: outcome.atMs,
          pointsMs: [outcome.atMs],
          metadata: {
            atMs: outcome.atMs,
            requestedAtMs: outcome.atMs,
            schedulePolicy: FRAME_SCHEDULE_POLICY_VERSION,
            scheduleIndex: nextIndex + offset,
            role: "evidence",
            ...cropFields(outcome.artifact),
            ...(presentedSuccesses === 0 && grouping ? { deduplication: grouping } : {}),
            ...(presentedSuccesses === 0 && presentationArtifactIds.length
              ? { presentation: input.presentation, presentationArtifactIds }
              : {}),
          },
          presentedAt: new Date().toISOString(),
        });
        presentedSuccesses += 1;
      }
      const successCount = slots.filter((slot) =>
        slot.status === "success"
      ).length;
      const errorCount = slots.filter((slot) => slot.status === "error").length;
      const unfinishedCount = slots.length - successCount - errorCount;
      const nextCursor = frontier < totalTargets
        ? scheduleCursor({
          kind: "fixed-cadence",
          investigationRef: input.investigationRef,
          sourceRef: source.sourceRef,
          sourceRevision: source.revision,
          durationMs: source.durationMs,
          representation,
          timeline: FRAME_TIMELINE_VERSION,
          selection: FRAME_SELECTION_CONTRACT_VERSION,
          policy: FRAME_SCHEDULE_POLICY_VERSION,
          startMs: schedule.startMs,
          endMs: schedule.endMs,
          cadenceMs: schedule.cadenceMs,
          totalTargets,
          nextIndex: frontier,
          ...(input.crop ? { crop: input.crop } : {}),
        })
        : null;
      call.succeed({
        networkBytes: 0,
        networkAccountingComplete: true,
        metadata: {
          presentation: input.presentation,
          requestedTimestamps: timesMs,
          requestedFrameCount: timesMs.length,
          returnedFrameCount: successCount,
          timestampsRequested: timesMs.length,
          framesReturned: successCount,
          cacheHits: successfulOutcomes.filter((outcome) => outcome.cacheHit)
            .length,
          canonicalArtifactCount: successCount,
          imageCount: panel ? 1 : displayedFrames.length,
          imageBytes: panel
            ? panel.artifact.byteSize
            : displayedFrames.reduce(
              (sum, outcome) => sum + outcome.artifact.byteSize,
              0,
            ),
          scheduleComplete: frontier >= totalTargets,
          scheduleIndexFrontier: frontier,
          successCount,
          errorCount,
          unfinishedCount,
          ...(panel
            ? {
              canvasWidth: panel.dimensions.width,
              canvasHeight: panel.dimensions.height,
              cellCount: displayedFrames.length,
              panelCacheHit: panel.cacheHit,
            }
            : {}),
        },
      });
      const stateSummary = compactState(
        deriveInvestigationState(this.store, input.investigationRef),
      );
      const base = {
        kind: "scheduled_exact_points" as const,
        ...(grouping ? { deduplication: grouping } : {}),
        ...(deltaHints ? { diffHints: deltaHints } : {}),
        continuous: false as const,
        observations: "discrete-points" as const,
        samplingGaps: summarizeSamplingGaps(
          schedule.startMs,
          schedule.endMs,
          successfulOutcomes.map((outcome) => outcome.atMs),
          "requested",
        ),
        schedule: {
          kind: "fixed-cadence" as const,
          startMs: schedule.startMs,
          endMs: schedule.endMs,
          cadenceMs: schedule.cadenceMs,
          totalTargets,
          policyVersion: FRAME_SCHEDULE_POLICY_VERSION,
        },
        page: {
          startIndex: nextIndex,
          endIndexExclusive: pageEnd,
          pageSize,
        },
        slots,
        counts: {
          successes: successCount,
          errors: errorCount,
          unfinished: unfinishedCount,
        },
        continuationFrontier: frontier,
        remainingTargetCount: totalTargets - frontier,
        scheduleComplete: frontier >= totalTargets,
        nextCursor,
      };
      if (input.presentation === "panel") {
        return {
          ...base,
          presentation: "panel" as const,
          cells: slots.map((slot, index) =>
            slot.status === "success"
              ? {
                index: slot.index,
                panelIndex: panel ? grouping?.groups.find((group) => group.members.some((member) => member.index === slot.index))?.panelIndex ?? index + 1 : null,
                requestedAtMs: slot.requestedAtMs,
                status: slot.status,
                artifactId: slot.artifactId,
                mimeType: slot.mimeType,
                byteSize: slot.byteSize,
                resource: slot.resource,
                cacheHit: slot.cacheHit,
                ...(slot.crop ? { crop: slot.crop } : {}),
                ...(slot.preview ? { preview: slot.preview } : {}),
              }
              : {
                index: slot.index,
                panelIndex: null,
                requestedAtMs: slot.requestedAtMs,
                status: slot.status,
              }
          ),
          panel: panel
            ? {
              artifactId: panel.artifact.artifactId,
              mimeType: "image/jpeg" as const,
              byteSize: panel.artifact.byteSize,
              resource: investigationArtifactUri(
                input.investigationRef,
                panel.artifact.artifactId,
              ),
              width: panel.dimensions.width,
              height: panel.dimensions.height,
              cellCount: displayedFrames.length,
              cacheHit: panel.cacheHit,
              derived: true as const,
              canonical: false as const,
              ...(input.rulers ? { rulers: true as const, coordinateSpace: "individual-displayed-source" as const } : {}),
            }
            : null,
          stateSummary,
        };
      }
      return {
        ...base,
        presentation: "individual" as const,
        stateSummary,
      };
    } catch (error) {
      call.fail(error);
      throw error;
    }
  }

  async #framePreviews(
    source: ResolvedSource, ref: InvestigationRef, frames: readonly ExactFrameResult[],
    enabled: boolean, signal?: AbortSignal,
  ) {
    const previews = new Map<number, {
      artifactId: StoredArtifact["artifactId"]; resource: string; mimeType: "image/jpeg";
      byteSize: number; width: number; height: number; derived: true; canonical: false;
      rulers: true; coordinateSpace: "individual-displayed-source";
    }>();
    if (enabled) for (const frame of frames) {
      const preview = await this.framePanels.get(source, [frame], signal, { rulers: true, individual: true });
      previews.set(frame.atMs, {
        artifactId: preview.artifact.artifactId,
        resource: investigationArtifactUri(ref, preview.artifact.artifactId),
        mimeType: "image/jpeg", byteSize: preview.artifact.byteSize,
        width: preview.dimensions.width, height: preview.dimensions.height,
        derived: true, canonical: false, rulers: true, coordinateSpace: "individual-displayed-source",
      });
    }
    return previews;
  }

  async #analyzeHints(source: ResolvedSource, ref: InvestigationRef,
    frames: readonly (ExactFrameResult & { index: number })[], signal?: AbortSignal) {
    const call = startAcquisition(this.store, {
      sourceRef: source.sourceRef, sourceRevision: source.revision, investigationRef: ref,
      operation: "analyze:visual-delta", method: "ffmpeg-decode", debug: this.config.debug,
      requestKey: deterministicRequestKey(source.revision, "visual-delta", frames.map((frame) => ({ atMs: frame.atMs, artifactId: frame.artifact.artifactId })), "rgb-block-delta-v1"),
    });
    try {
      const result = { ...await this.visualAnalyzer.hints(frames, signal),
        sourceRef: source.sourceRef, sourceRevision: source.revision };
      if (Buffer.byteLength(JSON.stringify(result)) > 128 * 1024) throw new UrmaError("OUTPUT_LIMIT_EXCEEDED", "Visual diff hints exceed the 128 KiB analysis payload budget; request fewer frames");
      call.succeed({ networkBytes: 0, networkAccountingComplete: true, metadata: result });
      return result;
    } catch (error) { call.fail(error); throw error; }
  }

  async #groupFrames(source: ResolvedSource, ref: InvestigationRef,
    frames: readonly (ExactFrameResult & { index: number })[], signal?: AbortSignal) {
    const call = startAcquisition(this.store, {
      sourceRef: source.sourceRef, sourceRevision: source.revision, investigationRef: ref,
      operation: "analyze:frame-deduplication", method: "ffmpeg-decode", debug: this.config.debug,
      requestKey: deterministicRequestKey(source.revision, "frame-deduplication",
        frames.map((frame) => ({ index: frame.index, atMs: frame.atMs, artifactId: frame.artifact.artifactId })), FRAME_DEDUPLICATION_VERSION),
    });
    try {
      const result = await this.visualAnalyzer.group(frames, ref, signal);
      call.succeed({ networkBytes: 0, networkAccountingComplete: true, metadata: result });
      return result;
    } catch (error) { call.fail(error); throw error; }
  }

  async getFrames(
    input: Omit<FramesInput, "request" | "refinement" | "discovery"> & { request?: FramesInput["request"] | RefineRequest | DiscoveryRequest },
    signal?: AbortSignal,
  ): Promise<FrameResult<Awaited<ReturnType<EvidenceService["selectFrames"]>>> & { discovery?: DiscoveryResult }> {
    if (input.deduplicate !== undefined && typeof input.deduplicate !== "boolean") throw new UrmaError("INVALID_SOURCE", "deduplicate must be a boolean; omit it to retain the default presentation");
    const { request, ...rest } = input;
    if (request?.kind !== "discover") {
      return await this.selectFrames({ ...rest, ...(request ? { request } : {}) }, signal);
    }
    if (input.cursor !== undefined || input.pageSize !== undefined || input.maxTargets !== undefined) {
      throw new UrmaError("INVALID_SOURCE", "Discovery uses its own budget; cadence cursors, pageSize and maxTargets are not supported");
    }
    if (input.crop !== undefined) {
      const crop = validateFrameCrop(input.crop);
      rest.crop = crop;
    }
    const source = resolvedFromInvestigation(this.store, input.investigationRef);
    const call = startAcquisition(this.store, {
      sourceRef: source.sourceRef, sourceRevision: source.revision, investigationRef: input.investigationRef,
      operation: "analyze:visual-discovery", method: "ffmpeg-decode", debug: this.config.debug,
      requestKey: deterministicRequestKey(source.revision, "discovery", request, DISCOVERY_VERSION),
    });
    let discovered: DiscoveryResult;
    try {
      discovered = await this.discovery.get(source, input.investigationRef, request, signal);
      call.succeed({ networkBytes: 0, networkAccountingComplete: true, metadata: discovered });
    } catch (error) { call.fail(error); throw error; }
    const timesMs = discovered.candidates.map((candidate) => candidate.requestedAtMs);
    if (!timesMs.length) {
      const emptyCall = startAcquisition(this.store, {
        sourceRef: source.sourceRef, sourceRevision: source.revision, investigationRef: input.investigationRef,
        operation: "tool:get_frames", method: "cache", debug: this.config.debug,
        requestKey: deterministicRequestKey(source.revision, "get_frames", request, "evidence-api"),
      });
      emptyCall.succeed({ networkBytes: 0, networkAccountingComplete: true, metadata: { discovery: discovered, returnedFrameCount: 0 } });
      return { kind: "exact_points" as const, continuousMotion: false, frames: [], discovery: discovered,
        samplingGaps: summarizeSamplingGaps(discovered.interval.startMs, discovered.interval.endMs, [], "requested"),
        stateSummary: compactState(deriveInvestigationState(this.store, input.investigationRef)) };
    }
    const result = await this.#getFrames({ ...rest, request: { kind: "points", timesMs }, discovery: discovered }, signal);
    if ("schedule" in result) throw new UrmaError("INTERNAL_ERROR", "Discovery point retrieval unexpectedly returned a cadence schedule");
    const samplingGaps = summarizeSamplingGaps(discovered.interval.startMs, discovered.interval.endMs, timesMs, "requested");
    return { ...result, discovery: discovered, samplingGaps };
  }

  private async selectFrames(
    input: Omit<FramesInput, "request" | "refinement" | "discovery"> & { request?: FramesInput["request"] | RefineRequest },
    signal?: AbortSignal,
  ) {
    if (input.crop !== undefined) input = { ...input, crop: validateFrameCrop(input.crop) };
    const { request, ...rest } = input;
    if (request?.kind !== "refine") {
      return await this.#getFrames({ ...rest, ...(request ? { request } : {}) }, signal);
    }
    if (input.cursor !== undefined || input.pageSize !== undefined || input.maxTargets !== undefined) {
      throw new UrmaError("INVALID_SOURCE", "Refinement uses request.budget (1-12); cursor, pageSize and maxTargets apply only to cadence");
    }
    if (signal?.aborted) throw new UrmaError("CANCELLED", "Refinement was cancelled before timestamp selection");
    const source = resolvedFromInvestigation(this.store, input.investigationRef);
    const startMs = request.startMs ?? 0;
    const endMs = request.endMs ?? source.durationMs;
    try {
      assertInterval(startMs, endMs, source.durationMs);
    } catch (cause) {
      throw new UrmaError("INVALID_SOURCE", `Refinement range [${startMs},${endMs}) must be non-empty and within source duration ${source.durationMs} ms`, { cause });
    }
    if (!Number.isSafeInteger(request.budget) || request.budget < 1 || request.budget > 12) {
      throw new UrmaError("OUTPUT_LIMIT_EXCEEDED", `Refinement budget must be an integer from 1 to 12; received ${String(request.budget)}`);
    }
    const basis = request.basis ?? "visual";
    if (basis !== "visual" && basis !== "exact") throw new UrmaError("INVALID_SOURCE", "Refinement basis must be visual or exact");
    const history = () => {
      const evidence = deriveInvestigationState(this.store, input.investigationRef).evidence;
      return [
        ...evidence.exactVisualPoints.map((point) => point.atMs),
        ...evidence.orderedVisualSets.flatMap((set) => set.pointsMs),
        ...(basis === "visual" ? evidence.sparseVisualSets.flatMap((set) => set.pointsMs) : []),
      ];
    };
    const pending = this.#pendingRefinements.get(input.investigationRef) ?? new Set<number>();
    const timesMs = refineGapPoints(startMs, endMs, [...history(), ...pending], request.budget);
    this.#pendingRefinements.set(input.investigationRef, pending);
    timesMs.forEach((time) => pending.add(time));
    try {
      if (!timesMs.length) {
        const call = startAcquisition(this.store, {
          sourceRef: source.sourceRef, sourceRevision: source.revision,
          investigationRef: input.investigationRef, operation: "tool:get_frames",
          requestKey: deterministicRequestKey(source.revision, "get_frames", request, "evidence-api"),
          method: "cache", debug: this.config.debug,
        });
        call.succeed({ networkBytes: 0, networkAccountingComplete: true,
          metadata: { refinement: request, requestedTimestamps: [], returnedFrameCount: 0 } });
      }
      const result = timesMs.length ? await this.#getFrames({
        ...rest, request: { kind: "points", timesMs },
        refinement: { policy: "largest-gap-midpoint-v1", startMs, endMs, budget: request.budget, basis },
      }, signal) : {
        kind: "exact_points" as const, continuousMotion: false,
        frames: [], stateSummary: compactState(deriveInvestigationState(this.store, input.investigationRef)),
      };
      const gaps = summarizeSamplingGaps(startMs, endMs, history(), "requested");
      return {
        ...result,
        samplingGaps: summarizeSamplingGaps(startMs, endMs, timesMs, "requested"),
        refinement: {
          policy: "largest-gap-midpoint-v1" as const, budget: request.budget, basis,
          selectedTimesMs: timesMs,
          exhausted: refineGapPoints(startMs, endMs, history(), 1).length === 0,
          remainingGaps: { ...gaps, scope: "investigation" as const,
            timestampBasis: basis === "visual" ? "nominal-and-requested" as const : "requested" as const },
        },
      };
    } finally {
      timesMs.forEach((time) => pending.delete(time));
      if (!pending.size) this.#pendingRefinements.delete(input.investigationRef);
    }
  }

  async #getFrames(
    input: FramesInput,
    signal?: AbortSignal,
  ) {
    const presentation = input.presentation ?? "individual";
    if (
      input.cursor !== undefined &&
      input.request !== undefined
    ) {
      throw new UrmaError(
        "INVALID_SOURCE",
        "A cadence continuation cursor must be used without a new request",
      );
    }
    if (
      input.request !== undefined &&
      input.request.kind !== "cadence" &&
      (input.pageSize !== undefined || input.maxTargets !== undefined)
    ) {
      throw new UrmaError(
        "INVALID_SOURCE",
        "pageSize and maxTargets apply only to cadence schedules",
      );
    }
    return await withExactFrameDiagnostics(
      this.config.debug,
      { requestKind: input.request?.kind ?? "cadence", presentation },
      async (trace) => {
        const sourceStarted = performance.now();
        let source!: ResolvedSource;
        try {
          source = resolvedFromInvestigation(
            this.store,
            input.investigationRef,
          );
        } finally {
          trace?.addStage(
            "sourceResolutionMs",
            performance.now() - sourceStarted,
          );
        }
        if (input.cursor !== undefined || input.request?.kind === "cadence") {
          return await this.#getCadenceFrames(
            {
              investigationRef: input.investigationRef,
              ...(input.request?.kind === "cadence"
                ? { request: input.request }
                : {}),
              ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
              ...(input.pageSize === undefined
                ? {}
                : { pageSize: input.pageSize }),
              ...(input.maxTargets === undefined
                ? {}
                : { maxTargets: input.maxTargets }),
              presentation,
              ...(input.crop ? { crop: input.crop } : {}),
              ...(input.rulers === undefined ? {} : { rulers: input.rulers }),
              ...(input.diffHints === undefined ? {} : { diffHints: input.diffHints }),
              ...(input.deduplicate === undefined ? {} : { deduplicate: input.deduplicate }),
            },
            source,
            signal,
          );
        }
        if (input.request === undefined) {
          throw new UrmaError(
            "INVALID_SOURCE",
            "get_frames requires an explicit point/burst request or a cadence cursor",
          );
        }
        let timesMs: number[];
        if (input.request.kind === "points") {
          if (
            input.request.timesMs.length < 1 ||
            input.request.timesMs.length > 12
          ) {
            throw new UrmaError(
              "OUTPUT_LIMIT_EXCEEDED",
              `Point frame requests require 1-12 timestamps; received ${input.request.timesMs.length}. Split larger panel comparisons into separate requests.`,
            );
          }
          timesMs = input.request.timesMs.map((time) =>
            assertMs(time, "frame timestamp")
          );
          if (new Set(timesMs).size !== timesMs.length) {
            throw new UrmaError(
              "INVALID_SOURCE",
              "Point frame timestamps must be unique within one request",
            );
          }
          if (timesMs.some((time) => time >= source.durationMs)) {
            throw new UrmaError(
              "INVALID_SOURCE",
              `Frame timestamp must be below source durationMs ${source.durationMs}`,
            );
          }
        } else {
          assertInterval(
            input.request.startMs,
            input.request.endMs,
            source.durationMs,
          );
          if (
            !Number.isInteger(input.request.count) ||
            input.request.count < 2 ||
            input.request.count > 12
          ) {
            throw new UrmaError(
              "OUTPUT_LIMIT_EXCEEDED",
              `Burst count must be an integer from 2 to 12; received ${
                String(input.request.count)
              }. Split larger panel comparisons into separate requests.`,
            );
          }
          timesMs = uniformPointsMs(
            input.request.startMs,
            input.request.endMs,
            input.request.count,
          );
        }
        const callParameters = presentation === "individual" && !input.crop && !input.rulers && !input.refinement
          ? input.request
          : { ...input.request, presentation, ...(input.crop ? { crop: input.crop } : {}), ...(input.rulers ? { rulers: true } : {}), ...(input.refinement ? { refinement: input.refinement } : {}) };
        trace?.setSource(source.sourceRef, source.durationMs);
        trace?.setRequestedTimestamps(timesMs);
        const call = startAcquisition(this.store, {
          sourceRef: source.sourceRef,
          sourceRevision: source.revision,
          investigationRef: input.investigationRef,
          operation: "tool:get_frames",
          requestKey: deterministicRequestKey(
            source.revision,
            "get_frames",
            callParameters,
            "evidence-api",
          ),
          method: presentation === "panel" ? "ffmpeg-panel" : "ffmpeg-decode",
          debug: this.config.debug,
        });
        try {
          const key = deterministicRequestKey(
            source.revision,
            "frames",
            { timesMs, ...(input.crop ? { crop: input.crop } : {}) },
            "frame-batch",
          );
          const sharedFrames = await this.singleflight.run(
            `frames:${key}`,
            signal,
            (sharedSignal) =>
              this.frames.get(
                source,
                input.investigationRef,
                timesMs,
                sharedSignal,
                input.crop,
              ),
          );
          const frames = this.#admitFrameArtifacts(source, sharedFrames, input.crop);
          const indexedFrames = frames.map((frame, index) => ({ ...frame, index }));
          const grouping = input.deduplicate ? await this.#groupFrames(source, input.investigationRef, indexedFrames, signal) : undefined;
          const representativeIndices = new Set(grouping?.groups.map((group) => group.representativeIndex));
          const displayedFrames = grouping ? indexedFrames.filter((frame) => representativeIndices.has(frame.index)) : indexedFrames;
          const deltaHints = input.diffHints ? await this.#analyzeHints(source, input.investigationRef,
            indexedFrames, signal) : undefined;
          const previews = await this.#framePreviews(source, input.investigationRef, displayedFrames,
            input.rulers === true && presentation === "individual", signal);
          const panel = presentation === "panel"
            ? await this.framePanels.get(source, displayedFrames, signal, { rulers: input.rulers === true })
            : null;
          if (grouping && panel) grouping.groups.forEach((group, index) => { group.panelIndex = index + 1; });
          const presentationArtifactIds = [
            ...(panel ? [panel.artifact.artifactId] : []),
            ...[...previews.values()].map((preview) => preview.artifactId),
          ];
          const serviceResultStarted = performance.now();
          try {
            if (input.request.kind === "points") {
              for (const [index, frame] of frames.entries()) {
                this.store.addPresentation({
                  id: randomUUID(),
                  investigationRef: input.investigationRef,
                  artifactId: frame.artifact.artifactId,
                  modality: "visual",
                  evidenceKind: "point",
                  startMs: frame.atMs,
                  endMs: frame.atMs,
                  pointsMs: [frame.atMs],
                  metadata: {
                    atMs: frame.atMs,
                    role: "evidence",
                    ...cropFields(frame.artifact),
                    ...(index === 0 && grouping ? { deduplication: grouping } : {}),
                    ...(input.refinement ? { refinement: input.refinement } : {}),
                    ...(input.discovery ? { discovery: { policy: input.discovery.policy,
                      observedPresentationTimeMs: input.discovery.candidates[index]?.observedPresentationTimeMs } } : {}),
                    ...(index === 0 && presentationArtifactIds.length
                      ? { presentation, presentationArtifactIds }
                      : {}),
                  },
                  presentedAt: new Date().toISOString(),
                });
              }
            } else {
              this.store.addPresentation({
                id: randomUUID(),
                investigationRef: input.investigationRef,
                artifactId: null,
                modality: "visual",
                evidenceKind: "ordered_points",
                startMs: input.request.startMs,
                endMs: input.request.endMs,
                pointsMs: timesMs,
                metadata: {
                  artifactIds: frames.map((frame) => frame.artifact.artifactId),
                  role: "evidence",
                  continuousMotion: false,
                  ...(grouping ? { deduplication: grouping } : {}),
                  ...(input.crop ? { crops: frames.map((frame) => cropFields(frame.artifact).crop) } : {}),
                  ...(presentationArtifactIds.length
                    ? { presentation, presentationArtifactIds }
                    : {}),
                },
                presentedAt: new Date().toISOString(),
              });
            }
            const imageBytes = frames.reduce(
              (sum, frame) => sum + frame.artifact.byteSize,
              0,
            );
            const cacheHits = frames.filter((frame) => frame.cacheHit).length;
            call.succeed({
              networkBytes: 0,
              networkAccountingComplete: true,
              metadata: {
                presentation,
                requestedTimestamps: timesMs,
                requestedFrameCount: timesMs.length,
                returnedFrameCount: frames.length,
                timestampsRequested: timesMs.length,
                framesReturned: frames.length,
                frames: frames.length,
                cacheHits,
                canonicalArtifactCount: frames.length,
                imageCount: presentation === "panel" ? 1 : displayedFrames.length,
                imageBytes: presentation === "panel"
                  ? panel!.artifact.byteSize
                  : grouping ? displayedFrames.reduce((sum, frame) => sum + frame.artifact.byteSize, 0) : imageBytes,
                ...(panel
                  ? {
                    canvasWidth: panel.dimensions.width,
                    canvasHeight: panel.dimensions.height,
                    cellCount: displayedFrames.length,
                    panelCacheHit: panel.cacheHit,
                  }
                  : {}),
              },
            });
            const stateSummary = compactState(
              deriveInvestigationState(this.store, input.investigationRef),
            );
            const kind = input.request.kind === "points"
              ? ("exact_points" as const)
              : ("ordered_points" as const);
            const samplingGaps = summarizeSamplingGaps(
              input.request.kind === "points" ? 0 : input.request.startMs,
              input.request.kind === "points"
                ? source.durationMs
                : input.request.endMs,
              frames.map((frame) => frame.atMs),
              "requested",
            );
            if (!panel) {
              return {
                kind,
                continuousMotion: false,
                samplingGaps,
                ...(deltaHints ? { diffHints: deltaHints } : {}),
                ...(grouping ? { deduplication: grouping } : {}),
                frames: frames.map((frame, index) => ({
                  index,
                  atMs: frame.atMs,
                  artifactId: frame.artifact.artifactId,
                  mimeType: frame.artifact.mimeType,
                  byteSize: frame.artifact.byteSize,
                  resource: investigationArtifactUri(
                    input.investigationRef,
                    frame.artifact.artifactId,
                  ),
                  cacheHit: frame.cacheHit,
                  ...cropFields(frame.artifact),
                  ...(previews.get(frame.atMs) ? { preview: previews.get(frame.atMs)! } : {}),
                })),
                stateSummary,
              };
            }
            return {
              kind,
              continuousMotion: false,
              samplingGaps,
              ...(deltaHints ? { diffHints: deltaHints } : {}),
              ...(grouping ? { deduplication: grouping } : {}),
              presentation: "panel" as const,
              cells: frames.map((frame, index) => ({
                index: index + 1,
                timestampMs: frame.atMs,
                artifactId: frame.artifact.artifactId,
                mimeType: frame.artifact.mimeType,
                byteSize: frame.artifact.byteSize,
                resource: investigationArtifactUri(
                  input.investigationRef,
                  frame.artifact.artifactId,
                ),
                cacheHit: frame.cacheHit,
                ...cropFields(frame.artifact),
              })),
              panel: {
                artifactId: panel.artifact.artifactId,
                mimeType: "image/jpeg" as const,
                byteSize: panel.artifact.byteSize,
                resource: investigationArtifactUri(
                  input.investigationRef,
                  panel.artifact.artifactId,
                ),
                width: panel.dimensions.width,
                height: panel.dimensions.height,
                cellCount: displayedFrames.length,
                cacheHit: panel.cacheHit,
                derived: true as const,
                canonical: false as const,
                ...(input.rulers ? { rulers: true as const, coordinateSpace: "individual-displayed-source" as const } : {}),
              },
              stateSummary,
            };
          } finally {
            trace?.addStage(
              "serviceResultConstructionMs",
              performance.now() - serviceResultStarted,
            );
          }
        } catch (error) {
          call.fail(error);
          throw error;
        }
      },
    );
  }

  state(ref: InvestigationRef) {
    return deriveInvestigationState(this.store, ref);
  }
}
