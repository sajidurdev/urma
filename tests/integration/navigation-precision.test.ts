import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client, InMemoryTransport, type CallToolResult } from "@modelcontextprotocol/client";
import { openUrma } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { parseInvestigationRef } from "../../src/core/ids.js";
import { buildMcpServer } from "../../src/mcp/server.js";
import { runChecked } from "../../src/subprocess/runner.js";
import { exactFrameRequestKey } from "../../src/acquisition/frames.js";

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "urma-navigation-precision-"));
  const video = path.join(directory, "fixture.mp4");
  await runChecked("ffmpeg", ["-v", "error", "-f", "lavfi", "-i",
    "testsrc2=s=960x640:d=4:r=4", "-vf", "setsar=3/2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", video],
    { timeoutMs: 30_000 });
  const app = await openUrma(loadConfig({ URMA_DATA_DIR: path.join(directory, "data"), URMA_LOCAL_ROOTS: directory }));
  const server = buildMcpServer(app.evidence, app.store, app.blobs, app.config);
  const client = new Client({ name: "navigation-precision-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  t.after(async () => {
    await client.close(); await server.close(); app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const inspected = await app.evidence.inspectVideo({ source: video });
  return { app, client, directory, video, inspected, investigationRef: inspected.investigationRef };
}

function structured(result: CallToolResult) {
  assert(!result.isError, JSON.stringify(result.content));
  assert(result.structuredContent);
  return result.structuredContent as Record<string, any>;
}

async function dimensions(file: string) {
  const result = await runChecked("ffprobe", ["-v", "error", "-show_entries", "stream=width,height,sample_aspect_ratio", "-of", "json", file], { timeoutMs: 30_000 });
  return (JSON.parse(result.stdout.toString()) as { streams: { width: number; height: number }[] }).streams[0]!;
}

test("refinement uses presented history, explicit budgets, nominal/exact semantics, and scoped exhaustion over MCP", async (t) => {
  const { app, client, investigationRef } = await fixture(t);
  const overview = structured(await client.callTool({ name: "get_overview", arguments: { investigationRef } }));
  assert.equal(overview.samplingGaps.timestampBasis, "nominal");
  assert.equal(app.evidence.state(investigationRef).evidence.exactVisualPoints.length, 0);
  const visual = structured(await client.callTool({ name: "get_frames", arguments: {
    investigationRef, request: { kind: "refine", budget: 2 },
  } }));
  assert.equal(visual.frames.length, 2);
  assert(visual.frames.every((frame: { atMs: number }) => !overview.observedCoverage.sampleTimestampsMs.includes(frame.atMs)));
  assert.equal(visual.refinement.remainingGaps.timestampBasis, "nominal-and-requested");
  assert.equal(visual.samplingGaps.timestampBasis, "requested");
  const [first, second] = await Promise.all([1, 2].map(() => app.evidence.getFrames({
    investigationRef, request: { kind: "refine", startMs: 1000, endMs: 2000, budget: 2, basis: "exact" },
  })));
  assert(first && second && "frames" in first && "frames" in second);
  assert.equal(new Set([...first.frames, ...second.frames].map((frame) => frame.atMs)).size, 4);
  assert([...first.frames, ...second.frames].every((frame) => frame.atMs >= 1000 && frame.atMs < 2000));
  const tiny = { investigationRef, request: { kind: "refine", startMs: 10, endMs: 12, budget: 12, basis: "exact" } };
  const fill = structured(await client.callTool({ name: "get_frames", arguments: tiny }));
  assert.equal(fill.frames.length, 2);
  assert.equal(fill.refinement.exhausted, true);
  const empty = structured(await client.callTool({ name: "get_frames", arguments: { ...tiny, presentation: "panel" } }));
  assert.deepEqual(empty.frames, []);
  assert.equal(empty.refinement.exhausted, true);
  assert.equal(empty.refinement.remainingGaps.scope, "investigation");
  assert.equal(app.evidence.state(investigationRef).evidence.exactVisualPoints.length, 8);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(app.evidence.getFrames({ investigationRef, request: { kind: "refine", budget: 1 } }, aborted.signal), /cancelled/u);
  const invalidRange = await client.callTool({ name: "get_frames", arguments: {
    investigationRef, request: { kind: "refine", endMs: 5000, budget: 1 },
  } });
  assert.equal(invalidRange.isError, true);
  assert.match(JSON.stringify(invalidRange.content), /INVALID_SOURCE/u);
});

test("native crops honor rotation/SAR, keep provenance and cache identity, and rulers are derived exterior previews", async (t) => {
  const { app, client, directory, video, investigationRef, inspected } = await fixture(t);
  const base = { investigationRef, request: { kind: "points", timesMs: [1000] } };
  const ordinary = structured(await client.callTool({ name: "get_frames", arguments: base }));
  const crop = { x: 25, y: 25, w: 50, h: 50 };
  const response = await client.callTool({ name: "get_frames", arguments: { ...base, crop, rulers: true } });
  const cropped = structured(response);
  const frame = cropped.frames[0];
  assert.deepEqual(frame.crop, {
    coordinates: "displayed-source-percent", requested: crop,
    sourceWidth: 1440, sourceHeight: 640,
    pixels: { x: 360, y: 160, width: 720, height: 320 },
  });
  assert.notEqual(frame.artifactId, ordinary.frames[0].artifactId);
  assert.equal(frame.preview.canonical, false);
  assert.equal(frame.preview.coordinateSpace, "individual-displayed-source");
  assert.equal(response.content.filter((item) => item.type === "image").length, 1);
  const canonical = app.store.getArtifact(frame.artifactId)!;
  const preview = app.store.getArtifact(frame.preview.artifactId)!;
  assert.equal(canonical.role, "evidence"); assert.equal(preview.role, "locator");
  assert.deepEqual(await dimensions(app.blobs.pathForHash(canonical.sha256)), { width: 720, height: 320, sample_aspect_ratio: "1:1" });
  const image = response.content.find((item) => item.type === "image");
  assert(image?.type === "image");
  assert.deepEqual(Buffer.from(image.data, "base64"), await readFile(app.blobs.pathForHash(preview.sha256)));
  const resources = app.evidence.state(investigationRef).reopenableResources;
  assert(resources.includes(frame.resource)); assert(resources.includes(frame.preview.resource));
  assert.deepEqual(app.evidence.state(investigationRef).evidence.exactVisualPoints[1]?.crop, frame.crop);
  await client.readResource({ uri: frame.preview.resource });
  const cached = await app.evidence.getFrames({ investigationRef, request: { kind: "points", timesMs: [1000] }, crop });
  assert("frames" in cached && cached.frames[0]?.cacheHit);
  assert.deepEqual(cached.frames[0].crop, frame.crop);
  const other = await app.evidence.inspectVideo({ source: inspected.sourceRef });
  const cacheOther = await app.evidence.getFrames({ investigationRef: other.investigationRef, request: { kind: "points", timesMs: [1000] }, crop });
  assert("frames" in cacheOther && cacheOther.frames[0]?.cacheHit);
  assert.equal(cacheOther.stateSummary.visual.exactPoints, 1);
  for (const rotation of [90, 180, 270]) {
    const rotated = path.join(directory, `rotated-${rotation}.mp4`);
    await runChecked("ffmpeg", ["-v", "error", "-display_rotation:v:0", String(rotation), "-i", video, "-c", "copy", "-y", rotated], { timeoutMs: 30_000 });
    const rotatedInspection = await app.evidence.inspectVideo({ source: rotated });
    const rotatedFrames = await app.evidence.getFrames({ investigationRef: rotatedInspection.investigationRef, request: { kind: "points", timesMs: [1000] }, crop });
    assert("frames" in rotatedFrames);
    const geometry = rotatedFrames.frames[0]?.crop;
    assert.equal(geometry?.sourceWidth, rotation === 180 ? 1440 : 640);
    assert.equal(geometry?.sourceHeight, rotation === 180 ? 640 : 1440);
    assert.deepEqual(geometry?.pixels, rotation === 180
      ? { x: 360, y: 160, width: 720, height: 320 }
      : { x: 160, y: 360, width: 320, height: 720 });
    const rotatedArtifact = app.store.getArtifact(rotatedFrames.frames[0]!.artifactId)!;
    const actual = await runChecked("ffmpeg", ["-v", "error", "-i", app.blobs.pathForHash(rotatedArtifact.sha256),
      "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { timeoutMs: 30_000, maxStdoutBytes: 2_000_000 });
    const rotate = rotation === 180 ? "hflip,vflip" : `transpose=${rotation === 90 ? "cclock" : "clock"}`;
    const pixels = geometry!.pixels;
    const expected = await runChecked("ffmpeg", ["-v", "error", "-ss", "1", "-i", video,
      "-vf", `scale=1440:640,setsar=1,${rotate},format=yuv444p,crop=${pixels.width}:${pixels.height}:${pixels.x}:${pixels.y}:exact=1`,
      "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { timeoutMs: 30_000, maxStdoutBytes: 2_000_000 });
    assert.equal(actual.stdout.length, expected.stdout.length);
    const difference = actual.stdout.reduce((sum, value, index) => sum + Math.abs(value - expected.stdout[index]!), 0) / actual.stdout.length;
    assert(difference < 8, `${rotation} degree crop should match independently rotated source pixels; mean error ${difference}`);
  }
  const panel = structured(await client.callTool({ name: "get_frames", arguments: {
    investigationRef, request: { kind: "points", timesMs: [1000, 2000] }, presentation: "panel", rulers: true, crop,
  } }));
  assert.equal(panel.panel.width, 800); assert.equal(panel.panel.height, 292);
  assert.equal(panel.panel.rulers, true);
  assert(panel.cells.every((cell: { crop: unknown }) => cell.crop));
  const overview = structured(await client.callTool({ name: "get_overview", arguments: { investigationRef, rulers: true } }));
  assert.equal(overview.rulers, true);
  assert.equal(overview.samplingGaps.timestampBasis, "nominal");
  assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(),
    ["get_frames", "get_overview", "inspect_video", "read_transcript", "search_transcript"]);
  assert.equal(parseInvestigationRef(cropped.investigationRef), investigationRef);
});

test("cadence cursors retain crops and reject a changed coordinate region", async (t) => {
  const { client, investigationRef } = await fixture(t);
  const crop = { x: 50, y: 0, w: 50, h: 100 };
  const first = structured(await client.callTool({ name: "get_frames", arguments: {
    investigationRef, request: { kind: "cadence", startMs: 0, endMs: 3000, cadenceMs: 1000 }, crop, pageSize: 1, rulers: true,
  } }));
  assert(first.slots[0].crop); assert(first.slots[0].preview);
  const next = structured(await client.callTool({ name: "get_frames", arguments: {
    investigationRef, cursor: first.nextCursor, pageSize: 1,
  } }));
  assert.deepEqual(next.slots[0].crop.requested, crop);
  const rejected = await client.callTool({ name: "get_frames", arguments: {
    investigationRef, cursor: next.nextCursor, crop: { x: 0, y: 0, w: 100, h: 100 },
  } });
  assert.equal(rejected.isError, true);
});

test("identical crop bytes retain independent regions, sources, and snapshot provenance", async (t) => {
  const { app, directory } = await fixture(t);
  const videoA = path.join(directory, "flat-a.mp4");
  const videoB = path.join(directory, "flat-b.mp4");
  await runChecked("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=64x32:d=2:r=2",
    "-c:v", "libx264", "-y", videoA], { timeoutMs: 30_000 });
  await copyFile(videoA, videoB);
  const inspections = await Promise.all([videoA, videoB].map((source) => app.evidence.inspectVideo({ source })));
  const regions = [{ x: 0, y: 0, w: 50, h: 100 }, { x: 50, y: 0, w: 50, h: 100 }];
  const [left, right] = await Promise.all(inspections.map((inspection, index) => app.evidence.getFrames({
    investigationRef: inspection.investigationRef, request: { kind: "points", timesMs: [0] }, crop: regions[index]!, rulers: true,
  })));
  assert(left && right && "frames" in left && "frames" in right);
  assert.equal(left.frames[0]?.artifactId, right.frames[0]?.artifactId, "uniform scenes may share immutable bytes");
  assert.notEqual(left.frames[0]?.preview?.artifactId, right.frames[0]?.preview?.artifactId, "source-coordinate rulers retain each region even when image content matches");
  for (const [index, inspection] of inspections.entries()) {
    const artifact = app.store.getArtifactByRequest(exactFrameRequestKey({
      sourceRef: inspection.sourceRef, revision: inspection.source.snapshotRevision, kind: "local",
    }, 0, regions[index]!));
    assert(artifact);
    assert.equal(artifact.sourceRef, inspection.sourceRef);
    assert.equal(artifact.sourceRevision, inspection.source.snapshotRevision);
    assert.deepEqual(artifact.params.crop, regions[index]);
    assert.deepEqual(app.evidence.state(inspection.investigationRef).evidence.exactVisualPoints[0]?.crop?.requested, regions[index]);
  }
  const tiny = await app.evidence.getFrames({ investigationRef: inspections[0]!.investigationRef,
    request: { kind: "points", timesMs: [0] }, crop: { x: 99.99, y: 99.99, w: .01, h: .01 } });
  assert("frames" in tiny);
  const artifact = app.store.getArtifact(tiny.frames[0]!.artifactId)!;
  const size = await dimensions(app.blobs.pathForHash(artifact.sha256));
  assert.equal(size.width, 1); assert.equal(size.height, 1);
  const noSar = path.join(directory, "unknown-sar.mp4");
  await runChecked("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=64x32:d=2:r=2",
    "-vf", "setsar=0", "-c:v", "libx264", "-y", noSar], { timeoutMs: 30_000 });
  const noSarInspection = await app.evidence.inspectVideo({ source: noSar });
  const noSarFrames = await app.evidence.getFrames({ investigationRef: noSarInspection.investigationRef,
    request: { kind: "points", timesMs: [0] }, crop: { x: 0, y: 0, w: 100, h: 100 }, rulers: true });
  assert("frames" in noSarFrames);
  assert.equal(noSarFrames.frames[0]?.crop?.sourceWidth, 64);
  assert.equal(noSarFrames.frames[0]?.crop?.sourceHeight, 32);
});
