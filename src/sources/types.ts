import type {
  CandidateKey,
  FiniteTimeline,
  RemoteIdentity,
  SnapshotRef,
} from "../core/model.js";
import type { SourceRef, TrackRef } from "../core/ids.js";
import type {
  SourceCapabilities,
  SourceKind,
  TranscriptKind,
} from "../core/model.js";
import type { RemoteAcquisitionBoundary } from "../remote/worker.js";

export type CaptionVariantSummary = Readonly<{
  variantId: string;
  format: "json3" | "vtt" | "srt" | string;
  providerVariantId: string | null;
}>;

export type CaptionTrackSummary = Readonly<{
  trackRef: TrackRef;
  language: string;
  kind: TranscriptKind;
  displayName: string | null;
  formats: readonly string[];
  providerTrackId: string | null;
  variants?: readonly CaptionVariantSummary[];
}>;
export type FormatSummary = Readonly<{
  /** Provider selector used only inside an acquisition lease */
  id: string;
  formatId?: string;
  /** Snapshot-scoped identity derived from the complete safe description */
  candidateKey?: CandidateKey;
  ext: string | null;
  protocol: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  estimatedBytes: number | null;
  rows: number | null;
  columns: number | null;
}>;

export type ResolvedSource = Readonly<{
  sourceRef: SourceRef;
  kind: SourceKind;
  canonicalKey: string;
  identity: RemoteIdentity | null;
  snapshotRef: SnapshotRef;
  canonicalLocator: string;
  revision: string;
  observedAt: string;
  title: string;
  durationMs: number;
  metadataDurationMs: number | null;
  timeline: FiniteTimeline;
  extractor: string | null;
  extractorKey: string | null;
  liveState: "finite" | "live" | "upcoming" | "unknown";
  safeOrigins: readonly string[];
  resolverVersion: string;
  normalizationVersion: string;
  policyVersion: string;
  chapters: readonly Readonly<{
    startMs: number;
    endMs: number;
    title: string;
  }>[];
  captionTracks: readonly CaptionTrackSummary[];
  formats: readonly FormatSummary[];
  capabilities: SourceCapabilities;
  safeMetadata: Readonly<Record<string, unknown>>;
  /** Internal marker requiring Urma's Safe Proxy for remote acquisition */
  remoteAcquisition?: RemoteAcquisitionBoundary;
}>;
