import { setImmediate } from "node:timers/promises";
import type { UrmaConfig } from "../config.js";
import { UrmaError } from "../core/errors.js";
import { analysisDimensions, analyzeVisualDelta, isConservativeVisualMatch, VISUAL_DELTA_VERSION, type AnalysisDimensions } from "../core/visual-delta.js";
import type { FrameCrop, FrameCropGeometry } from "../core/frame-crop.js";
import { investigationArtifactUri, stableJson, type ArtifactId, type InvestigationRef, type SourceRef } from "../core/ids.js";
import { BlobStore } from "../store/blob-store.js";
import type { StoredArtifact } from "../store/store.js";
import { Ffmpeg } from "../subprocess/ffmpeg.js";
import { Ffprobe } from "../subprocess/ffprobe.js";

export type AnalysisBudget = Readonly<{ signal: AbortSignal; remainingMs: () => number }>;
export type AnalysisFrame = Readonly<{ index: number; atMs: number; artifact: StoredArtifact }>;
export const FRAME_DEDUPLICATION_VERSION = "conservative-frame-groups-v1";
type CachedRgb = Readonly<{ rgb: Buffer; dimensions: AnalysisDimensions; nativeGrid: boolean }>;
type GroupMember = Readonly<{
  index: number; requestedAtMs: number; artifactId: ArtifactId; resource: string;
  sourceRef: SourceRef; sourceRevision: string; crop?: FrameCropGeometry;
  relation: "representative" | "identical-artifact" | "native-rgb-identical" | "uniform-native-offset";
  verifiedAgainstIndices: readonly number[];
  measurement: Readonly<{ width: number; height: number; blockSize: 4; globalChangedPixelRatio: number;
    maximumChannelDelta: number; maximumBlockMeanDelta: number; blockMeanSpread: number; channelOffsetSpread: number }> | null;
}>;

export function probedAnalysisDimensions(probe: Record<string, unknown>): AnalysisDimensions {
  const streams = Array.isArray(probe.streams) ? probe.streams as Record<string, unknown>[] : [];
  const stream = streams.find((item) => item.codec_type === "video");
  if (!stream || typeof stream.width !== "number" || typeof stream.height !== "number") {
    throw new UrmaError("MEDIA_INVALID", "Visual analysis requires a video stream with valid display geometry");
  }
  const sarText = typeof stream.sample_aspect_ratio === "string" ? /^(\d+):(\d+)$/u.exec(stream.sample_aspect_ratio) : null;
  const sar = sarText && Number(sarText[1]) > 0 && Number(sarText[2]) > 0 ? Number(sarText[1]) / Number(sarText[2]) : 1;
  const sideData = Array.isArray(stream.side_data_list) ? stream.side_data_list as Record<string, unknown>[] : [];
  const matrix = sideData.find((item) => item.side_data_type === "Display Matrix");
  const tags = typeof stream.tags === "object" && stream.tags !== null ? stream.tags as Record<string, unknown> : {};
  const rotation = matrix?.rotation ?? tags.rotate ?? 0;
  return analysisDimensions(stream.width, stream.height, sar, Number(rotation));
}

export class VisualAnalyzer {
  #active = 0;
  readonly #rgbCache = new Map<ArtifactId, CachedRgb>();
  constructor(readonly config: UrmaConfig, readonly blobs: BlobStore) {}

  async withBudget<T>(signal: AbortSignal | undefined, worker: (budget: AnalysisBudget) => Promise<T>): Promise<T> {
    if (signal?.aborted) throw new UrmaError("CANCELLED", "Visual analysis was cancelled before decoding");
    if (this.#active >= 2) throw new UrmaError("OUTPUT_LIMIT_EXCEEDED", "Visual analysis is limited to two simultaneous jobs; retry after an active job finishes", { retryable: true });
    this.#active++;
    const timeoutMs = Math.min(15_000, this.config.limits.mediaTimeoutMs);
    const deadline = performance.now() + timeoutMs;
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const remainingMs = () => {
      if (signal?.aborted) throw new UrmaError("CANCELLED", "Visual analysis was cancelled");
      const remaining = Math.ceil(deadline - performance.now());
      if (remaining < 1 || timeout.aborted) throw new UrmaError("MEDIA_ACQUISITION_TIMEOUT", `Visual analysis exceeded its ${timeoutMs} ms deadline`);
      return Math.min(15_000, remaining);
    };
    try {
      const value = await worker({ signal: combined, remainingMs });
      remainingMs();
      return value;
    } catch (error) {
      if (!signal?.aborted && timeout.aborted) throw new UrmaError("MEDIA_ACQUISITION_TIMEOUT", `Visual analysis exceeded its ${timeoutMs} ms deadline`, { cause: error });
      throw error;
    } finally { this.#active--; }
  }

  async #image(frame: AnalysisFrame, budget: AnalysisBudget, requireNativeGrid = false) {
    budget.remainingMs();
    await this.blobs.verify(frame.artifact.artifactId, frame.artifact.blobPath);
    const cached = this.#rgbCache.get(frame.artifact.artifactId);
    if (cached) return { ...cached, cacheHit: true, decoded: false };
    const file = this.blobs.pathForHash(frame.artifact.sha256);
    const probe = await new Ffprobe(this.config).inspect(file, budget.signal);
    const dimensions = probedAnalysisDimensions(probe);
    const stream = (probe.streams as Record<string, unknown>[]).find((item) => item.codec_type === "video")!;
    const sar = stream.sample_aspect_ratio;
    const nativeGrid = stream.width === dimensions.width && stream.height === dimensions.height &&
      (sar === undefined || sar === "N/A" || sar === "0:1" || sar === "1:1") &&
      !((stream.side_data_list as Record<string, unknown>[] | undefined)?.some((item) => item.side_data_type === "Display Matrix"));
    // Downsampling can hide small changes, so it cannot establish a near match.
    if (requireNativeGrid && !nativeGrid) return { rgb: Buffer.alloc(0), dimensions, nativeGrid, cacheHit: false, decoded: false };
    const decoded = await new Ffmpeg(this.config).rgbFrames(file, dimensions, {
      seekMs: 0, endMs: 1000, maxFrames: 1, timeoutMs: budget.remainingMs(),
    }, budget.signal);
    if (decoded.length !== 1) throw new UrmaError("MEDIA_INVALID", "Canonical frame did not yield exactly one RGB analysis image");
    const image = { rgb: decoded[0]!.rgb, dimensions, nativeGrid };
    if (this.#rgbCache.size >= 32) this.#rgbCache.delete(this.#rgbCache.keys().next().value!);
    this.#rgbCache.set(frame.artifact.artifactId, image);
    return { ...image, cacheHit: false, decoded: true };
  }

  async group(frames: readonly AnalysisFrame[], ref: InvestigationRef, signal?: AbortSignal) {
    if (frames.length > 12 || new Set(frames.map((frame) => frame.index)).size !== frames.length ||
      frames.some((frame) => !Number.isSafeInteger(frame.index) || frame.index < 0 || !Number.isSafeInteger(frame.atMs) || frame.atMs < 0)) {
      throw new UrmaError("INVALID_SOURCE", "Frame grouping requires at most 12 uniquely indexed observations with valid requested milliseconds");
    }
    return await this.withBudget(signal, async (budget) => {
      const groups: Array<{ representativeIndex: number; representativeAtMs: number;
        representativeArtifactId: ArtifactId; representativeResource: string; panelIndex: number | null;
        members: GroupMember[] }> = [];
      const groupFrames: AnalysisFrame[][] = [];
      const images = new Map<ArtifactId, CachedRgb>();
      let comparisons = 0, decodedFrames = 0, cacheHits = 0;
      const imageFor = async (frame: AnalysisFrame) => {
        let image = images.get(frame.artifact.artifactId);
        if (!image) {
          const acquired = await this.#image(frame, budget, true);
          if (acquired.cacheHit) cacheHits++; else if (acquired.decoded) decodedFrames++;
          images.set(frame.artifact.artifactId, acquired);
          image = acquired;
        }
        return image;
      };
      const sameScope = (a: AnalysisFrame, b: AnalysisFrame) => a.artifact.sourceRef === b.artifact.sourceRef &&
        a.artifact.sourceRevision === b.artifact.sourceRevision && stableJson(a.artifact.producer.crop ?? null) === stableJson(b.artifact.producer.crop ?? null);
      for (const frame of frames) {
        budget.remainingMs();
        let selectedGroup = -1;
        let relation: GroupMember["relation"] = "representative";
        let measurement: GroupMember["measurement"] = null;
        for (const [groupIndex, members] of groupFrames.entries()) {
          if (!sameScope(members[0]!, frame)) continue;
          if (members.some((member) => member.artifact.artifactId === frame.artifact.artifactId)) {
            selectedGroup = groupIndex; relation = "identical-artifact";
            break;
          }
          let compatible = true;
          let maximumChannelDelta = 0, maximumBlockMeanDelta = 0;
          for (const member of members) {
            if (++comparisons > 66) throw new UrmaError("OUTPUT_LIMIT_EXCEEDED", "Frame grouping exceeded its 66-comparison processing budget");
            const a = await imageFor(member), b = await imageFor(frame);
            if (!a.nativeGrid || !b.nativeGrid || a.dimensions.width !== b.dimensions.width || a.dimensions.height !== b.dimensions.height) {
              compatible = false; break;
            }
            const delta = analyzeVisualDelta(a.rgb, b.rgb, a.dimensions, true);
            if (!isConservativeVisualMatch(delta, true)) { compatible = false; break; }
            maximumChannelDelta = Math.max(maximumChannelDelta, delta.deduplicationMetrics!.maximumChannelDelta);
            maximumBlockMeanDelta = Math.max(maximumBlockMeanDelta, delta.deduplicationMetrics!.maximumBlockMeanDelta);
            measurement = { width: a.dimensions.width, height: a.dimensions.height, blockSize: 4,
              globalChangedPixelRatio: delta.changedPixelRatio, maximumChannelDelta, maximumBlockMeanDelta,
              blockMeanSpread: delta.deduplicationMetrics!.blockMeanSpread, channelOffsetSpread: delta.deduplicationMetrics!.channelOffsetSpread };
            await setImmediate(); budget.remainingMs();
          }
          if (compatible) {
            selectedGroup = groupIndex;
            relation = maximumChannelDelta === 0 ? "native-rgb-identical" : "uniform-native-offset";
            break;
          }
          measurement = null;
        }
        const previousIndices = selectedGroup >= 0 ? groupFrames[selectedGroup]!.map((member) => member.index) : [];
        const member: GroupMember = { index: frame.index, requestedAtMs: frame.atMs,
          artifactId: frame.artifact.artifactId, resource: investigationArtifactUri(ref, frame.artifact.artifactId),
          sourceRef: frame.artifact.sourceRef, sourceRevision: frame.artifact.sourceRevision,
          ...(frame.artifact.producer.crop ? { crop: frame.artifact.producer.crop as FrameCropGeometry } : {}),
          relation, verifiedAgainstIndices: previousIndices, measurement };
        if (selectedGroup < 0) {
          groupFrames.push([frame]);
          groups.push({ representativeIndex: frame.index, representativeAtMs: frame.atMs,
            representativeArtifactId: frame.artifact.artifactId, representativeResource: member.resource,
            panelIndex: null, members: [member] });
        } else {
          groupFrames[selectedGroup]!.push(frame);
          groups[selectedGroup]!.members.push(member);
        }
        await setImmediate(); budget.remainingMs();
      }
      const result = { policy: FRAME_DEDUPLICATION_VERSION, scope: "response" as const,
        observationsPreserved: true as const, continuousObservation: false as const,
        inputFrameCount: frames.length, representativeCount: groups.length,
        suppressedImageCount: frames.length - groups.length, comparisons, decodedFrames, cacheHits, groups };
      if (Buffer.byteLength(JSON.stringify(result)) > 128 * 1024) throw new UrmaError("OUTPUT_LIMIT_EXCEEDED", "Frame grouping exceeds its 128 KiB payload budget");
      return result;
    });
  }

  async hints(frames: readonly AnalysisFrame[], signal?: AbortSignal) {
    if (frames.length > 12) throw new UrmaError("OUTPUT_LIMIT_EXCEEDED", "Visual diff hints support at most 12 returned frames");
    return await this.withBudget(signal, async (budget) => {
      const comparisons: Array<{
        fromIndex: number; toIndex: number; fromRequestedAtMs: number; toRequestedAtMs: number;
        fromArtifactId: ArtifactId; toArtifactId: ArtifactId;
        status: "analyzed" | "unavailable"; reason?: string;
        coordinateSpace: "individual-displayed-source"; sourceCrop?: FrameCropGeometry;
        delta?: ReturnType<typeof analyzeVisualDelta>;
      }> = [];
      let decodedFrames = 0, cacheHits = 0;
      let prior: { rgb: Buffer; dimensions: AnalysisDimensions } | undefined;
      for (const [index, frame] of (frames.length >= 2 ? frames : []).entries()) {
        const current = await this.#image(frame, budget);
        if (current.cacheHit) cacheHits++; else decodedFrames++;
        if (index > 0) {
          const previous = frames[index - 1]!;
          const sourceCrop = frame.artifact.producer.crop as FrameCropGeometry | undefined;
          const previousCrop = previous.artifact.producer.crop as FrameCropGeometry | undefined;
          const comparable = prior!.dimensions.width === current.dimensions.width && prior!.dimensions.height === current.dimensions.height &&
            JSON.stringify(previousCrop) === JSON.stringify(sourceCrop);
          const delta = comparable ? analyzeVisualDelta(prior!.rgb, current.rgb, current.dimensions) : undefined;
          if (delta && sourceCrop) {
            // Map crop-relative boxes back to the full source frame.
            const toSource = (box: FrameCrop): FrameCrop => ({
              x: (sourceCrop.pixels.x + box.x / 100 * sourceCrop.pixels.width) / sourceCrop.sourceWidth * 100,
              y: (sourceCrop.pixels.y + box.y / 100 * sourceCrop.pixels.height) / sourceCrop.sourceHeight * 100,
              w: box.w / 100 * sourceCrop.pixels.width / sourceCrop.sourceWidth * 100,
              h: box.h / 100 * sourceCrop.pixels.height / sourceCrop.sourceHeight * 100,
            });
            delta.regions = delta.regions.map((region) => ({ ...region, ...toSource(region),
              ...(region.suggestedCrop ? { suggestedCrop: toSource(region.suggestedCrop) } : {}),
            }));
          }
          comparisons.push({
            fromIndex: previous.index, toIndex: frame.index,
            fromRequestedAtMs: previous.atMs, toRequestedAtMs: frame.atMs,
            fromArtifactId: previous.artifact.artifactId, toArtifactId: frame.artifact.artifactId,
            status: comparable ? "analyzed" : "unavailable", coordinateSpace: "individual-displayed-source",
            ...(sourceCrop ? { sourceCrop } : {}),
            ...(delta ? { delta } : { reason: "Returned frames have incompatible display grids or crop bounds" }),
          });
        }
        prior = current;
        await setImmediate();
        budget.remainingMs();
      }
      return { policy: VISUAL_DELTA_VERSION, comparisonOrder: "returned-request-order" as const,
        semanticInterpretation: false as const, continuousObservation: false as const,
        decodedFrames, cacheHits, comparisons };
    });
  }
}
export type FrameDeduplication = Awaited<ReturnType<VisualAnalyzer["group"]>>;
