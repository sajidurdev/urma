import { putTestSource } from "../support/source-fixture.js";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FrameAcquirer } from "../../src/acquisition/frames.js";
import { MediaAcquirer } from "../../src/acquisition/media.js";
import { loadConfig } from "../../src/config.js";
import {
  createInvestigationRef,
  localSourceRef,
  remoteSourceRef,
  youtubeRemoteIdentity,
} from "../../src/core/ids.js";
import { UrmaError } from "../../src/core/errors.js";
import type { ResolvedSource } from "../../src/sources/types.js";
import {
  isTimestampCovered,
  parseStoredBoundedVideoCoverage,
  parseStoredVideoCoverage,
  parseVideoStreamCoverage,
  physicalSeekMs,
  serializeVideoPtsCoverage,
} from "../../src/acquisition/video-timing.js";
import { Ffmpeg } from "../../src/subprocess/ffmpeg.js";
import { Ffprobe } from "../../src/subprocess/ffprobe.js";
import { type ProcessResult, runChecked } from "../../src/subprocess/runner.js";
import { BlobStore } from "../../src/store/blob-store.js";
import type { StoredArtifact } from "../../src/store/store.js";
import { SqliteStore } from "../../src/store/sqlite-store.js";

const SECTION_PREFIX = "URMA_SECTION\t";

function source(
  durationMs = 10_000,
  estimatedBytes: number | null = null,
): ResolvedSource {
  const videoId = "yP0axVHdP-U";
  return {
    sourceRef: remoteSourceRef(youtubeRemoteIdentity(videoId)),
    kind: "remote",
    identity: { basis: "extractor", namespace: "youtube", id: videoId },
    snapshotRef: {
      sourceRef: remoteSourceRef(youtubeRemoteIdentity(videoId)),
      revision: `v1:test:${videoId}`,
    },
    canonicalKey: videoId,
    canonicalLocator: `https://www.youtube.com/watch?v=${videoId}`,
      revision: `v1:test:${videoId}`,
    observedAt: new Date(0).toISOString(),
    title: "PTS fixture",
    durationMs,
    metadataDurationMs: durationMs,
    timeline: {
      finite: true,
      durationMs,
      basis: "container",
      validatedAt: new Date(0).toISOString(),
    },
    extractor: "youtube",
    extractorKey: videoId,
    liveState: "finite",
    safeOrigins: ["https://www.youtube.com"],
    resolverVersion: "fixture",
    normalizationVersion: "remote-normalization-v1",
    policyVersion: "fixture",
    chapters: [],
    captionTracks: [],
    formats: [
      {
        id: "hls",
        ext: "mp4",
        protocol: "m3u8_native",
        width: 320,
        height: 180,
        fps: 2,
        videoCodec: "h264",
        audioCodec: "none",
        estimatedBytes,
        rows: null,
        columns: null,
      },
    ],
    capabilities: {
      nativeCaptions: false,
      chapters: false,
      nativeStoryboard: false,
      targetedMedia: true,
      audio: false,
    },
    safeMetadata: {},
  };
}

function processResult(
  args: readonly string[],
  stdout = "",
  code = 0,
): ProcessResult {
  return {
    executable: "fake-yt-dlp",
    args,
    code,
    stdout: Buffer.from(stdout),
    stderr: Buffer.alloc(0),
    wallMs: 1,
  };
}

function rangeArguments(
  args: readonly string[],
): Array<{ startMs: number; endMs: number }> {
  const ranges: Array<{ startMs: number; endMs: number }> = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--download-sections") continue;
    const match = /^\*([0-9]+(?:\.[0-9]+)?)-([0-9]+(?:\.[0-9]+)?)$/u.exec(
      String(args[index + 1]),
    );
    assert(match, `invalid section argument ${String(args[index + 1])}`);
    ranges.push({
      startMs: Math.round(Number(match[1]) * 1_000),
      endMs: Math.round(Number(match[2]) * 1_000),
    });
  }
  return ranges;
}

function emission(startMs: number, endMs: number, filepath: string): string {
  return `${SECTION_PREFIX}${JSON.stringify(startMs / 1_000)}\t${
    JSON.stringify(endMs / 1_000)
  }\t${JSON.stringify(filepath)}`;
}

async function fixture(t: test.TestContext, durationMs = 10_000) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "urma-pts-aware-"));
  const config = loadConfig({
    URMA_DATA_DIR: path.join(directory, "data"),
    URMA_FFMPEG: "ffmpeg",
    URMA_FFPROBE: "ffprobe",
    URMA_YTDLP: "fake-yt-dlp",
    URMA_DEBUG: "0",
  });
  const store = await SqliteStore.open(path.join(config.dataDir, "urma.db"));
  const blobs = new BlobStore(path.join(config.dataDir, "blobs"));
  await blobs.initialize();
  const ref = createInvestigationRef("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
  const resolved = source(durationMs);
  const now = new Date(0).toISOString();
  putTestSource(store, {
    sourceRef: resolved.sourceRef,
    kind: resolved.kind,
    canonicalKey: resolved.canonicalKey,
    revision: resolved.revision,
    title: resolved.title,
    durationMs: resolved.durationMs,
    metadata: {},
  });
  store.createInvestigation({
    investigationRef: ref,
    sourceRef: resolved.sourceRef,
    sourceRevision: resolved.revision,
    durationMs: resolved.durationMs,
    createdAt: now,
    updatedAt: now,
  });
  const full = path.join(directory, "full.mp4");
  await runChecked(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=320x180:rate=2:duration=10",
      "-c:v",
      "libx264",
      "-g",
      "1",
      "-bf",
      "0",
      "-pix_fmt",
      "yuv420p",
      "-video_track_timescale",
      "90000",
      "-y",
      full,
    ],
    { timeoutMs: 30_000 },
  );
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, config, store, blobs, ref, resolved, full };
}

function copyingDownloader(
  ctx: Awaited<ReturnType<typeof fixture>>,
  bounded: string,
  reusable = ctx.full,
) {
  const calls: string[][] = [];
  const downloader = {
    run: async (args: readonly string[]) => {
      calls.push([...args]);
      const outputDirectory = String(args[args.indexOf("--paths") + 1]);
      const ranges = rangeArguments(args);
      if (ranges.length === 0) {
        await copyFile(reusable, path.join(outputDirectory, "media.mp4"));
        return processResult(args);
      }
      if (ranges.length === 1 && !args.includes("--print")) {
        await copyFile(bounded, path.join(outputDirectory, "media.mp4"));
        return processResult(args);
      }
      const lines: string[] = [];
      for (const range of ranges) {
        const filepath = path.join(
          outputDirectory,
          `media-${(range.startMs / 1_000).toFixed(3)}-${
            (range.endMs / 1_000).toFixed(3)
          }.mp4`,
        );
        await copyFile(bounded, filepath);
        lines.push(emission(range.startMs, range.endMs, filepath));
      }
      return processResult(args, `${lines.join("\n")}\n`);
    },
  };
  return { calls, downloader };
}

async function makeShortVideo(
  ctx: Awaited<ReturnType<typeof fixture>>,
  durationSeconds: number,
): Promise<string> {
  const output = path.join(ctx.directory, `short-${durationSeconds}.mp4`);
  await runChecked(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `testsrc=size=320x180:rate=2:duration=${durationSeconds}`,
      "-c:v",
      "libx264",
      "-g",
      "1",
      "-bf",
      "0",
      "-pix_fmt",
      "yuv420p",
      "-video_track_timescale",
      "90000",
      "-y",
      output,
    ],
    { timeoutMs: 30_000 },
  );
  return output;
}

async function makeOffsetSection(
  ctx: Awaited<ReturnType<typeof fixture>>,
  input: string,
  offsetSeconds: number,
): Promise<string> {
  const output = path.join(ctx.directory, `offset-${offsetSeconds}.mp4`);
  await runChecked(
    "ffmpeg",
    [
      "-v",
      "error",
      "-itsoffset",
      offsetSeconds.toFixed(3),
      "-i",
      input,
      "-c",
      "copy",
      "-avoid_negative_ts",
      "disabled",
      "-y",
      output,
    ],
    { timeoutMs: 30_000 },
  );
  return output;
}

async function makeZeroStreamSection(
  ctx: Awaited<ReturnType<typeof fixture>>,
  name: string,
): Promise<string> {
  const output = path.join(ctx.directory, `${name}.mp4`);
  await runChecked(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=320x180:rate=2:duration=1",
      "-t",
      "0",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-y",
      output,
    ],
    { timeoutMs: 30_000 },
  );
  return output;
}

async function makeShiftedSameCodecSection(
  ctx: Awaited<ReturnType<typeof fixture>>,
): Promise<string> {
  const segment = path.join(ctx.directory, "same-codec-segment.mp4");
  const shifted = path.join(ctx.directory, "same-codec-shifted-section.mp4");
  await runChecked(
    "ffmpeg",
    [
      "-v",
      "error",
      "-ss",
      "3.664",
      "-i",
      ctx.full,
      "-t",
      "4",
      "-c",
      "copy",
      "-avoid_negative_ts",
      "disabled",
      "-y",
      segment,
    ],
    { timeoutMs: 30_000 },
  );
  await runChecked(
    "ffmpeg",
    [
      "-v",
      "error",
      "-itsoffset",
      "2.164",
      "-i",
      segment,
      "-c",
      "copy",
      "-avoid_negative_ts",
      "disabled",
      "-y",
      shifted,
    ],
    { timeoutMs: 30_000 },
  );
  return shifted;
}

async function makeTailSection(
  ctx: Awaited<ReturnType<typeof fixture>>,
): Promise<string> {
  const output = path.join(ctx.directory, "tail-section.mp4");
  await runChecked(
    "ffmpeg",
    [
      "-v",
      "error",
      "-ss",
      "7.5",
      "-i",
      ctx.full,
      "-t",
      "2.5",
      "-c",
      "copy",
      "-avoid_negative_ts",
      "disabled",
      "-y",
      output,
    ],
    { timeoutMs: 30_000 },
  );
  return output;
}

async function canonicalFrame(
  ctx: Awaited<ReturnType<typeof fixture>>,
  atMs: number,
  name: string,
): Promise<Buffer> {
  const output = path.join(ctx.directory, `${name}.jpg`);
  const ffmpeg = new Ffmpeg(ctx.config);
  await ffmpeg.extractJpeg(ctx.full, atMs, output);
  await ffmpeg.validateJpeg(output);
  return await readFile(output);
}

async function storedTransport(
  ctx: Awaited<ReturnType<typeof fixture>>,
  file: string,
  values: {
    startMs: number;
    endMs: number;
    version: "bounded-section";
    producer?: Readonly<Record<string, unknown>>;
  },
): Promise<StoredArtifact> {
  const blob = await ctx.blobs.putFile(file);
  const artifact: StoredArtifact = {
    artifactId: blob.artifactId,
    sourceRef: ctx.resolved.sourceRef,
    sourceRevision: ctx.resolved.revision,
    kind: "media_section",
    role: "transport",
    mimeType: "video/mp4",
    sha256: blob.sha256,
    byteSize: blob.byteSize,
    blobPath: blob.relativePath,
    startMs: values.startMs,
    endMs: values.endMs,
    params: {
      formatId: "hls",
      fidelity: "evidence",
      requestedStartMs: values.startMs,
      requestedEndMs: values.endMs,
    },
    producer: {
      version: values.version,
      validatedVideoTimingVersion: 2,
      ...(values.producer ?? {}),
    },
    createdAt: new Date().toISOString(),
  };
  ctx.store.putArtifact(artifact);
  return artifact;
}

async function pinnedLocalVideo(
  ctx: Awaited<ReturnType<typeof fixture>>,
  file: string,
  revision: string,
  sourceRef = ctx.resolved.sourceRef,
): Promise<ResolvedSource> {
  const blob = await ctx.blobs.putFile(file);
  const probe = await new Ffprobe(ctx.config).inspect(file);
  const streams = Array.isArray(probe.streams)
    ? (probe.streams as Array<Record<string, unknown>>)
    : [];
  const video = streams.find((stream) => stream.codec_type === "video");
  assert(video);
  const coverage = parseVideoStreamCoverage(video);
  assert(coverage);
  return {
    ...ctx.resolved,
    kind: "local",
    identity: null,
    sourceRef,
    snapshotRef: { sourceRef, revision },
    canonicalLocator: path.join(ctx.directory, "replaced-local-path.mp4"),
    revision,
    safeMetadata: {
      localSnapshot: {
        version: "local-snapshot-v1",
        video: {
          artifactId: blob.artifactId,
          sha256: blob.sha256,
          byteSize: blob.byteSize,
          blobPath: blob.relativePath,
          extension: null,
        },
        caption: null,
      },
      videoTiming: serializeVideoPtsCoverage(coverage),
    },
  };
}

test("exact-frame extraction uses the first decodable presentation frame at or after the requested timestamp", async (t) => {
  const ctx = await fixture(t);
  const output = path.join(ctx.directory, "first-frame-at-or-after.jpg");
  const ffmpeg = new Ffmpeg(ctx.config);
  await ffmpeg.extractJpeg(ctx.full, 4_250, output);
  await ffmpeg.validateJpeg(output);
  assert.deepEqual(
    await readFile(output),
    await canonicalFrame(ctx, 4_500, "first-frame-canonical"),
  );
  assert.notDeepEqual(
    await readFile(output),
    await canonicalFrame(ctx, 4_000, "previous-frame"),
  );
});

test("bounded PTS coverage includes its start, excludes its end, and preserves the physical offset", () => {
  const coverage = parseStoredBoundedVideoCoverage({
    version: "bounded-section",
    validatedVideoTimingVersion: 2,
    validatedVideoStartPts: "4950",
    validatedVideoEndPts: "184950",
    validatedVideoDurationTs: "180000",
    validatedVideoTimeBase: "1/90000",
  });
  assert(coverage);
  assert.equal(isTimestampCovered(coverage, 54), false);
  assert.equal(isTimestampCovered(coverage, 55), true);
  assert.equal(isTimestampCovered(coverage, 1_055), true);
  assert.equal(isTimestampCovered(coverage, 2_055), false);
  assert.equal(physicalSeekMs(coverage, 1_055), 1_000);
});

test("PTS-aware bounded extraction returns the canonical same-codec frame instead of the silent shifted frame", async (t) => {
  const ctx = await fixture(t);
  const shifted = await makeShiftedSameCodecSection(ctx);
  const transport = copyingDownloader(ctx, shifted);
  const observed = await new FrameAcquirer(
    ctx.config,
    ctx.store,
    ctx.blobs,
    new MediaAcquirer(ctx.config, ctx.store, ctx.blobs, transport.downloader),
  ).get(ctx.resolved, ctx.ref, [4_000]);
  const expected = await canonicalFrame(ctx, 4_000, "canonical-40000");
  const shiftedFrame = await canonicalFrame(ctx, 5_664, "shifted-41664");
  const actual = await ctx.blobs.read(
    observed[0]!.artifact.artifactId,
    observed[0]!.artifact.blobPath,
    8 * 1024 * 1024,
  );
  assert.deepEqual(actual, expected);
  assert.notDeepEqual(actual, shiftedFrame);
  assert.equal(transport.calls.length, 1);
  const section = ctx.store
    .listArtifacts(ctx.resolved.sourceRef, ctx.resolved.revision)
    .find((artifact) => artifact.kind === "media_section");
  assert(section);
  assert.equal(section.startMs, 2_000);
  assert.equal(section.endMs, 6_001);
  assert.equal(section.producer.version, "bounded-section");
  assert.equal(section.producer.validatedVideoStartPts, "149760");
  assert.equal(section.producer.validatedVideoTimeBase, "1/90000");
  assert.equal(Number(section.producer.validatedVideoStart), 1.664);
  assert(Number(section.producer.validatedVideoEnd) > 6);
});

test("fresh reusable evidence maps nonzero PTS to the canonical exact frame", async (t) => {
  const ctx = await fixture(t);
  const shifted = await makeOffsetSection(ctx, ctx.full, 2);
  const nonTargetable = {
    ...ctx.resolved,
    formats: ctx.resolved.formats.map((format) => ({
      ...format,
      protocol: "https",
    })),
    capabilities: { ...ctx.resolved.capabilities, targetedMedia: false },
  };
  const transport = copyingDownloader(ctx, shifted, shifted);
  const observed = await new FrameAcquirer(
    ctx.config,
    ctx.store,
    ctx.blobs,
    new MediaAcquirer(ctx.config, ctx.store, ctx.blobs, transport.downloader),
  ).get(nonTargetable, ctx.ref, [4_000]);
  assert.deepEqual(
    await ctx.blobs.read(
      observed[0]!.artifact.artifactId,
      observed[0]!.artifact.blobPath,
      8 * 1024 * 1024,
    ),
    await canonicalFrame(ctx, 2_000, "reusable-fresh-canonical"),
  );
  assert.deepEqual(
    transport.calls.map((args) => rangeArguments(args).length),
    [0],
  );
  const reusable = ctx.store
    .listArtifacts(ctx.resolved.sourceRef, ctx.resolved.revision)
    .find((artifact) => artifact.kind === "evidence_media");
  assert(reusable);
  assert(parseStoredVideoCoverage(reusable.producer));
});

test("cached reusable evidence maps nonzero PTS and rejects uncovered boundaries", async (t) => {
  const ctx = await fixture(t);
  const shifted = await makeOffsetSection(ctx, ctx.full, 2);
  const nonTargetable = {
    ...ctx.resolved,
    formats: ctx.resolved.formats.map((format) => ({
      ...format,
      protocol: "https",
    })),
    capabilities: { ...ctx.resolved.capabilities, targetedMedia: false },
  };
  const transport = copyingDownloader(ctx, shifted, shifted);
  const media = new MediaAcquirer(
    ctx.config,
    ctx.store,
    ctx.blobs,
    transport.downloader,
  );
  const cached = await media.reusableEvidence(nonTargetable, ctx.ref);
  transport.calls.length = 0;
  const observed = await new FrameAcquirer(
    ctx.config,
    ctx.store,
    ctx.blobs,
    media,
  ).get(nonTargetable, ctx.ref, [4_000]);
  assert.deepEqual(
    await ctx.blobs.read(
      observed[0]!.artifact.artifactId,
      observed[0]!.artifact.blobPath,
      8 * 1024 * 1024,
    ),
    await canonicalFrame(ctx, 2_000, "reusable-cache-canonical"),
  );
  assert.deepEqual(transport.calls, []);
  assert.equal(
    observed[0]!.artifact.producer.transportArtifactId,
    cached.artifact.artifactId,
  );
  const cachedCoverage = parseStoredVideoCoverage(cached.artifact.producer);
  assert(cachedCoverage);
  assert.equal(cachedCoverage.startSeconds, 2);

  const boundary = await new FrameAcquirer(
    ctx.config,
    ctx.store,
    ctx.blobs,
    media,
  ).getOutcomes(nonTargetable, ctx.ref, [0, 10_000]);
  assert.deepEqual(boundary.map((outcome) => outcome.status), ["error", "error"]);
  for (const outcome of boundary) {
    if (outcome.status !== "error") continue;
    assert(outcome.error instanceof UrmaError);
    assert.equal(outcome.error.code, "TARGETED_MEDIA_UNAVAILABLE");
    assert.equal(outcome.error.detail.reason, "reusable-coverage-miss");
  }
});

test("unknown PTS origin fails exact targets instead of becoming zero-origin", async (t) => {
  const ctx = await fixture(t);
  const shifted = await makeOffsetSection(ctx, ctx.full, 2);
  const knownOrigin = {
    codec_type: "video",
    time_base: "1/90000",
    start_pts: "180000",
    duration_ts: "360000",
    start_time: "2.000000",
    duration: "4.000000",
  };
  const knownCoverage = parseVideoStreamCoverage(knownOrigin);
  assert(knownCoverage);
  assert.equal(knownCoverage.startSeconds, 2);
  const missingOrigin = {
    ...knownOrigin,
    start_pts: undefined,
    start_time: undefined,
  };
  assert.equal(parseVideoStreamCoverage(missingOrigin), null);
  assert.match(shifted, /offset-2\.mp4$/u);

  const local = await pinnedLocalVideo(ctx, shifted, ctx.resolved.revision);
  const unavailable = {
    ...local,
    safeMetadata: { ...local.safeMetadata, videoTiming: null },
  };
  const outcomes = await new FrameAcquirer(
    ctx.config,
    ctx.store,
    ctx.blobs,
    new MediaAcquirer(ctx.config, ctx.store, ctx.blobs, {
      run: async () => {
        throw new Error("unknown local timing must not acquire remote media");
      },
    }),
  ).getOutcomes(unavailable, ctx.ref, [0, 4_000]);
  assert.deepEqual(outcomes.map((outcome) => outcome.status), ["error", "error"]);
  for (const outcome of outcomes) {
    if (outcome.status !== "error") continue;
    assert(outcome.error instanceof UrmaError);
    assert.equal(outcome.error.code, "MEDIA_INVALID");
    assert.equal(outcome.error.detail.reason, "local-timing-unavailable");
  }
  assert.equal(
    ctx.store
      .listArtifacts(unavailable.sourceRef, unavailable.revision)
      .filter((artifact) => artifact.kind === "frame").length,
    0,
  );

  const trueZero = parseVideoStreamCoverage({
    codec_type: "video",
    time_base: "1/90000",
    start_pts: "0",
    duration_ts: "360000",
  });
  assert(trueZero);
  assert.equal(trueZero.startSeconds, 0);
});

test("unmarked stored timing is not reusable exact evidence", () => {
  const oldTiming = {
    validatedVideoStart: 0,
    validatedVideoEnd: 4,
    validatedVideoStartPts: "0",
    validatedVideoEndPts: "360000",
    validatedVideoDurationTs: "360000",
    validatedVideoTimeBase: "1/90000",
  };
  assert.equal(parseStoredVideoCoverage(oldTiming), null);
  assert.equal(
    parseStoredBoundedVideoCoverage({
      version: "bounded-section",
      ...oldTiming,
    }),
    null,
  );
});

test("exact-frame cache reuse is source-scoped when local revisions collide", async (t) => {
  const ctx = await fixture(t);
  const sourceA = await pinnedLocalVideo(
    ctx,
    ctx.full,
    ctx.resolved.revision,
    localSourceRef(path.join(ctx.directory, "source-a.mp4")),
  );
  const sourceB = await pinnedLocalVideo(
    ctx,
    ctx.full,
    ctx.resolved.revision,
    localSourceRef(path.join(ctx.directory, "source-b.mp4")),
  );
  assert.notEqual(sourceA.sourceRef, sourceB.sourceRef);
  assert.equal(sourceA.revision, sourceB.revision);
  for (const local of [sourceA, sourceB]) {
    putTestSource(ctx.store, {
      sourceRef: local.sourceRef,
      kind: local.kind,
      canonicalKey: local.canonicalKey,
      revision: local.revision,
      title: local.title,
      durationMs: local.durationMs,
      metadata: {},
    });
  }
  const acquirer = new FrameAcquirer(
    ctx.config,
    ctx.store,
    ctx.blobs,
    new MediaAcquirer(ctx.config, ctx.store, ctx.blobs, {
      run: async () => {
        throw new Error("local exact frames must not acquire remote media");
      },
    }),
  );

  const first = await acquirer.get(sourceA, ctx.ref, [4_000]);
  const repeated = await acquirer.get(sourceA, ctx.ref, [4_000]);
  const second = await acquirer.get(sourceB, ctx.ref, [4_000]);

  assert.equal(first[0]!.cacheHit, false);
  assert.equal(repeated[0]!.cacheHit, true);
  assert.equal(second[0]!.cacheHit, false);
  assert.equal(first[0]!.artifact.artifactId, second[0]!.artifact.artifactId);
  assert.equal(first[0]!.artifact.sourceRef, sourceA.sourceRef);
  assert.equal(second[0]!.artifact.sourceRef, sourceB.sourceRef);
  assert.equal(
    ctx.store.listArtifacts(sourceA.sourceRef, sourceA.revision)
      .filter((artifact) => artifact.kind === "frame").length,
    1,
  );
  assert.equal(
    ctx.store.listArtifacts(sourceB.sourceRef, sourceB.revision)
      .filter((artifact) => artifact.kind === "frame").length,
    1,
  );
});

test("local exact frames use pinned nonzero-PTS timing and fail closed without it", async (t) => {
  const ctx = await fixture(t);
  const shifted = await makeOffsetSection(ctx, ctx.full, 2);
  const local = await pinnedLocalVideo(ctx, shifted, ctx.resolved.revision);
  const observed = await new FrameAcquirer(
    ctx.config,
    ctx.store,
    ctx.blobs,
    new MediaAcquirer(ctx.config, ctx.store, ctx.blobs, {
      run: async () => {
        throw new Error("local exact frames must not acquire remote media");
      },
    }),
  ).get(local, ctx.ref, [4_000]);
  assert.deepEqual(
    await ctx.blobs.read(
      observed[0]!.artifact.artifactId,
      observed[0]!.artifact.blobPath,
      8 * 1024 * 1024,
    ),
    await canonicalFrame(ctx, 2_000, "local-pts-canonical"),
  );

  for (const videoTiming of [
    null,
    {
      validatedVideoStartPts: "invalid",
      validatedVideoEndPts: "invalid",
      validatedVideoDurationTs: "invalid",
      validatedVideoTimeBase: "1/90000",
    },
  ]) {
    const invalid = {
      ...local,
      safeMetadata: { ...local.safeMetadata, videoTiming },
    };
    const outcomes = await new FrameAcquirer(
      ctx.config,
      ctx.store,
      ctx.blobs,
      new MediaAcquirer(ctx.config, ctx.store, ctx.blobs, {
        run: async () => {
          throw new Error("invalid local timing must not acquire remote media");
        },
      }),
    ).getOutcomes(invalid, ctx.ref, [5_000]);
    const outcome = outcomes[0]!;
    assert.equal(outcome.status, "error");
    if (outcome.status !== "error") continue;
    assert(outcome.error instanceof UrmaError);
    assert.equal(outcome.error.code, "MEDIA_INVALID");
    assert.equal(outcome.error.detail.reason, "local-timing-unavailable");
  }
});

test("Twitch-shaped source-start coverage miss is a target failure with no reusable escalation", async (t) => {
  const ctx = await fixture(t);
  const short = await makeShortVideo(ctx, 2);
  const bounded = await makeOffsetSection(ctx, short, 0.055);
  const transport = copyingDownloader(ctx, bounded);
  const outcomes = await new FrameAcquirer(
    ctx.config,
    ctx.store,
    ctx.blobs,
    new MediaAcquirer(ctx.config, ctx.store, ctx.blobs, transport.downloader),
  ).getOutcomes(ctx.resolved, ctx.ref, [0]);

  const outcome = outcomes[0]!;
  assert.equal(outcome.status, "error");
  if (outcome.status !== "error") throw new Error("target unexpectedly succeeded");
  assert(outcome.error instanceof UrmaError);
  assert.equal(outcome.error.code, "TARGETED_MEDIA_UNAVAILABLE");
  assert.equal(outcome.error.detail.reason, "bounded-coverage-miss");
  assert.deepEqual(
    transport.calls.map((args) => rangeArguments(args).length),
    [1],
  );
  const section = ctx.store
    .listArtifacts(ctx.resolved.sourceRef, ctx.resolved.revision)
    .find((artifact) => artifact.kind === "media_section");
  assert(section);
  assert(Math.abs(Number(section.producer.validatedVideoStart) * 1_000 - 55) <= 2);
  const artifacts = ctx.store.listArtifacts(
    ctx.resolved.sourceRef,
    ctx.resolved.revision,
  );
  assert.equal(artifacts.filter((artifact) => artifact.kind === "evidence_media").length, 0);
  assert.equal(artifacts.filter((artifact) => artifact.kind === "frame").length, 0);
  assert.deepEqual(ctx.store.listPresentations(ctx.ref), []);
});

test("bounded acquisition timeout and integrity failures stay target failures", async (t) => {
  const ctx = await fixture(t);
  const failures = [
    new UrmaError("MEDIA_ACQUISITION_TIMEOUT", "bounded timeout", {
      retryable: true,
    }),
    new UrmaError("MEDIA_INVALID", "bounded integrity failure", {
      retryable: true,
      detail: { integrity: "sha256" },
    }),
  ];
  let failure = failures[0]!;
  const calls: string[][] = [];
  const downloader = {
    run: async (args: readonly string[]) => {
      calls.push([...args]);
      throw failure;
    },
  };
  const acquirer = new FrameAcquirer(
    ctx.config,
    ctx.store,
    ctx.blobs,
    new MediaAcquirer(ctx.config, ctx.store, ctx.blobs, downloader),
  );
  for (const expected of failures) {
    failure = expected;
    const outcomes = await acquirer.getOutcomes(ctx.resolved, ctx.ref, [4_000]);
    const outcome = outcomes[0]!;
    assert.equal(outcome.status, "error");
    if (outcome.status !== "error") continue;
    assert.equal(outcome.error, expected);
  }
  assert.deepEqual(
    calls.map((args) => rangeArguments(args).length),
    [1, 1],
  );
  assert.equal(
    ctx.store
      .listArtifacts(ctx.resolved.sourceRef, ctx.resolved.revision)
      .filter((artifact) => artifact.kind === "evidence_media").length,
    0,
  );
});

test("invalid bounded timing remains a target failure without reusable escalation", async (t) => {
  const ctx = await fixture(t);
  const empty = await makeZeroStreamSection(ctx, "empty-section");
  const transport = copyingDownloader(ctx, empty);
  const times = [1_000, 7_000];
  const outcomes = await new FrameAcquirer(
    ctx.config,
    ctx.store,
    ctx.blobs,
    new MediaAcquirer(ctx.config, ctx.store, ctx.blobs, transport.downloader),
  ).getOutcomes(ctx.resolved, ctx.ref, times);
  assert.deepEqual(
    transport.calls.map((args) => rangeArguments(args)),
    [
      [
        { startMs: 0, endMs: 3_001 },
        { startMs: 5_000, endMs: 9_001 },
      ],
    ],
  );
  for (const outcome of outcomes) {
    assert.equal(outcome.status, "error");
    if (outcome.status !== "error") continue;
    assert(outcome.error instanceof UrmaError);
    assert.equal(outcome.error.code, "TARGETED_MEDIA_UNAVAILABLE");
  }
  assert.equal(
    ctx.store
      .listArtifacts(ctx.resolved.sourceRef, ctx.resolved.revision)
      .filter((artifact) => artifact.kind === "media_section").length,
    0,
  );
  assert.equal(
    ctx.store
      .listArtifacts(ctx.resolved.sourceRef, ctx.resolved.revision)
      .filter((artifact) => artifact.kind === "evidence_media").length,
    0,
  );
});

test("mixed bounded batch preserves good sections and fails bad siblings without reusable escalation", async (t) => {
  const ctx = await fixture(t);
  const good = await makeShortVideo(ctx, 3);
  const empty = await makeZeroStreamSection(ctx, "mixed-empty-section");
  const calls: string[][] = [];
  const downloader = {
    run: async (args: readonly string[]) => {
      calls.push([...args]);
      const outputDirectory = String(args[args.indexOf("--paths") + 1]);
      const ranges = rangeArguments(args);
      if (ranges.length === 0) {
        await copyFile(ctx.full, path.join(outputDirectory, "media.mp4"));
        return processResult(args);
      }
      if (ranges.length === 1 && !args.includes("--print")) {
        await copyFile(empty, path.join(outputDirectory, "media.mp4"));
        return processResult(args);
      }
      const lines: string[] = [];
      for (const [index, range] of ranges.entries()) {
        const filepath = path.join(
          outputDirectory,
          `media-${(range.startMs / 1_000).toFixed(3)}-${
            (range.endMs / 1_000).toFixed(3)
          }.mp4`,
        );
        await copyFile(index === 0 ? good : empty, filepath);
        lines.push(emission(range.startMs, range.endMs, filepath));
      }
      return processResult(args, `${lines.join("\n")}\n`);
    },
  };
  const times = [1_000, 8_000];
  const outcomes = await new FrameAcquirer(
    ctx.config,
    ctx.store,
    ctx.blobs,
    new MediaAcquirer(ctx.config, ctx.store, ctx.blobs, downloader),
  ).getOutcomes(ctx.resolved, ctx.ref, times);
  assert.deepEqual(
    calls.map((args) => rangeArguments(args).length),
    [2],
  );
  const artifacts = ctx.store.listArtifacts(
    ctx.resolved.sourceRef,
    ctx.resolved.revision,
  );
  assert.equal(
    artifacts.filter((artifact) => artifact.kind === "media_section").length,
    1,
  );
  assert.equal(
    artifacts.filter((artifact) => artifact.kind === "evidence_media").length,
    0,
  );
  const early = outcomes[0]!;
  const late = outcomes[1]!;
  assert.equal(early.status, "success");
  assert.equal(late.status, "error");
  if (early.status !== "success" || late.status !== "error") {
    throw new Error("mixed bounded outcomes did not preserve the expected sibling statuses");
  }
  assert(late.error instanceof UrmaError);
  assert.equal(late.error.code, "TARGETED_MEDIA_UNAVAILABLE");
  assert.equal(
    artifacts.find(
      (artifact) =>
        artifact.artifactId ===
          early.artifact.producer.transportArtifactId,
    )?.kind,
    "media_section",
  );
  assert.deepEqual(
    await ctx.blobs.read(
      early.artifact.artifactId,
      early.artifact.blobPath,
      8 * 1024 * 1024,
    ),
    await canonicalFrame(ctx, times[0]!, "mixed-canonical-early"),
  );
});

test("a bounded section with nominally covered but actually uncovered PTS fails only that target", async (t) => {
  const ctx = await fixture(t);
  const short = await makeShortVideo(ctx, 1);
  const transport = copyingDownloader(ctx, short);
  const outcomes = await new FrameAcquirer(
    ctx.config,
    ctx.store,
    ctx.blobs,
    new MediaAcquirer(ctx.config, ctx.store, ctx.blobs, transport.downloader),
  ).getOutcomes(ctx.resolved, ctx.ref, [4_000]);
  const outcome = outcomes[0]!;
  assert.equal(outcome.status, "error");
  if (outcome.status !== "error") throw new Error("coverage miss unexpectedly succeeded");
  assert(outcome.error instanceof UrmaError);
  assert.equal(outcome.error.code, "TARGETED_MEDIA_UNAVAILABLE");
  assert.equal(outcome.error.detail.reason, "bounded-coverage-miss");
  assert.deepEqual(
    transport.calls.map((args) => rangeArguments(args).length),
    [1],
  );
  const section = ctx.store
    .listArtifacts(ctx.resolved.sourceRef, ctx.resolved.revision)
    .find((artifact) => artifact.kind === "media_section");
  assert(section);
  assert.equal(section.producer.version, "bounded-section");
  assert(Number(section.producer.validatedVideoEnd) < 2);
  assert.equal(
    ctx.store
      .listArtifacts(ctx.resolved.sourceRef, ctx.resolved.revision)
      .filter((artifact) => artifact.kind === "evidence_media").length,
    0,
  );
});

test("a valid tail timestamp maps through a bounded section without shifting", async (t) => {
  const ctx = await fixture(t);
  const tail = await makeTailSection(ctx);
  const transport = copyingDownloader(ctx, tail);
  const observed = await new FrameAcquirer(
    ctx.config,
    ctx.store,
    ctx.blobs,
    new MediaAcquirer(ctx.config, ctx.store, ctx.blobs, transport.downloader),
  ).get(ctx.resolved, ctx.ref, [9_500]);
  assert.deepEqual(
    await ctx.blobs.read(
      observed[0]!.artifact.artifactId,
      observed[0]!.artifact.blobPath,
      8 * 1024 * 1024,
    ),
    await canonicalFrame(ctx, 9_500, "tail-canonical"),
  );
  assert.equal(transport.calls.length, 1);
  assert.equal(
    transport.calls[0] ? rangeArguments(transport.calls[0]).length : 0,
    1,
  );
});

test("ffmpeg exit zero without a JPEG fails the bounded target without reusable escalation", async (t) => {
  const ctx = await fixture(t);
  const short = await makeShortVideo(ctx, 5);
  const noOutput = path.join(ctx.directory, "missing-output.jpg");
  await assert.rejects(
    new Ffmpeg(ctx.config).extractJpeg(short, 9_000, noOutput),
    (error: unknown) => {
      assert(error instanceof Error);
      assert.equal(
        "code" in error ? error.code : undefined,
        "FRAME_EXTRACTION_FAILED",
      );
      assert.doesNotMatch(error.message, /ENOENT/u);
      return true;
    },
  );
  const bounded = await storedTransport(ctx, short, {
    startMs: 0,
    endMs: 10_000,
    version: "bounded-section",
    producer: {
      requestedStartMs: 0,
      requestedEndMs: 10_000,
      validatedVideoStart: 0,
      validatedVideoEnd: 20,
      validatedVideoStartPts: "0",
      validatedVideoEndPts: "1800000",
      validatedVideoDurationTs: "1800000",
      validatedVideoTimeBase: "1/90000",
      validatedVideoStartTime: "0.000000",
      validatedVideoEndTime: "20.000000",
    },
  });
  const transport = copyingDownloader(ctx, short);
  const outcomes = await new FrameAcquirer(
    ctx.config,
    ctx.store,
    ctx.blobs,
    new MediaAcquirer(ctx.config, ctx.store, ctx.blobs, transport.downloader),
  ).getOutcomes(ctx.resolved, ctx.ref, [9_000]);
  const outcome = outcomes[0]!;
  assert.equal(outcome.status, "error");
  if (outcome.status !== "error") throw new Error("extraction unexpectedly succeeded");
  assert(outcome.error instanceof UrmaError);
  assert.equal(outcome.error.code, "FRAME_EXTRACTION_FAILED");
  assert.equal(transport.calls.length, 0);
  const artifacts = ctx.store.listArtifacts(
    ctx.resolved.sourceRef,
    ctx.resolved.revision,
  );
  assert.equal(artifacts.filter((artifact) => artifact.kind === "frame").length, 0);
  assert.equal(artifacts.filter((artifact) => artifact.kind === "evidence_media").length, 0);
  assert.equal(
    artifacts.filter((artifact) => artifact.artifactId === bounded.artifactId).length,
    1,
  );
});

test("cache hits retain PTS coverage and reproduce canonical exact frames", async (t) => {
  const ctx = await fixture(t);
  const shifted = await makeShiftedSameCodecSection(ctx);
  const transport = copyingDownloader(ctx, shifted);
  const media = new MediaAcquirer(
    ctx.config,
    ctx.store,
    ctx.blobs,
    transport.downloader,
  );
  const cached = await media.section(ctx.resolved, ctx.ref, 2_000, 6_001);
  const observed = await new FrameAcquirer(
    ctx.config,
    ctx.store,
    ctx.blobs,
    media,
  ).get(ctx.resolved, ctx.ref, [4_000]);
  assert.deepEqual(
    await ctx.blobs.read(
      observed[0]!.artifact.artifactId,
      observed[0]!.artifact.blobPath,
      8 * 1024 * 1024,
    ),
    await canonicalFrame(ctx, 4_000, "pts-cache-canonical"),
  );
  assert.equal(transport.calls.length, 1);
  assert.equal(
    observed[0]!.artifact.producer.transportArtifactId,
    cached.artifact.artifactId,
  );
});

test("verified reusable evidence already in cache remains eligible for a targetable HLS source", async (t) => {
  const ctx = await fixture(t);
  const transport = copyingDownloader(ctx, ctx.full);
  const media = new MediaAcquirer(
    ctx.config,
    ctx.store,
    ctx.blobs,
    transport.downloader,
  );
  const cached = await media.reusableEvidence(ctx.resolved, ctx.ref);
  transport.calls.length = 0;

  const outcomes = await new FrameAcquirer(
    ctx.config,
    ctx.store,
    ctx.blobs,
    media,
  ).getOutcomes(ctx.resolved, ctx.ref, [4_000]);
  const outcome = outcomes[0]!;
  assert.equal(outcome.status, "success");
  if (outcome.status !== "success") throw new Error("cached reusable evidence was not selected");
  assert.deepEqual(transport.calls, []);
  assert.equal(
    outcome.artifact.producer.transportArtifactId,
    cached.artifact.artifactId,
  );
});

test("corrupt reusable cache does not authorize full acquisition for a bounded HLS request", async (t) => {
  const ctx = await fixture(t);
  const reusableTransport = copyingDownloader(ctx, ctx.full);
  const media = new MediaAcquirer(
    ctx.config,
    ctx.store,
    ctx.blobs,
    reusableTransport.downloader,
  );
  const cached = await media.reusableEvidence(ctx.resolved, ctx.ref);
  await writeFile(cached.path, Buffer.from("corrupt", "utf8"));

  const short = await makeShortVideo(ctx, 1);
  const boundedTransport = copyingDownloader(ctx, short);
  const outcomes = await new FrameAcquirer(
    ctx.config,
    ctx.store,
    ctx.blobs,
    new MediaAcquirer(
      ctx.config,
      ctx.store,
      ctx.blobs,
      boundedTransport.downloader,
    ),
  ).getOutcomes(ctx.resolved, ctx.ref, [4_000]);
  const outcome = outcomes[0]!;
  assert.equal(outcome.status, "error");
  if (outcome.status !== "error") throw new Error("corrupt reusable cache unexpectedly satisfied the target");
  assert(outcome.error instanceof UrmaError);
  assert.equal(outcome.error.code, "TARGETED_MEDIA_UNAVAILABLE");
  assert.equal(outcome.error.detail.reason, "bounded-coverage-miss");
  assert.deepEqual(
    boundedTransport.calls.map((args) => rangeArguments(args).length),
    [1],
  );
});

test("a non-targetable remote transport keeps reusable evidence as its primary path", async (t) => {
  const ctx = await fixture(t);
  const nonTargetable = {
    ...ctx.resolved,
    formats: ctx.resolved.formats.map((format) => ({
      ...format,
      protocol: "https",
    })),
    capabilities: { ...ctx.resolved.capabilities, targetedMedia: false },
  };
  const transport = copyingDownloader(ctx, ctx.full);
  const outcomes = await new FrameAcquirer(
    ctx.config,
    ctx.store,
    ctx.blobs,
    new MediaAcquirer(ctx.config, ctx.store, ctx.blobs, transport.downloader),
  ).getOutcomes(nonTargetable, ctx.ref, [4_000]);
  assert.equal(outcomes[0]?.status, "success");
  assert.deepEqual(
    transport.calls.map((args) => rangeArguments(args).length),
    [0],
  );
});

test("strict cancellation, hard budget, and malformed local media do not become reusable fallback", async (t) => {
  const ctx = await fixture(t);

  const calls: string[][] = [];
  const downloader = {
    run: async (args: readonly string[]) => {
      calls.push([...args]);
      await copyFile(
        ctx.full,
        path.join(String(args[args.indexOf("--paths") + 1]), "media.mp4"),
      );
      return processResult(args);
    },
  };
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    new FrameAcquirer(
      ctx.config,
      ctx.store,
      ctx.blobs,
      new MediaAcquirer(ctx.config, ctx.store, ctx.blobs, downloader),
    ).get(ctx.resolved, ctx.ref, [4_000], cancelled.signal),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "CANCELLED",
  );
  assert.equal(calls.length, 0);

  const budgetConfig = loadConfig({
    URMA_DATA_DIR: ctx.config.dataDir,
    URMA_FFMPEG: "ffmpeg",
    URMA_FFPROBE: "ffprobe",
    URMA_YTDLP: "fake-yt-dlp",
    URMA_MAX_TARGETED_MEDIA_BYTES: "1024",
  });
  const budgetSource = source(10_000, 10_000);
  await assert.rejects(
    new FrameAcquirer(
      budgetConfig,
      ctx.store,
      ctx.blobs,
      new MediaAcquirer(budgetConfig, ctx.store, ctx.blobs, downloader),
    ).get(budgetSource, ctx.ref, [4_000]),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "MEDIA_BUDGET_EXCEEDED",
  );
  assert.equal(calls.length, 0);

  const malformed = path.join(ctx.directory, "malformed-local.mp4");
  await writeFile(malformed, Buffer.alloc(262));
  const local = {
    ...ctx.resolved,
    kind: "local" as const,
    canonicalLocator: malformed,
    formats: [],
    capabilities: { ...ctx.resolved.capabilities, targetedMedia: false },
  };
  await assert.rejects(
    new FrameAcquirer(
      ctx.config,
      ctx.store,
      ctx.blobs,
      new MediaAcquirer(ctx.config, ctx.store, ctx.blobs, downloader),
    ).get(local, ctx.ref, [1_000]),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code !== "TARGETED_MEDIA_UNAVAILABLE",
  );
  assert.equal(calls.length, 0);
});
