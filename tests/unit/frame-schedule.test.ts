import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../../src/config.js";
import {
  fixedCadenceTargetAt,
  fixedCadenceTargetCount,
  fixedCadenceTargets,
  validateFixedCadenceSchedule,
} from "../../src/core/frame-schedule.js";

test("fixed cadence uses a half-open interval and direct integer targets", () => {
  const schedule = { startMs: 0, endMs: 12_000, cadenceMs: 1_000 };
  assert.equal(fixedCadenceTargetCount(schedule), 12);
  assert.deepEqual(fixedCadenceTargets(schedule, 0, 12), [
    0,
    1_000,
    2_000,
    3_000,
    4_000,
    5_000,
    6_000,
    7_000,
    8_000,
    9_000,
    10_000,
    11_000,
  ]);
  assert.equal(fixedCadenceTargetAt(schedule, 11), 11_000);
  assert.throws(() => fixedCadenceTargetAt(schedule, 12));
});

test("fixed cadence handles non-divisible and shorter intervals without resampling", () => {
  assert.deepEqual(
    fixedCadenceTargets(
      { startMs: 100, endMs: 3_350, cadenceMs: 1_000 },
      0,
      4,
    ),
    [100, 1_100, 2_100, 3_100],
  );
  const short = { startMs: 500, endMs: 700, cadenceMs: 1_000 };
  assert.equal(fixedCadenceTargetCount(short), 1);
  assert.deepEqual(fixedCadenceTargets(short, 0, 1), [500]);
});

test("fixed cadence boundary counts include exactly twelve and one hundred twenty targets", () => {
  assert.equal(
    fixedCadenceTargetCount({ startMs: 0, endMs: 12, cadenceMs: 1 }),
    12,
  );
  assert.equal(
    fixedCadenceTargetCount({ startMs: 0, endMs: 120, cadenceMs: 1 }),
    120,
  );
  assert.equal(
    fixedCadenceTargetCount({ startMs: 0, endMs: 121, cadenceMs: 1 }),
    121,
  );
});

test("fixed cadence rejects invalid values and checks arithmetic safely", () => {
  for (
    const schedule of [
      { startMs: 0, endMs: 10, cadenceMs: 0 },
      { startMs: 0, endMs: 10, cadenceMs: -1 },
      { startMs: 10, endMs: 10, cadenceMs: 1 },
      { startMs: 11, endMs: 10, cadenceMs: 1 },
      { startMs: -1, endMs: 10, cadenceMs: 1 },
    ]
  ) {
    assert.throws(() => validateFixedCadenceSchedule(schedule));
  }
  const awkward = {
    startMs: Number.MAX_SAFE_INTEGER - 5,
    endMs: Number.MAX_SAFE_INTEGER,
    cadenceMs: 2,
  };
  assert.equal(fixedCadenceTargetCount(awkward), 3);
  assert.deepEqual(fixedCadenceTargets(awkward, 0, 3), [
    Number.MAX_SAFE_INTEGER - 5,
    Number.MAX_SAFE_INTEGER - 3,
    Number.MAX_SAFE_INTEGER - 1,
  ]);
});

test("frame schedule limits are exposed through the existing environment configuration", () => {
  const config = loadConfig({
    URMA_MAX_FRAME_SCHEDULE_PAGE_TARGETS: "6",
    URMA_MAX_FRAME_SCHEDULE_TARGETS: "240",
  });
  assert.equal(config.limits.maxFrameSchedulePageTargets, 6);
  assert.equal(config.limits.maxFrameScheduleTargets, 240);
  assert.throws(
    () => loadConfig({ URMA_MAX_FRAME_SCHEDULE_PAGE_TARGETS: "13" }),
    /must not exceed 12/u,
  );
});
