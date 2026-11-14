import assert from "node:assert/strict";
import test from "node:test";
import { analysisDimensions, analyzeVisualDelta } from "../../src/core/visual-delta.js";

test("analysis dimensions fit displayed geometry with a bounded and explicit 4px rounding error", () => {
  assert.deepEqual(analysisDimensions(1920, 1080), { width: 256, height: 144, aspectRatioError: 0 });
  const portrait = analysisDimensions(1920, 1080, 1, 90);
  assert.equal(portrait.width, 72); assert.equal(portrait.height, 128);
  assert(portrait.aspectRatioError < .02);
  assert.deepEqual(analysisDimensions(640, 480, 4 / 3), analysisDimensions(1920, 1080));
  assert.throws(() => analysisDimensions(2, 10000), /aspect ratio/u);
  assert.throws(() => analysisDimensions(100, 100, 1, 45), /rotation/u);
});

test("scattered changes remain separate; strong tiny UI events survive conservative filtering", () => {
  const dimensions = analysisDimensions(64, 32);
  const before = Buffer.alloc(64 * 32 * 3);
  const after = Buffer.from(before);
  for (const [x, y] of [[1, 1], [40, 20]]) after[(y! * 64 + x!) * 3] = 255;
  const result = analyzeVisualDelta(before, after, dimensions);
  assert.equal(result.regions.length, 2);
  assert.equal(result.changedPixelRatio, 2 / 2048);
  assert.equal(result.regions[0]?.density, 1 / 16);
  assert.deepEqual(result.regions.map(({ x, y, w, h }) => ({ x, y, w, h })), [
    { x: 0, y: 0, w: 6.25, h: 12.5 }, { x: 62.5, y: 62.5, w: 6.25, h: 12.5 },
  ]);
  assert.deepEqual(analyzeVisualDelta(before, after, dimensions), result);
});

test("codec-scale noise and weak isolated differences are counted without inventing confident regions", () => {
  const dimensions = analysisDimensions(64, 32);
  const before = Buffer.alloc(64 * 32 * 3, 100);
  const noise = Buffer.alloc(before.length, 104);
  const result = analyzeVisualDelta(before, noise, dimensions);
  assert.equal(result.changedPixelRatio, 0);
  assert.equal(result.nonzeroPixelRatio, 1);
  assert.deepEqual(result.regions, []);
  noise[0] = 114;
  const weak = analyzeVisualDelta(before, noise, dimensions);
  assert.equal(weak.unclusteredChangedPixelRatio, 1 / 2048);
  assert.equal(weak.changedPixelRatio, 1 / 2048);
  assert.deepEqual(weak.regions, []);
  assert.throws(() => analyzeVisualDelta(before.subarray(1), noise, dimensions), /RGB24/u);
});

test("region caps report omitted islands instead of merging scattered regions into one box", () => {
  const dimensions = analysisDimensions(128, 64);
  const before = Buffer.alloc(128 * 64 * 3), after = Buffer.from(before);
  for (let i = 0; i < 20; i++) after[(Math.floor(i / 10) * 16 * 128 + (i % 10) * 12) * 3] = 255;
  const result = analyzeVisualDelta(before, after, dimensions);
  assert.equal(result.regions.length, 16);
  assert.equal(result.omittedRegionCount, 4);
  assert.equal(result.omittedChangedPixelRatio, 4 / (128 * 64));
});

test("suggested crops add one block on each side without changing measured regions or pixel ratios", () => {
  for (const [width, height] of [[64, 32], [72, 128], [256, 144]]) {
    const dimensions = analysisDimensions(width!, height!);
    const before = Buffer.alloc(width! * height! * 3), after = Buffer.from(before);
    for (const [x, y] of [[0, 0], [12, 12], [width! - 1, height! - 1]]) after[(y! * width! + x!) * 3] = 255;
    const delta = analyzeVisualDelta(before, after, dimensions);
    assert.equal(delta.changedPixelRatio, 3 / (width! * height!));
    assert.equal(delta.regions.length, 3);
    assert.equal(delta.regions[0]?.density, 1 / 16);
    for (const region of delta.regions) {
      const crop = region.suggestedCrop!;
      const left = Math.max(0, region.x - 400 / width!), top = Math.max(0, region.y - 400 / height!);
      const right = Math.min(100, region.x + region.w + 400 / width!), bottom = Math.min(100, region.y + region.h + 400 / height!);
      for (const [actual, expected] of [[crop.x, left], [crop.y, top], [crop.w, right - left], [crop.h, bottom - top]]) assert(Math.abs(actual! - expected!) < 1e-10);
      assert(crop.x >= 0 && crop.y >= 0 && crop.x + crop.w <= 100 + 1e-10 && crop.y + crop.h <= 100 + 1e-10);
    }
    assert.deepEqual(delta, analyzeVisualDelta(before, after, dimensions));
  }
});
