import { setImmediate } from "node:timers/promises";
import type { UrmaConfig } from "../config.js";
import { assertInterval, summarizeSamplingGaps } from "../core/coverage.js";
import { UrmaError } from "../core/errors.js";
import type { InvestigationRef } from "../core/ids.js";
import { analyzeVisualDelta, type VisualDelta } from "../core/visual-delta.js";
import { verifyPinnedLocalVideo } from "../sources/local.js";
import type { ResolvedSource } from "../sources/types.js";
import type { UrmaStore } from "../store/store.js";
import { Ffmpeg } from "../subprocess/ffmpeg.js";
import { Ffprobe } from "../subprocess/ffprobe.js";
import { collectBinaryVersions } from "../subprocess/versions.js";
import { FrameAcquirer, mediaForGlobalTimestamp } from "./frames.js";
import { chooseFrameTransport } from "./transport-policy.js";
import { parseStoredVideoCoverage } from "./video-timing.js";
import { probedAnalysisDimensions, VisualAnalyzer } from "./visual-analysis.js";

export const DISCOVERY_VERSION = "visual-transition-v1";
export type DiscoveryRequest = Readonly<{
  kind: "discover"; startMs?: number | undefined; endMs?: number | undefined;
  budget: number; maxFrames?: number | undefined; maxScanMs?: number | undefined;
  sceneThreshold?: number | undefined; minChangedRatio?: number | undefined;
  keyframeAssist?: boolean | undefined;
}>;
type Candidate = Readonly<{
  requestedAtMs: number; observedPresentationTimeMs: number; comparedFromPresentationTimeMs: number;
  sceneScore: number; delta: VisualDelta;
}>;

export class DiscoveryAcquirer {
  constructor(readonly config: UrmaConfig, readonly store: UrmaStore,
    readonly frames: FrameAcquirer, readonly analyzer: VisualAnalyzer) {}

  async get(source: ResolvedSource, ref: InvestigationRef, request: DiscoveryRequest, signal?: AbortSignal) {
    const startMs = request.startMs ?? 0, endMs = request.endMs ?? source.durationMs;
    const maxFrames = request.maxFrames ?? 120, maxScanMs = request.maxScanMs ?? 30_000;
    const sceneThreshold = request.sceneThreshold ?? 10, minChangedRatio = request.minChangedRatio ?? .08;
    try { assertInterval(startMs, endMs, source.durationMs); }
    catch (cause) { throw new UrmaError("INVALID_SOURCE", "Discovery requires a non-empty range within the source duration", { cause }); }
    if (!Number.isSafeInteger(request.budget) || request.budget < 1 || request.budget > 12 ||
      !Number.isSafeInteger(maxFrames) || maxFrames < 4 || maxFrames > 240 ||
      !Number.isSafeInteger(maxScanMs) || maxScanMs < 1 || maxScanMs > 30_000 ||
      !Number.isFinite(sceneThreshold) || sceneThreshold <= 0 || sceneThreshold > 100 ||
      !Number.isFinite(minChangedRatio) || minChangedRatio <= 0 || minChangedRatio > 1 ||
      (request.keyframeAssist !== undefined && typeof request.keyframeAssist !== "boolean")) {
      throw new UrmaError("INVALID_SOURCE", "Discovery requires budget 1-12, maxFrames 4-240, maxScanMs 1-30000, sceneThreshold (0,100] and minChangedRatio (0,1]");
    }
    const scanEndMs = Math.min(endMs, startMs + maxScanMs);
    let mediaPath: string, seekMs: number, sourceOffsetMs: number;
    let transportArtifactId: string | null = null;
    if (source.kind === "local") {
      mediaPath = await verifyPinnedLocalVideo(source.safeMetadata.localSnapshot, this.analyzer.blobs);
      const timing = source.safeMetadata.videoTiming;
      const coverage = typeof timing === "object" && timing !== null
        ? parseStoredVideoCoverage(timing as Record<string, unknown>) : null;
      if (!coverage) throw new UrmaError("MEDIA_INVALID", "Discovery requires retained local video timing; refresh the source snapshot");
      seekMs = startMs;
      sourceOffsetMs = 0;
    } else {
      let selected: ReturnType<typeof mediaForGlobalTimestamp> = null;
      const cached = this.store.listArtifacts(source.sourceRef, source.revision).filter((artifact) =>
        (artifact.kind === "media_section" || artifact.kind === "evidence_media") && artifact.endMs !== null && artifact.endMs >= scanEndMs);
      for (const artifact of cached) {
        try {
          const file = await this.analyzer.blobs.verify(artifact.artifactId, artifact.blobPath);
          selected = mediaForGlobalTimestamp(artifact, file, startMs, true);
        } catch { continue; }
        if (selected) break;
      }
      if (!selected) {
        const acquired = chooseFrameTransport(source).primary === "hls-bounded-section"
          ? await this.frames.media.section(source, ref, startMs, scanEndMs, signal)
          : await this.frames.media.reusableEvidence(source, ref, signal);
        selected = mediaForGlobalTimestamp(acquired.artifact, acquired.path, startMs, acquired.cacheHit);
      }
      if (!selected?.coverage || !selected.parent) throw new UrmaError("TARGETED_MEDIA_UNAVAILABLE", "Discovery media does not provide validated timing for the requested scan");
      mediaPath = selected.path; seekMs = selected.seekMs;
      sourceOffsetMs = selected.parent.startMs! + selected.coverage.containerStartSeconds * 1000;
      transportArtifactId = selected.parent.artifactId;
    }
    return await this.analyzer.withBudget(signal, async (budget) => {
      const dimensions = probedAnalysisDimensions(await new Ffprobe(this.config).inspect(mediaPath, budget.signal));
      const versions = await collectBinaryVersions(this.config, ["ffmpeg"], budget.signal);
      const ffmpeg = new Ffmpeg(this.config);
      const scan = async (scanStart: number, scanEnd: number, count: number, keyframes: boolean) => {
        const result = await ffmpeg.rgbFrames(mediaPath, dimensions, {
          seekMs: seekMs + scanStart - startMs, endMs: seekMs + scanEnd - startMs,
          maxFrames: count, keyframes, scene: true, sceneThreshold, timeoutMs: budget.remainingMs(),
        }, budget.signal);
        return { emittedCount: result.length, frames: result.map((frame) => ({ ...frame, presentationTimeMs: frame.presentationTimeMs + sourceOffsetMs }))
          .filter((frame) => frame.presentationTimeMs >= scanStart && frame.presentationTimeMs < scanEnd) };
      };
      let coarseTimesMs: number[] = [];
      let coarseFrameCount = 0;
      let fineStartMs = startMs, fineEndMs = scanEndMs;
      if (request.keyframeAssist) {
        const coarseResult = await scan(startMs, scanEndMs, Math.min(24, Math.floor(maxFrames / 4)), true);
        const coarse = coarseResult.frames;
        coarseFrameCount = coarseResult.emittedCount;
        coarseTimesMs = coarse.map((frame) => frame.presentationTimeMs);
        const transition = coarse.slice(1).filter((frame) => frame.sceneScore >= sceneThreshold)
          .sort((a, b) => b.sceneScore - a.sceneScore || a.presentationTimeMs - b.presentationTimeMs)[0];
        if (transition) {
          fineStartMs = Math.max(startMs, Math.floor(transition.presentationTimeMs) - 1000);
          fineEndMs = Math.min(scanEndMs, Math.ceil(transition.presentationTimeMs) + 1001);
        }
      }
      const fineBudget = maxFrames - coarseFrameCount;
      const fineResult = await scan(fineStartMs, fineEndMs, fineBudget, false);
      const fine = fineResult.frames;
      const candidates: Candidate[] = [];
      const seen = new Set<number>();
      const rank = (candidate: Candidate) => Math.max(candidate.sceneScore / 100, candidate.delta.changedPixelRatio);
      let candidateCount = 0;
      for (let index = 1; index < fine.length; index++) {
        budget.remainingMs();
        const before = fine[index - 1]!, after = fine[index]!;
        if (after.presentationTimeMs <= before.presentationTimeMs) throw new UrmaError("MEDIA_INVALID", "Discovery requires strictly increasing video presentation timestamps");
        const delta = analyzeVisualDelta(before.rgb, after.rgb, dimensions);
        const requestedAtMs = Math.floor(after.presentationTimeMs);
        if ((after.sceneScore >= sceneThreshold || delta.changedPixelRatio >= minChangedRatio) && !seen.has(requestedAtMs)) {
          seen.add(requestedAtMs); candidateCount++;
          candidates.push({ requestedAtMs, observedPresentationTimeMs: after.presentationTimeMs,
            comparedFromPresentationTimeMs: before.presentationTimeMs, sceneScore: after.sceneScore, delta });
          candidates.sort((a, b) => rank(b) - rank(a) || a.observedPresentationTimeMs - b.observedPresentationTimeMs);
          if (candidates.length > request.budget) candidates.pop();
        }
        await setImmediate();
      }
      candidates.sort((a, b) => a.requestedAtMs - b.requestedAtMs);
      const presentationTimesMs = fine.map((frame) => frame.presentationTimeMs);
      const gapSummary = summarizeSamplingGaps(startMs, endMs, presentationTimesMs.map(Math.floor), "requested");
      const result = {
        policy: DISCOVERY_VERSION, sourceRef: source.sourceRef, sourceRevision: source.revision,
        semanticInterpretation: false as const, continuousObservation: false as const,
        coordinateSpace: "individual-displayed-source" as const,
        interval: { startMs, endMs }, scanInterval: { startMs: fineStartMs, endMs: fineEndMs },
        analysis: dimensions, budget: request.budget, maxFrames, maxScanMs,
        decodedAnalysisFrames: coarseFrameCount + fineResult.emittedCount, fineFrameCount: fine.length,
        keyframeAssisted: request.keyframeAssist === true, coarsePresentationTimesMs: coarseTimesMs,
        presentationTimesMs, candidateCount, omittedCandidateCount: candidateCount - candidates.length,
        candidates, frameLimitReached: fineResult.emittedCount >= fineBudget,
        rangeLimited: fineStartMs !== startMs || fineEndMs !== endMs,
        scanSamplingGaps: { ...gapSummary, timestampBasis: "decoded-presentation-floor-ms" as const },
        provenance: { method: "ffmpeg-rgb24-scdet" as const, transportArtifactId, ffmpegVersion: versions.ffmpegVersion,
          timeline: "container-origin-relative" as const, ffmpegSceneThreshold: sceneThreshold,
          minChangedRatio, decoderThreads: 1 as const, maxInputPixels: 8388608,
          maxWallMs: Math.min(15_000, this.config.limits.mediaTimeoutMs),
          selectedFramePtsAvailable: false as const },
      };
      if (Buffer.byteLength(JSON.stringify(result)) > 128 * 1024) throw new UrmaError("OUTPUT_LIMIT_EXCEEDED", "Discovery hints exceed the 128 KiB analysis payload budget; lower the candidate budget");
      return result;
    });
  }
}

export type DiscoveryResult = Awaited<ReturnType<DiscoveryAcquirer["get"]>>;
