import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client, InMemoryTransport, type CallToolResult } from "@modelcontextprotocol/client";
import { openUrma } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { buildMcpServer } from "../../src/mcp/server.js";
import { type DiscoveryResult } from "../../src/acquisition/discovery.js";
import type { VisualAnalyzer } from "../../src/acquisition/visual-analysis.js";
import { runChecked } from "../../src/subprocess/runner.js";
import { parseInvestigationRef } from "../../src/core/ids.js";
import { createInvestigationRef, remoteSourceRef, youtubeRemoteIdentity } from "../../src/core/ids.js";
import { parseVideoStreamCoverage, serializeVideoPtsCoverage } from "../../src/acquisition/video-timing.js";
import { Ffprobe } from "../../src/subprocess/ffprobe.js";
import type { ResolvedSource } from "../../src/sources/types.js";
import { putTestSource } from "../support/source-fixture.js";

const timesMs = [0, 120, 500, 920, 960, 1400, 2200, 2600];
async function fixture(t: test.TestContext, offset = 0, rotation = 0, sar = "1/1") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "urma-visual-discovery-"));
  const input = path.join(directory, "input.rgb"), base = path.join(directory, "base.mp4");
  const rgb = timesMs.map((_, index) => {
    const image = Buffer.alloc(128 * 72 * 3);
    const color = index < 3 ? [70, 70, 70] : index < 6 ? [20, 20, 220] : [20, 220, 20];
    for (let pixel = 0; pixel < image.length; pixel += 3) image.set(color, pixel);
    if (index === 4) for (const [x, y] of [[8, 8], [100, 52]]) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      image.set([255, 255, 255], (((y! + dy) * 128) + x! + dx) * 3);
    }
    return image;
  });
  await writeFile(input, Buffer.concat(rgb));
  const pts = timesMs.reduceRight((rest, time, index) => `if(eq(N,${index}),${time},${rest})`, "0");
  await runChecked("ffmpeg", ["-v", "error", "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", "128x72",
    "-framerate", "1000", "-i", input, "-vf", `settb=1/1000,setpts='${pts}',setsar=${sar}`,
    "-fps_mode", "vfr", "-c:v", "libx264", "-crf", "0", "-g", "999", "-sc_threshold", "0", "-bf", "0",
    "-pix_fmt", "yuv420p", "-video_track_timescale", "1000", "-y", base], { timeoutMs: 30_000 });
  const video = path.join(directory, "fixture.mp4");
  await runChecked("ffmpeg", ["-v", "error", "-display_rotation:v:0", String(rotation), "-i", base,
    "-c", "copy", "-output_ts_offset", String(offset), "-y", video], { timeoutMs: 30_000 });
  const config = loadConfig({ URMA_DATA_DIR: path.join(directory, "data"), URMA_LOCAL_ROOTS: directory });
  const app = await openUrma(config);
  const server = buildMcpServer(app.evidence, app.store, app.blobs, app.config);
  const client = new Client({ name: "visual-discovery-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  t.after(async () => { await client.close(); await server.close(); app.close(); await rm(directory, { recursive: true, force: true }); });
  const inspection = await app.evidence.inspectVideo({ source: video });
  return { app, client, inspection, directory, video };
}
type Hints = Awaited<ReturnType<VisualAnalyzer["hints"]>>;
type Output = { discovery: DiscoveryResult; diffHints: Hints; frames: { atMs: number; artifactId: string }[];
  samplingGaps: { timestampBasis: string }; investigationRef: string };
function structured(result: CallToolResult): Output {
  assert(!result.isError, JSON.stringify(result.content));
  assert(result.structuredContent);
  return result.structuredContent as unknown as Output;
}

for (const offset of [0, 7]) test(`non-keyframe transitions retain VFR timing with source origin ${offset}s`, async (t) => {
  const { app, client, inspection, video } = await fixture(t, offset);
  const keyframes = await runChecked("ffprobe", ["-v", "error", "-select_streams", "v:0", "-skip_frame", "nokey",
    "-show_entries", "frame=pts_time", "-of", "json", video], { timeoutMs: 30_000 });
  assert.equal((JSON.parse(keyframes.stdout.toString()) as { frames: unknown[] }).frames.length, 1, "long-GOP fixture has only one keyframe");
  const args = { investigationRef: inspection.investigationRef, request: { kind: "discover", budget: 2, maxFrames: 24 } };
  const response = structured(await client.callTool({ name: "get_frames", arguments: args }));
  assert.deepEqual(response.frames.map((frame) => frame.atMs), [920, 2200]);
  assert.deepEqual(response.discovery.presentationTimesMs, timesMs);
  assert.equal(response.discovery.fineFrameCount, 8);
  assert.equal(response.discovery.semanticInterpretation, false);
  assert.equal(response.discovery.provenance.selectedFramePtsAvailable, false);
  assert.equal(response.discovery.sourceRef, inspection.sourceRef);
  assert.equal(response.discovery.sourceRevision, inspection.source.snapshotRevision);
  assert.equal(response.discovery.scanSamplingGaps.timestampBasis, "decoded-presentation-floor-ms");
  assert.equal(response.samplingGaps.timestampBasis, "requested");
  assert.equal(app.evidence.state(inspection.investigationRef).evidence.exactVisualPoints.length, 2, "scan-only RGB frames are not presented observations");
  const again = structured(await client.callTool({ name: "get_frames", arguments: { ...args, deduplicate: true } }));
  assert.deepEqual(again.discovery, response.discovery);
  assert.deepEqual(again.frames.map((frame) => [frame.atMs, frame.artifactId]), response.frames.map((frame) => [frame.atMs, frame.artifactId]));
  const assisted = structured(await client.callTool({ name: "get_frames", arguments: {
    ...args, request: { ...args.request, keyframeAssist: true },
  } }));
  assert.equal(assisted.discovery.keyframeAssisted, true);
  assert.deepEqual(assisted.discovery.candidates.map((candidate) => candidate.requestedAtMs), [920, 2200]);
  assert(assisted.discovery.fineFrameCount > assisted.discovery.coarsePresentationTimesMs.length);
  const limited = structured(await client.callTool({ name: "get_frames", arguments: {
    ...args, request: { kind: "discover", budget: 1, maxFrames: 4, maxScanMs: 2000 },
  } }));
  assert(limited.discovery.decodedAnalysisFrames <= 4);
  assert.equal(limited.discovery.frameLimitReached, true);
  assert.equal(limited.discovery.rangeLimited, true);
  assert.deepEqual(limited.frames.map((frame) => frame.atMs), [920]);
  t.diagnostic(`Known large-transition recall: ${response.frames.length}/2 with ${response.discovery.decodedAnalysisFrames} RGB frames; ${limited.frames.length}/2 with ${limited.discovery.decodedAnalysisFrames} RGB frames under the four-frame cap`);
  assert(limited.discovery.scanSamplingGaps.largestGaps.some((gap) => gap.startMs === 920 && gap.endMs === inspection.source.durationMs));
  const scoped = structured(await client.callTool({ name: "get_frames", arguments: {
    ...args, request: { kind: "discover", startMs: 500, endMs: 2400, budget: 2, maxFrames: 24 },
  } }));
  assert.deepEqual(scoped.frames.map((frame) => frame.atMs), [920, 2200]);
});

test("diff hints retain scattered tiny UI events, reuse canonical RGB data, and map crop boxes to source coordinates", async (t) => {
  const { app, client, inspection } = await fixture(t);
  const args = { investigationRef: inspection.investigationRef, request: { kind: "points", timesMs: [920, 960] }, diffHints: true };
  const result = structured(await client.callTool({ name: "get_frames", arguments: args }));
  assert.equal(result.diffHints.comparisons.length, 1);
  const comparison = result.diffHints.comparisons[0]!;
  assert.equal(comparison.status, "analyzed");
  assert.equal(comparison.coordinateSpace, "individual-displayed-source");
  assert.equal(comparison.delta?.regions.length, 2, JSON.stringify(comparison.delta));
  assert(comparison.delta!.changedPixelRatio > 0 && comparison.delta!.changedPixelRatio < .01);
  t.diagnostic(`Tiny UI fixture: 8 source pixels (${(8 / (128 * 72) * 100).toFixed(3)}%); canonical JPEG analysis marks ${(comparison.delta!.changedPixelRatio * 100).toFixed(3)}% across ${comparison.delta!.regions.length} regions`);
  assert.equal(comparison.delta!.analysis.width, 128);
  assert.equal(comparison.delta!.analysis.height, 72);
  assert.equal(result.diffHints.decodedFrames, 2);
  const repeat = structured(await client.callTool({ name: "get_frames", arguments: args }));
  assert.equal(repeat.diffHints.decodedFrames, 0);
  assert.equal(repeat.diffHints.cacheHits, 2);
  assert.deepEqual(repeat.diffHints.comparisons, result.diffHints.comparisons);
  const cropped = structured(await client.callTool({ name: "get_frames", arguments: {
    ...args, crop: { x: 50, y: 0, w: 50, h: 100 }, presentation: "panel", rulers: true,
  } }));
  assert.equal(cropped.diffHints.comparisons[0]?.delta?.regions.length, 1);
  assert(cropped.diffHints.comparisons[0]!.delta!.regions[0]!.x >= 50);
  const region = cropped.diffHints.comparisons[0]!.delta!.regions[0]!;
  assert(region.suggestedCrop && region.suggestedCrop.x >= 50);
  assert(region.suggestedCrop.x <= region.x && region.suggestedCrop.y <= region.y);
  assert(region.suggestedCrop.w >= region.w && region.suggestedCrop.h >= region.h);
  assert.equal(app.evidence.state(inspection.investigationRef).evidence.exactVisualPoints.length, 6);
});

test("long static VFR holds do not produce synthetic scan frames or consume the fine-frame budget", async (t) => {
  const { app, directory, video } = await fixture(t);
  const held = path.join(directory, "static-hold.mp4");
  await runChecked("ffmpeg", ["-v", "error", "-i", video, "-vf", "settb=1/1000,setpts='if(eq(N,0),0,8000+(N-1)*10)'",
    "-fps_mode", "passthrough", "-c:v", "libx264", "-crf", "0", "-g", "999", "-bf", "0", "-enc_time_base:v", "1/1000", "-video_track_timescale", "1000", "-y", held], { timeoutMs: 30_000 });
  const inspected = await app.evidence.inspectVideo({ source: held });
  const output = await app.evidence.getFrames({ investigationRef: inspected.investigationRef,
    request: { kind: "discover", budget: 2, maxFrames: 24 } });
  assert(output.discovery);
  assert.equal(output.discovery.decodedAnalysisFrames, 8);
  assert.deepEqual(output.discovery.presentationTimesMs, [0, 8000, 8010, 8020, 8030, 8040, 8050, 8060]);
  assert.deepEqual(output.frames?.map((frame) => frame.atMs), [8020, 8050]);
  assert.equal(output.discovery.frameLimitReached, false);
});

test("portrait/SAR discovery uses displayed aspect ratio and only returns discrete evidence", async (t) => {
  const { client, inspection } = await fixture(t, 7, 90, "3/2");
  const result = structured(await client.callTool({ name: "get_frames", arguments: {
    investigationRef: inspection.investigationRef, request: { kind: "discover", budget: 2, maxFrames: 24 }, diffHints: true,
  } }));
  const { width, height, aspectRatioError } = result.discovery.analysis;
  assert.equal(width % 4, 0); assert.equal(height % 4, 0);
  assert(width < height && width <= 256 && height <= 144);
  assert(aspectRatioError <= .05);
  assert.deepEqual(result.frames.map((frame) => frame.atMs), [920, 2200]);
  assert.equal(result.diffHints.continuousObservation, false);
});

test("no-transition scans do not add observations and malformed budgets are rejected", async (t) => {
  const { app, client, inspection } = await fixture(t);
  const result = structured(await client.callTool({ name: "get_frames", arguments: {
    investigationRef: inspection.investigationRef, request: { kind: "discover", startMs: 0, endMs: 500, budget: 2, maxFrames: 24 },
  } }));
  assert.deepEqual(result.frames, []);
  assert.equal(app.evidence.state(inspection.investigationRef).evidence.exactVisualPoints.length, 0);
  for (const request of [{ kind: "discover", budget: 0 }, { kind: "discover", budget: 1, maxFrames: 241 },
    { kind: "discover", budget: 1, maxScanMs: 30001 }, { kind: "discover", budget: 1, minChangedRatio: 0 }]) {
    const rejected = await client.callTool({ name: "get_frames", arguments: { investigationRef: inspection.investigationRef, request } });
    assert.equal(rejected.isError, true);
  }
  assert.equal(parseInvestigationRef(result.investigationRef), inspection.investigationRef);
});

test("cached remote sections map container-relative scan PTS back to source time without a new acquisition", async (t) => {
  const { app, video } = await fixture(t, 7);
  const local = (await app.evidence.resolver.resolve(video)).source;
  const identity = youtubeRemoteIdentity("yP0axVHdP-U"), sourceRef = remoteSourceRef(identity);
  const revision = "remote-discovery-fixture";
  const source: ResolvedSource = { ...local, sourceRef, kind: "remote", identity, revision,
    snapshotRef: { sourceRef, revision }, durationMs: 12000, canonicalKey: "yP0axVHdP-U", safeMetadata: {},
    formats: [{ id: "hls", ext: "mp4", protocol: "m3u8_native", width: 128, height: 72, fps: null,
      videoCodec: "h264", audioCodec: "none", estimatedBytes: null, rows: null, columns: null }],
  };
  putTestSource(app.store, { sourceRef, kind: "remote", canonicalKey: "yP0axVHdP-U", revision,
    title: "Remote section", durationMs: 12000, metadata: {} });
  const investigationRef = createInvestigationRef(), now = new Date(0).toISOString();
  app.store.createInvestigation({ investigationRef, sourceRef, sourceRevision: revision, durationMs: 12000, createdAt: now, updatedAt: now });
  const probe = await new Ffprobe(app.config).inspect(video);
  const coverage = parseVideoStreamCoverage((probe.streams as Record<string, unknown>[])[0]!, (probe.format as Record<string, unknown>).start_time);
  assert(coverage);
  const blob = await app.blobs.putFile(video);
  app.store.putArtifact({ artifactId: blob.artifactId, sourceRef, sourceRevision: revision,
    kind: "media_section", role: "transport", mimeType: "video/mp4", sha256: blob.sha256,
    byteSize: blob.byteSize, blobPath: blob.relativePath, startMs: 1000, endMs: 12000,
    params: {}, producer: { version: "bounded-section", ...serializeVideoPtsCoverage(coverage) }, createdAt: now });
  t.mock.method(app.evidence.frames.media, "section", async () => { throw new Error("Validated cached section must be reused"); });
  const result = await app.evidence.discovery.get(source, investigationRef,
    { kind: "discover", startMs: 8000, endMs: 10601, budget: 2, maxFrames: 24 });
  assert.deepEqual(result.candidates.map((candidate) => candidate.requestedAtMs), [8920, 10200]);
  assert.deepEqual(result.presentationTimesMs, timesMs.map((time) => time + 8000));
  assert.equal(result.provenance.transportArtifactId, blob.artifactId);
  assert.equal(result.sourceRef, sourceRef); assert.equal(result.sourceRevision, revision);
  assert.equal(app.evidence.state(investigationRef).evidence.exactVisualPoints.length, 0);
});

test("keyframe scouting restricts a fine window but never returns an unconfirmed coarse transition", async (t) => {
  const { app, client, directory, video } = await fixture(t);
  const keyed = path.join(directory, "keyed.mp4");
  await runChecked("ffmpeg", ["-v", "error", "-i", video, "-c:v", "libx264", "-crf", "0", "-bf", "0",
    "-force_key_frames", "0,1.4,2.2", "-fps_mode", "vfr", "-y", keyed], { timeoutMs: 30_000 });
  const inspected = await app.evidence.inspectVideo({ source: keyed });
  const result = structured(await client.callTool({ name: "get_frames", arguments: {
    investigationRef: inspected.investigationRef,
    request: { kind: "discover", budget: 4, maxFrames: 24, keyframeAssist: true },
  } }));
  assert(result.discovery.coarsePresentationTimesMs.length >= 2);
  assert(result.discovery.fineFrameCount >= 2);
  assert.equal(result.discovery.rangeLimited, true);
  assert(result.discovery.candidates.length > 0);
  for (const candidate of result.discovery.candidates) {
    assert(result.discovery.presentationTimesMs.includes(candidate.observedPresentationTimeMs));
    assert(result.discovery.presentationTimesMs.includes(candidate.comparedFromPresentationTimeMs));
  }
});
