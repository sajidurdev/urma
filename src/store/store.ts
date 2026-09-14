import type {
  ArtifactId,
  InvestigationRef,
  RemoteIdentity,
  SourceRef,
} from "../core/ids.js";
import type {
  AcquisitionMethod,
  ArtifactKind,
  ArtifactRole,
  SourceKind,
  TranscriptKind,
} from "../core/model.js";

export type StoredSource = Readonly<{
  sourceRef: SourceRef;
  kind: SourceKind;
  identity: RemoteIdentity | Readonly<{ basis: "local"; pathDigest: string }>;
  latestRevision: string;
  createdAt: string;
}>;

export type StoredSourceSnapshot = Readonly<{
  sourceRef: SourceRef;
  revision: string;
  observedAt: string;
  durationMs: number;
  descriptor: Readonly<Record<string, unknown>>;
}>;

export type StoredSourceLocator = Readonly<{
  sourceRef: SourceRef;
  locatorDigest: string;
  privateReopenLocator: string;
  observedAt: string;
}>;

export type StoredInvestigation = Readonly<{
  investigationRef: InvestigationRef;
  sourceRef: SourceRef;
  sourceRevision: string;
  durationMs: number;
  createdAt: string;
  updatedAt: string;
}>;

export type StoredTrack = Readonly<{
  id: string;
  sourceRef: SourceRef;
  sourceRevision: string;
  language: string;
  kind: TranscriptKind;
  providerTrackId: string | null;
  acquiredAt: string;
  metadata: Readonly<Record<string, unknown>>;
}>;

export type StoredSegment = Readonly<{
  id: number;
  trackId: string;
  startMs: number;
  endMs: number;
  text: string;
  ordinal: number;
}>;

export type StoredArtifact = Readonly<{
  artifactId: ArtifactId;
  sourceRef: SourceRef;
  sourceRevision: string;
  kind: ArtifactKind;
  role: ArtifactRole;
  mimeType: string;
  sha256: string;
  byteSize: number;
  blobPath: string;
  startMs: number | null;
  endMs: number | null;
  params: Readonly<Record<string, unknown>>;
  producer: Readonly<Record<string, unknown>>;
  createdAt: string;
}>;

export type StoredAcquisition = Readonly<{
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

export type StoredPresentation = Readonly<{
  id: string;
  investigationRef: InvestigationRef;
  artifactId: ArtifactId | null;
  modality: "transcript" | "visual" | "audio";
  evidenceKind:
    | "transcript_search"
    | "transcript_range"
    | "point"
    | "sparse"
    | "ordered_points"
    | "audio";
  startMs: number | null;
  endMs: number | null;
  pointsMs: readonly number[] | null;
  metadata: Readonly<Record<string, unknown>>;
  presentedAt: string;
}>;

export interface UrmaStore {
  readonly ftsEnabled: boolean;
  close(): void;
  putSourceSnapshot(input: Readonly<{
    source: Omit<StoredSource, "createdAt">;
    snapshot: StoredSourceSnapshot;
    locators: readonly StoredSourceLocator[];
  }>): StoredSourceSnapshot;
  getSource(sourceRef: SourceRef): StoredSource | null;
  getSnapshot(sourceRef: SourceRef, revision: string): StoredSourceSnapshot | null;
  getLatestSnapshot(sourceRef: SourceRef): StoredSourceSnapshot | null;
  getLocator(sourceRef: SourceRef, locatorDigest: string): StoredSourceLocator | null;
  listSourceLocators(sourceRef: SourceRef): StoredSourceLocator[];
  findSourcesByLocatorDigest(locatorDigest: string): StoredSource[];
  createInvestigation(investigation: StoredInvestigation): void;
  getInvestigation(
    investigationRef: InvestigationRef,
  ): StoredInvestigation | null;
  putTranscript(
    track: StoredTrack,
    segments: readonly Omit<StoredSegment, "id">[],
  ): void;
  listTranscriptTracks(sourceRef: SourceRef, revision: string): StoredTrack[];
  listTranscriptSegments(
    trackId: string,
    startMs?: number,
    endMs?: number,
  ): StoredSegment[];
  searchTranscriptSegments(
    trackId: string,
    query: string,
    limit: number,
  ): StoredSegment[];
  putArtifact(
    artifact: StoredArtifact,
    request?: Readonly<{ requestKey: string; operation: string }>,
    parents?: readonly ArtifactId[],
  ): void;
  getArtifact(artifactId: ArtifactId): StoredArtifact | null;
  getArtifactByRequest(requestKey: string): StoredArtifact | null;
  listArtifacts(sourceRef: SourceRef, revision: string): StoredArtifact[];
  beginAcquisition(acquisition: StoredAcquisition): void;
  finishAcquisition(
    id: string,
    result: Pick<
      StoredAcquisition,
      | "status"
      | "completedAt"
      | "wallMs"
      | "networkBytes"
      | "networkAccountingComplete"
      | "errorCode"
      | "metadata"
    >,
  ): void;
  listAcquisitions(investigationRef: InvestigationRef): StoredAcquisition[];
  addPresentation(presentation: StoredPresentation): void;
  listPresentations(investigationRef: InvestigationRef): StoredPresentation[];
  isArtifactPresented(
    investigationRef: InvestigationRef,
    artifactId: ArtifactId,
  ): boolean;
  listPresentedArtifactIds(investigationRef: InvestigationRef): ArtifactId[];
  cacheStats(): {
    sources: number;
    investigations: number;
    artifacts: number;
    artifactBytes: number;
    acquisitions: number;
  };
}
