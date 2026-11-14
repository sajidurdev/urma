import { UrmaError } from "./errors.js";
import type { FrameCrop } from "./frame-crop.js";

export const VISUAL_DELTA_VERSION = "rgb-block-delta-v1";
export const MAX_ANALYSIS_WIDTH = 256;
export const MAX_ANALYSIS_HEIGHT = 144;
export const MAX_DELTA_REGIONS = 16;
export type AnalysisDimensions = Readonly<{ width: number; height: number; aspectRatioError: number }>;
export type DeltaRegion = Readonly<{
  x: number; y: number; w: number; h: number;
  changedPixelRatio: number; density: number;
  suggestedCrop?: FrameCrop;
}>;

export function analysisDimensions(width: number, height: number, sar = 1, rotation = 0): AnalysisDimensions {
  if (![width, height].every((value) => Number.isSafeInteger(value) && value > 0 && value <= 32768) ||
    !Number.isFinite(sar) || sar <= 0 || !Number.isFinite(rotation) || rotation % 90 !== 0) {
    throw new UrmaError("MEDIA_INVALID", "Visual analysis requires valid dimensions, positive SAR, and a quarter-turn display rotation");
  }
  const turned = Math.abs(rotation % 180) === 90;
  const displayWidth = turned ? height : width * sar;
  const displayHeight = turned ? width * sar : height;
  const maxWidth = Math.min(MAX_ANALYSIS_WIDTH, Math.max(4, Math.floor(displayWidth / 4) * 4));
  const maxHeight = Math.min(MAX_ANALYSIS_HEIGHT, Math.max(4, Math.floor(displayHeight / 4) * 4));
  let w = 4, h = 4, aspectRatioError = Infinity;
  for (let candidateH = 4; candidateH <= maxHeight; candidateH += 4) for (let candidateW = 4; candidateW <= maxWidth; candidateW += 4) {
    const error = Math.abs((candidateW / candidateH) / (displayWidth / displayHeight) - 1);
    if (error < aspectRatioError - 1e-12 || (Math.abs(error - aspectRatioError) <= 1e-12 && candidateW * candidateH > w * h)) {
      w = candidateW; h = candidateH; aspectRatioError = error;
    }
  }
  if (aspectRatioError > 0.05) {
    throw new UrmaError("MEDIA_INVALID", "Displayed aspect ratio cannot fit the 256x144 analysis grid within 5% rounding error; use a less extreme source region");
  }
  return { width: w, height: h, aspectRatioError };
}

export function analyzeVisualDelta(before: Uint8Array, after: Uint8Array, dimensions: AnalysisDimensions, includeDeduplicationMetrics = false) {
  const { width, height } = dimensions;
  if (![width, height].every((value) => Number.isSafeInteger(value) && value >= 4 && value % 4 === 0) ||
    width > MAX_ANALYSIS_WIDTH || height > MAX_ANALYSIS_HEIGHT ||
    before.length !== width * height * 3 || after.length !== before.length) {
    throw new UrmaError("MEDIA_INVALID", "Visual delta requires equally sized RGB24 frames on the bounded 4px analysis grid");
  }
  const columns = width / 4;
  const rows = height / 4;
  const counts = new Uint8Array(columns * rows);
  const peaks = new Uint8Array(counts.length);
  let changed = 0;
  let nonzero = 0;
  let absoluteSum = 0;
  const blockSums = includeDeduplicationMetrics ? new Uint32Array(counts.length) : null;
  const minimumOffsets = [255, 255, 255], maximumOffsets = [-255, -255, -255];
  let maximumChannelDelta = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 3;
    const r = Math.abs(after[offset]! - before[offset]!);
    const g = Math.abs(after[offset + 1]! - before[offset + 1]!);
    const b = Math.abs(after[offset + 2]! - before[offset + 2]!);
    const peak = Math.max(r, g, b);
    absoluteSum += r + g + b;
    if (blockSums) {
      const block = Math.floor(y / 4) * columns + Math.floor(x / 4);
      blockSums[block] = blockSums[block]! + r + g + b;
      maximumChannelDelta = Math.max(maximumChannelDelta, peak);
      for (let channel = 0; channel < 3; channel++) {
        const difference = after[offset + channel]! - before[offset + channel]!;
        minimumOffsets[channel] = Math.min(minimumOffsets[channel]!, difference);
        maximumOffsets[channel] = Math.max(maximumOffsets[channel]!, difference);
      }
    }
    if (peak > 0) nonzero++;
    if (peak < 12) continue;
    changed++;
    const block = Math.floor(y / 4) * columns + Math.floor(x / 4);
    counts[block] = counts[block]! + 1;
    peaks[block] = Math.max(peaks[block]!, peak);
  }
  // Keep strong single-pixel events. Weak isolated pixels remain in reported totals.
  const active = counts.map((count, index) => count >= 2 || peaks[index]! >= 48 ? 1 : 0);
  const regions: Array<DeltaRegion & { pixels: number }> = [];
  let clusteredPixels = 0;
  const queue = new Int32Array(active.length);
  for (let seed = 0; seed < active.length; seed++) {
    if (!active[seed]) continue;
    let head = 0, tail = 1, pixels = 0;
    let left = columns, right = 0, top = rows, bottom = 0;
    queue[0] = seed;
    active[seed] = 0;
    while (head < tail) {
      const block = queue[head++]!;
      const x = block % columns, y = Math.floor(block / columns);
      pixels += counts[block]!;
      left = Math.min(left, x); right = Math.max(right, x + 1);
      top = Math.min(top, y); bottom = Math.max(bottom, y + 1);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if ((dx === 0 && dy === 0) || x + dx < 0 || x + dx >= columns || y + dy < 0 || y + dy >= rows) continue;
        const neighbor = (y + dy) * columns + x + dx;
        if (active[neighbor]) {
          active[neighbor] = 0;
          queue[tail++] = neighbor;
        }
      }
    }
    clusteredPixels += pixels;
    const paddedLeft = Math.max(0, left - 1), paddedTop = Math.max(0, top - 1);
    const paddedRight = Math.min(columns, right + 1), paddedBottom = Math.min(rows, bottom + 1);
    regions.push({ x: left * 4 / width * 100, y: top * 4 / height * 100,
      w: (right - left) * 4 / width * 100, h: (bottom - top) * 4 / height * 100,
      suggestedCrop: { x: paddedLeft * 4 / width * 100, y: paddedTop * 4 / height * 100,
        w: (paddedRight - paddedLeft) * 4 / width * 100, h: (paddedBottom - paddedTop) * 4 / height * 100 },
      pixels, changedPixelRatio: pixels / (width * height),
      density: pixels / ((right - left) * (bottom - top) * 16) });
  }
  regions.sort((a, b) => b.pixels - a.pixels || a.y - b.y || a.x - b.x);
  const retained = regions.slice(0, MAX_DELTA_REGIONS);
  return {
    policy: VISUAL_DELTA_VERSION,
    analysis: { ...dimensions, pixelFormat: "rgb24" as const, blockSize: 4 as const,
      pixelThreshold: 12, strongPixelThreshold: 48, connectivity: 8 as const },
    changedPixelRatio: changed / (width * height),
    nonzeroPixelRatio: nonzero / (width * height),
    meanAbsoluteChannelDelta: absoluteSum / (before.length * 255),
    unclusteredChangedPixelRatio: (changed - clusteredPixels) / (width * height),
    omittedRegionCount: Math.max(0, regions.length - MAX_DELTA_REGIONS),
    omittedChangedPixelRatio: regions.slice(MAX_DELTA_REGIONS).reduce((sum, region) => sum + region.pixels, 0) / (width * height),
    regions: retained.map(({ pixels: _pixels, ...region }) => region),
    ...(blockSums ? { deduplicationMetrics: {
      maximumChannelDelta,
      maximumBlockMeanDelta: Math.max(...blockSums) / 48,
      blockMeanSpread: (Math.max(...blockSums) - Math.min(...blockSums)) / 48,
      channelOffsetSpread: Math.max(...minimumOffsets.map((minimum, channel) => maximumOffsets[channel]! - minimum)),
      uniformChannelOffsets: minimumOffsets,
    } } : {}),
  };
}

export type VisualDelta = ReturnType<typeof analyzeVisualDelta>;

/** Near matches require full spatial resolution and no localized residual, even below the hint threshold. */
export function isConservativeVisualMatch(delta: VisualDelta, nativeGrid: boolean): boolean {
  const metrics = delta.deduplicationMetrics;
  return nativeGrid && metrics !== undefined && delta.changedPixelRatio === 0 &&
    metrics.maximumChannelDelta <= 2 && metrics.channelOffsetSpread === 0 && metrics.blockMeanSpread === 0;
}
