import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client, InMemoryTransport, type CallToolResult } from "@modelcontextprotocol/client";
import { openUrma } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { buildMcpServer } from "../../src/mcp/server.js";
import type { FrameDeduplication } from "../../src/acquisition/visual-analysis.js";
import { runChecked } from "../../src/subprocess/runner.js";
import { framesInput } from "../../src/mcp/schemas.js";
import { Ffmpeg } from "../../src/subprocess/ffmpeg.js";
import { UrmaError } from "../../src/core/errors.js";

const times = [0, 120, 500, 920];
type Frame = { index: number; atMs: number; artifactId: string; resource: string };
type Output = { frames: Frame[]; cells: { index: number; timestampMs: number; artifactId: string; resource: string; panelIndex?: number }[];
  panel: { artifactId: string; cellCount: number; width: number; height: number; resource: string };
  deduplication?: FrameDeduplication; samplingGaps: unknown;
  slots: { index: number; status: string; requestedAtMs: number; artifactId?: string }[]; nextCursor: string | null };
function structured(result: CallToolResult): Output {
  assert(!result.isError, JSON.stringify(result.content)); assert(result.structuredContent);
  return result.structuredContent as unknown as Output;
}
function imageBytes(result: CallToolResult): number {
  return result.content.reduce((sum, block) => sum + (block.type === "image" ? Buffer.from(block.data, "base64").length : 0), 0);
}
async function fixture(t: test.TestContext, mode: "uniform" | "blink" | "texture" | "large" = "uniform", portrait = false, levels = [80, 81, 82, 80]) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "urma-frame-dedup-"));
  const width = mode === "large" ? 512 : portrait ? 72 : 256, height = mode === "large" ? 288 : portrait ? 128 : 144;
  const rgb = times.map((_, index) => {
    const image = Buffer.alloc(width * height * 3, mode === "uniform" ? levels[index]! : 100);
    if (mode === "texture") for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      image.set([(x * 13 + y * 7) % 180 + 30, (x * 3 + y * 11) % 180 + 30, (x * 17 + y * 5) % 180 + 30], (y * width + x) * 3);
    }
    if ((mode === "blink" || mode === "large") && index === 1) {
      image.set([255, 255, 255], (10 * width + 10) * 3);
    }
    if (mode === "blink" && index === 3) for (const [x, y] of [[4, 4], [width - 8, height - 8]]) {
      image.set([255, 40, 40], (y! * width + x!) * 3);
    }
    return image;
  });
  const input = path.join(directory, "input.rgb"), video = path.join(directory, "fixture.mp4");
  await writeFile(input, Buffer.concat(rgb));
  const pts = times.reduceRight((rest, atMs, index) => `if(eq(N,${index}),${atMs},${rest})`, "0");
  await runChecked("ffmpeg", ["-v", "error", "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", `${width}x${height}`,
    "-framerate", "1000", "-i", input, "-vf", `settb=1/1000,setpts='${pts}'`, "-fps_mode", "vfr",
    "-c:v", "libx264rgb", "-crf", "0", "-g", "999", "-sc_threshold", "0", "-bf", "0", "-video_track_timescale", "1000", "-y", video], { timeoutMs: 30_000 });
  const app = await openUrma(loadConfig({ URMA_DATA_DIR: path.join(directory, "data"), URMA_LOCAL_ROOTS: directory }));
  const server = buildMcpServer(app.evidence, app.store, app.blobs, app.config), client = new Client({ name: "frame-dedup-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await Promise.all([client.connect(a), server.connect(b)]);
  t.after(async () => { await client.close(); await server.close(); app.close(); await rm(directory, { recursive: true, force: true }); });
  const plain = await app.evidence.inspectVideo({ source: video });
  const grouped = await app.evidence.inspectVideo({ source: plain.sourceRef });
  return { app, client, plain, grouped, directory };
}

test("opt-in grouping saves representative images while preserving every VFR observation, resource, and gap", async (t) => {
  const { app, client, plain, grouped } = await fixture(t);
  const request = { kind: "points", timesMs: times };
  const baselineResponse = await client.callTool({ name: "get_frames", arguments: { investigationRef: plain.investigationRef, request } });
  const response = await client.callTool({ name: "get_frames", arguments: { investigationRef: grouped.investigationRef, request, deduplicate: true } });
  const baseline = structured(baselineResponse), result = structured(response), grouping = result.deduplication;
  assert(grouping);
  assert.equal(grouping.representativeCount, 1, JSON.stringify(grouping));
  assert.equal(grouping.inputFrameCount, 4); assert.equal(grouping.suppressedImageCount, 3);
  assert.deepEqual(result.frames.map((frame) => [frame.atMs, frame.artifactId]), baseline.frames.map((frame) => [frame.atMs, frame.artifactId]));
  assert.deepEqual(result.samplingGaps, baseline.samplingGaps);
  assert.deepEqual(grouping.groups[0]?.members.map((member) => member.requestedAtMs), times);
  assert(grouping.groups[0]?.members.every((member) => member.sourceRef === grouped.sourceRef && member.sourceRevision === grouped.source.snapshotRevision));
  assert.equal(response.content.filter((block) => block.type === "image").length, 1);
  assert.equal(grouping.groups[0]?.panelIndex, null);
  for (const frame of result.frames) await client.readResource({ uri: frame.resource });
  const before = app.evidence.state(plain.investigationRef), after = app.evidence.state(grouped.investigationRef);
  assert.equal(after.evidence.exactVisualPoints.length, before.evidence.exactVisualPoints.length);
  assert.deepEqual(after.largestExactFrameGaps, before.largestExactFrameGaps);
  assert.equal(after.calls, before.calls);
  const repeat = structured(await client.callTool({ name: "get_frames", arguments: { investigationRef: grouped.investigationRef, request, deduplicate: true } }));
  assert.deepEqual(repeat.deduplication?.groups, grouping.groups);
  assert.equal(repeat.deduplication?.decodedFrames, 0);
  t.diagnostic(`Uniform quantization fixture: images ${imageBytes(baselineResponse)} -> ${imageBytes(response)} bytes; complete MCP payload ${Buffer.byteLength(JSON.stringify(baselineResponse))} -> ${Buffer.byteLength(JSON.stringify(response))} bytes`);
});

test("a blinking single-pixel UI indicator and scattered changes retain separate representatives, including portrait video", async (t) => {
  for (const portrait of [false, true]) {
    const { client, grouped } = await fixture(t, "blink", portrait);
    const response = await client.callTool({ name: "get_frames", arguments: {
      investigationRef: grouped.investigationRef, request: { kind: "points", timesMs: times }, deduplicate: true, diffHints: true,
    } });
    const result = structured(response), grouping = result.deduplication;
    assert(grouping); assert.equal(grouping.representativeCount, 3, JSON.stringify(grouping));
    assert.deepEqual(grouping.groups.map((group) => group.members.map((member) => member.index)), [[0, 2], [1], [3]]);
    assert.equal(response.content.filter((block) => block.type === "image").length, 3);
    assert.equal(grouping.continuousObservation, false);
    t.diagnostic(`${portrait ? "Portrait" : "Landscape"} UI fixture: 0 false groupings across blink/scattered changes`);
  }
});

test("downscaled visual comparisons never suppress a distinct high-resolution frame", async (t) => {
  const { client, grouped } = await fixture(t, "large");
  const result = structured(await client.callTool({ name: "get_frames", arguments: {
    investigationRef: grouped.investigationRef, request: { kind: "points", timesMs: times }, deduplicate: true,
  } }));
  assert.equal(result.deduplication?.representativeCount, 2);
  assert.deepEqual(result.deduplication?.groups.map((group) => group.members.map((member) => member.index)), [[0, 2, 3], [1]]);
  assert.equal(result.deduplication?.decodedFrames, 0, "unsafe downsampled comparisons do not need an RGB decode");
});

test("representative panels retain full cell mappings and reduce actual panel bytes", async (t) => {
  const { app, client, plain, grouped } = await fixture(t, "texture");
  const request = { kind: "points", timesMs: times };
  const baselineResponse = await client.callTool({ name: "get_frames", arguments: { investigationRef: plain.investigationRef, request, presentation: "panel", rulers: true } });
  const response = await client.callTool({ name: "get_frames", arguments: { investigationRef: grouped.investigationRef, request, presentation: "panel", deduplicate: true, rulers: true } });
  const result = structured(response), grouping = result.deduplication;
  assert(grouping); assert.equal(result.cells.length, 4); assert.equal(result.panel.cellCount, 1);
  assert.equal(grouping.groups[0]?.panelIndex, 1);
  assert.deepEqual(result.cells.map((cell) => cell.timestampMs), times);
  assert.equal(app.evidence.state(grouped.investigationRef).evidence.exactVisualPoints.length, 4);
  assert(imageBytes(response) < imageBytes(baselineResponse));
  t.diagnostic(`Repeated texture panel: ${imageBytes(baselineResponse)} -> ${imageBytes(response)} JPEG bytes; complete MCP payload ${Buffer.byteLength(JSON.stringify(baselineResponse))} -> ${Buffer.byteLength(JSON.stringify(response))} bytes`);
  const uri = result.panel.resource; await client.readResource({ uri });
});

test("cadence pages retain all success slots and share representative panel indices", async (t) => {
  const { app, client, grouped } = await fixture(t, "texture");
  const result = structured(await client.callTool({ name: "get_frames", arguments: {
    investigationRef: grouped.investigationRef, request: { kind: "cadence", startMs: 0, endMs: 900, cadenceMs: 200 }, pageSize: 4,
    presentation: "panel", deduplicate: true,
  } }));
  assert.equal(result.slots.length, 4); assert(result.slots.every((slot) => slot.status === "success"));
  assert.equal(result.panel.cellCount, 1); assert(result.cells.every((cell) => cell.panelIndex === 1));
  assert.equal(result.deduplication?.inputFrameCount, 4);
  assert.equal(app.evidence.state(grouped.investigationRef).evidence.exactVisualPoints.length, 4);
  assert(result.nextCursor);
  const next = structured(await client.callTool({ name: "get_frames", arguments: { investigationRef: grouped.investigationRef, cursor: result.nextCursor, deduplicate: true } }));
  assert.equal(next.deduplication?.inputFrameCount, 1);
  assert.equal(app.evidence.state(grouped.investigationRef).evidence.exactVisualPoints.length, 5);
});

test("default behavior is unchanged and malformed or cancelled grouping requests add no observations", async (t) => {
  const { app, client, grouped } = await fixture(t);
  const request = { kind: "points", timesMs: times };
  assert(!framesInput.safeParse({ investigationRef: grouped.investigationRef, request, deduplicate: {} }).success);
  const rejected = await client.callTool({ name: "get_frames", arguments: { investigationRef: grouped.investigationRef, request, deduplicate: "yes" } });
  assert.equal(rejected.isError, true);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(app.evidence.getFrames({ investigationRef: grouped.investigationRef,
    request: { kind: "points", timesMs: times }, deduplicate: true }, controller.signal), /cancelled/u);
  assert.equal(app.evidence.state(grouped.investigationRef).evidence.exactVisualPoints.length, 0);
  const result = structured(await client.callTool({ name: "get_frames", arguments: { investigationRef: grouped.investigationRef, request, deduplicate: false } }));
  assert.equal(result.deduplication, undefined); assert.equal(result.frames.length, 4);
});

test("pairwise grouping prevents a chain of small global offsets from hiding a larger change", async (t) => {
  const { client, grouped } = await fixture(t, "uniform", false, [82, 80, 84, 82]);
  const result = structured(await client.callTool({ name: "get_frames", arguments: {
    investigationRef: grouped.investigationRef, request: { kind: "points", timesMs: times }, deduplicate: true,
  } }));
  assert.equal(result.deduplication?.representativeCount, 2);
  assert.deepEqual(result.deduplication?.groups.map((group) => group.members.map((member) => member.index)), [[0, 1, 3], [2]]);
});

test("cropped reverse-order points, bursts, and refinement retain their original sampling contracts", async (t) => {
  const { app, client, plain, grouped } = await fixture(t, "texture");
  const crop = { x: 0, y: 0, w: 50, h: 100 };
  const reversed = structured(await client.callTool({ name: "get_frames", arguments: {
    investigationRef: grouped.investigationRef, request: { kind: "points", timesMs: [...times].reverse() }, crop, deduplicate: true,
  } }));
  assert.deepEqual(reversed.frames.map((frame) => frame.atMs), [...times].reverse());
  assert.equal(reversed.deduplication?.groups[0]?.representativeAtMs, 920);
  assert(reversed.deduplication?.groups[0]?.members.every((member) => member.crop?.requested.w === 50));
  const burst = await app.evidence.getFrames({ investigationRef: grouped.investigationRef,
    request: { kind: "burst", startMs: 0, endMs: 900, count: 4 }, deduplicate: true });
  assert.equal(burst.deduplication?.inputFrameCount, 4);
  assert.equal(burst.kind, "ordered_points");
  assert.equal(app.evidence.state(grouped.investigationRef).evidence.orderedVisualSets[0]?.pointsMs.length, 4);
  const refinedInvestigation = await app.evidence.inspectVideo({ source: grouped.sourceRef });
  const request = { kind: "refine" as const, budget: 3, endMs: 900 };
  const baseline = await app.evidence.getFrames({ investigationRef: plain.investigationRef, request });
  const refined = await app.evidence.getFrames({ investigationRef: refinedInvestigation.investigationRef, request, deduplicate: true });
  assert("refinement" in refined && "refinement" in baseline);
  assert.deepEqual(refined.refinement, baseline.refinement);
  assert.deepEqual(refined.samplingGaps, baseline.samplingGaps);
  assert.equal(refined.deduplication?.inputFrameCount, 3);
  assert.equal(app.evidence.state(refinedInvestigation.investigationRef).evidence.exactVisualPoints.length, 3);
});

test("cancelling during grouping preserves cached acquisitions but commits no observations", async (t) => {
  const { app, plain, grouped } = await fixture(t);
  await app.evidence.getFrames({ investigationRef: plain.investigationRef, request: { kind: "points", timesMs: times } });
  let notifyStarted!: () => void;
  const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
  const decode = t.mock.method(Ffmpeg.prototype, "rgbFrames", async (...args: Parameters<Ffmpeg["rgbFrames"]>) => {
    const signal = args[3];
    notifyStarted();
    await new Promise<void>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new UrmaError("CANCELLED", "cancelled RGB grouping fixture")), { once: true });
    });
    return [];
  });
  const controller = new AbortController();
  const pending = app.evidence.getFrames({ investigationRef: grouped.investigationRef,
    request: { kind: "points", timesMs: times }, deduplicate: true }, controller.signal);
  await started; controller.abort();
  await assert.rejects(pending, /cancelled/u); decode.mock.restore();
  assert.equal(app.evidence.state(grouped.investigationRef).evidence.exactVisualPoints.length, 0);
  const recovered = await app.evidence.getFrames({ investigationRef: grouped.investigationRef,
    request: { kind: "points", timesMs: times }, deduplicate: true });
  assert.equal(recovered.stateSummary.visual.exactPoints, 4);
});
