import type {
  ExactVisualPoint,
  OrderedVisualSet,
  SparseVisualSet,
} from "./model.js";

export const OVERVIEW_CELL_COUNT = 12;

export function assertMs(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(
      `${label} must be a non-negative safe integer in milliseconds; received ${
        String(value)
      }`,
    );
  }
  return value;
}

export function assertInterval(
  startMs: number,
  endMs: number,
  durationMs?: number,
): void {
  assertMs(startMs, "startMs");
  assertMs(endMs, "endMs");
  if (startMs >= endMs) {
    throw new RangeError(
      `Interval must satisfy startMs < endMs; received [${startMs},${endMs})`,
    );
  }
  if (durationMs !== undefined && endMs > durationMs) {
    throw new RangeError(
      `Interval endMs ${endMs} exceeds source durationMs ${durationMs}`,
    );
  }
}

export function uniformPointsMs(
  startMs: number,
  endMs: number,
  count = OVERVIEW_CELL_COUNT,
): number[] {
  assertInterval(startMs, endMs);
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError(
      `Sample count must be a positive integer; received ${String(count)}`,
    );
  }
  if (count === 1) return [Math.floor(startMs + (endMs - startMs) / 2)];
  const span = endMs - startMs;
  const endpointMargin = Math.min(500, Math.max(1, Math.floor(span / 2)));
  const sampleEnd = endMs - endpointMargin;
  const points = Array.from(
    { length: count },
    (_, index) =>
      startMs + Math.floor(((sampleEnd - startMs) * index) / (count - 1)),
  );
  return [...new Set(points)];
}

export function createSparseVisualSet(
  startMs: number,
  endMs: number,
  pointsMs: readonly number[],
  artifactId: SparseVisualSet["artifactId"],
): SparseVisualSet {
  assertInterval(startMs, endMs);
  const normalized = [
    ...new Set(pointsMs.map((point) => assertMs(point, "sparse point"))),
  ].sort((a, b) => a - b);
  if (
    normalized.length === 0 ||
    normalized.some((point) => point < startMs || point >= endMs)
  ) {
    throw new RangeError(
      `Sparse visual points must be non-empty and inside [${startMs},${endMs})`,
    );
  }
  return { kind: "sparse", startMs, endMs, pointsMs: normalized, artifactId };
}

export function createOrderedVisualSet(
  startMs: number,
  endMs: number,
  pointsMs: readonly number[],
  artifactIds: OrderedVisualSet["artifactIds"],
): OrderedVisualSet {
  assertInterval(startMs, endMs);
  const normalized = pointsMs.map((point) => assertMs(point, "ordered point"));
  if (
    normalized.length === 0 ||
    normalized.some(
      (point, index) =>
        point < startMs ||
        point >= endMs ||
        (index > 0 && point <= normalized[index - 1]!),
    )
  ) {
    throw new RangeError(
      `Ordered visual points must be strictly increasing inside [${startMs},${endMs})`,
    );
  }
  if (artifactIds.length !== normalized.length) {
    throw new RangeError(
      `Ordered visual set has ${normalized.length} points but ${artifactIds.length} artifacts`,
    );
  }
  return {
    kind: "ordered_points",
    startMs,
    endMs,
    pointsMs: normalized,
    artifactIds,
  };
}

export function pointTimestamps(
  evidence: Readonly<{
    sparse: readonly SparseVisualSet[];
    exact: readonly ExactVisualPoint[];
    ordered: readonly OrderedVisualSet[];
  }>,
): number[] {
  return [
    ...new Set([
      ...evidence.sparse.flatMap((set) => set.pointsMs),
      ...evidence.exact.map((point) => point.atMs),
      ...evidence.ordered.flatMap((set) => set.pointsMs),
    ]),
  ].sort((a, b) => a - b);
}

export function largestUnsampledGaps(
  durationMs: number,
  pointsMs: readonly number[],
  limit = 5,
): Array<{ startMs: number; endMs: number }> {
  assertMs(durationMs, "durationMs");
  if (durationMs === 0) return [];
  const points = [
    ...new Set(
      pointsMs.filter(
        (point) =>
          Number.isSafeInteger(point) && point >= 0 && point < durationMs,
      ),
    ),
  ].sort((a, b) => a - b);
  const boundaries = [0, ...points, durationMs];
  const gaps = boundaries
    .slice(0, -1)
    .map((startMs, index) => ({ startMs, endMs: boundaries[index + 1]! }))
    .filter((gap) => gap.endMs > gap.startMs)
    .sort(
      (a, b) =>
        b.endMs - b.startMs - (a.endMs - a.startMs) || a.startMs - b.startMs,
    );
  return gaps.slice(0, Math.max(0, limit));
}

export function largestExactFrameGaps(
  durationMs: number,
  exactFrameTimestampsMs: readonly number[],
): Array<{ startMs: number; endMs: number }> {
  return largestUnsampledGaps(durationMs, exactFrameTimestampsMs, 3);
}
