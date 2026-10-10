import { putTestSource } from "../support/source-fixture.js";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { deterministicRequestKey } from "../../src/core/request-key.js";
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
import { candidateKeyForSourceFormat } from "../../src/sources/candidates.js";
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
  preciseTimescale = false,
): Promise<string> {
  const output = path.join(ctx.directory, `offset-${offsetSeconds}.mp4`);
  await runChecked(
    "ffmpeg",
    [
      "-v",
      "error",
      "-itsoffset",
      offsetSeconds.toFixed(9),
      "-i",
      input,
      "-c",
      "copy",
      "-avoid_negative_ts",
      "disabled",
      ...(preciseTimescale
        ? ["-movie_timescale", "1000000", "-video_track_timescale", "1000000"]
        : []),
      "-y",
      output,
    ],
    { timeoutMs: 30_000 },
  );
  return output;
}

async function makeAudioVideoWithDelayedVideo(
  ctx: Awaited<ReturnType<typeof fixture>>,
  omitSampleAspectRatio = false,
): Promise<string> {
  const zeroOriginVideo = path.join(ctx.directory, "zero-origin-video.mp4");
  const output = path.join(ctx.directory, "audio-zero-video-55ms.mp4");
  await runChecked(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=160x90:rate=10:duration=2",
      ...(omitSampleAspectRatio ? ["-vf", "setsar=0"] : []),
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
      zeroOriginVideo,
    ],
    { timeoutMs: 30_000 },
  );
  await runChecked(
    "ffmpeg",
    [
      "-v",
      "error",
      "-itsoffset",
      "0.055",
      "-i",
      zeroOriginVideo,
      "-f",
      "lavfi",
      "-i",
      "anullsrc=channel_layout=stereo:sample_rate=48000",
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-t",
      "2.055",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-avoid_negative_ts",
      "disabled",
      "-video_track_timescale",
      "90000",
      "-y",
      output,
    ],
    { timeoutMs: 30_000 },
  );
  return output;
}

async function makeHlsPrefix(
  ctx: Awaited<ReturnType<typeof fixture>>,
  input: string,
): Promise<{ playlist: string; segment: string }> {
  const directory = path.join(ctx.directory, "hls-prefix");
  await mkdir(directory, { recursive: true });
  const playlist = path.join(directory, "index.m3u8");
  const segment = path.join(directory, "segment0.ts");
  await runChecked(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      input,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0",
      "-c",
      "copy",
      "-f",
      "mpegts",
      "-y",
      segment,
    ],
    { timeoutMs: 30_000 },
  );
  await writeFile(
    playlist,
    "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:3\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-TWITCH-ELAPSED-SECS:0.000\n#EXT-X-TWITCH-TOTAL-SECS:11496.201\n#EXTINF:2.055,\nsegment0.ts\n#EXT-X-ENDLIST\n",
    "utf8",
  );
  return { playlist, segment };
}

async function makeCutAudioVideo(
  ctx: Awaited<ReturnType<typeof fixture>>,
  input: string,
): Promise<string> {
  const cutVideo = path.join(ctx.directory, "cut-video-only.mp4");
  const cutMp4 = path.join(ctx.directory, "cut-audio-zero-video-later.mp4");
  const output = path.join(ctx.directory, "cut-audio-zero-video-later.ts");
  await runChecked(
    "ffmpeg",
    [
      "-v",
      "error",
      "-ss",
      "0.2",
      "-i",
      input,
      "-t",
      "1.8",
      "-map",
      "0:v:0",
      "-an",
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
      "-avoid_negative_ts",
      "disabled",
      "-y",
      cutVideo,
    ],
    { timeoutMs: 30_000 },
  );
  await runChecked(
    "ffmpeg",
    [
      "-v",
      "error",
      "-itsoffset",
      "0.055",
      "-i",
      cutVideo,
      "-f",
      "lavfi",
      "-i",
      "anullsrc=channel_layout=stereo:sample_rate=48000",
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-t",
      "1.855",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-avoid_negative_ts",
      "disabled",
      "-video_track_timescale",
      "90000",
      "-y",
      cutMp4,
    ],
    { timeoutMs: 30_000 },
  );
  await runChecked(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      cutMp4,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0",
      "-c",
      "copy",
      "-muxdelay",
      "0",
      "-muxpreload",
      "0",
      "-f",
      "mpegts",
      "-y",
      output,
    ],
    { timeoutMs: 30_000 },
  );
  return output;
}

async function makeSampleAspectRatioVariant(
  ctx: Awaited<ReturnType<typeof fixture>>,
  input: string,
): Promise<string> {
  const output = path.join(ctx.directory, "different-sar-same-pixels.ts");
  await runChecked(
    ctx.config.ffmpeg,
    [
      "-v",
      "error",
      "-i",
      input,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      "-c",
      "copy",
      "-bsf:v",
      "h264_metadata=sample_aspect_ratio=2/1",
      "-f",
      "mpegts",
      "-y",
      output,
    ],
    { timeoutMs: 30_000 },
  );
  return output;
}

async function firstFrameRgbHash(
  ctx: Awaited<ReturnType<typeof fixture>>,
  file: string,
): Promise<string> {
  const result = await runChecked(
    ctx.config.ffmpeg,
    [
      "-v",
      "error",
      "-i",
      file,
      "-map",
      "0:v:0",
      "-frames:v",
      "1",
      "-vf",
      "format=rgb24",
      "-f",
      "hash",
      "-hash",
      "sha256",
      "pipe:1",
    ],
    { timeoutMs: 30_000, maxStdoutBytes: 1024 },
  );
  const match = /^SHA256=([a-f0-9]{64})\s*$/imu.exec(
    result.stdout.toString("utf8"),
  );
  assert(match, "ffmpeg did not emit one RGB24 frame SHA-256");
  return match[1]!;
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
    createdAt?: string;
  },
  requestKey?: string,
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
      validatedVideoTimingVersion: 3,
      validatedContainerStartTime: "0.000000",
      ...(values.producer ?? {}),
    },
    createdAt: values.createdAt ?? new Date().toISOString(),
  };
  ctx.store.putArtifact(
    artifact,
    requestKey === undefined
      ? undefined
      : { requestKey, operation: "media-section" },
  );
  return artifact;
}

async function seedLegacyReusableEvidence(
  ctx: Awaited<ReturnType<typeof fixture>>,
  source: ResolvedSource,
  file: string,
): Promise<StoredArtifact> {
  const blob = await ctx.blobs.putFile(file);
  const probe = await new Ffprobe(ctx.config).inspect(file);
  const streams = Array.isArray(probe.streams)
    ? (probe.streams as Array<Record<string, unknown>>)
    : [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const format = probe.format as Record<string, unknown>;
  assert(video);
  const coverage = parseVideoStreamCoverage(video, format.start_time);
  assert(coverage);
  const legacyTiming = { ...serializeVideoPtsCoverage(coverage) };
  delete legacyTiming.validatedContainerStartTime;
  legacyTiming.validatedVideoTimingVersion = 2;
  const formatSummary = source.formats[0]!;
  const params = {
    candidateKey: candidateKeyForSourceFormat(source, formatSummary),
    formatId: formatSummary.id,
    fidelity: "evidence",
  };
  const createdAt = new Date().toISOString();
  const artifact: StoredArtifact = {
    artifactId: blob.artifactId,
    sourceRef: source.sourceRef,
    sourceRevision: source.revision,
    kind: "evidence_media",
    role: "transport",
    mimeType: "video/mp4",
    sha256: blob.sha256,
    byteSize: blob.byteSize,
    blobPath: blob.relativePath,
    startMs: 0,
    endMs: source.durationMs,
    params,
    producer: {
      version: "evidence-copy",
      ...legacyTiming,
    },
    createdAt,
  };
  const requestKey = deterministicRequestKey(
    source.revision,
    "evidence-copy",
    { startMs: 0, endMs: source.durationMs, ...params },
    "evidence-copy",
  );
  ctx.store.putArtifact(artifact, { requestKey, operation: "evidence-copy" });
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
  const format = probe.format as Record<string, unknown>;
  const coverage = parseVideoStreamCoverage(video, format.start_time);
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
    validatedVideoTimingVersion: 3,
    validatedContainerStartTime: "0.055000",
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

test("complete A/V evidence with zero container origin accepts target zero before its first video PTS", async (t) => {
  const ctx = await fixture(t);
  const delayed = await makeAudioVideoWithDelayedVideo(ctx);
  const probe = await new Ffprobe(ctx.config).inspect(delayed);
  const streams = probe.streams as Array<Record<string, unknown>>;
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  const format = probe.format as Record<string, unknown>;
  assert(video);
  assert(audio);
  assert.equal(format.start_time, "0.000000");
  assert.equal(audio.start_time, "0.000000");
  assert.equal(video.start_time, "0.055000");

  const progressive = {
    ...ctx.resolved,
    formats: ctx.resolved.formats.map((item) => ({
      ...item,
      protocol: "https",
    })),
    capabilities: { ...ctx.resolved.capabilities, targetedMedia: false },
  };
  const transport = copyingDownloader(ctx, delayed, delayed);
  const outcomes = await new FrameAcquirer(
    ctx.config,
    ctx.store,
    ctx.blobs,
    new MediaAcquirer(ctx.config, ctx.store, ctx.blobs, transport.downloader),
  ).getOutcomes(progressive, ctx.ref, [0]);
  const outcome = outcomes[0]!;
  assert.equal(outcome.status, "success");
  if (outcome.status !== "success") {
    throw new Error("complete A/V evidence should satisfy target zero");
  }

  const expectedPath = path.join(ctx.directory, "complete-av-zero.jpg");
  await new Ffmpeg(ctx.config).extractJpeg(delayed, 0, expectedPath);
  assert.deepEqual(
    await ctx.blobs.read(
      outcome.artifact.artifactId,
      outcome.artifact.blobPath,
      8 * 1024 * 1024,
    ),
    await readFile(expectedPath),
  );
});

test("complete A/V evidence maps interior timestamps from the container origin", async (t) => {
  const ctx = await fixture(t);
  const delayed = await makeAudioVideoWithDelayedVideo(ctx);
  const probe = await new Ffprobe(ctx.config).inspect(delayed);
  const streams = probe.streams as Array<Record<string, unknown>>;
  assert.equal((probe.format as Record<string, unknown>).start_time, "0.000000");
  assert.equal(
    streams.find((stream) => stream.codec_type === "audio")?.start_time,
    "0.000000",
  );
  assert.equal(
    streams.find((stream) => stream.codec_type === "video")?.start_time,
    "0.055000",
  );

  const progressive = {
    ...ctx.resolved,
    formats: ctx.resolved.formats.map((item) => ({
      ...item,
      protocol: "https",
    })),
    capabilities: { ...ctx.resolved.capabilities, targetedMedia: false },
  };
  const transport = copyingDownloader(ctx, delayed, delayed);
  const observed = await new FrameAcquirer(
    ctx.config,
    ctx.store,
    ctx.blobs,
    new MediaAcquirer(ctx.config, ctx.store, ctx.blobs, transport.downloader),
  ).get(progressive, ctx.ref, [1_000]);
  const expectedPath = path.join(ctx.directory, "complete-av-1000.jpg");
  await new Ffmpeg(ctx.config).extractJpeg(delayed, 1_000, expectedPath);
  assert.deepEqual(
    await ctx.blobs.read(
      observed[0]!.artifact.artifactId,
      observed[0]!.artifact.blobPath,
      8 * 1024 * 1024,
    ),
    await readFile(expectedPath),
  );
});

test("complete video-only evidence keeps its 55ms first frame eligible at zero", async (t) => {
  const ctx = await fixture(t);
  const delayed = await makeOffsetSection(ctx, ctx.full, 0.055);
  const probe = await new Ffprobe(ctx.config).inspect(delayed);
  assert.equal((probe.format as Record<string, unknown>).start_time, "0.055000");

  const progressive = {
    ...ctx.resolved,
    formats: ctx.resolved.formats.map((item) => ({
      ...item,
      protocol: "https",
    })),
    capabilities: { ...ctx.resolved.capabilities, targetedMedia: false },
  };
  const transport = copyingDownloader(ctx, delayed, delayed);
  const observed = await new FrameAcquirer(
    ctx.config,
    ctx.store,
    ctx.blobs,
    new MediaAcquirer(ctx.config, ctx.store, ctx.blobs, transport.downloader),
  ).get(progressive, ctx.ref, [0]);
  const expectedPath = path.join(ctx.directory, "complete-video-only-zero.jpg");
  await new Ffmpeg(ctx.config).extractJpeg(delayed, 0, expectedPath);
  assert.deepEqual(
    await ctx.blobs.read(
      observed[0]!.artifact.artifactId,
      observed[0]!.artifact.blobPath,
      8 * 1024 * 1024,
    ),
    await readFile(expectedPath),
  );
});

test("sub-millisecond container-relative seek preserves the next-frame boundary", async (t) => {
  const ctx = await fixture(t);
  const delayed = await makeOffsetSection(ctx, ctx.full, 0.0009, true);
  const probe = await new Ffprobe(ctx.config).inspect(delayed);
  const containerStartTime = Number(
    (probe.format as Record<string, unknown>).start_time,
  );
  assert(Math.abs(containerStartTime - 0.0009) < 0.00005);

  const progressive = {
    ...ctx.resolved,
    formats: ctx.resolved.formats.map((item) => ({
      ...item,
      protocol: "https",
    })),
    capabilities: { ...ctx.resolved.capabilities, targetedMedia: false },
  };
  const transport = copyingDownloader(ctx, delayed, delayed);
  const observed = await new FrameAcquirer(
    ctx.config,
    ctx.store,
    ctx.blobs,
    new MediaAcquirer(ctx.config, ctx.store, ctx.blobs, transport.downloader),
  ).get(progressive, ctx.ref, [1]);

  const expectedPath = path.join(ctx.directory, "sub-ms-expected.jpg");
  const oldRoundedPath = path.join(ctx.directory, "sub-ms-rounded-to-zero.jpg");
  await new Ffmpeg(ctx.config).extractJpeg(delayed, 1, expectedPath);
  await runChecked(
    "ffmpeg",
    [
      "-v",
      "error",
      "-ss",
      "0.000",
      "-i",
      delayed,
      "-frames:v",
      "1",
      "-pix_fmt",
      "yuvj420p",
      "-q:v",
      "2",
      "-y",
      oldRoundedPath,
    ],
    { timeoutMs: 30_000 },
  );
  const expected = await readFile(expectedPath);
  assert.notDeepEqual(await readFile(oldRoundedPath), expected);
  assert.deepEqual(
    await ctx.blobs.read(
      observed[0]!.artifact.artifactId,
      observed[0]!.artifact.blobPath,
      8 * 1024 * 1024,
    ),
    expected,
  );
});

test("legacy v2 reusable evidence is replaced once before exact frames reuse it", async (t) => {
  const ctx = await fixture(t);
  const delayed = await makeAudioVideoWithDelayedVideo(ctx);
  const progressive = {
    ...ctx.resolved,
    formats: ctx.resolved.formats.map((item) => ({
      ...item,
      protocol: "https",
    })),
    capabilities: { ...ctx.resolved.capabilities, targetedMedia: false },
  };
  const legacy = await seedLegacyReusableEvidence(ctx, progressive, delayed);
  assert.equal(legacy.producer.validatedVideoTimingVersion, 2);

  const transport = copyingDownloader(ctx, delayed, delayed);
  const media = new MediaAcquirer(
    ctx.config,
    ctx.store,
    ctx.blobs,
    transport.downloader,
  );
  const frames = new FrameAcquirer(ctx.config, ctx.store, ctx.blobs, media);
  const first = await frames.get(progressive, ctx.ref, [0]);
  const expectedZero = path.join(ctx.directory, "legacy-v2-zero.jpg");
  await new Ffmpeg(ctx.config).extractJpeg(delayed, 0, expectedZero);
  assert.deepEqual(
    await ctx.blobs.read(
      first[0]!.artifact.artifactId,
      first[0]!.artifact.blobPath,
      8 * 1024 * 1024,
    ),
    await readFile(expectedZero),
  );
  assert.equal(transport.calls.length, 1);
  assert(
    ctx.store
      .listArtifacts(progressive.sourceRef, progressive.revision)
      .some((artifact) =>
        artifact.kind === "evidence_media" &&
        artifact.producer.validatedVideoTimingVersion === 3 &&
        artifact.producer.validatedSourcePrefix === "complete"
      ),
  );

  const second = await frames.get(progressive, ctx.ref, [1_000]);
  const expected = path.join(ctx.directory, "legacy-v2-one-second.jpg");
  await new Ffmpeg(ctx.config).extractJpeg(delayed, 1_000, expected);
  assert.deepEqual(
    await ctx.blobs.read(
      second[0]!.artifact.artifactId,
      second[0]!.artifact.blobPath,
      8 * 1024 * 1024,
    ),
    await readFile(expected),
  );
  assert.equal(transport.calls.length, 1);
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
  assert.deepEqual(boundary.map((outcome) => outcome.status), ["success", "error"]);
  for (const outcome of boundary) {
    if (outcome.atMs !== 10_000) continue;
    assert.equal(outcome.status, "error");
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
  const knownCoverage = parseVideoStreamCoverage(knownOrigin, "2.000000");
  assert(knownCoverage);
  assert.equal(knownCoverage.startSeconds, 2);
  const missingOrigin = {
    ...knownOrigin,
    start_pts: undefined,
    start_time: undefined,
  };
  assert.equal(parseVideoStreamCoverage(missingOrigin, "2.000000"), null);
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
  }, "0.000000");
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

test("stored timing needs a finite exact container origin and preserves negative origins", () => {
  const valid = {
    validatedVideoTimingVersion: 3,
    validatedVideoStartPts: "0",
    validatedVideoEndPts: "90000",
    validatedVideoDurationTs: "90000",
    validatedVideoTimeBase: "1/90000",
    validatedVideoStartTime: "0.000000000",
    validatedVideoEndTime: "1.000000000",
    validatedContainerStartTime: "0.000000",
  };
  assert(parseStoredVideoCoverage(valid));
  for (const invalid of [
    { ...valid, validatedContainerStartTime: undefined },
    { ...valid, validatedContainerStartTime: "not-a-time" },
    { ...valid, validatedContainerStartTime: "9".repeat(400) },
    { ...valid, validatedVideoTimingVersion: 2 },
  ]) {
    assert.equal(parseStoredVideoCoverage(invalid), null);
  }

  const negativeOrigin = parseStoredVideoCoverage({
    ...valid,
    validatedContainerStartTime: "-0.500000",
  });
  assert(negativeOrigin);
  assert.equal(negativeOrigin.containerStartSeconds, -0.5);
  assert.equal(physicalSeekMs(negativeOrigin, 0), 500);
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

test("legacy v2 local timing is reprobed from the pinned blob before selecting frames", async (t) => {
  const ctx = await fixture(t);
  const delayed = await makeAudioVideoWithDelayedVideo(ctx);
  const local = await pinnedLocalVideo(ctx, delayed, ctx.resolved.revision);
  const timingV2 = {
    ...(local.safeMetadata.videoTiming as Record<string, unknown>),
  };
  assert.equal(timingV2.validatedVideoTimingVersion, 3);
  delete timingV2.validatedContainerStartTime;
  timingV2.validatedVideoTimingVersion = 2;
  const legacy = {
    ...local,
    safeMetadata: { ...local.safeMetadata, videoTiming: timingV2 },
  };

  const outcomes = await new FrameAcquirer(
    ctx.config,
    ctx.store,
    ctx.blobs,
    new MediaAcquirer(ctx.config, ctx.store, ctx.blobs, {
      run: async () => {
        throw new Error("pinned local timing reprobe must not acquire remote media");
      },
    }),
  ).getOutcomes(legacy, ctx.ref, [0, 1_000]);
  assert.deepEqual(outcomes.map((outcome) => outcome.status), ["success", "success"]);
  for (const outcome of outcomes) {
    if (outcome.status !== "success") {
      throw new Error("explicit v2 timing should reprobe the pinned local blob");
    }
    const expectedPath = path.join(ctx.directory, `local-v2-${outcome.atMs}.jpg`);
    await new Ffmpeg(ctx.config).extractJpeg(delayed, outcome.atMs, expectedPath);
    assert.deepEqual(
      await ctx.blobs.read(
        outcome.artifact.artifactId,
        outcome.artifact.blobPath,
        8 * 1024 * 1024,
      ),
      await readFile(expectedPath),
    );
  }
  assert.equal(
    (legacy.safeMetadata.videoTiming as Record<string, unknown>)
      .validatedVideoTimingVersion,
    2,
  );
});

test("local targets with container origin after video PTS fail per target", async (t) => {
  const ctx = await fixture(t);
  const delayed = await makeAudioVideoWithDelayedVideo(ctx);
  const local = await pinnedLocalVideo(ctx, delayed, ctx.resolved.revision);
  const inconsistentTiming = {
    ...(local.safeMetadata.videoTiming as Record<string, unknown>),
    validatedContainerStartTime: "0.500000",
  };
  const inconsistent = {
    ...local,
    safeMetadata: { ...local.safeMetadata, videoTiming: inconsistentTiming },
  };
  const outcomes = await new FrameAcquirer(
    ctx.config,
    ctx.store,
    ctx.blobs,
    new MediaAcquirer(ctx.config, ctx.store, ctx.blobs, {
      run: async () => {
        throw new Error("local origin mismatch must not acquire remote media");
      },
    }),
  ).getOutcomes(inconsistent, ctx.ref, [100, 1_000]);

  assert.deepEqual(outcomes.map((outcome) => outcome.status), ["error", "success"]);
  const unavailable = outcomes[0]!;
  assert.equal(unavailable.status, "error");
  if (unavailable.status === "error") {
    assert(unavailable.error instanceof UrmaError);
    assert.equal(unavailable.error.code, "MEDIA_INVALID");
    assert.equal(unavailable.error.detail.reason, "local-seek-origin-mismatch");
  }
});

test("cached bounded media skips an inconsistent container origin for a valid candidate", async (t) => {
  const ctx = await fixture(t);
  const invalidMedia = await makeAudioVideoWithDelayedVideo(ctx);
  const validMedia = await makeShortVideo(ctx, 2);
  const readCoverage = async (file: string) => {
    const probe = await new Ffprobe(ctx.config).inspect(file);
    const streams = probe.streams as Array<Record<string, unknown>>;
    const video = streams.find((stream) => stream.codec_type === "video");
    const format = probe.format as Record<string, unknown>;
    assert(video);
    const coverage = parseVideoStreamCoverage(video, format.start_time);
    assert(coverage);
    return serializeVideoPtsCoverage(coverage);
  };
  const invalidTiming = {
    ...(await readCoverage(invalidMedia)),
    validatedContainerStartTime: "0.500000",
  };
  const validTiming = await readCoverage(validMedia);
  const invalid = await storedTransport(ctx, invalidMedia, {
    startMs: 0,
    endMs: 2_000,
    version: "bounded-section",
    createdAt: new Date(1).toISOString(),
    producer: invalidTiming,
  });
  const valid = await storedTransport(ctx, validMedia, {
    startMs: 0,
    endMs: 2_000,
    version: "bounded-section",
    createdAt: new Date(2).toISOString(),
    producer: validTiming,
  });
  assert.notEqual(invalid.artifactId, valid.artifactId);

  const outcome = (await new FrameAcquirer(
    ctx.config,
    ctx.store,
    ctx.blobs,
    new MediaAcquirer(ctx.config, ctx.store, ctx.blobs, {
      run: async () => {
        throw new Error("a later cached candidate should satisfy the target");
      },
    }),
  ).getOutcomes(ctx.resolved, ctx.ref, [100]))[0]!;
  assert.equal(outcome.status, "success");
  if (outcome.status === "success") {
    assert.equal(outcome.artifact.producer.transportArtifactId, valid.artifactId);
  }
});

function sourcePrefixDownloader(
  ctx: Awaited<ReturnType<typeof fixture>>,
  bounded: string,
  prefix: { playlist: string; segment: string },
  behavior: Readonly<{
    manifestFailures?: number;
    blockManifest?: boolean;
    manifestText?: string;
  }> = {},
) {
  const calls: string[][] = [];
  const runTimeouts: number[] = [];
  const manifestTimeouts: number[] = [];
  let manifestCalls = 0;
  let remainingManifestFailures = behavior.manifestFailures ?? 0;
  let announceManifestStarted!: () => void;
  const manifestStarted = new Promise<void>((resolve) => {
    announceManifestStarted = resolve;
  });
  const deliveryUrl = "https://fixture.invalid/hls/index.m3u8";
  let manifestTextOverride = behavior.manifestText;
  const candidateKey = candidateKeyForSourceFormat(
    ctx.resolved,
    ctx.resolved.formats[0]!,
  );
  const downloader = {
    lease: async (
      selectedSource: ResolvedSource,
      format: ResolvedSource["formats"][number],
    ) => ({
      snapshotRef: selectedSource.snapshotRef,
      candidateKey,
      sourceRef: selectedSource.sourceRef,
      formatId: format.id,
      deliveryUrl,
      expiresAtMs: Date.now() + 60_000,
    }),
    manifestText: async (
      url: string,
      signal?: AbortSignal,
      options?: Readonly<{ timeoutMs?: number }>,
    ) => {
      manifestCalls += 1;
      assert.equal(url, deliveryUrl);
      assert(options?.timeoutMs === undefined || options.timeoutMs > 0);
      manifestTimeouts.push(options?.timeoutMs ?? 0);
      announceManifestStarted();
      if (remainingManifestFailures > 0) {
        remainingManifestFailures -= 1;
        throw new UrmaError("SOURCE_UNAVAILABLE", "fixture manifest failure");
      }
      if (behavior.blockManifest) {
        await new Promise<never>((_resolve, reject) => {
          const abort = () => {
            signal?.removeEventListener("abort", abort);
            reject(new UrmaError("CANCELLED", "fixture manifest cancelled"));
          };
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        });
      }
      return manifestTextOverride ?? await readFile(prefix.playlist, "utf8");
    },
    run: async (
      args: readonly string[],
      runOptions?: Readonly<{ signal?: AbortSignal; timeoutMs?: number }>,
    ) => {
      calls.push([...args]);
      runTimeouts.push(runOptions?.timeoutMs ?? 0);
      if (args.includes("--download-sections")) {
        const outputDirectory = String(args[args.indexOf("--paths") + 1]);
        const extension = path.extname(bounded) || ".bin";
        await copyFile(bounded, path.join(outputDirectory, `media${extension}`));
        return processResult(args);
      }
      const url = String(args.at(-1));
      assert.equal(url, new URL("segment0.ts", deliveryUrl).href);
      const output = String(args[args.indexOf("-o") + 1]);
      await copyFile(prefix.segment, output);
      return processResult(args);
    },
  };
  return {
    calls,
    runTimeouts,
    manifestTimeouts,
    get manifestCalls() { return manifestCalls; },
    setManifestText(text: string) { manifestTextOverride = text; },
    manifestStarted,
    deliveryUrl,
    candidateKey,
    downloader,
  };
}

async function coverageDelayMs(
  ctx: Awaited<ReturnType<typeof fixture>>,
  file: string,
): Promise<number> {
  const probe = await new Ffprobe(ctx.config).inspect(file);
  const streams = probe.streams as Array<Record<string, unknown>>;
  const video = streams.find((stream) => stream.codec_type === "video");
  const format = probe.format as Record<string, unknown>;
  assert(video);
  const coverage = parseVideoStreamCoverage(video, format.start_time);
  assert(coverage);
  return (coverage.startSeconds - coverage.containerStartSeconds) * 1_000;
}

test("a zero-start HLS section may use its first frame after native source identity and timing match", async (t) => {
  const ctx = await fixture(t);
  const delayed = await makeAudioVideoWithDelayedVideo(ctx);
  const prefix = await makeHlsPrefix(ctx, delayed);
  const playlist = await readFile(prefix.playlist, "utf8");
  assert(playlist.includes("#EXT-X-MEDIA-SEQUENCE:0"));
  assert(playlist.includes("#EXT-X-ENDLIST"));
  assert(!playlist.includes("#EXT-X-START"));
  const sourceHash = await firstFrameRgbHash(ctx, prefix.segment);
  assert.equal(sourceHash, await firstFrameRgbHash(ctx, delayed));
  const sourceDelayMs = await coverageDelayMs(ctx, prefix.segment);
  assert(sourceDelayMs > 1);

  const bounded = prefix.segment;
  const legacyKey = deterministicRequestKey(
    ctx.resolved.revision,
    "media-section",
    {
      startMs: 0,
      endMs: 2_001,
      candidateKey: candidateKeyForSourceFormat(
        ctx.resolved,
        ctx.resolved.formats[0]!,
      ),
      formatId: "hls",
      fidelity: "evidence",
      requestedStartMs: 0,
      requestedEndMs: 2_001,
    },
    "bounded-section",
  );
  const legacy = await storedTransport(ctx, bounded, {
    startMs: 0,
    endMs: 2_001,
    version: "bounded-section",
  }, legacyKey);
  assert.equal(legacy.producer.validatedSourceFirstFrame, undefined);

  const transport = sourcePrefixDownloader(ctx, bounded, prefix);
  const acquirer = new FrameAcquirer(
    ctx.config,
    ctx.store,
    ctx.blobs,
    new MediaAcquirer(ctx.config, ctx.store, ctx.blobs, transport.downloader),
  );
  const outcomes = await acquirer.getOutcomes(ctx.resolved, ctx.ref, [0]);

  assert.equal(
    outcomes[0]?.status,
    "success",
    outcomes[0]?.status === "error"
      ? `target-zero failure: ${outcomes[0].error instanceof Error ? outcomes[0].error.message : String(outcomes[0].error)}`
      : undefined,
  );
  const section = ctx.store
    .listArtifacts(ctx.resolved.sourceRef, ctx.resolved.revision)
    .find((artifact) => artifact.kind === "media_section" &&
      artifact.producer.validatedSourceFirstFrame !== undefined);
  assert(section);
  const proof = section.producer.validatedSourceFirstFrame as Record<string, unknown>;
  assert.equal(proof.version, 1);
  assert.equal(proof.candidateKey, transport.candidateKey);
  assert.equal(proof.frameSha256, sourceHash);
  assert(Math.abs(Number(proof.sourceVideoDelayMs) - sourceDelayMs) <= 1);
  assert(Math.abs(Number(proof.sectionVideoDelayMs) - sourceDelayMs) <= 1);
  assert.equal(transport.calls.filter((args) => args.includes("--download-sections")).length, 1);
  assert.equal(transport.calls.length, 2);
  assert.equal(transport.runTimeouts.length, 2);
  assert(transport.runTimeouts[0]! > transport.runTimeouts[1]!);
  assert(transport.manifestTimeouts[0]! < transport.runTimeouts[0]!);
  const repeated = await acquirer.getOutcomes(ctx.resolved, ctx.ref, [0]);
  assert.equal(repeated[0]?.status, "success");
  assert.equal(transport.calls.length, 2);
});

test("matching native streams with unspecified SAR can verify the zero-start frame", async (t) => {
  const ctx = await fixture(t);
  const delayed = await makeAudioVideoWithDelayedVideo(ctx, true);
  const prefix = await makeHlsPrefix(ctx, delayed);
  const bounded = prefix.segment;
  const sourceProbe = await new Ffprobe(ctx.config).inspect(prefix.segment);
  const sectionProbe = await new Ffprobe(ctx.config).inspect(bounded);
  const sourceVideo = (sourceProbe.streams as Array<Record<string, unknown>>)
    .find((stream) => stream.codec_type === "video");
  const sectionVideo = (sectionProbe.streams as Array<Record<string, unknown>>)
    .find((stream) => stream.codec_type === "video");
  assert(sourceVideo);
  assert(sectionVideo);
  assert.equal(sourceVideo.sample_aspect_ratio, undefined);
  assert.equal(sectionVideo.sample_aspect_ratio, undefined);
  assert((await coverageDelayMs(ctx, prefix.segment)) > 1);

  const transport = sourcePrefixDownloader(ctx, bounded, prefix);
  const acquirer = new FrameAcquirer(
    ctx.config,
    ctx.store,
    ctx.blobs,
    new MediaAcquirer(ctx.config, ctx.store, ctx.blobs, transport.downloader),
  );
  const first = (await acquirer.getOutcomes(ctx.resolved, ctx.ref, [0]))[0]!;
  assert.equal(first.status, "success");
  if (first.status === "success") assert.equal(first.cacheHit, false);
  const section = ctx.store
    .listArtifacts(ctx.resolved.sourceRef, ctx.resolved.revision)
    .find((artifact) => artifact.kind === "media_section" &&
      artifact.producer.validatedSourceFirstFrame !== undefined);
  assert(section);
  assert.ok(section.producer.validatedSourceFirstFrame);

  const repeated = (await acquirer.getOutcomes(ctx.resolved, ctx.ref, [0]))[0]!;
  assert.equal(repeated.status, "success");
  if (repeated.status === "success") assert.equal(repeated.cacheHit, true);
  assert.equal(transport.calls.length, 2);
});

test("Twitch elapsed metadata must prove an exact zero origin before source-frame verification", async (t) => {
  const ctx = await fixture(t);
  const delayed = await makeAudioVideoWithDelayedVideo(ctx);
  const prefix = await makeHlsPrefix(ctx, delayed);
  const validPlaylist = await readFile(prefix.playlist, "utf8");
  const invalidPlaylists = [
    ["nonzero elapsed", validPlaylist.replace(
      "#EXT-X-TWITCH-ELAPSED-SECS:0.000",
      "#EXT-X-TWITCH-ELAPSED-SECS:1.000",
    )],
    ["negative elapsed", validPlaylist.replace(
      "#EXT-X-TWITCH-ELAPSED-SECS:0.000",
      "#EXT-X-TWITCH-ELAPSED-SECS:-0.000",
    )],
    ["malformed elapsed", validPlaylist.replace(
      "#EXT-X-TWITCH-ELAPSED-SECS:0.000",
      "#EXT-X-TWITCH-ELAPSED-SECS:1e3",
    )],
    ["zero total duration", validPlaylist.replace(
      "#EXT-X-TWITCH-TOTAL-SECS:11496.201",
      "#EXT-X-TWITCH-TOTAL-SECS:0",
    )],
  ] as const;
  const transport = sourcePrefixDownloader(ctx, prefix.segment, prefix);
  const acquirer = new FrameAcquirer(
    ctx.config,
    ctx.store,
    ctx.blobs,
    new MediaAcquirer(ctx.config, ctx.store, ctx.blobs, transport.downloader),
  );

  for (const [label, playlist] of invalidPlaylists) {
    assert.notEqual(playlist, validPlaylist, `${label} fixture did not change`);
    transport.setManifestText(playlist);
    const outcome = (await acquirer.getOutcomes(ctx.resolved, ctx.ref, [0]))[0]!;
    assert.equal(outcome.status, "error", `${label} should not authorize target zero`);
    if (outcome.status === "error") {
      assert(outcome.error instanceof UrmaError);
      assert.equal(outcome.error.code, "TARGETED_MEDIA_UNAVAILABLE");
      assert.equal(outcome.error.detail.reason, "bounded-coverage-miss");
    }
  }

  const section = ctx.store
    .listArtifacts(ctx.resolved.sourceRef, ctx.resolved.revision)
    .find((artifact) => artifact.kind === "media_section");
  assert(section);
  assert.equal(section.producer.validatedSourceFirstFrame, undefined);
  assert.equal(
    ctx.store.listArtifacts(ctx.resolved.sourceRef, ctx.resolved.revision)
      .filter((artifact) => artifact.kind === "frame").length,
    0,
  );
  assert.equal(transport.calls.filter((args) => args.includes("--download-sections")).length, 1);
  assert.equal(transport.calls.length, 1, "invalid origin metadata must not fetch a source segment");
  assert.equal(transport.manifestCalls, invalidPlaylists.length);
});

test("a later request can verify a cached zero-start section without downloading that section again", async (t) => {
  const ctx = await fixture(t);
  const delayed = await makeAudioVideoWithDelayedVideo(ctx);
  const prefix = await makeHlsPrefix(ctx, delayed);
  const transport = sourcePrefixDownloader(ctx, prefix.segment, prefix, {
    manifestFailures: 1,
  });
  const media = new MediaAcquirer(
    ctx.config,
    ctx.store,
    ctx.blobs,
    transport.downloader,
  );
  const acquirer = new FrameAcquirer(
    ctx.config,
    ctx.store,
    ctx.blobs,
    media,
  );

  const first = await acquirer.getOutcomes(ctx.resolved, ctx.ref, [0]);
  assert.equal(first[0]?.status, "error");
  assert.equal(transport.manifestCalls, 1);
  assert.equal(
    transport.calls.filter((args) => args.includes("--download-sections")).length,
    1,
  );
  assert.equal(transport.calls.length, 1);

  const second = await media.section(ctx.resolved, ctx.ref, 0, 2_001);
  assert.equal(second.cacheHit, true);
  assert.ok(second.artifact.producer.validatedSourceFirstFrame);
  assert.equal(transport.manifestCalls, 2);
  assert.equal(
    transport.calls.filter((args) => args.includes("--download-sections")).length,
    1,
  );
  assert.equal(transport.calls.length, 2);

  const third = await acquirer.getOutcomes(ctx.resolved, ctx.ref, [0]);
  assert.equal(third[0]?.status, "success");
  if (third[0]?.status === "success") assert.equal(third[0].cacheHit, false);
  const fourth = await acquirer.getOutcomes(ctx.resolved, ctx.ref, [0]);
  assert.equal(fourth[0]?.status, "success");
  if (fourth[0]?.status === "success") assert.equal(fourth[0].cacheHit, true);
  assert.equal(transport.manifestCalls, 2);
  assert.equal(transport.calls.length, 2);
});

test("source-start verification shares cancellation with the section acquisition", async (t) => {
  const ctx = await fixture(t);
  const delayed = await makeAudioVideoWithDelayedVideo(ctx);
  const prefix = await makeHlsPrefix(ctx, delayed);
  const transport = sourcePrefixDownloader(ctx, prefix.segment, prefix, {
    blockManifest: true,
  });
  const media = new MediaAcquirer(
    ctx.config,
    ctx.store,
    ctx.blobs,
    transport.downloader,
  );
  const controller = new AbortController();
  const pending = media.section(ctx.resolved, ctx.ref, 0, 2_001, controller.signal);
  await transport.manifestStarted;
  controller.abort();

  await assert.rejects(
    pending,
    (error: unknown) => error instanceof UrmaError && error.code === "CANCELLED",
  );
  assert.equal(transport.manifestCalls, 1);
  assert.equal(transport.calls.length, 1);
  assert.equal(
    transport.calls.filter((args) => args.includes("--download-sections")).length,
    1,
  );
});

test("combined bounded-section and source-segment bytes stay within the acquisition cap", async (t) => {
  const ctx = await fixture(t);
  const delayed = await makeAudioVideoWithDelayedVideo(ctx);
  const prefix = await makeHlsPrefix(ctx, delayed);
  const fileBytes = (await readFile(prefix.segment)).byteLength;
  const constrainedConfig = {
    ...ctx.config,
    limits: {
      ...ctx.config.limits,
      maxTargetedMediaBytes: fileBytes + 1,
    },
  };
  const transport = sourcePrefixDownloader(ctx, prefix.segment, prefix);
  const outcome = (await new FrameAcquirer(
    constrainedConfig,
    ctx.store,
    ctx.blobs,
    new MediaAcquirer(
      constrainedConfig,
      ctx.store,
      ctx.blobs,
      transport.downloader,
    ),
  ).getOutcomes(ctx.resolved, ctx.ref, [0]))[0]!;

  assert.equal(outcome.status, "error");
  if (outcome.status === "error") {
    assert(outcome.error instanceof UrmaError);
    assert.equal(outcome.error.code, "MEDIA_BUDGET_EXCEEDED");
  }
  assert.equal(transport.calls.length, 2);
  assert.equal(
    ctx.store.listArtifacts(ctx.resolved.sourceRef, ctx.resolved.revision)
      .filter((artifact) => artifact.kind === "frame").length,
    0,
  );
});

test("a timed-out bounded batch does not restart its deadline in single-section fallback", async (t) => {
  const ctx = await fixture(t);
  let invocations = 0;
  const media = new MediaAcquirer(ctx.config, ctx.store, ctx.blobs, {
    run: async () => {
      invocations += 1;
      throw new UrmaError(
        "MEDIA_ACQUISITION_TIMEOUT",
        "fixture batch deadline expired",
      );
    },
  });
  const outcomes = await media.sections([
    {
      source: ctx.resolved,
      investigationRef: ctx.ref,
      startMs: 0,
      endMs: 2_001,
    },
    {
      source: ctx.resolved,
      investigationRef: ctx.ref,
      startMs: 0,
      endMs: 4_001,
    },
  ]);

  assert.equal(invocations, 1);
  assert.equal(outcomes.length, 2);
  for (const outcome of outcomes) {
    assert.equal(outcome.status, "rejected");
    if (outcome.status === "rejected") {
      assert(outcome.reason instanceof UrmaError);
      assert.equal(outcome.reason.code, "MEDIA_ACQUISITION_TIMEOUT");
    }
  }
});

test("a sequence-zero HLS cut with a different first frame cannot use the zero-start exception", async (t) => {
  const ctx = await fixture(t);
  const delayed = await makeAudioVideoWithDelayedVideo(ctx);
  const prefix = await makeHlsPrefix(ctx, delayed);
  const cut = await makeCutAudioVideo(ctx, delayed);
  const sourceDelayMs = await coverageDelayMs(ctx, prefix.segment);
  const cutDelayMs = await coverageDelayMs(ctx, cut);
  assert(
    Math.abs(cutDelayMs - sourceDelayMs) <= 1,
    `source delay ${sourceDelayMs}ms did not match cut delay ${cutDelayMs}ms`,
  );
  assert.notEqual(
    await firstFrameRgbHash(ctx, prefix.segment),
    await firstFrameRgbHash(ctx, cut),
  );
  const playlist = await readFile(prefix.playlist, "utf8");
  assert(playlist.includes("#EXT-X-MEDIA-SEQUENCE:0"));

  const transport = sourcePrefixDownloader(ctx, cut, prefix);
  const outcome = (await new FrameAcquirer(
    ctx.config,
    ctx.store,
    ctx.blobs,
    new MediaAcquirer(ctx.config, ctx.store, ctx.blobs, transport.downloader),
  ).getOutcomes(ctx.resolved, ctx.ref, [0]))[0]!;

  assert.equal(outcome.status, "error");
  if (outcome.status === "error") {
    assert(outcome.error instanceof UrmaError);
    assert.equal(
      outcome.error.code,
      "TARGETED_MEDIA_UNAVAILABLE",
      `${outcome.error.message}; cause: ${String(outcome.error.cause)}`,
    );
    assert.equal(outcome.error.detail.reason, "bounded-coverage-miss");
  }
  const section = ctx.store
    .listArtifacts(ctx.resolved.sourceRef, ctx.resolved.revision)
    .find((artifact) => artifact.kind === "media_section");
  assert(section);
  assert.equal(section.producer.validatedSourceFirstFrame, undefined);
  assert.equal(
    ctx.store.listArtifacts(ctx.resolved.sourceRef, ctx.resolved.revision)
      .filter((artifact) => artifact.kind === "frame").length,
    0,
  );
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

test("a matching first RGB frame with different sample geometry cannot use the zero-start exception", async (t) => {
  const ctx = await fixture(t);
  const delayed = await makeAudioVideoWithDelayedVideo(ctx, true);
  const prefix = await makeHlsPrefix(ctx, delayed);
  const altered = await makeSampleAspectRatioVariant(ctx, prefix.segment);
  assert.equal(await firstFrameRgbHash(ctx, prefix.segment), await firstFrameRgbHash(ctx, altered));
  assert(Math.abs(await coverageDelayMs(ctx, prefix.segment) - await coverageDelayMs(ctx, altered)) <= 1);
  const sourceProbe = await new Ffprobe(ctx.config).inspect(prefix.segment);
  const alteredProbe = await new Ffprobe(ctx.config).inspect(altered);
  const sourceVideo = (sourceProbe.streams as Array<Record<string, unknown>>)
    .find((stream) => stream.codec_type === "video");
  const alteredVideo = (alteredProbe.streams as Array<Record<string, unknown>>)
    .find((stream) => stream.codec_type === "video");
  assert(sourceVideo);
  assert(alteredVideo);
  assert.equal(sourceVideo.sample_aspect_ratio, undefined);
  assert.equal(alteredVideo.sample_aspect_ratio, "2:1");
  assert.notEqual(sourceVideo.sample_aspect_ratio, alteredVideo.sample_aspect_ratio);

  const transport = sourcePrefixDownloader(ctx, altered, prefix);
  const outcome = (await new FrameAcquirer(
    ctx.config,
    ctx.store,
    ctx.blobs,
    new MediaAcquirer(ctx.config, ctx.store, ctx.blobs, transport.downloader),
  ).getOutcomes(ctx.resolved, ctx.ref, [0]))[0]!;

  assert.equal(outcome.status, "error");
  if (outcome.status === "error") {
    assert(outcome.error instanceof UrmaError);
    assert.equal(outcome.error.code, "TARGETED_MEDIA_UNAVAILABLE");
    assert.equal(outcome.error.detail.reason, "bounded-coverage-miss");
  }
  const section = ctx.store
    .listArtifacts(ctx.resolved.sourceRef, ctx.resolved.revision)
    .find((artifact) => artifact.kind === "media_section");
  assert(section);
  assert.equal(section.producer.validatedSourceFirstFrame, undefined);
  assert.equal(
    ctx.store.listArtifacts(ctx.resolved.sourceRef, ctx.resolved.revision)
      .filter((artifact) => artifact.kind === "frame").length,
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
      validatedContainerStartTime: "0.000000",
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
