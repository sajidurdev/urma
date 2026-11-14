import * as z from "zod/v4";
import {
  MAX_TRANSCRIPT_BATCH_CHARACTERS,
  MAX_TRANSCRIPT_BATCH_HITS,
  MAX_TRANSCRIPT_BATCH_QUERIES,
  MAX_TRANSCRIPT_QUERY_CHARACTERS,
  MAX_TRANSCRIPT_SEARCH_RESULTS,
} from "../core/search-limits.js";

export const sourceRefSchema = z
  .string()
  .regex(/^urma:source:(?:remote:v1:[0-9a-f]{64}|local:[0-9a-f]{32})$/);

export const investigationRefSchema = z
  .string()
  .regex(/^urma:investigation:[0-9a-f]{32}$/);

export const artifactIdSchema = z
  .string()
  .regex(/^urma:artifact:sha256:[0-9a-f]{64}$/);

export const trackRefSchema = z.string().regex(/^urma:track:[0-9a-f]{32}$/);

const ms = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveMs = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const interval = z.object({ startMs: ms, endMs: ms });
const cropCoordinates = z.strictObject({
  x: z.number().min(0).max(100), y: z.number().min(0).max(100),
  w: z.number().positive().max(100), h: z.number().positive().max(100),
}).refine((crop) => crop.x < 100 && crop.y < 100 && crop.x + crop.w <= 100 + 1e-9 && crop.y + crop.h <= 100 + 1e-9,
  { message: "crop must fit within the individual displayed source frame (x+w and y+h <= 100)" });
const cropGeometry = z.object({
  coordinates: z.literal("displayed-source-percent"), requested: cropCoordinates,
  sourceWidth: positiveMs, sourceHeight: positiveMs,
  pixels: z.object({ x: ms, y: ms, width: positiveMs, height: positiveMs }),
});
const framePreview = z.object({
  artifactId: artifactIdSchema, resource: z.string().max(256),
  mimeType: z.literal("image/jpeg"), byteSize: positiveMs,
  width: positiveMs, height: positiveMs,
  derived: z.literal(true), canonical: z.literal(false),
  rulers: z.literal(true), coordinateSpace: z.literal("individual-displayed-source"),
});
const refinement = z.object({
  policy: z.literal("largest-gap-midpoint-v1"), budget: z.number().int().min(1).max(12),
  basis: z.enum(["visual", "exact"]), selectedTimesMs: z.array(ms).max(12),
  exhausted: z.boolean(),
  remainingGaps: z.object({
    scope: z.literal("investigation"), interval,
    timestampBasis: z.enum(["nominal-and-requested", "requested"]),
    largestGaps: z.array(z.object({ startMs: ms, endMs: ms, durationSeconds: z.number().positive() })).max(5),
  }),
});
const gap = z.object({ startMs: ms, endMs: ms });
const samplingGaps = z.object({
  scope: z.literal("response"),
  interval,
  timestampBasis: z.enum(["nominal", "requested"]),
  largestGaps: z.array(gap.extend({
    durationSeconds: z.number().positive().max(Number.MAX_SAFE_INTEGER / 1_000),
  })).min(1).max(5),
});

const ratio = z.number().min(0).max(1);
const analysisDimensions = z.object({
  width: z.number().int().min(4).max(256), height: z.number().int().min(4).max(144), aspectRatioError: z.number().min(0).max(.05),
});
const visualDelta = z.object({
  policy: z.literal("rgb-block-delta-v1"),
  analysis: analysisDimensions.extend({ pixelFormat: z.literal("rgb24"), blockSize: z.literal(4),
    pixelThreshold: z.literal(12), strongPixelThreshold: z.literal(48), connectivity: z.literal(8) }),
  changedPixelRatio: ratio, nonzeroPixelRatio: ratio, meanAbsoluteChannelDelta: ratio,
  unclusteredChangedPixelRatio: ratio, omittedChangedPixelRatio: ratio,
  omittedRegionCount: z.number().int().nonnegative().max(2304),
  regions: z.array(z.object({ x: z.number().min(0).max(100), y: z.number().min(0).max(100),
    w: z.number().positive().max(100), h: z.number().positive().max(100), changedPixelRatio: ratio, density: ratio,
    suggestedCrop: cropCoordinates.optional() })).max(16),
});
const diffHints = z.object({
  policy: z.literal("rgb-block-delta-v1"), comparisonOrder: z.literal("returned-request-order"),
  sourceRef: sourceRefSchema, sourceRevision: z.string().max(256),
  semanticInterpretation: z.literal(false), continuousObservation: z.literal(false),
  decodedFrames: z.number().int().nonnegative().max(12), cacheHits: z.number().int().nonnegative().max(12),
  comparisons: z.array(z.object({
    fromIndex: ms, toIndex: ms, fromRequestedAtMs: ms, toRequestedAtMs: ms,
    fromArtifactId: artifactIdSchema, toArtifactId: artifactIdSchema,
    status: z.enum(["analyzed", "unavailable"]), reason: z.string().max(512).optional(),
    coordinateSpace: z.literal("individual-displayed-source"), sourceCrop: cropGeometry.optional(), delta: visualDelta.optional(),
  })).max(11),
});
const deduplication = z.object({
  policy: z.literal("conservative-frame-groups-v1"), scope: z.literal("response"),
  observationsPreserved: z.literal(true), continuousObservation: z.literal(false),
  inputFrameCount: z.number().int().min(0).max(12), representativeCount: z.number().int().min(0).max(12),
  suppressedImageCount: z.number().int().min(0).max(11), comparisons: z.number().int().min(0).max(66),
  decodedFrames: z.number().int().min(0).max(12), cacheHits: z.number().int().min(0).max(12),
  groups: z.array(z.object({
    representativeIndex: ms, representativeAtMs: ms, representativeArtifactId: artifactIdSchema,
    representativeResource: z.string().max(256), panelIndex: z.number().int().min(1).max(12).nullable(),
    members: z.array(z.object({
      index: ms, requestedAtMs: ms, artifactId: artifactIdSchema, resource: z.string().max(256),
      sourceRef: sourceRefSchema, sourceRevision: z.string().max(256), crop: cropGeometry.optional(),
      relation: z.enum(["representative", "identical-artifact", "native-rgb-identical", "uniform-native-offset"]),
      verifiedAgainstIndices: z.array(ms).max(11),
      measurement: z.object({ width: z.number().int().min(4).max(256), height: z.number().int().min(4).max(144), blockSize: z.literal(4),
        globalChangedPixelRatio: z.literal(0), maximumChannelDelta: z.number().int().min(0).max(2),
        maximumBlockMeanDelta: z.number().min(0).max(2), blockMeanSpread: z.literal(0), channelOffsetSpread: z.literal(0),
      }).nullable(),
    })).min(1).max(12),
  })).max(12),
});
const presentationMs = z.number().nonnegative().max(Number.MAX_SAFE_INTEGER);
const discovery = z.object({
  policy: z.literal("visual-transition-v1"), sourceRef: sourceRefSchema, sourceRevision: z.string().max(256),
  semanticInterpretation: z.literal(false), continuousObservation: z.literal(false),
  coordinateSpace: z.literal("individual-displayed-source"),
  interval, scanInterval: interval, analysis: analysisDimensions,
  budget: z.number().int().min(1).max(12), maxFrames: z.number().int().min(4).max(240), maxScanMs: z.number().int().min(1).max(30000),
  decodedAnalysisFrames: z.number().int().nonnegative().max(240), fineFrameCount: z.number().int().nonnegative().max(240),
  keyframeAssisted: z.boolean(), coarsePresentationTimesMs: z.array(presentationMs).max(24),
  presentationTimesMs: z.array(presentationMs).max(240), candidateCount: z.number().int().nonnegative().max(239),
  omittedCandidateCount: z.number().int().nonnegative().max(239),
  candidates: z.array(z.object({ requestedAtMs: ms, observedPresentationTimeMs: presentationMs,
    comparedFromPresentationTimeMs: presentationMs, sceneScore: z.number().min(0).max(100), delta: visualDelta })).max(12),
  frameLimitReached: z.boolean(), rangeLimited: z.boolean(),
  scanSamplingGaps: samplingGaps.extend({ timestampBasis: z.literal("decoded-presentation-floor-ms") }),
  provenance: z.object({ method: z.literal("ffmpeg-rgb24-scdet"), transportArtifactId: artifactIdSchema.nullable(),
    ffmpegVersion: z.string().max(512).nullable(),
    timeline: z.literal("container-origin-relative"), ffmpegSceneThreshold: z.number().positive().max(100),
    minChangedRatio: z.number().positive().max(1), decoderThreads: z.literal(1), maxInputPixels: z.literal(8388608),
    maxWallMs: z.number().int().positive().max(15000), selectedFramePtsAvailable: z.literal(false) }),
});

const overviewProvenance = z.object({
  kind: z.enum(["storyboard", "decoded"]),
  timing: z.enum(["exact", "nominal"]),
  sampleId: z.string().min(1).max(256),
  sourceArtifactId: artifactIdSchema.nullable(),
  fragmentIndex: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .nullable(),
  cellIndex: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .nullable(),
});

const overviewStateCell = z.object({
  index: z.number().int().nonnegative().max(11),
  timestampMs: ms,
  provenance: overviewProvenance,
});

const overviewSampleReuse = z.object({
  relation: z.enum([
    "not-scoped",
    "no-prior-overview",
    "same-samples",
    "different-subset",
    "new-decoded-samples",
  ]),
  reusedUnderlyingSamples: z.boolean(),
});

const overviewObservedCoverage = z.object({
  kind: z.literal("sample-points-only"),
  continuous: z.literal(false),
  sampleTimestampsMs: z.array(ms).min(1).max(12),
  adjacentSpacingMs: z.array(ms).max(11),
});

const overviewStateSet = z.object({
  kind: z.literal("overview"),
  timebase: z.literal("source-global"),
  requestedInterval: interval,
  requestedPointsMs: z.array(ms).min(1).max(12),
  observedCoverage: overviewObservedCoverage,
  source: z.enum(["native-storyboard", "navigation-media"]),
  artifactId: artifactIdSchema.nullable(),
  cells: z.array(overviewStateCell).min(1).max(12),
  sampleReuse: overviewSampleReuse,
});

export const stateSummarySchema = z.object({
  investigationRef: investigationRefSchema,
  calls: z.number().int().nonnegative(),
  visual: z.object({
    sparseSets: z.number().int().nonnegative(),
    exactPoints: z.number().int().nonnegative(),
    orderedBursts: z.number().int().nonnegative(),
    largestUnsampledGaps: z.array(gap).max(5),
    largestExactFrameGaps: z.array(gap).max(3),
    recentOverviewSets: z.array(overviewStateSet).max(5),
  }),
  transcript: z.object({
    searches: z.number().int().nonnegative(),
    returnedRanges: z.array(interval).max(5),
  }),
  cache: z.object({
    storyboard: z.boolean(),
    navigationCopy: z.boolean(),
    continuousMediaIntervals: z.number().int().nonnegative(),
  }),
  network: z.object({
    measuredBytes: z.number().int().nonnegative().nullable(),
    accountingComplete: z.boolean(),
  }),
  stateResource: z.string().max(256),
});

export const inspectInput = z.object({
  source: z.string().min(1).max(4096),
  freshness: z.enum(["reuse", "refresh"]).optional(),
});

const cachedMediaInterval = z.object({
  kind: z.literal("cached_media"),
  startMs: ms,
  endMs: ms,
  artifactId: artifactIdSchema,
  fidelity: z.enum(["navigation", "evidence"]),
});

const transcriptTrack = z.object({
  trackRef: trackRefSchema,
  language: z.string().max(100),
  kind: z.enum(["manual", "automatic", "sidecar", "unknown"]),
  displayName: z.string().max(200).nullable(),
  providerTrackId: z.string().max(256).nullable(),
  embedded: z.object({ streamIndex: ms, codec: z.enum(["subrip", "webvtt", "mov_text"]), default: z.boolean() }).optional(),
});

export const inspectOutput = z.object({
  sourceRef: sourceRefSchema,
  investigationRef: investigationRefSchema,
  source: z.object({
    kind: z.enum(["remote", "local"]),
    observedAt: z.string().min(1).max(100),
    snapshotRevision: z.string().min(1).max(256),
    metadataDurationMs: ms.nullable(),
    timeline: z.object({
      finite: z.literal(true),
      durationMs: positiveMs,
      basis: z.enum(["progressive", "hls", "dash", "container"]),
      validatedAt: z.string().min(1).max(100),
    }),
    extractor: z.string().max(200).nullable(),
    extractorKey: z.string().max(512).nullable(),
    safeOrigins: z.array(z.string().max(2048)).max(32),
    title: z.string().max(1000),
    titlePartial: z.boolean(),
    durationMs: positiveMs,
    chapters: z
      .array(z.object({ startMs: ms, endMs: ms, title: z.string().max(1000) }))
      .max(500),
    chapterCount: z.number().int().nonnegative(),
    chaptersPartial: z.boolean(),
  }),
  capabilities: z.object({
    nativeCaptions: z.boolean(),
    chapters: z.boolean(),
    nativeStoryboard: z.boolean(),
    targetedMedia: z.boolean(),
    audio: z.boolean(),
    progressive: z.boolean().optional(),
    hls: z.boolean().optional(),
    dash: z.boolean().optional(),
    mhtml: z.boolean().optional(),
  }),
  captionTracks: z.array(transcriptTrack).max(100),
  captionTrackCount: z.number().int().nonnegative(),
  captionTracksPartial: z.boolean(),
  cache: z.object({
    transcriptTracks: z.number().int().nonnegative(),
    storyboard: z.boolean(),
    navigationCopy: z.boolean(),
    continuousMediaIntervalCount: z.number().int().nonnegative(),
    continuousMediaIntervals: z.array(cachedMediaInterval).max(20),
    partial: z.boolean(),
    reusableArtifacts: z.number().int().nonnegative(),
  }),
  stateSummary: stateSummarySchema,
  stateResource: z.string().max(256),
});

const transcriptQuery = z
  .string()
  .min(1)
  .max(MAX_TRANSCRIPT_QUERY_CHARACTERS)
  .regex(/\S/u, "must contain non-whitespace characters");

const searchFields = {
  investigationRef: investigationRefSchema,
  trackRef: trackRefSchema.optional(),
  mode: z.enum(["phrase", "terms"]).optional(),
  limit: z.number().int().min(1).max(MAX_TRANSCRIPT_SEARCH_RESULTS).optional(),
};

const singleSearchInput = z.looseObject({
  query: transcriptQuery,
  queries: z.never().optional(),
});

const batchSearchInput = z.looseObject({
  query: z.never().optional(),
  queries: z.array(transcriptQuery).min(1).max(MAX_TRANSCRIPT_BATCH_QUERIES),
});

export const searchInput = z.looseObject(searchFields).and(
  z.xor([singleSearchInput, batchSearchInput]),
);

const searchHit = z.object({
  startMs: ms,
  endMs: ms,
  text: z.string().max(MAX_TRANSCRIPT_BATCH_CHARACTERS),
  context: z
    .array(
      z.object({
        startMs: ms,
        endMs: ms,
        text: z.string().max(MAX_TRANSCRIPT_BATCH_CHARACTERS),
      }),
    )
    .max(3),
});

const batchSearchHit = z.object({
  startMs: ms,
  endMs: ms,
  text: z.string().max(MAX_TRANSCRIPT_BATCH_CHARACTERS),
  matchedQueries: z
    .array(transcriptQuery)
    .min(1)
    .max(MAX_TRANSCRIPT_BATCH_QUERIES),
});

const searchScope = z.literal("selected-caption-track");

const singleSearchOutput = z.object({
  query: z.string().max(MAX_TRANSCRIPT_QUERY_CHARACTERS),
  mode: z.enum(["phrase", "terms"]),
  scope: searchScope,
  track: transcriptTrack,
  hits: z.array(searchHit).max(MAX_TRANSCRIPT_SEARCH_RESULTS),
  candidateHitCount: z.number().int().nonnegative(),
  candidateCountComplete: z.boolean(),
  omittedHits: z.number().int().nonnegative().nullable(),
  partial: z.boolean(),
  matchSemantics: z.string().max(500),
  missMeaning: z.string().max(500).nullable(),
  stateSummary: stateSummarySchema,
});

const batchSearchOutput = z.object({
  queries: z.array(transcriptQuery).min(1).max(MAX_TRANSCRIPT_BATCH_QUERIES),
  mode: z.enum(["phrase", "terms"]),
  scope: searchScope,
  track: transcriptTrack,
  hits: z.array(batchSearchHit).max(MAX_TRANSCRIPT_BATCH_HITS),
  candidateHitCount: z.number().int().nonnegative(),
  candidateCountComplete: z.boolean(),
  omittedHits: z.number().int().nonnegative().nullable(),
  returnedCharacters: z
    .number()
    .int()
    .nonnegative()
    .max(MAX_TRANSCRIPT_BATCH_CHARACTERS),
  partial: z.boolean(),
  matchSemantics: z.string().max(500),
  missMeaning: z.string().max(500).nullable(),
  stateSummary: stateSummarySchema,
});

export const searchOutput = z.union([singleSearchOutput, batchSearchOutput]);

export const readInput = z.object({
  investigationRef: investigationRefSchema,
  startMs: ms,
  endMs: ms,
  trackRef: trackRefSchema.optional(),
  cursor: z.string().max(1024).optional(),
});

export const readOutput = z.object({
  requestedRange: interval,
  returnedRange: interval.nullable(),
  track: transcriptTrack,
  segments: z
    .array(z.object({ startMs: ms, endMs: ms, text: z.string().max(16_000) }))
    .max(200),
  partial: z.boolean(),
  nextCursor: z.string().max(1024).nullable(),
  stateSummary: stateSummarySchema,
});

export const overviewInput = z.object({
  investigationRef: investigationRefSchema,
  startMs: ms.optional(),
  endMs: ms.optional(),
  rulers: z.boolean().optional(),
});

const overviewCell = z.object({
  index: z.number().int().nonnegative().max(11),
  timestampMs: ms,
  artifactId: artifactIdSchema,
  resource: z.string().max(256),
  provenance: overviewProvenance,
});

const overviewSampling = z.object({
  requestedCount: z.literal(12),
  requestedPointsMs: z.array(ms).min(1).max(12),
  returnedCount: z.number().int().min(1).max(12),
  adjacentSpacingMs: z.array(ms).max(11),
  resolutionMs: z.null(),
  sampleReuse: overviewSampleReuse,
});

export const overviewOutput = z.object({
  role: z.literal("locator"),
  sparse: z.literal(true),
  continuousInspection: z.literal(false),
  requestedCount: z.literal(12),
  actualCount: z.number().int().min(1).max(12),
  interval,
  requestedInterval: interval,
  timebase: z.literal("source-global"),
  observedCoverage: overviewObservedCoverage,
  sampling: overviewSampling,
  samplingGaps,
  cells: z.array(overviewCell).min(1).max(12),
  source: z.enum(["native-storyboard", "navigation-media"]),
  artifact: z.object({
    artifactId: artifactIdSchema,
    mimeType: z.literal("image/jpeg"),
    byteSize: z.number().int().positive(),
    resource: z.string().max(256),
  }),
  cacheHit: z.boolean(),
  rulers: z.literal(true).optional(),
  stateSummary: stateSummarySchema,
});

const pointsRequest = z.object({
  kind: z.literal("points"),
  timesMs: z
    .array(ms)
    .min(1)
    .max(
      12,
      "get_frames supports at most 12 timestamps; split larger panel comparisons into separate requests",
    ),
});

const burstRequest = z.object({
  kind: z.literal("burst"),
  startMs: ms,
  endMs: ms,
  count: z
    .number()
    .int()
    .min(2)
    .max(
      12,
      "get_frames supports at most 12 frames; split larger panel comparisons into separate requests",
    ),
});

const cadenceRequest = z
  .object({
    kind: z.literal("cadence"),
    startMs: ms,
    endMs: ms,
    cadenceMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .refine((value) => value.endMs > value.startMs, {
    message: "Cadence schedule requires endMs > startMs",
  });

const frameRequest = z.discriminatedUnion("kind", [
  pointsRequest,
  burstRequest,
  cadenceRequest,
  z.object({
    kind: z.literal("refine"), startMs: ms.optional(), endMs: ms.optional(),
    budget: z.number().int().min(1).max(12), basis: z.enum(["visual", "exact"]).optional(),
  }).refine((request) => request.startMs === undefined || request.endMs === undefined || request.endMs > request.startMs,
    { message: "Refinement range requires endMs > startMs" }),
  z.object({ kind: z.literal("discover"), startMs: ms.optional(), endMs: ms.optional(),
    budget: z.number().int().min(1).max(12), maxFrames: z.number().int().min(4).max(240).optional(),
    maxScanMs: z.number().int().min(1).max(30000).optional(), sceneThreshold: z.number().positive().max(100).optional(),
    minChangedRatio: z.number().positive().max(1).optional(), keyframeAssist: z.boolean().optional(),
  }).refine((request) => request.startMs === undefined || request.endMs === undefined || request.endMs > request.startMs,
    { message: "Discovery range requires endMs > startMs" }),
]);

const framesBaseInput = z.looseObject({
  investigationRef: investigationRefSchema,
  presentation: z.enum(["individual", "panel"]).optional(),
  crop: cropCoordinates.optional(),
  rulers: z.boolean().optional(),
  diffHints: z.boolean().optional(),
  deduplicate: z.boolean().optional(),
  pageSize: z.number().int().min(1).max(12).optional(),
  maxTargets: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
});

const framesSelectionInput = z.xor([
  z.looseObject({
    request: frameRequest,
    cursor: z.never().optional(),
  }),
  z.looseObject({
    request: z.never().optional(),
    cursor: z.string().max(1024),
  }),
]);

export const framesInput = framesBaseInput.and(framesSelectionInput).superRefine((value, context) => {
  const hasCursor = value.cursor !== undefined;
  if (value.request === undefined && !hasCursor) {
    context.addIssue({
      code: "custom",
      path: ["request"],
      message: "Provide an explicit request or a cadence continuation cursor",
    });
  }
  if (value.request !== undefined && hasCursor) {
    context.addIssue({
      code: "custom",
      path: ["cursor"],
      message: "A continuation cursor must be used without a new request",
    });
  }
  if (
    value.request !== undefined &&
    value.request.kind !== "cadence" &&
    (value.pageSize !== undefined || value.maxTargets !== undefined)
  ) {
    context.addIssue({
      code: "custom",
      path: ["request"],
      message: "pageSize and maxTargets apply only to cadence schedules",
    });
  }
});

const canonicalFrame = z.object({
  artifactId: artifactIdSchema,
  mimeType: z.literal("image/jpeg"),
  byteSize: z.number().int().positive(),
  resource: z.string().max(256),
  cacheHit: z.boolean(),
  crop: cropGeometry.optional(),
  preview: framePreview.optional(),
});

const individualFramesOutput = z.object({
  kind: z.enum(["exact_points", "ordered_points"]),
  continuousMotion: z.literal(false),
  samplingGaps,
  refinement: refinement.optional(),
  discovery: discovery.optional(),
  diffHints: diffHints.optional(),
  deduplication: deduplication.optional(),
  frames: z
    .array(
      z.object({
        index: z.number().int().nonnegative().max(11),
        atMs: ms,
        ...canonicalFrame.shape,
      }),
    )
    .min(1)
    .max(12),
  stateSummary: stateSummarySchema,
});

const panelFramesOutput = z.object({
  kind: z.enum(["exact_points", "ordered_points"]),
  continuousMotion: z.literal(false),
  samplingGaps,
  refinement: refinement.optional(),
  discovery: discovery.optional(),
  diffHints: diffHints.optional(),
  deduplication: deduplication.optional(),
  presentation: z.literal("panel"),
  cells: z
    .array(
      z.object({
        index: z.number().int().min(1).max(12),
        timestampMs: ms,
        ...canonicalFrame.shape,
      }),
    )
    .min(1)
    .max(12),
  panel: z.object({
    artifactId: artifactIdSchema,
    mimeType: z.literal("image/jpeg"),
    byteSize: z.number().int().positive(),
    resource: z.string().max(256),
    width: z.number().int().positive().max(1600),
    height: z.number().int().positive().max(876),
    rulers: z.literal(true).optional(),
    coordinateSpace: z.literal("individual-displayed-source").optional(),
    cellCount: z.number().int().min(1).max(12),
    cacheHit: z.boolean(),
    derived: z.literal(true),
    canonical: z.literal(false),
  }),
  stateSummary: stateSummarySchema,
});

const scheduleTiming = z.object({
  requestedAtMs: ms,
  selectedPresentationTimeMs: ms.nullable(),
  status: z.literal("unavailable"),
});

const scheduleSuccessSlot = z.object({
  index: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  requestedAtMs: ms,
  status: z.literal("success"),
  timing: scheduleTiming,
  ...canonicalFrame.shape,
});

const scheduleErrorSlot = z.object({
  index: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  requestedAtMs: ms,
  status: z.literal("error"),
  timing: scheduleTiming,
  error: z.object({
    code: z.string().min(1).max(64),
    retryable: z.boolean(),
    detail: z.string().max(2_000),
  }),
});

const scheduleUnfinishedSlot = z.object({
  index: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  requestedAtMs: ms,
  status: z.literal("unfinished"),
  timing: scheduleTiming,
});

const scheduleSlot = z.union([
  scheduleSuccessSlot,
  scheduleErrorSlot,
  scheduleUnfinishedSlot,
]);

const scheduleFields = z.object({
  kind: z.literal("scheduled_exact_points"),
  continuous: z.literal(false),
  observations: z.literal("discrete-points"),
  samplingGaps,
  diffHints: diffHints.optional(),
  deduplication: deduplication.optional(),
  schedule: z.object({
    kind: z.literal("fixed-cadence"),
    startMs: ms,
    endMs: ms,
    cadenceMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    totalTargets: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    policyVersion: z.literal("fixed-cadence-v1"),
  }),
  page: z.object({
    startIndex: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    endIndexExclusive: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    pageSize: z.number().int().min(1).max(12),
  }),
  slots: z.array(scheduleSlot).min(1).max(12),
  counts: z.object({
    successes: z.number().int().nonnegative().max(12),
    errors: z.number().int().nonnegative().max(12),
    unfinished: z.number().int().nonnegative().max(12),
  }),
  continuationFrontier: z.number().int().nonnegative().max(120),
  remainingTargetCount: z.number().int().nonnegative().max(
    Number.MAX_SAFE_INTEGER,
  ),
  scheduleComplete: z.boolean(),
  nextCursor: z.string().max(1024).nullable(),
});

const schedulePanelCell = z.union([
  z.object({
    index: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    panelIndex: z.number().int().positive().max(12).nullable(),
    requestedAtMs: ms,
    status: z.literal("success"),
    ...canonicalFrame.shape,
  }),
  z.object({
    index: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    panelIndex: z.null(),
    requestedAtMs: ms,
    status: z.enum(["error", "unfinished"]),
  }),
]);

const schedulePanel = z.object({
  artifactId: artifactIdSchema,
  mimeType: z.literal("image/jpeg"),
  byteSize: z.number().int().positive(),
  resource: z.string().max(256),
  width: z.number().int().positive().max(1600),
  height: z.number().int().positive().max(876),
  rulers: z.literal(true).optional(),
  coordinateSpace: z.literal("individual-displayed-source").optional(),
  cellCount: z.number().int().min(1).max(12),
  cacheHit: z.boolean(),
  derived: z.literal(true),
  canonical: z.literal(false),
});

const scheduleIndividualOutput = z.object({
  ...scheduleFields.shape,
  presentation: z.literal("individual"),
  stateSummary: stateSummarySchema,
});

const schedulePanelOutput = z.object({
  ...scheduleFields.shape,
  presentation: z.literal("panel"),
  cells: z.array(schedulePanelCell).min(1).max(12),
  panel: schedulePanel.nullable(),
  stateSummary: stateSummarySchema,
});

export const framesOutput = z.union([
  individualFramesOutput,
  panelFramesOutput,
  scheduleIndividualOutput,
  schedulePanelOutput,
  individualFramesOutput.extend({
    frames: z.array(z.never()).length(0), refinement,
  }),
  individualFramesOutput.extend({ frames: z.array(z.never()).length(0), discovery }),
]);

const modelIdentity = {
  investigationRef: investigationRefSchema,
  stateResource: z.string().max(256),
};

/** Rich schemas validate internal records; public schemas cover the compact MCP projection */
export const inspectMcpOutput = inspectOutput.omit({ stateSummary: true });

const singleSearchMcpOutput = singleSearchOutput
  .omit({ stateSummary: true })
  .extend(modelIdentity);
const batchSearchMcpOutput = batchSearchOutput
  .omit({ stateSummary: true })
  .extend(modelIdentity);
export const searchMcpOutput = z.union([
  singleSearchMcpOutput,
  batchSearchMcpOutput,
]);

export const readMcpOutput = readOutput
  .omit({ stateSummary: true })
  .extend(modelIdentity);

const overviewCellMcp = overviewCell.omit({ artifactId: true, resource: true });
const overviewSamplingMcp = overviewSampling.omit({
  requestedCount: true,
  adjacentSpacingMs: true,
  resolutionMs: true,
});
const overviewArtifactMcp = overviewOutput.shape.artifact.omit({
  mimeType: true,
  byteSize: true,
});
export const overviewMcpOutput = overviewOutput
  .omit({
    stateSummary: true,
    requestedCount: true,
    interval: true,
    sampling: true,
    cells: true,
    artifact: true,
    cacheHit: true,
  })
  .extend({
    ...modelIdentity,
    sampling: overviewSamplingMcp,
    cells: z.array(overviewCellMcp).min(1).max(12),
    artifact: overviewArtifactMcp,
  });

const canonicalFrameMcp = canonicalFrame.omit({
  mimeType: true,
  byteSize: true,
  cacheHit: true,
});
const individualFramesMcpOutput = individualFramesOutput
  .omit({ stateSummary: true, frames: true })
  .extend({
    ...modelIdentity,
    frames: z.array(
      z.object({
        index: z.number().int().nonnegative().max(11),
        atMs: ms,
        ...canonicalFrameMcp.shape,
      }),
    ).min(1).max(12),
  });
const panelFramesMcpOutput = panelFramesOutput
  .omit({ stateSummary: true, cells: true, panel: true })
  .extend({
    ...modelIdentity,
    cells: z.array(
      z.object({
        index: z.number().int().min(1).max(12),
        timestampMs: ms,
        ...canonicalFrameMcp.shape,
      }),
    ).min(1).max(12),
    panel: panelFramesOutput.shape.panel.omit({
      mimeType: true,
      byteSize: true,
      cacheHit: true,
    }),
  });

const scheduleMcp = scheduleFields.shape.schedule.omit({ policyVersion: true });
const scheduleSuccessMcpSlot = scheduleSuccessSlot
  .omit({ timing: true, mimeType: true, byteSize: true, cacheHit: true })
  .extend(canonicalFrameMcp.shape);
const scheduleErrorMcpSlot = scheduleErrorSlot.omit({ timing: true });
const scheduleUnfinishedMcpSlot = scheduleUnfinishedSlot.omit({ timing: true });
const scheduleMcpSlot = z.union([
  scheduleSuccessMcpSlot,
  scheduleErrorMcpSlot,
  scheduleUnfinishedMcpSlot,
]);
const scheduleFieldsMcp = scheduleFields
  .omit({ schedule: true, slots: true })
  .extend({
    schedule: scheduleMcp,
    slots: z.array(scheduleMcpSlot).min(1).max(12),
  });
const schedulePanelMcpCell = z.union([
  z.object({
    index: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    panelIndex: z.number().int().positive().max(12).nullable(),
    requestedAtMs: ms,
    status: z.literal("success"),
    ...canonicalFrameMcp.shape,
  }),
  z.object({
    index: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    panelIndex: z.null(),
    requestedAtMs: ms,
    status: z.enum(["error", "unfinished"]),
  }),
]);
const schedulePanelMcp = schedulePanel.omit({
  mimeType: true,
  byteSize: true,
  cacheHit: true,
});
export const framesMcpOutput = z.union([
  individualFramesMcpOutput,
  individualFramesMcpOutput.extend({ frames: z.array(z.never()).length(0), refinement }),
  individualFramesMcpOutput.extend({ frames: z.array(z.never()).length(0), discovery }),
  panelFramesMcpOutput,
  scheduleIndividualOutput
    .omit({ stateSummary: true, schedule: true, slots: true })
    .extend({
      ...modelIdentity,
      ...scheduleFieldsMcp.shape,
      presentation: z.literal("individual"),
    }),
  schedulePanelOutput
    .omit({ stateSummary: true, schedule: true, slots: true, cells: true, panel: true })
    .extend({
      ...modelIdentity,
      ...scheduleFieldsMcp.shape,
      presentation: z.literal("panel"),
      cells: z.array(schedulePanelMcpCell).min(1).max(12),
      panel: schedulePanelMcp.nullable(),
    }),
]);
