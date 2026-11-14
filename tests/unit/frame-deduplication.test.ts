import assert from "node:assert/strict";
import test from "node:test";
import { analysisDimensions, analyzeVisualDelta, isConservativeVisualMatch } from "../../src/core/visual-delta.js";
import { VisualAnalyzer } from "../../src/acquisition/visual-analysis.js";
import { loadConfig } from "../../src/config.js";
import { BlobStore } from "../../src/store/blob-store.js";
import { artifactIdFromSha256, createInvestigationRef, localSourceRef } from "../../src/core/ids.js";
import type { StoredArtifact } from "../../src/store/store.js";

test("native-grid matching accepts only identical pixels or uniformly tiny channel offsets", () => {
  const dimensions = analysisDimensions(64, 32);
  const before = Buffer.alloc(64 * 32 * 3, 100);
  const uniform = Buffer.alloc(before.length, 102);
  const identical = analyzeVisualDelta(before, before, dimensions, true);
  assert(isConservativeVisualMatch(identical, true));
  const noise = analyzeVisualDelta(before, uniform, dimensions, true);
  assert(isConservativeVisualMatch(noise, true));
  assert.equal(noise.deduplicationMetrics?.maximumChannelDelta, 2);
  assert.equal(noise.deduplicationMetrics?.maximumBlockMeanDelta, 2);
  assert(!isConservativeVisualMatch(noise, false), "downsampling uncertainty must retain distinct artifacts");
  assert(!isConservativeVisualMatch(analyzeVisualDelta(before, uniform, dimensions), true), "hints alone do not contain a grouping proof");
  assert(!isConservativeVisualMatch(analyzeVisualDelta(before, Buffer.alloc(before.length, 103), dimensions, true), true));
});

test("a single low-contrast pixel, blinking indicator, or scattered change blocks deduplication", () => {
  const dimensions = analysisDimensions(64, 32), before = Buffer.alloc(64 * 32 * 3, 100);
  for (const amplitude of [1, 2, 8, 12, 48, 155]) {
    const after = Buffer.from(before); after[0] = 100 + amplitude;
    const delta = analyzeVisualDelta(before, after, dimensions, true);
    assert(!isConservativeVisualMatch(delta, true), `single-pixel amplitude ${amplitude} must remain visible`);
    assert(delta.deduplicationMetrics!.channelOffsetSpread > 0);
  }
  const scattered = Buffer.from(before);
  for (const pixel of [1, 71, 800, 2047]) scattered[pixel * 3] = 102;
  assert(!isConservativeVisualMatch(analyzeVisualDelta(before, scattered, dimensions, true), true));
  assert.deepEqual(analyzeVisualDelta(before, scattered, dimensions, true), analyzeVisualDelta(before, scattered, dimensions, true));
});

test("spatial codec-like noise is retained rather than treating all low-amplitude differences as safe", () => {
  const dimensions = analysisDimensions(64, 32), before = Buffer.alloc(64 * 32 * 3, 100);
  const noise = Buffer.from(before);
  for (let index = 0; index < noise.length; index++) noise[index] = 100 + (index * 17 % 5) - 2;
  const delta = analyzeVisualDelta(before, noise, dimensions, true);
  assert.equal(delta.changedPixelRatio, 0);
  assert(!isConservativeVisualMatch(delta, true));
  assert(delta.deduplicationMetrics!.channelOffsetSpread > 0);
});

test("grouping rejects oversized/duplicate-index inputs and never combines different source identities", async () => {
  const analyzer = new VisualAnalyzer(loadConfig({}), new BlobStore("unused-frame-grouping-test"));
  const artifact: StoredArtifact = { artifactId: artifactIdFromSha256("0".repeat(64)), sha256: "0".repeat(64),
    sourceRef: localSourceRef("source-a"), sourceRevision: "revision-a", kind: "frame", role: "evidence", mimeType: "image/jpeg",
    byteSize: 4, blobPath: "unused", startMs: 0, endMs: 0, params: {}, producer: {}, createdAt: new Date(0).toISOString() };
  const ref = createInvestigationRef();
  const first = { index: 0, atMs: 0, artifact };
  await assert.rejects(analyzer.group([first, first], ref), /uniquely indexed/u);
  await assert.rejects(analyzer.group(Array.from({ length: 13 }, (_, index) => ({ ...first, index })), ref), /at most 12/u);
  const result = await analyzer.group([first, { index: 1, atMs: 1,
    artifact: { ...artifact, sourceRef: localSourceRef("source-b") } }], ref);
  assert.equal(result.representativeCount, 2); assert.equal(result.decodedFrames, 0);
  assert.notEqual(result.groups[0]?.members[0]?.sourceRef, result.groups[1]?.members[0]?.sourceRef);
  const changedScope = await analyzer.group([first,
    { ...first, index: 1, artifact: { ...artifact, sourceRevision: "revision-b" } },
    { ...first, index: 2, artifact: { ...artifact, producer: { crop: { x: 1 } } } },
  ], ref);
  assert.equal(changedScope.representativeCount, 3);
  const empty = await analyzer.group([], ref);
  assert.equal(empty.representativeCount, 0);
  const atLimit = await analyzer.group(Array.from({ length: 12 }, (_, index) => ({ ...first, index: 11 - index, atMs: index })), ref);
  assert.equal(atLimit.groups[0]?.representativeIndex, 11);
  assert.deepEqual(atLimit.groups[0]?.members.map((member) => member.index), Array.from({ length: 12 }, (_, index) => 11 - index));
  assert.equal(atLimit.suppressedImageCount, 11);
  assert.equal(atLimit.decodedFrames, 0);
});
