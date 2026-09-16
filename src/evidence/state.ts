import {
  type ArtifactId,
  investigationArtifactUri,
  type InvestigationRef,
  parseTrackRef,
  type TrackRef,
} from "../core/ids.js";
import {
  largestExactFrameGaps,
  largestUnsampledGaps,
} from "../core/coverage.js";
import {
  type AudioEvidenceInterval,
  type CachedMediaInterval,
  type ExactVisualPoint,
  type InvestigationState,
  type OrderedVisualSet,
  OVERVIEW_CONTRACT_ID,
  type OverviewCell,
  type OverviewEvidenceSet,
  type OverviewSampleReuse,
  type SparseVisualSet,
  type TranscriptKind,
} from "../core/model.js";
import { UrmaError } from "../core/errors.js";
import type { UrmaStore } from "../store/store.js";

const OVERVIEW_RELATIONS = new Set<OverviewSampleReuse["relation"]>([
  "not-scoped",
  "no-prior-overview",
  "same-samples",
  "different-subset",
  "new-decoded-samples",
]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function provenance(value: unknown): OverviewCell["provenance"] | null {
  if (
    !record(value) ||
    (value.kind !== "storyboard" && value.kind !== "decoded") ||
    (value.timing !== "exact" && value.timing !== "nominal") ||
    typeof value.sampleId !== "string" ||
    value.sampleId.length < 1 ||
    value.sampleId.length > 256
  ) {
    return null;
  }
  const sourceArtifactId = value.sourceArtifactId === null
    ? null
    : typeof value.sourceArtifactId === "string" &&
        /^urma:artifact:sha256:[0-9a-f]{64}$/u.test(value.sourceArtifactId)
    ? (value.sourceArtifactId as ArtifactId)
    : undefined;
  const fragmentIndex = value.fragmentIndex === null
    ? null
    : nonNegativeInteger(value.fragmentIndex)
    ? value.fragmentIndex
    : undefined;
  const cellIndex = value.cellIndex === null
    ? null
    : nonNegativeInteger(value.cellIndex)
    ? value.cellIndex
    : undefined;
  if (
    sourceArtifactId === undefined ||
    fragmentIndex === undefined ||
    cellIndex === undefined
  ) {
    return null;
  }
  if (value.kind === "storyboard" && value.timing !== "nominal") return null;
  if (
    value.kind === "storyboard" &&
    (sourceArtifactId === null || fragmentIndex === null || cellIndex === null)
  ) {
    return null;
  }
  if (
    value.kind === "decoded" &&
    (fragmentIndex !== null || cellIndex !== null)
  ) {
    return null;
  }
  return {
    kind: value.kind,
    timing: value.timing,
    sampleId: value.sampleId,
    sourceArtifactId,
    fragmentIndex,
    cellIndex,
  };
}
function overviewCells(
  value: unknown,
  pointsMs: readonly number[],
): OverviewCell[] | null {
  if (
    !Array.isArray(value) ||
    value.length !== pointsMs.length ||
    value.length < 1 ||
    value.length > 12
  ) {
    return null;
  }
  const cells: OverviewCell[] = [];
  for (const [index, item] of value.entries()) {
    if (
      !record(item) ||
      item.index !== index ||
      item.timestampMs !== pointsMs[index]
    ) {
      return null;
    }
    const cellProvenance = provenance(item.provenance);
    if (!cellProvenance) return null;
    cells.push({
      index,
      timestampMs: pointsMs[index]!,
      provenance: cellProvenance,
    });
  }
  return cells;
}
function overviewReuse(value: unknown): OverviewSampleReuse | null {
  if (
    !record(value) ||
    typeof value.reusedUnderlyingSamples !== "boolean" ||
    typeof value.relation !== "string" ||
    !OVERVIEW_RELATIONS.has(value.relation as OverviewSampleReuse["relation"])
  ) {
    return null;
  }
  return {
    relation: value.relation as OverviewSampleReuse["relation"],
    reusedUnderlyingSamples: value.reusedUnderlyingSamples,
  };
}
function overviewFromPresentation(
  entry: Readonly<{
    evidenceKind: string;
    artifactId: ArtifactId | null;
    startMs: number | null;
    endMs: number | null;
    pointsMs: readonly number[] | null;
    metadata: Readonly<Record<string, unknown>>;
  }>,
): OverviewEvidenceSet | null {
  if (
    entry.evidenceKind !== "sparse" ||
    entry.metadata.overviewContractId !== OVERVIEW_CONTRACT_ID ||
    entry.startMs === null ||
    entry.endMs === null ||
    entry.pointsMs === null
  ) {
    return null;
  }
  const source = entry.metadata.source;
  if (source !== "native-storyboard" && source !== "navigation-media") {
    return null;
  }
  const requested = entry.metadata.requestedPointsMs;
  const requestedPointsMs = Array.isArray(requested) &&
      requested.length >= 1 &&
      requested.length <= 12 &&
      requested.every(
        (point, index) =>
          nonNegativeInteger(point) &&
          point >= entry.startMs! &&
          point < entry.endMs! &&
          (index === 0 ||
            (nonNegativeInteger(requested[index - 1]) &&
              point > requested[index - 1])),
      )
    ? [...(requested as number[])]
    : null;
  const pointsMs = [...entry.pointsMs];
  if (
    !requestedPointsMs ||
    pointsMs.length < 1 ||
    pointsMs.length > 12 ||
    pointsMs.some(
      (point, index) =>
        !nonNegativeInteger(point) ||
        point < entry.startMs! ||
        point >= entry.endMs! ||
        (index > 0 && point <= pointsMs[index - 1]!),
    )
  ) {
    return null;
  }
  const cells = overviewCells(entry.metadata.cells, pointsMs);
  const sampleReuse = overviewReuse(entry.metadata.sampleReuse);
  if (!cells || !sampleReuse) return null;
  return {
    kind: "overview",
    timebase: "source-global",
    requestedInterval: { startMs: entry.startMs, endMs: entry.endMs },
    requestedPointsMs,
    observedCoverage: {
      kind: "sample-points-only",
      continuous: false,
      sampleTimestampsMs: pointsMs,
      adjacentSpacingMs: pointsMs
        .slice(1)
        .map((point, index) => point - pointsMs[index]!),
    },
    source,
    artifactId: entry.artifactId,
    cells,
    sampleReuse,
  };
}

export function deriveInvestigationState(
  store: UrmaStore,
  ref: InvestigationRef,
): InvestigationState {
  const investigation = store.getInvestigation(ref);
  if (!investigation) {
    throw new UrmaError(
      "INVALID_SOURCE",
      `Investigation ${ref} is unknown; call inspect_video to start a new investigation`,
    );
  }
  const source = store.getSource(investigation.sourceRef);
  if (!source) {
    throw new UrmaError(
      "INTERNAL_ERROR",
      `Investigation ${ref} refers to a missing source record; inspect the Urma database`,
    );
  }
  const acquisitions = store.listAcquisitions(ref);
  const presentations = store.listPresentations(ref);
  const artifacts = store.listArtifacts(
    investigation.sourceRef,
    investigation.sourceRevision,
  );
  const sparse: SparseVisualSet[] = [];
  const overviewSets: OverviewEvidenceSet[] = [];
  const exact: ExactVisualPoint[] = [];
  const ordered: OrderedVisualSet[] = [];
  const audio: AudioEvidenceInterval[] = [];
  const transcriptRanges: Array<{ startMs: number; endMs: number }> = [];
  const transcriptTracks = new Map<
    TrackRef,
    {
      trackRef: TrackRef;
      language: string;
      kind: TranscriptKind;
      displayName: string | null;
      providerTrackId: string | null;
    }
  >();
  let transcriptSearches = 0;
  for (const entry of presentations) {
    if (
      entry.evidenceKind === "transcript_search" ||
      entry.evidenceKind === "transcript_range"
    ) {
      const raw = entry.metadata.trackRef;
      const language = entry.metadata.language;
      const kind = entry.metadata.kind;
      try {
        if (
          typeof raw === "string" &&
          typeof language === "string" &&
          (kind === "manual" ||
            kind === "automatic" ||
            kind === "sidecar" ||
            kind === "unknown")
        ) {
          const trackRef = parseTrackRef(raw);
          transcriptTracks.set(trackRef, {
            trackRef,
            language,
            kind,
            displayName: typeof entry.metadata.displayName === "string"
              ? entry.metadata.displayName
              : null,
            providerTrackId: typeof entry.metadata.providerTrackId === "string"
              ? entry.metadata.providerTrackId
              : null,
          });
        }
      } catch {
      }
    }
    if (entry.evidenceKind === "transcript_search") transcriptSearches += 1;
    else if (
      entry.evidenceKind === "transcript_range" &&
      entry.startMs !== null &&
      entry.endMs !== null
    ) {
      transcriptRanges.push({ startMs: entry.startMs, endMs: entry.endMs });
    } else if (
      entry.evidenceKind === "sparse" &&
      entry.startMs !== null &&
      entry.endMs !== null &&
      entry.pointsMs
    ) {
      sparse.push({
        kind: "sparse",
        startMs: entry.startMs,
        endMs: entry.endMs,
        pointsMs: entry.pointsMs,
        artifactId: entry.artifactId,
      });
      const overview = overviewFromPresentation(entry);
      if (overview) overviewSets.push(overview);
    } else if (
      entry.evidenceKind === "point" &&
      entry.startMs !== null &&
      entry.artifactId
    ) {
      exact.push({
        kind: "point",
        atMs: entry.startMs,
        artifactId: entry.artifactId,
      });
    } else if (
      entry.evidenceKind === "ordered_points" &&
      entry.startMs !== null &&
      entry.endMs !== null &&
      entry.pointsMs
    ) {
      const ids = Array.isArray(entry.metadata.artifactIds)
        ? (entry.metadata.artifactIds as ArtifactId[])
        : [];
      ordered.push({
        kind: "ordered_points",
        startMs: entry.startMs,
        endMs: entry.endMs,
        pointsMs: entry.pointsMs,
        artifactIds: ids,
      });
    } else if (
      entry.evidenceKind === "audio" &&
      entry.startMs !== null &&
      entry.endMs !== null &&
      entry.artifactId
    ) {
      audio.push({
        kind: "audio",
        startMs: entry.startMs,
        endMs: entry.endMs,
        artifactId: entry.artifactId,
      });
    }
  }
  const media: CachedMediaInterval[] = artifacts
    .filter(
      (artifact) =>
        artifact.kind === "media_section" ||
        artifact.kind === "navigation_media" ||
        artifact.kind === "evidence_media",
    )
    .filter((artifact) => artifact.startMs !== null && artifact.endMs !== null)
    .map((artifact) => ({
      kind: "cached_media",
      startMs: artifact.startMs!,
      endMs: artifact.endMs!,
      artifactId: artifact.artifactId,
      fidelity: artifact.kind === "navigation_media"
        ? "navigation"
        : "evidence",
    }));
  const known = acquisitions.reduce(
    (sum, item) => sum + (item.networkBytes ?? 0),
    0,
  );
  const incomplete = acquisitions.filter(
    (item) => item.status === "succeeded" && !item.networkAccountingComplete,
  ).length;
  const points = [
    ...sparse.flatMap((item) => item.pointsMs),
    ...exact.map((item) => item.atMs),
    ...ordered.flatMap((item) => item.pointsMs),
  ];
  const exactFramePoints = [
    ...exact.map((item) => item.atMs),
    ...ordered.flatMap((item) => item.pointsMs),
  ];
  return {
    investigationRef: ref,
    sourceRef: investigation.sourceRef,
    sourceRevision: investigation.sourceRevision,
    calls: acquisitions.filter((item) => item.operation.startsWith("tool:"))
      .length,
    network: {
      measuredBytes: incomplete === 0 ? known : null,
      knownMeasuredBytes: known,
      accountingComplete: incomplete === 0,
      unknownAcquisitionCount: incomplete,
    },
    evidence: {
      transcriptSearches,
      transcriptRanges,
      transcriptTracks: [...transcriptTracks.values()],
      sparseVisualSets: sparse,
      overviewSets,
      exactVisualPoints: exact,
      orderedVisualSets: ordered,
      audioIntervals: audio,
    },
    cache: {
      transcriptTracks: store.listTranscriptTracks(
        investigation.sourceRef,
        investigation.sourceRevision,
      ).length,
      storyboard: artifacts.some((item) => item.kind === "storyboard"),
      navigationCopy: artifacts.some(
        (item) => item.kind === "navigation_media",
      ),
      continuousMediaIntervals: media,
      reusableArtifacts: artifacts.length,
    },
    largestUnsampledVisualGaps: largestUnsampledGaps(
      investigation.durationMs,
      points,
      5,
    ),
    largestExactFrameGaps: largestExactFrameGaps(
      investigation.durationMs,
      exactFramePoints,
    ),
    reopenableResources: [
      `urma://investigation/${ref.slice("urma:investigation:".length)}/state`,
      ...store
        .listPresentedArtifactIds(ref)
        .map((artifactId) => investigationArtifactUri(ref, artifactId)),
    ],
    resourceReadAttribution: "tool-presentations-only",
  };
}
export function compactState(state: InvestigationState) {
  return {
    investigationRef: state.investigationRef,
    calls: state.calls,
    visual: {
      sparseSets: state.evidence.sparseVisualSets.length,
      exactPoints: state.evidence.exactVisualPoints.length,
      orderedBursts: state.evidence.orderedVisualSets.length,
      largestUnsampledGaps: state.largestUnsampledVisualGaps,
      largestExactFrameGaps: state.largestExactFrameGaps,
      recentOverviewSets: state.evidence.overviewSets.slice(-5),
    },
    transcript: {
      searches: state.evidence.transcriptSearches,
      returnedRanges: state.evidence.transcriptRanges.slice(-5),
    },
    cache: {
      storyboard: state.cache.storyboard,
      navigationCopy: state.cache.navigationCopy,
      continuousMediaIntervals: state.cache.continuousMediaIntervals.length,
    },
    network: {
      measuredBytes: state.network.measuredBytes,
      accountingComplete: state.network.accountingComplete,
    },
    stateResource: `urma://investigation/${
      state.investigationRef.slice("urma:investigation:".length)
    }/state`,
  };
}
