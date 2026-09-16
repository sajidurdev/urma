import { assertInterval, assertMs } from "./coverage.js";

export const DEFAULT_FRAME_SCHEDULE_PAGE_TARGETS = 12;
export const DEFAULT_FRAME_SCHEDULE_MAX_TARGETS = 120;
export const FRAME_SCHEDULE_POLICY_VERSION = "fixed-cadence-v1";
export const FRAME_TIMELINE_VERSION = "source-global-ms";
export const FRAME_SELECTION_CONTRACT_VERSION = "frame-extractor";

export type FixedCadenceSchedule = Readonly<{
  startMs: number;
  endMs: number;
  cadenceMs: number;
}>;

export function validateFixedCadenceSchedule(
  schedule: FixedCadenceSchedule,
  durationMs?: number,
): FixedCadenceSchedule {
  assertInterval(schedule.startMs, schedule.endMs, durationMs);
  assertMs(schedule.cadenceMs, "cadenceMs");
  if (schedule.cadenceMs < 1) {
    throw new RangeError(
      `cadenceMs must be a positive safe integer in milliseconds; received ${
        String(schedule.cadenceMs)
      }`,
    );
  }
  return schedule;
}

/** Count targets without an overflowing span-plus-cadence expression */
export function fixedCadenceTargetCount(
  schedule: FixedCadenceSchedule,
  durationMs?: number,
): number {
  validateFixedCadenceSchedule(schedule, durationMs);
  const span = BigInt(schedule.endMs) - BigInt(schedule.startMs);
  const cadence = BigInt(schedule.cadenceMs);
  const count = (span + cadence - 1n) / cadence;
  if (count > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(
      "Fixed-cadence target count exceeds safe integer range",
    );
  }
  return Number(count);
}

/** Derive a target from the original schedule start and index */
export function fixedCadenceTargetAt(
  schedule: FixedCadenceSchedule,
  index: number,
  durationMs?: number,
): number {
  const count = fixedCadenceTargetCount(schedule, durationMs);
  if (!Number.isSafeInteger(index) || index < 0 || index >= count) {
    throw new RangeError(
      `Fixed-cadence schedule index must be in [0,${count}); received ${
        String(index)
      }`,
    );
  }
  const target = BigInt(schedule.startMs) +
    BigInt(index) * BigInt(schedule.cadenceMs);
  if (target > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("Fixed-cadence target exceeds safe integer range");
  }
  return Number(target);
}

export function fixedCadenceTargets(
  schedule: FixedCadenceSchedule,
  startIndex: number,
  endIndexExclusive: number,
  durationMs?: number,
): number[] {
  const count = fixedCadenceTargetCount(schedule, durationMs);
  if (
    !Number.isSafeInteger(startIndex) ||
    !Number.isSafeInteger(endIndexExclusive) ||
    startIndex < 0 ||
    endIndexExclusive < startIndex ||
    endIndexExclusive > count
  ) {
    throw new RangeError(
      `Fixed-cadence page must be inside [0,${count}]; received [${
        String(startIndex)
      },${String(endIndexExclusive)})`,
    );
  }
  const start = BigInt(schedule.startMs);
  const cadence = BigInt(schedule.cadenceMs);
  return Array.from(
    { length: endIndexExclusive - startIndex },
    (_, offset) => Number(start + BigInt(startIndex + offset) * cadence),
  );
}
