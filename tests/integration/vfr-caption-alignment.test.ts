import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openUrma } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { deterministicRequestKey } from "../../src/core/request-key.js";
import { runChecked } from "../../src/subprocess/runner.js";
import { vttForSegments } from "../support/source-fixture.js";

const pointsMs = [0, 120, 800, 1_520, 1_560, 2_800, 4_000];
const colors = {
  red: [230, 20, 20], green: [20, 230, 20], blue: [20, 20, 230],
  yellow: [230, 230, 20], magenta: [230, 20, 230],
  cyan: [20, 230, 230], white: [230, 230, 230],
} as const;

async function fixture(t: test.TestContext, offsetSeconds: number) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "urma-vfr-captions-"));
  let app: Awaited<ReturnType<typeof openUrma>> | undefined;
  t.after(async () => {
    try {
      app?.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  const raw = Buffer.concat(Object.values(colors).map((color) => {
    const frame = Buffer.alloc(96 * 64 * 3);
    for (let index = 0; index < frame.length; index += 3) frame.set(color, index);
    return frame;
  }));
  const input = path.join(directory, "frames.rgb");
  const mp4 = path.join(directory, "fixture.mp4");
  await writeFile(input, raw);
  const expression = pointsMs.reduceRight(
    (rest, point, index) => `if(eq(N,${index}),${point},${rest})`, "0",
  );
  await runChecked("ffmpeg", [
    "-v", "error", "-f", "rawvideo", "-pixel_format", "rgb24",
    "-video_size", "96x64", "-framerate", "1000", "-i", input,
    "-vf", `settb=1/1000,setpts='${expression}'`, "-fps_mode", "vfr",
    "-c:v", "libx264", "-crf", "0", "-g", "1", "-bf", "0",
    "-pix_fmt", "yuv420p", "-video_track_timescale", "1000", "-y", mp4,
  ], { timeoutMs: 30_000 });
  let video = mp4;
  if (offsetSeconds !== 0) {
    video = path.join(directory, "fixture.ts");
    await runChecked("ffmpeg", [
      "-v", "error", "-i", mp4, "-c", "copy",
      "-output_ts_offset", String(offsetSeconds), "-muxdelay", "0", "-y", video,
    ], { timeoutMs: 30_000 });
  }
  const probed = await runChecked("ffprobe", [
    "-v", "error", "-select_streams", "v:0", "-show_frames",
    "-show_entries", "format=start_time:frame=best_effort_timestamp_time",
    "-of", "json", video,
  ], { timeoutMs: 30_000 });
  const probe = JSON.parse(probed.stdout.toString("utf8")) as {
    format: { start_time: string };
    frames: { best_effort_timestamp_time: string }[];
  };
  assert.equal(Number(probe.format.start_time), offsetSeconds);
  assert.deepEqual(
    probe.frames.map((frame) => Math.round(Number(frame.best_effort_timestamp_time) * 1_000)),
    pointsMs.map((point) => point + offsetSeconds * 1_000),
    "fixture must retain its irregular presentation timestamps",
  );
  await writeFile(path.join(directory, "fixture.vtt"), vttForSegments([
    { startMs: 800, endMs: 1_520, text: "blue event" },
    { startMs: 1_520, endMs: 1_560, text: "yellow event" },
  ]));
  const config = loadConfig({
    URMA_DATA_DIR: path.join(directory, "data"), URMA_LOCAL_ROOTS: directory,
  });
  app = await openUrma(config);
  return {
    app, video, directory,
    async reopen() {
      app!.close();
      app = undefined;
      app = await openUrma(config);
      return app;
    },
  };
}

test("older local frame caches cannot override a caption-aligned VFR extraction", async (t) => {
  const ctx = await fixture(t, 7);
  const inspected = await ctx.app.evidence.inspectVideo({ source: ctx.video });
  const legacyJpeg = path.join(ctx.directory, "legacy.jpg");
  // The old origin subtraction clamped a request for 800ms to this opening frame.
  await runChecked("ffmpeg", [
    "-v", "error", "-i", ctx.video, "-frames:v", "1",
    "-pix_fmt", "yuvj420p", "-q:v", "2", "-y", legacyJpeg,
  ], { timeoutMs: 30_000 });
  await assertColor(legacyJpeg, colors.red, "legacy cache seed");
  const blob = await ctx.app.blobs.put(await readFile(legacyJpeg));
  ctx.app.store.putArtifact({
    artifactId: blob.artifactId, sourceRef: inspected.sourceRef,
    sourceRevision: inspected.source.snapshotRevision, kind: "frame", role: "evidence",
    mimeType: "image/jpeg", sha256: blob.sha256, byteSize: blob.byteSize,
    blobPath: blob.relativePath, startMs: 800, endMs: 800,
    params: { atMs: 800, format: "jpeg" }, producer: { version: "frame-extractor-v2" },
    createdAt: new Date(0).toISOString(),
  }, {
    requestKey: deterministicRequestKey(
      inspected.source.snapshotRevision, "frame",
      { sourceRef: inspected.sourceRef, atMs: 800, format: "jpeg" }, "frame-extractor-v2",
    ),
    operation: "frame",
  });
  const result = await ctx.app.evidence.getFrames({
    investigationRef: inspected.investigationRef, request: { kind: "points", timesMs: [800] },
  });
  assert("frames" in result);
  const frame = result.frames[0];
  assert(frame);
  assert.equal(frame.cacheHit, false);
  assert.notEqual(frame.artifactId, blob.artifactId);
  const artifact = ctx.app.store.listArtifacts(inspected.sourceRef, inspected.source.snapshotRevision)
    .find((item) => item.artifactId === frame.artifactId);
  assert(artifact);
  assert.equal(artifact.producer.version, "local-frame-extractor-v3");
  await assertColor(ctx.app.blobs.pathForHash(artifact.sha256), colors.blue, "recomputed caption frame");
  await ctx.app.blobs.verify(blob.artifactId, blob.relativePath);
});

async function assertColor(
  jpeg: string,
  expected: readonly number[],
  label: string,
): Promise<void> {
  // Decode pixels only: the oracle performs no timestamp seeking.
  const decoded = await runChecked("ffmpeg", [
    "-v", "error", "-i", jpeg, "-vf", "scale=1:1,format=rgb24",
    "-frames:v", "1", "-f", "rawvideo", "pipe:1",
  ], { timeoutMs: 30_000 });
  assert.equal(decoded.stdout.length, 3);
  assert(
    expected.every((channel, index) => Math.abs(decoded.stdout[index]! - channel) <= 12),
    `${label}: expected RGB near ${expected}, got ${[...decoded.stdout]}`,
  );
}

for (const offsetSeconds of [0, 7]) {
  test(`VFR caption events select the correct images before, at, and after boundaries with container origin ${offsetSeconds}s`, async (t) => {
    const ctx = await fixture(t, offsetSeconds);
    const inspected = await ctx.app.evidence.inspectVideo({ source: ctx.video });
    const ref = inspected.investigationRef;
    const blue = await ctx.app.evidence.searchTranscript({ investigationRef: ref, query: "blue event" });
    const yellow = await ctx.app.evidence.searchTranscript({ investigationRef: ref, query: "yellow event" });
    assert.equal(blue.hits[0]?.startMs, 800);
    assert.equal(yellow.hits[0]?.startMs, 1_520);
    const targets = [
      blue.hits[0]!.startMs - 1, blue.hits[0]!.startMs, blue.hits[0]!.startMs + 1,
      yellow.hits[0]!.startMs - 1, yellow.hits[0]!.startMs, yellow.hits[0]!.startMs + 1,
    ];
    // First-at-or-after selection can advance to the next scene between frames.
    const expected = [colors.blue, colors.blue, colors.yellow,
      colors.yellow, colors.yellow, colors.magenta];
    const request = { investigationRef: ref, request: { kind: "points" as const, timesMs: targets } };
    const fresh = await ctx.app.evidence.getFrames(request);
    assert("frames" in fresh);
    assert.deepEqual(fresh.frames.map((frame) => frame.atMs), targets);
    for (const [index, frame] of fresh.frames.entries()) {
      const artifact = ctx.app.store.listArtifacts(inspected.sourceRef, inspected.source.snapshotRevision)
        .find((item) => item.artifactId === frame.artifactId);
      assert(artifact);
      await assertColor(ctx.app.blobs.pathForHash(artifact.sha256), expected[index]!, `target ${frame.atMs}ms`);
      assert.equal(frame.cacheHit, false);
    }
    const reopened = await ctx.reopen();
    const cached = await reopened.evidence.getFrames(request);
    assert("frames" in cached);
    assert(cached.frames.every((frame) => frame.cacheHit));
    assert.deepEqual(
      cached.frames.map((frame) => frame.artifactId),
      fresh.frames.map((frame) => frame.artifactId),
    );
    const unseen = await reopened.evidence.getFrames({
      investigationRef: ref, request: { kind: "points", timesMs: [2_800] },
    });
    assert("frames" in unseen);
    const unseenFrame = unseen.frames[0];
    assert(unseenFrame);
    assert.equal(unseenFrame.cacheHit, false);
    const artifact = reopened.store.listArtifacts(inspected.sourceRef, inspected.source.snapshotRevision)
      .find((item) => item.artifactId === unseenFrame.artifactId);
    assert(artifact);
    await assertColor(reopened.blobs.pathForHash(artifact.sha256), colors.cyan, "new target after reopening");
  });
}
