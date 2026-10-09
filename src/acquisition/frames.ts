import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import type { UrmaConfig } from "../config.js";
import {
  currentExactFrameDiagnosticTrace,
  measureDiagnosticAsync,
} from "../core/diagnostics.js";
import { normalizeError, UrmaError } from "../core/errors.js";
import { deterministicRequestKey } from "../core/request-key.js";
import type { InvestigationRef } from "../core/ids.js";
import type { ResolvedSource } from "../sources/types.js";
import { verifyPinnedLocalVideo } from "../sources/local.js";
import { Ffmpeg } from "../subprocess/ffmpeg.js";
import { Ffprobe } from "../subprocess/ffprobe.js";
import { collectBinaryVersions } from "../subprocess/versions.js";
import { BlobStore } from "../store/blob-store.js";
import type { StoredArtifact, UrmaStore } from "../store/store.js";
import { URMA_VERSION } from "../version.js";
import { MediaAcquirer } from "./media.js";
import type { RemoteOperationContext } from "../remote/worker.js";
import type { SectionAcquisitionOutcome } from "./media.js";
import {
  isTimestampCovered,
  parseStoredBoundedVideoCoverage,
  parseStoredVideoCoverage,
  parseVideoStreamCoverage,
  physicalSeekMs,
  type VideoPtsCoverage,
} from "./video-timing.js";
import {
  chooseFrameTransport,
} from "./transport-policy.js";

type FrameMedia = Readonly<{
  path: string;
  seekMs: number;
  parent: StoredArtifact | null;
  coverage: VideoPtsCoverage | null;
  transportCacheHit: boolean;
}>;

function targetedDerivativeUnavailable(
  message: string,
  detail: Readonly<Record<string, unknown>> = {},
): UrmaError {
  return new UrmaError("TARGETED_MEDIA_UNAVAILABLE", message, { detail });
}

export function exactFrameRequestKey(
  source: Pick<ResolvedSource, "sourceRef" | "revision">,
  atMs: number,
): string {
  return deterministicRequestKey(
    source.revision,
    "frame",
    { sourceRef: source.sourceRef, atMs, format: "jpeg" },
    "frame-extractor-v2",
  );
}

export type FrameTargetOutcome =
  | Readonly<{
    status: "success";
    atMs: number;
    artifact: StoredArtifact;
    cacheHit: boolean;
  }>
  | Readonly<{
    status: "error";
    atMs: number;
    error: unknown;
  }>
  | Readonly<{
    status: "unfinished";
    atMs: number;
  }>;

function mediaForGlobalTimestamp(
  artifact: StoredArtifact,
  mediaPath: string,
  globalTimeMs: number,
  transportCacheHit: boolean,
): FrameMedia | null {
  if (
    artifact.startMs === null ||
    artifact.endMs === null ||
    globalTimeMs < artifact.startMs ||
    globalTimeMs >= artifact.endMs
  ) {
    return null;
  }
  if (artifact.kind === "evidence_media") {
    const coverage = parseStoredVideoCoverage(artifact.producer);
    if (coverage === null) return null;
    const nominalLocalMs = globalTimeMs - artifact.startMs;
    const includesSourcePrefix =
      artifact.startMs === 0 &&
      artifact.producer.version === "evidence-copy" &&
      artifact.producer.validatedSourcePrefix === "complete";
    if (
      !isTimestampCovered(
        coverage,
        nominalLocalMs,
        includesSourcePrefix,
      )
    ) return null;
    let seekMs: number;
    try {
      seekMs = physicalSeekMs(
        coverage,
        nominalLocalMs,
        includesSourcePrefix,
      );
    } catch {
      return null;
    }
    return {
      path: mediaPath,
      seekMs,
      parent: artifact,
      coverage,
      transportCacheHit,
    };
  }
  if (artifact.kind !== "media_section") return null;
  const coverage = parseStoredBoundedVideoCoverage(artifact.producer);
  if (coverage === null) return null;
  const nominalLocalMs = globalTimeMs - artifact.startMs;
  if (!isTimestampCovered(coverage, nominalLocalMs)) return null;
  let seekMs: number;
  try {
    seekMs = physicalSeekMs(coverage, nominalLocalMs);
  } catch {
    return null;
  }
  return {
    path: mediaPath,
    seekMs,
    parent: artifact,
    coverage,
    transportCacheHit,
  };
}

export class FrameAcquirer {
  readonly media: MediaAcquirer;
  constructor(
    readonly config: UrmaConfig,
    readonly store: UrmaStore,
    readonly blobs: BlobStore,
    media?: MediaAcquirer,
    readonly remoteContext: RemoteOperationContext | null = null,
  ) {
    this.media = media ?? new MediaAcquirer(config, store, blobs, undefined, remoteContext);
  }

  async get(
    source: ResolvedSource,
    ref: InvestigationRef,
    timesMs: readonly number[],
    signal?: AbortSignal,
  ): Promise<
    Array<{ atMs: number; artifact: StoredArtifact; cacheHit: boolean }>
  > {
    const outcomes = await this.#getOutcomes(
      source,
      ref,
      timesMs,
      signal,
      false,
    );
    return outcomes.map((outcome) => {
      if (outcome.status === "success") {
        return {
          atMs: outcome.atMs,
          artifact: outcome.artifact,
          cacheHit: outcome.cacheHit,
        };
      }
      if (outcome.status === "error") throw normalizeError(outcome.error);
      throw new UrmaError(
        "INTERNAL_ERROR",
        `Exact-frame target ${outcome.atMs} ms was left unfinished by strict extraction`,
      );
    });
  }

  /** Keep successful sibling targets when one target fails; cancellation aborts the request */
  async getOutcomes(
    source: ResolvedSource,
    ref: InvestigationRef,
    timesMs: readonly number[],
    signal?: AbortSignal,
  ): Promise<readonly FrameTargetOutcome[]> {
    return await this.#getOutcomes(source, ref, timesMs, signal, true);
  }

  async #getOutcomes(
    source: ResolvedSource,
    ref: InvestigationRef,
    timesMs: readonly number[],
    signal: AbortSignal | undefined,
    allowTargetErrors: boolean,
  ): Promise<FrameTargetOutcome[]> {
    const trace = currentExactFrameDiagnosticTrace();
    trace?.setRequestedTimestamps(timesMs);
    const frameIndexByTime = new Map<number, number>();
    for (const [index, atMs] of timesMs.entries()) {
      if (!frameIndexByTime.has(atMs)) frameIndexByTime.set(atMs, index);
    }
    const frameIndexForTime = (atMs: number): number =>
      frameIndexByTime.get(atMs) ?? 0;
    const recordSelection = (atMs: number, media: FrameMedia): void => {
      const index = frameIndexForTime(atMs);
      trace?.markFrameSelection(index, atMs, {
        path: media.parent === null
          ? "local-direct"
          : media.parent.kind === "media_section"
          ? "bounded-section"
          : "reusable-evidence",
        transportCacheHit: media.transportCacheHit,
        sectionStartMs: media.parent?.startMs ?? null,
        sectionEndMs: media.parent?.endMs ?? null,
        physicalSeekMs: media.seekMs,
        coverage: media.coverage === null ? null : {
          startSeconds: media.coverage.startSeconds,
          endSeconds: media.coverage.endSeconds,
          startPts: media.coverage.startPts,
          endPts: media.coverage.endPts,
          durationTs: media.coverage.durationTs,
          timeBase: media.coverage.timeBase,
        },
      });
      if (media.parent?.kind === "media_section") {
        trace?.markCacheStatus(index, atMs, "reusable", "not-needed");
      }
    };

    const results: Array<{
      atMs: number;
      artifact: StoredArtifact;
      cacheHit: boolean;
    }> = [];
    const targetErrors = new Map<number, unknown>();
    const markTargetError = (atMs: number, error: unknown): void => {
      targetErrors.set(atMs, error);
      const normalized = normalizeError(error);
      trace?.markFrameStatus(
        frameIndexForTime(atMs),
        atMs,
        normalized.code === "CANCELLED" ? "cancelled" : "failed",
        normalized.code,
      );
    };
    const finishOutcomes = (): FrameTargetOutcome[] =>
      timesMs.map((atMs) => {
        const error = targetErrors.get(atMs);
        if (error !== undefined) {
          return { status: "error", atMs, error } as const;
        }
        const result = results.find((item) => item.atMs === atMs);
        if (result) {
          return {
            status: "success",
            atMs,
            artifact: result.artifact,
            cacheHit: result.cacheHit,
          } as const;
        }
        return { status: "unfinished", atMs } as const;
      });
    const missing: number[] = [];
    for (const [index, atMs] of timesMs.entries()) {
      trace?.ensureFrame(index, atMs);
      const lookupStarted = performance.now();
      let cacheHit = false;
      try {
        const key = exactFrameRequestKey(source, atMs);
        const artifact = this.store.getArtifactByRequest(key);
        if (artifact) {
          try {
            await this.blobs.verify(artifact.artifactId, artifact.blobPath);
            results.push({ atMs, artifact, cacheHit: true });
            cacheHit = true;
          } catch {
          }
        }
      } finally {
        const elapsedMs = performance.now() - lookupStarted;
        trace?.addStage("exactFrameCacheLookupMs", elapsedMs);
        trace?.addFrameStage(index, "exactFrameCacheLookupMs", elapsedMs);
      }
      trace?.markExactFrameCache(index, atMs, cacheHit);
      if (!cacheHit) missing.push(atMs);
    }
    if (missing.length === 0) return finishOutcomes();

    const mediaFor = new Map<number, FrameMedia>();
    const acquireReusable = async (
      requestedTimes: readonly number[],
    ): Promise<void> => {
      if (requestedTimes.length === 0) return;
      try {
        const reusable = await this.media.reusableEvidence(source, ref, signal);
        for (const time of requestedTimes) {
          const media = mediaForGlobalTimestamp(
            reusable.artifact,
            reusable.path,
            time,
            reusable.cacheHit,
          );
          if (media === null) {
            const error = targetedDerivativeUnavailable(
              `Reusable evidence media does not provide validated timing coverage for target ${time} ms`,
              { reason: "reusable-coverage-miss", targetMs: time },
            );
            if (!allowTargetErrors) throw error;
            markTargetError(time, error);
            continue;
          }
          mediaFor.set(time, media);
          recordSelection(time, media);
        }
      } catch (error) {
        const normalized = normalizeError(error);
        if (!allowTargetErrors || normalized.code === "CANCELLED") throw error;
        for (const time of requestedTimes) markTargetError(time, normalized);
      }
    };

    if (source.kind === "local") {
      let pinnedPath: string;
      try {
        pinnedPath = await verifyPinnedLocalVideo(
          source.safeMetadata.localSnapshot,
          this.blobs,
        );
      } catch (error) {
        if (!allowTargetErrors) throw error;
        for (const time of missing) markTargetError(time, error);
        pinnedPath = "";
      }
      const rawTiming = source.safeMetadata.videoTiming;
      let coverage = typeof rawTiming === "object" &&
          rawTiming !== null && !Array.isArray(rawTiming)
        ? parseStoredVideoCoverage(rawTiming as Record<string, unknown>)
        : null;
      const legacyTiming = typeof rawTiming === "object" &&
          rawTiming !== null && !Array.isArray(rawTiming) &&
          (rawTiming as Record<string, unknown>)
            .validatedVideoTimingVersion === 2;
      let reprobeError: unknown;
      if (pinnedPath && coverage === null && legacyTiming) {
        try {
          const probe = await measureDiagnosticAsync(
            trace,
            "mediaProbeTimingValidationMs",
            () => new Ffprobe(this.config, this.remoteContext).inspect(
              pinnedPath,
              signal,
            ),
          );
          const streams = Array.isArray(probe.streams)
            ? (probe.streams as Array<Record<string, unknown>>)
            : [];
          const videoStream = streams.find(
            (stream) => stream.codec_type === "video",
          );
          const format = typeof probe.format === "object" &&
              probe.format !== null && !Array.isArray(probe.format)
            ? (probe.format as Record<string, unknown>)
            : {};
          coverage = videoStream === undefined
            ? null
            : parseVideoStreamCoverage(videoStream, format.start_time);
        } catch (error) {
          if (normalizeError(error).code === "CANCELLED") throw error;
          reprobeError = error;
        }
      }
      if (pinnedPath && coverage === null) {
        const error = new UrmaError(
          "MEDIA_INVALID",
          "Local source has no valid retained video PTS coverage and container start time; the exact target is unavailable",
          {
            detail: {
              reason: reprobeError === undefined
                ? "local-timing-unavailable"
                : "local-timing-reprobe-failed",
            },
            ...(reprobeError === undefined ? {} : { cause: reprobeError }),
          },
        );
        if (!allowTargetErrors) throw error;
        for (const time of missing) markTargetError(time, error);
      } else if (pinnedPath && coverage !== null) {
        // The verified local snapshot contains the full input, so its first frame
        // is a valid answer when a target predates the first video PTS.
        for (const time of missing) {
          if (!isTimestampCovered(coverage, time, true)) {
            const error = targetedDerivativeUnavailable(
              `Local source timing coverage does not include target ${time} ms`,
              { reason: "local-coverage-miss", targetMs: time },
            );
            if (!allowTargetErrors) throw error;
            markTargetError(time, error);
            continue;
          }
          let seekMs: number;
          try {
            seekMs = physicalSeekMs(coverage, time, true);
          } catch (cause) {
            const error = new UrmaError(
              "MEDIA_INVALID",
              "Local source container timing cannot map the exact target to an input seek position",
              {
                detail: { reason: "local-seek-origin-mismatch" },
                cause,
              },
            );
            if (!allowTargetErrors) throw error;
            markTargetError(time, error);
            continue;
          }
          const media: FrameMedia = {
            path: pinnedPath,
            seekMs,
            parent: null,
            coverage,
            transportCacheHit: false,
          };
          mediaFor.set(time, media);
          recordSelection(time, media);
        }
      }
    } else {
      const cached = this.store
        .listArtifacts(source.sourceRef, source.revision)
        .filter(
          (artifact) =>
            (artifact.kind === "evidence_media" ||
              artifact.kind === "media_section") &&
            artifact.startMs !== null &&
            artifact.endMs !== null,
        )
        .sort(
          (a, b) =>
            a.endMs! - a.startMs! - (b.endMs! - b.startMs!) ||
            a.createdAt.localeCompare(b.createdAt),
        );
      const verified = new Map<string, string | null>();
      for (const time of missing) {
        const lookupStarted = performance.now();
        let selected = false;
        try {
          for (const artifact of cached) {
            if (
              artifact.startMs === null ||
              artifact.endMs === null ||
              time < artifact.startMs ||
              time >= artifact.endMs
            ) {
              continue;
            }
            const candidateStarted = performance.now();
            try {
              let cachedPath = verified.get(artifact.artifactId);
              if (cachedPath === undefined) {
                try {
                  cachedPath = await this.blobs.verify(
                    artifact.artifactId,
                    artifact.blobPath,
                  );
                } catch {
                  cachedPath = null;
                }
                verified.set(artifact.artifactId, cachedPath);
              }
              if (cachedPath) {
                const selection = mediaForGlobalTimestamp(
                  artifact,
                  cachedPath,
                  time,
                  true,
                );
                if (selection) {
                  mediaFor.set(time, selection);
                  recordSelection(time, selection);
                  selected = true;
                }
              }
            } finally {
              const elapsedMs = performance.now() - candidateStarted;
              if (artifact.kind === "media_section") {
                trace?.addStage("boundedArtifactCacheLookupMs", elapsedMs);
              } else {trace?.addStage(
                  "reusableArtifactCacheLookupMs",
                  elapsedMs,
                );}
            }
            if (selected) break;
          }
        } finally {
          trace?.addStage(
            "artifactCacheLookupMs",
            performance.now() - lookupStarted,
          );
        }
      }

      const pending = missing.filter(
        (time) => !mediaFor.has(time) && !targetErrors.has(time),
      );
      const policy = chooseFrameTransport(source);
      for (const time of pending) {
        const index = frameIndexForTime(time);
        if (policy.primary === "hls-bounded-section") {
          trace?.markCacheStatus(index, time, "bounded", "miss");
          trace?.markCacheStatus(index, time, "reusable", "miss");
        } else {
          trace?.markCacheStatus(index, time, "reusable", "miss");
        }
      }
      if (pending.length > 0 && policy.primary === "hls-bounded-section") {
        const intervals = pending.map((time) => ({
          startMs: Math.max(0, time - 2_000),
          endMs: Math.min(source.durationMs, time + 2_001),
          times: [time],
        }));
        const groups: Array<{
          startMs: number;
          endMs: number;
          times: number[];
        }> = [];
        for (
          const interval of intervals.sort(
            (a, b) => a.startMs - b.startMs,
          )
        ) {
          const previous = groups.at(-1);
          if (previous && interval.startMs <= previous.endMs) {
            previous.endMs = Math.max(previous.endMs, interval.endMs);
            previous.times.push(...interval.times);
          } else groups.push(interval);
        }
        for (const group of groups) {
          for (const time of group.times) {
            trace?.markRequestedSection(
              frameIndexForTime(time),
              time,
              group.startMs,
              group.endMs,
            );
          }
        }
        let outcomes: SectionAcquisitionOutcome[];
        try {
          outcomes = await this.media.sections(
            groups.map((group) => ({
              source,
              investigationRef: ref,
              startMs: group.startMs,
              endMs: group.endMs,
            })),
            signal,
          );
        } catch (error) {
          const normalized = normalizeError(error);
          if (!allowTargetErrors || normalized.code === "CANCELLED") {
            throw error;
          }
          for (const group of groups) {
            for (const time of group.times) markTargetError(time, normalized);
          }
          outcomes = [];
        }
        for (const [index, outcome] of outcomes.entries()) {
          const group = groups[index]!;
          if (outcome.status === "fulfilled") {
            for (const time of group.times) {
              const selection = mediaForGlobalTimestamp(
                outcome.value.artifact,
                outcome.value.path,
                time,
                outcome.value.cacheHit,
              );
              if (selection) {
                mediaFor.set(time, selection);
                recordSelection(time, selection);
              } else {
                const error = new UrmaError(
                  "TARGETED_MEDIA_UNAVAILABLE",
                  `Bounded section [${group.startMs},${group.endMs}) does not cover target ${time} ms`,
                  {
                    detail: {
                      reason: "bounded-coverage-miss",
                      targetMs: time,
                      sectionStartMs: group.startMs,
                      sectionEndMs: group.endMs,
                    },
                  },
                );
                if (!allowTargetErrors) throw error;
                markTargetError(time, error);
              }
            }
          } else {
            const normalized = normalizeError(outcome.reason);
            if (!allowTargetErrors || normalized.code === "CANCELLED") {
              throw normalized;
            }
            for (const time of group.times) markTargetError(time, normalized);
          }
        }
      } else if (pending.length > 0) {
        await acquireReusable(pending);
      }
    }

    const extractable = missing.filter(
      (atMs) => mediaFor.has(atMs) && !targetErrors.has(atMs),
    );
    if (extractable.length === 0) return finishOutcomes();

    const working = await mkdtemp(path.join(this.config.dataDir, "tmp-frame-"));
    try {
      const ffmpeg = new Ffmpeg(this.config);
      const versions = await collectBinaryVersions(
        this.config,
        ["ffmpeg"],
        signal,
      );

      const extractAndStore = async (
        atMs: number,
        media: FrameMedia,
        outputIndex: number,
        frameIndex: number,
      ): Promise<void> => {
        const output = path.join(working, `frame-${outputIndex}.jpg`);
        await measureDiagnosticAsync(
          trace,
          "ffmpegExactFrameExtractionMs",
          () => ffmpeg.extractJpeg(media.path, media.seekMs, output, signal),
          frameIndex,
        );
        await measureDiagnosticAsync(
          trace,
          "jpegValidationMs",
          async () => {
            await ffmpeg.validateJpeg(output);
          },
          frameIndex,
        );
        const blob = await measureDiagnosticAsync(
          trace,
          "canonicalExactFrameArtifactCommitMs",
          () =>
            this.blobs.putFile(output, async (file) => {
              await measureDiagnosticAsync(
                trace,
                "jpegValidationMs",
                () => ffmpeg.validateJpeg(file),
                frameIndex,
              );
            }),
          frameIndex,
        );
        const requestKey = exactFrameRequestKey(source, atMs);
        const artifact: StoredArtifact = {
          artifactId: blob.artifactId,
          sourceRef: source.sourceRef,
          sourceRevision: source.revision,
          kind: "frame",
          role: "evidence",
          mimeType: "image/jpeg",
          sha256: blob.sha256,
          byteSize: blob.byteSize,
          blobPath: blob.relativePath,
          startMs: atMs,
          endMs: atMs,
          params: { atMs, format: "jpeg" },
          producer: {
            version: "frame-extractor-v2",
            urmaVersion: URMA_VERSION,
            ...versions,
            transportArtifactId: media.parent?.artifactId ?? null,
          },
          createdAt: new Date().toISOString(),
        };
        await measureDiagnosticAsync(
          trace,
          "canonicalExactFrameArtifactCommitMs",
          async () => {
            this.store.putArtifact(
              artifact,
              { requestKey, operation: "frame" },
              media.parent ? [media.parent.artifactId] : [],
            );
          },
        );
        results.push({ atMs, artifact, cacheHit: false });
        trace?.markFrameStatus(frameIndex, atMs, "succeeded");
      };

      for (const [index, atMs] of extractable.entries()) {
        const media = mediaFor.get(atMs)!;
        try {
          await extractAndStore(atMs, media, index, frameIndexForTime(atMs));
        } catch (error) {
          const normalized = normalizeError(error);
          if (!allowTargetErrors || normalized.code === "CANCELLED") {
            trace?.markFrameStatus(
              frameIndexForTime(atMs),
              atMs,
              normalized.code === "CANCELLED" ? "cancelled" : "failed",
              normalized.code,
            );
            throw normalized;
          }
          markTargetError(atMs, normalized);
        }
      }
    } finally {
      await rm(working, { recursive: true, force: true });
    }
    return finishOutcomes();
  }
}
