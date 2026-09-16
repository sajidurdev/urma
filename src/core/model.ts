import type {
  ArtifactId,
  InvestigationRef,
  RemoteIdentity,
  SourceRef,
  TrackRef,
} from "./ids.js";

export type SourceKind = "local" | "remote";
export type { RemoteIdentity } from "./ids.js";

/** An immutable observation revision of one logical source */
export type SnapshotRevision = string;
export type SnapshotRef = Readonly<{
  sourceRef: SourceRef;
  revision: SnapshotRevision;
}>;

export type TimelineBasis = "progressive" | "hls" | "dash" | "container";
export type FiniteTimeline = Readonly<{
  finite: true;
  durationMs: number;
  basis: TimelineBasis;
  validatedAt: string;
}>;

export type { CandidateKey } from "./ids.js";
export type ArtifactRole = "locator" | "transport" | "evidence";
export type ArtifactKind =
  | "caption"
  | "storyboard"
  | "navigation_media"
  | "evidence_media"
  | "media_section"
  | "overview_panel"
  | "frame_panel"
  | "frame"
  | "audio";
export type AcquisitionMethod =
  | "cache"
  | "local-file"
  | "yt-dlp-metadata"
  | "yt-dlp-caption"
  | "yt-dlp-storyboard"
  | "yt-dlp-bounded-section"
  | "yt-dlp-reusable-media"
  | "ffmpeg-decode"
  | "ffmpeg-panel";
export type TranscriptKind = "manual" | "automatic" | "sidecar" | "unknown";

export type SourceMetadata = Readonly<{
  sourceRef: SourceRef;
  kind: SourceKind;
  canonicalKey: string;
  identity?: RemoteIdentity;
  snapshot: SnapshotRef;
  title: string;
  durationMs: number;
  timeline: FiniteTimeline;
  chapters: readonly Readonly<{
    startMs: number;
    endMs: number;
    title: string;
  }>[];
  capabilities: SourceCapabilities;
}>;

export type SourceCapabilities = Readonly<{
  nativeCaptions: boolean;
  chapters: boolean;
  nativeStoryboard: boolean;
  targetedMedia: boolean;
  audio: boolean;
  progressive?: boolean;
  hls?: boolean;
  dash?: boolean;
  mhtml?: boolean;
}>;

export type TranscriptTrack = Readonly<{
  id: string;
  sourceRef: SourceRef;
  sourceRevision: string;
  language: string;
  kind: TranscriptKind;
  providerTrackId: string | null;
  acquiredAt: string;
  metadata: Readonly<Record<string, unknown>>;
}>;

export type TranscriptSegment = Readonly<{
  id?: number;
  trackId: string;
  startMs: number;
  endMs: number;
  text: string;
  ordinal: number;
}>;

export type ExactVisualPoint = Readonly<{
  kind: "point";
  atMs: number;
  artifactId: ArtifactId;
}>;
export type SparseVisualSet = Readonly<{
  kind: "sparse";
  startMs: number;
  endMs: number;
  pointsMs: readonly number[];
  artifactId: ArtifactId | null;
}>;
export type OrderedVisualSet = Readonly<{
  kind: "ordered_points";
  startMs: number;
  endMs: number;
  pointsMs: readonly number[];
  artifactIds: readonly ArtifactId[];
}>;
export type AudioEvidenceInterval = Readonly<{
  kind: "audio";
  startMs: number;
  endMs: number;
  artifactId: ArtifactId;
}>;
export type VisualEvidence =
  | ExactVisualPoint
  | SparseVisualSet
  | OrderedVisualSet;

export const OVERVIEW_CONTRACT_ID = "overview";

export type OverviewSampleProvenance = Readonly<{
  kind: "storyboard" | "decoded";
  timing: "exact" | "nominal";
  sampleId: string;
  sourceArtifactId: ArtifactId | null;
  fragmentIndex: number | null;
  cellIndex: number | null;
}>;

export type OverviewCell = Readonly<{
  index: number;
  timestampMs: number;
  provenance: OverviewSampleProvenance;
}>;

export type OverviewSampleReuse = Readonly<{
  relation:
    | "not-scoped"
    | "no-prior-overview"
    | "same-samples"
    | "different-subset"
    | "new-decoded-samples";
  reusedUnderlyingSamples: boolean;
}>;

export type OverviewObservedCoverage = Readonly<{
  kind: "sample-points-only";
  continuous: false;
  sampleTimestampsMs: readonly number[];
  adjacentSpacingMs: readonly number[];
}>;

export type OverviewEvidenceSet = Readonly<{
  kind: "overview";
  timebase: "source-global";
  requestedInterval: Readonly<{ startMs: number; endMs: number }>;
  requestedPointsMs: readonly number[];
  observedCoverage: OverviewObservedCoverage;
  source: "native-storyboard" | "navigation-media";
  artifactId: ArtifactId | null;
  cells: readonly OverviewCell[];
  sampleReuse: OverviewSampleReuse;
}>;

export type CachedMediaInterval = Readonly<{
  kind: "cached_media";
  startMs: number;
  endMs: number;
  artifactId: ArtifactId;
  fidelity: "navigation" | "evidence";
}>;

export type Provenance = Readonly<{
  sourceRef: SourceRef;
  sourceRevision: string;
  method: AcquisitionMethod;
  cacheHit: boolean;
  urmaVersion: string;
  ffmpegVersion: string | null;
  ffprobeVersion: string | null;
  ytdlpVersion: string | null;
  networkBytes: number | null;
  networkAccountingComplete: boolean;
  detail: Readonly<Record<string, unknown>>;
}>;

export type AcquisitionRecord = Readonly<{
  id: string;
  sourceRef: SourceRef;
  sourceRevision: string;
  investigationRef: InvestigationRef | null;
  operation: string;
  requestKey: string;
  method: AcquisitionMethod;
  status: "running" | "succeeded" | "failed" | "cancelled";
  startedAt: string;
  completedAt: string | null;
  wallMs: number | null;
  networkBytes: number | null;
  networkAccountingComplete: boolean;
  errorCode: string | null;
  metadata: Readonly<Record<string, unknown>>;
}>;

export type SourceCacheState = Readonly<{
  transcriptTracks: number;
  storyboard: boolean;
  navigationCopy: boolean;
  continuousMediaIntervals: readonly CachedMediaInterval[];
  reusableArtifacts: number;
}>;

export type InvestigationState = Readonly<{
  investigationRef: InvestigationRef;
  sourceRef: SourceRef;
  sourceRevision: string;
  calls: number;
  network: Readonly<{
    measuredBytes: number | null;
    knownMeasuredBytes: number;
    accountingComplete: boolean;
    unknownAcquisitionCount: number;
  }>;
  evidence: Readonly<{
    transcriptSearches: number;
    transcriptRanges: readonly Readonly<{ startMs: number; endMs: number }>[];
    transcriptTracks: readonly Readonly<{
      trackRef: TrackRef;
      language: string;
      kind: TranscriptKind;
      displayName: string | null;
      providerTrackId: string | null;
    }>[];
    sparseVisualSets: readonly SparseVisualSet[];
    overviewSets: readonly OverviewEvidenceSet[];
    exactVisualPoints: readonly ExactVisualPoint[];
    orderedVisualSets: readonly OrderedVisualSet[];
    audioIntervals: readonly AudioEvidenceInterval[];
  }>;
  cache: SourceCacheState;
  largestUnsampledVisualGaps: readonly Readonly<{
    startMs: number;
    endMs: number;
  }>[];
  largestExactFrameGaps: readonly Readonly<{
    startMs: number;
    endMs: number;
  }>[];
  reopenableResources: readonly string[];
  resourceReadAttribution: "tool-presentations-only";
}>;
