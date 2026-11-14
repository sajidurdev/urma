import assert from "node:assert/strict";
import test from "node:test";
import { refineGapPoints } from "../../src/core/coverage.js";
import { frameCropGeometry, validateFrameCrop } from "../../src/core/frame-crop.js";
import { framesInput, overviewInput } from "../../src/mcp/schemas.js";

test("gap refinement is bounded, deterministic, scoped, and never repeats an observed millisecond", () => {
  assert.deepEqual(refineGapPoints(0, 10_000, [], 4), [5000, 2500, 7500, 1250]);
  assert.deepEqual(refineGapPoints(100, 110, [0, 105, 105, 110], 3), [102, 107, 103]);
  assert.deepEqual(refineGapPoints(10, 12, [10], 12), [11]);
  assert.deepEqual(refineGapPoints(10, 12, [10, 11], 12), []);
  assert.deepEqual(refineGapPoints(Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER, [], 12), [Number.MAX_SAFE_INTEGER - 1]);
  let history: number[] = [];
  for (let run = 0; run < 20; run++) {
    const points = refineGapPoints(0, 31, history, 3);
    assert(points.length <= 3);
    assert(points.every((time) => !history.includes(time) && time >= 0 && time < 31));
    history.push(...points);
  }
  assert.equal(new Set(history).size, 31);
  for (const budget of [0, -1, 1.5, 13, Infinity, NaN]) {
    assert.throws(() => refineGapPoints(0, 10, [], budget), /budget/u);
  }
});

test("crop percentages validate bounds and preserve intersecting edge pixels", () => {
  assert.deepEqual(frameCropGeometry({ x: 25, y: 50, w: 75, h: 50 }, 101, 51).pixels,
    { x: 25, y: 25, width: 76, height: 26 });
  assert.deepEqual(frameCropGeometry({ x: 99.99, y: 99.99, w: .01, h: .01 }, 3, 1).pixels,
    { x: 2, y: 0, width: 1, height: 1 });
  for (const crop of [
    { x: -1, y: 0, w: 1, h: 1 }, { x: 0, y: 0, w: 0, h: 1 },
    { x: 90, y: 0, w: 11, h: 1 }, { x: 0, y: 90, w: 1, h: 11 },
    { x: NaN, y: 0, w: 1, h: 1 }, { x: 0, y: 0, w: Infinity, h: 1 },
    { x: 100, y: 0, w: Number.MIN_VALUE, h: 1 },
  ]) assert.throws(() => validateFrameCrop(crop), /crop requires/u);
  assert.throws(() => frameCropGeometry({ x: 0, y: 0, w: 100, h: 100 }, 32769, 1), /geometry/u);
});

test("MCP accepts optional crops/rulers/refinement while rejecting malformed and unbounded requests", () => {
  const investigationRef = `urma:investigation:${"a".repeat(32)}`;
  const base = { investigationRef, request: { kind: "refine", budget: 2 } };
  assert(framesInput.safeParse({ ...base, rulers: true, crop: { x: 50, y: 0, w: 50, h: 100 } }).success);
  assert(overviewInput.safeParse({ investigationRef, rulers: true }).success);
  for (const request of [{ kind: "refine" }, { kind: "refine", budget: 0 }, { kind: "refine", budget: 13 }]) {
    assert(!framesInput.safeParse({ investigationRef, request }).success);
  }
  for (const crop of [null, {}, { x: 0, y: 0, w: "50", h: 100 }, { x: 50, y: 0, w: 51, h: 100 }, { x: 0, y: 0, w: 1, h: 1, unit: "pixels" }]) {
    assert(!framesInput.safeParse({ ...base, crop }).success);
  }
  assert(!framesInput.safeParse({ ...base, pageSize: 1 }).success);
  assert(!framesInput.safeParse({ ...base, rulers: "true" }).success);
  assert(!framesInput.safeParse({ ...base, request: { kind: "refine", startMs: 10, endMs: 10, budget: 1 } }).success);
});
