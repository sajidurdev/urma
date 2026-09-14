import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import type { UrmaConfig } from "../config.js";
import {
  assertInterval,
  OVERVIEW_CELL_COUNT,
  uniformPointsMs,
} from "../core/coverage.js";
import { diagnosticLog } from "../core/diagnostics.js";
import { UrmaError } from "../core/errors.js";
import type { ArtifactId, InvestigationRef } from "../core/ids.js";
import {
  OVERVIEW_CONTRACT_ID,
  type OverviewCell,
  type OverviewSampleProvenance,
} from "../core/model.js";
import { deterministicRequestKey } from "../core/request-key.js";
import type { ResolvedSource } from "../sources/types.js";
import { verifyPinnedLocalVideo } from "../sources/local.js";
import { Ffmpeg } from "../subprocess/ffmpeg.js";
import { collectBinaryVersions } from "../subprocess/versions.js";
import { BlobStore } from "../store/blob-store.js";
import type { StoredArtifact, UrmaStore } from "../store/store.js";
import { URMA_VERSION } from "../version.js";
import { MediaAcquirer } from "./media.js";
import { createPanel } from "./panel.js";
import { StoryboardAcquirer } from "./storyboard.js";
import type { RemoteOperationContext } from "../remote/worker.js";

type OverviewSource = "native-storyboard" | "navigation-media";
type OverviewScope = Readonly<{ startMs: number; endMs: number }>;
export type OverviewResult = Readonly<{
  artifact: StoredArtifact;
  requestedPointsMs: number[];
  pointsMs: number[];
  cells: OverviewCell[];
  source: OverviewSource;
  materialCacheHit: boolean;
  cacheHit: boolean;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseArtifactId(value: unknown): ArtifactId | null | undefined {
  if (value === null) return null;
  if (
    typeof value === "string" &&
    /^urma:artifact:sha256:[0-9a-f]{64}$/u.test(value)
  ) {
    return value as ArtifactId;
  }
  return undefined;
}

function parseProvenance(value: unknown): OverviewSampleProvenance | null {
  if (
    !isRecord(value) ||
    (value.kind !== "storyboard" && value.kind !== "decoded") ||
    (value.timing !== "exact" && value.timing !== "nominal") ||
    typeof value.sampleId !== "string" ||
    value.sampleId.length < 1 ||
    value.sampleId.length > 256
  ) {
    return null;
  }
  const sourceArtifactId = parseArtifactId(value.sourceArtifactId);
  if (sourceArtifactId === undefined) return null;
  const fragmentIndex = value.fragmentIndex === null
    ? null
    : isNonNegativeSafeInteger(value.fragmentIndex)
    ? value.fragmentIndex
    : undefined;
  const cellIndex = value.cellIndex === null
    ? null
    : isNonNegativeSafeInteger(value.cellIndex)
    ? value.cellIndex
    : undefined;
  if (fragmentIndex === undefined || cellIndex === undefined) return null;
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

function parsePoints(value: unknown, scope: OverviewScope): number[] | null {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > OVERVIEW_CELL_COUNT
  ) {
    return null;
  }
  const points = value.map((point) => point);
  if (
    points.some(
      (point, index) =>
        !isNonNegativeSafeInteger(point) ||
        point < scope.startMs ||
        point >= scope.endMs ||
        (index > 0 && point <= points[index - 1]!),
    )
  ) {
    return null;
  }
  return points;
}

function parseCells(
  value: unknown,
  pointsMs: readonly number[],
): OverviewCell[] | null {
  if (!Array.isArray(value) || value.length !== pointsMs.length) return null;
  const cells: OverviewCell[] = [];
  for (const [index, raw] of value.entries()) {
    if (
      !isRecord(raw) ||
      raw.index !== index ||
      raw.timestampMs !== pointsMs[index]
    ) {
      return null;
    }
    const provenance = parseProvenance(raw.provenance);
    if (!provenance) return null;
    cells.push({ index, timestampMs: pointsMs[index]!, provenance });
  }
  return cells;
}

function cachedOverview(
  cached: StoredArtifact,
  scope: OverviewScope,
): {
  requestedPointsMs: number[];
  pointsMs: number[];
  cells: OverviewCell[];
  source: OverviewSource;
} | null {
  if (
    cached.kind !== "overview_panel" ||
    cached.role !== "locator" ||
    cached.mimeType !== "image/jpeg" ||
    cached.startMs !== scope.startMs ||
    cached.endMs !== scope.endMs
  ) {
    return null;
  }
  if (cached.params.contractId !== OVERVIEW_CONTRACT_ID) return null;
  const source = cached.params.source;
  if (source !== "native-storyboard" && source !== "navigation-media") {
    return null;
  }
  const requestedPointsMs = cached.params.requestedPointsMs;
  const pointsMs = cached.params.pointsMs;
  const requested = Array.isArray(requestedPointsMs) &&
      requestedPointsMs.length >= 1 &&
      requestedPointsMs.length <= OVERVIEW_CELL_COUNT &&
      requestedPointsMs.every(
        (point, index) =>
          isNonNegativeSafeInteger(point) &&
          point >= scope.startMs &&
          point < scope.endMs &&
          (index === 0 || point > requestedPointsMs[index - 1]!),
      )
    ? [...requestedPointsMs]
    : null;
  const points = parsePoints(pointsMs, scope);
  const cells = points ? parseCells(cached.params.cells, points) : null;
  if (!requested || !points || !cells) return null;
  return { requestedPointsMs: requested, pointsMs: [...points], cells, source };
}

export class OverviewAcquirer {
  readonly storyboards: StoryboardAcquirer;
  readonly media: MediaAcquirer;

  constructor(
    readonly config: UrmaConfig,
    readonly store: UrmaStore,
    readonly blobs: BlobStore,
    readonly remoteContext: RemoteOperationContext | null = null,
  ) {
    this.storyboards = new StoryboardAcquirer(config, store, blobs, remoteContext);
    this.media = new MediaAcquirer(config, store, blobs, undefined, remoteContext);
  }

  async #navigationFrames(
    source: ResolvedSource,
    ref: InvestigationRef,
    requested: readonly number[],
    working: string,
    signal?: AbortSignal,
  ): Promise<{
    frames: string[];
    pointsMs: number[];
    cells: OverviewCell[];
    parent: StoredArtifact | null;
    materialCacheHit: boolean;
  }> {
    const media = source.kind === "local"
      ? null
      : await this.media.navigation(source, ref, signal);
    const mediaPath = source.kind === "local"
      ? await verifyPinnedLocalVideo(source.safeMetadata.localSnapshot, this.blobs)
      : media?.path;
    if (!mediaPath) {
      throw new UrmaError(
        "TARGETED_MEDIA_UNAVAILABLE",
        "No navigation media was acquired for the requested overview",
      );
    }
    const ffmpeg = new Ffmpeg(this.config);
    const frames: string[] = [];
    const cells: OverviewCell[] = [];
    const sourceArtifactId = media?.artifact?.artifactId ?? null;
    for (const [index, time] of requested.entries()) {
      const output = path.join(working, `cell-${index}.jpg`);
      await ffmpeg.extractJpeg(mediaPath, time, output, signal);
      await ffmpeg.validateJpeg(output);
      frames.push(output);
      cells.push({
        index,
        timestampMs: time,
        provenance: {
          kind: "decoded",
          timing: "nominal",
          sampleId: `decoded:${time}`,
          sourceArtifactId,
          fragmentIndex: null,
          cellIndex: null,
        },
      });
    }
    return {
      frames,
      pointsMs: [...requested],
      cells,
      parent: media?.artifact ?? null,
      materialCacheHit: false,
    };
  }

  async get(
    source: ResolvedSource,
    ref: InvestigationRef,
    startMs: number,
    endMs: number,
    signal?: AbortSignal,
  ): Promise<OverviewResult> {
    assertInterval(startMs, endMs, source.durationMs);
    const requestKey = deterministicRequestKey(
      source.revision,
      "overview",
      { startMs, endMs, count: OVERVIEW_CELL_COUNT },
      OVERVIEW_CONTRACT_ID,
    );
    const cached = this.store.getArtifactByRequest(requestKey);
    if (cached) {
      try {
        await this.blobs.verify(cached.artifactId, cached.blobPath);
        const parsed = cachedOverview(cached, { startMs, endMs });
        if (parsed) {
          diagnosticLog(this.config.debug, "overview", {
            status: "cache-hit",
            source: parsed.source,
            startMs,
            endMs,
            imageCount: parsed.pointsMs.length,
            imageBytes: cached.byteSize,
          });
          return {
            artifact: cached,
            requestedPointsMs: parsed.requestedPointsMs,
            pointsMs: parsed.pointsMs,
            cells: parsed.cells,
            source: parsed.source,
            materialCacheHit: true,
            cacheHit: true,
          };
        }
      } catch {
        // Invalid or corrupt cached material is regenerated through the normal path.
      }
    }

    const working = await mkdtemp(
      path.join(this.config.dataDir, "tmp-overview-"),
    );
    try {
      const requested = uniformPointsMs(startMs, endMs, OVERVIEW_CELL_COUNT);
      let frames: string[];
      let pointsMs: number[];
      let cells: OverviewCell[];
      let sourceKind: OverviewSource;
      let parent: StoredArtifact | null;
      let materialCacheHit: boolean;

      if (source.capabilities.nativeStoryboard) {
        try {
          const result = await this.storyboards.cells(
            source,
            ref,
            requested,
            working,
            signal,
            { startMs, endMs },
          );
          frames = result.paths;
          pointsMs = result.pointsMs;
          cells = result.samples.map((sample, index) => ({
            index,
            timestampMs: sample.timestampMs,
            provenance: {
              kind: "storyboard",
              timing: "nominal",
              sampleId:
                `storyboard:${result.artifact.artifactId}:${sample.fragmentIndex}:${sample.cellIndex}`,
              sourceArtifactId: result.artifact.artifactId,
              fragmentIndex: sample.fragmentIndex,
              cellIndex: sample.cellIndex,
            },
          }));
          sourceKind = "native-storyboard";
          parent = result.artifact;
          materialCacheHit = result.cacheHit;
        } catch (error) {
          if (
            source.kind === "local" ||
            !(error instanceof UrmaError) ||
            error.code !== "STORYBOARD_UNAVAILABLE"
          ) {
            throw error;
          }
          const result = await this.#navigationFrames(
            source,
            ref,
            requested,
            working,
            signal,
          );
          frames = result.frames;
          pointsMs = result.pointsMs;
          cells = result.cells;
          sourceKind = "navigation-media";
          parent = result.parent;
          materialCacheHit = result.materialCacheHit;
        }
      } else {
        const result = await this.#navigationFrames(
          source,
          ref,
          requested,
          working,
          signal,
        );
        frames = result.frames;
        pointsMs = result.pointsMs;
        cells = result.cells;
        sourceKind = "navigation-media";
        parent = result.parent;
        materialCacheHit = result.materialCacheHit;
      }

      const panelPath = path.join(working, "overview.jpg");
      const dimensions = await createPanel(
        this.config,
        frames,
        pointsMs,
        panelPath,
        signal,
      );
      const blob = await this.blobs.putFile(
        panelPath,
        (file) => new Ffmpeg(this.config).validateJpeg(file),
      );
      const versions = await collectBinaryVersions(
        this.config,
        ["ffmpeg"],
        signal,
      );
      const artifact: StoredArtifact = {
        artifactId: blob.artifactId,
        sourceRef: source.sourceRef,
        sourceRevision: source.revision,
        kind: "overview_panel",
        role: "locator",
        mimeType: "image/jpeg",
        sha256: blob.sha256,
        byteSize: blob.byteSize,
        blobPath: blob.relativePath,
        startMs,
        endMs,
        params: {
          contractId: OVERVIEW_CONTRACT_ID,
          requestedPointsMs: requested,
          pointsMs,
          cells,
          source: sourceKind,
          count: pointsMs.length,
        },
        producer: {
          version: OVERVIEW_CONTRACT_ID,
          urmaVersion: URMA_VERSION,
          ...versions,
          width: dimensions.width,
          height: dimensions.height,
        },
        createdAt: new Date().toISOString(),
      };
      this.store.putArtifact(
        artifact,
        { requestKey, operation: "overview" },
        parent ? [parent.artifactId] : [],
      );
      diagnosticLog(this.config.debug, "overview", {
        status: "generated",
        source: sourceKind,
        startMs,
        endMs,
        materialCacheHit,
        imageCount: pointsMs.length,
        imageBytes: artifact.byteSize,
      });
      return {
        artifact,
        requestedPointsMs: requested,
        pointsMs,
        cells,
        source: sourceKind,
        materialCacheHit,
        cacheHit: false,
      };
    } finally {
      await rm(working, { recursive: true, force: true });
    }
  }
}
