import assert from "node:assert/strict";
import {
  copyFile,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openUrma } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { Ffmpeg } from "../../src/subprocess/ffmpeg.js";
import { runChecked } from "../../src/subprocess/runner.js";
import { parseLocalSnapshot } from "../../src/sources/local.js";

async function makeVideo(file: string, color: string): Promise<void> {
  await runChecked(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=c=${color}:s=320x180:d=4:r=2`,
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
      file,
    ],
    { timeoutMs: 30_000 },
  );
}

async function frameBytes(
  app: Awaited<ReturnType<typeof openUrma>>,
  source: string,
  name: string,
): Promise<Buffer> {
  const output = path.join(app.config.dataDir, `${name}.jpg`);
  const ffmpeg = new Ffmpeg(app.config);
  await ffmpeg.extractJpeg(source, 1_000, output);
  await ffmpeg.validateJpeg(output);
  return await readFile(output);
}

test("local investigations consume pinned video and sidecar snapshots after path replacement", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "urma-local-immutability-"));
  const video = path.join(directory, "video.mp4");
  const original = path.join(directory, "original.mp4");
  const replacement = path.join(directory, "replacement.mp4");
  const sidecar = path.join(directory, "video.vtt");
  await makeVideo(original, "blue");
  await makeVideo(replacement, "red");
  await copyFile(original, video);
  await writeFile(
    sidecar,
    "WEBVTT\n\n00:00:00.500 --> 00:00:01.500\noriginal caption\n",
  );
  const app = await openUrma(
    loadConfig({
      URMA_DATA_DIR: path.join(directory, "data"),
      URMA_LOCAL_ROOTS: directory,
    }),
  );
  t.after(async () => {
    app.close();
    await rm(directory, { recursive: true, force: true });
  });

  const first = await app.evidence.inspectVideo({ source: video });
  const firstSnapshot = app.store.getSnapshot(
    first.sourceRef,
    first.source.snapshotRevision,
  );
  assert(firstSnapshot);
  const pinned = parseLocalSnapshot(
    (firstSnapshot.descriptor.safeMetadata as Record<string, unknown>)
      .localSnapshot,
  );
  assert(pinned);
  const pinnedVideo = await app.blobs.read(
    pinned.video.artifactId,
    pinned.video.blobPath,
    64 * 1024 * 1024,
  );
  const originalPathStat = await stat(video);

  await writeFile(video, await readFile(replacement));
  await utimes(video, originalPathStat.atime, originalPathStat.mtime);
  const replacedPathStat = await stat(video);
  assert.equal(Math.round(replacedPathStat.mtimeMs), Math.round(originalPathStat.mtimeMs));

  const oldFrames = await app.evidence.getFrames({
    investigationRef: first.investigationRef,
    request: { kind: "points", timesMs: [1_000] },
  });
  const oldFrame = app.store
    .listArtifacts(first.sourceRef, first.source.snapshotRevision)
    .find((artifact) => artifact.kind === "frame");
  assert(oldFrame);
  assert.equal(oldFrames.kind, "exact_points");
  assert.deepEqual(
    await app.blobs.read(oldFrame.artifactId, oldFrame.blobPath, 8 * 1024 * 1024),
    await frameBytes(app, original, "expected-original"),
  );
  assert.notDeepEqual(
    await app.blobs.read(oldFrame.artifactId, oldFrame.blobPath, 8 * 1024 * 1024),
    await frameBytes(app, replacement, "expected-replacement"),
  );
  assert.deepEqual(
    await app.blobs.read(pinned.video.artifactId, pinned.video.blobPath, 64 * 1024 * 1024),
    pinnedVideo,
  );

  const oldCaption = await app.evidence.searchTranscript({
    investigationRef: first.investigationRef,
    query: "original caption",
  });
  assert.equal(oldCaption.hits.length, 1);
  const replacedCaption = await app.evidence.searchTranscript({
    investigationRef: first.investigationRef,
    query: "replacement caption",
  });
  assert.equal(replacedCaption.hits.length, 0);

  await writeFile(
    sidecar,
    "WEBVTT\n\n00:00:00.500 --> 00:00:01.500\nreplacement caption\n",
  );
  const refreshed = await app.evidence.inspectVideo({
    source: first.sourceRef,
    freshness: "refresh",
  });
  assert.notEqual(refreshed.source.snapshotRevision, first.source.snapshotRevision);
  const freshFrames = await app.evidence.getFrames({
    investigationRef: refreshed.investigationRef,
    request: { kind: "points", timesMs: [1_000] },
  });
  assert.equal(freshFrames.kind, "exact_points");
  const freshFrame = app.store
    .listArtifacts(refreshed.sourceRef, refreshed.source.snapshotRevision)
    .find((artifact) => artifact.kind === "frame");
  assert(freshFrame);
  assert.deepEqual(
    await app.blobs.read(freshFrame.artifactId, freshFrame.blobPath, 8 * 1024 * 1024),
    await frameBytes(app, replacement, "expected-refreshed"),
  );
  const freshCaption = await app.evidence.searchTranscript({
    investigationRef: refreshed.investigationRef,
    query: "replacement caption",
  });
  assert.equal(freshCaption.hits.length, 1);

  await rm(sidecar);
  const noCaption = await app.evidence.inspectVideo({
    source: first.sourceRef,
    freshness: "refresh",
  });
  await writeFile(
    sidecar,
    "WEBVTT\n\n00:00:00.500 --> 00:00:01.500\nadded later\n",
  );
  await assert.rejects(
    app.evidence.searchTranscript({
      investigationRef: noCaption.investigationRef,
      query: "added later",
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "CAPTIONS_UNAVAILABLE",
  );
  const added = await app.evidence.inspectVideo({
    source: noCaption.sourceRef,
    freshness: "refresh",
  });
  const addedCaption = await app.evidence.searchTranscript({
    investigationRef: added.investigationRef,
    query: "added later",
  });
  assert.equal(addedCaption.hits.length, 1);
});

test("identical local sources reuse bytes without sharing frame or caption provenance", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "urma-local-provenance-"));
  const seed = path.join(directory, "seed.mp4");
  const videoA = path.join(directory, "source-a.mp4");
  const videoB = path.join(directory, "source-b.mp4");
  await makeVideo(seed, "blue");
  await copyFile(seed, videoA);
  await copyFile(seed, videoB);
  const app = await openUrma(
    loadConfig({
      URMA_DATA_DIR: path.join(directory, "data"),
      URMA_LOCAL_ROOTS: directory,
    }),
  );
  t.after(async () => {
    app.close();
    await rm(directory, { recursive: true, force: true });
  });

  const inspectedA = await app.evidence.inspectVideo({ source: videoA });
  const inspectedB = await app.evidence.inspectVideo({ source: videoB });
  assert.notEqual(inspectedA.sourceRef, inspectedB.sourceRef);
  assert.equal(
    inspectedA.source.snapshotRevision,
    inspectedB.source.snapshotRevision,
  );

  const framesA = await app.evidence.getFrames({
    investigationRef: inspectedA.investigationRef,
    request: { kind: "points", timesMs: [1_000] },
  });
  const framesB = await app.evidence.getFrames({
    investigationRef: inspectedB.investigationRef,
    request: { kind: "points", timesMs: [1_000] },
  });
  assert.equal(framesA.kind, "exact_points");
  assert.equal(framesB.kind, "exact_points");
  if (framesA.kind !== "exact_points" || framesB.kind !== "exact_points") {
    throw new Error("identical local sources did not return exact point frames");
  }
  assert(framesA.frames);
  assert(framesB.frames);
  assert.equal(framesA.frames[0]!.cacheHit, false);
  assert.equal(framesB.frames[0]!.cacheHit, false);
  const frameA = app.store
    .listArtifacts(inspectedA.sourceRef, inspectedA.source.snapshotRevision)
    .find((artifact) => artifact.kind === "frame");
  const frameB = app.store
    .listArtifacts(inspectedB.sourceRef, inspectedB.source.snapshotRevision)
    .find((artifact) => artifact.kind === "frame");
  assert(frameA);
  assert(frameB);
  assert.equal(frameA.artifactId, frameB.artifactId);
  assert.equal(frameA.sourceRef, inspectedA.sourceRef);
  assert.equal(frameB.sourceRef, inspectedB.sourceRef);
  assert.equal(framesA.frames[0]!.artifactId, frameA.artifactId);
  assert.equal(framesB.frames[0]!.artifactId, frameB.artifactId);
  assert(
    app.store.listPresentations(inspectedA.investigationRef)
      .some((presentation) => presentation.artifactId === frameA.artifactId),
  );
  assert(
    app.store.listPresentations(inspectedB.investigationRef)
      .some((presentation) => presentation.artifactId === frameB.artifactId),
  );

  const caption = "WEBVTT\n\n00:00:00.500 --> 00:00:01.500\nshared caption\n";
  await writeFile(path.join(directory, "source-a.vtt"), caption);
  await writeFile(path.join(directory, "source-b.vtt"), caption);
  const captionedA = await app.evidence.inspectVideo({
    source: videoA,
    freshness: "refresh",
  });
  const captionedB = await app.evidence.inspectVideo({
    source: videoB,
    freshness: "refresh",
  });
  const transcriptA = await app.evidence.searchTranscript({
    investigationRef: captionedA.investigationRef,
    query: "shared caption",
  });
  const transcriptB = await app.evidence.searchTranscript({
    investigationRef: captionedB.investigationRef,
    query: "shared caption",
  });
  assert.equal(transcriptA.hits.length, 1);
  assert.equal(transcriptB.hits.length, 1);
  const captionArtifactA = app.store
    .listArtifacts(captionedA.sourceRef, captionedA.source.snapshotRevision)
    .find((artifact) => artifact.kind === "caption");
  const captionArtifactB = app.store
    .listArtifacts(captionedB.sourceRef, captionedB.source.snapshotRevision)
    .find((artifact) => artifact.kind === "caption");
  assert(captionArtifactA);
  assert(captionArtifactB);
  assert.equal(captionArtifactA.artifactId, captionArtifactB.artifactId);
  assert.equal(captionArtifactA.sourceRef, captionedA.sourceRef);
  assert.equal(captionArtifactB.sourceRef, captionedB.sourceRef);
  assert(
    app.store.listPresentations(captionedA.investigationRef)
      .some((presentation) => presentation.artifactId === captionArtifactA.artifactId),
  );
  assert(
    app.store.listPresentations(captionedB.investigationRef)
      .some((presentation) => presentation.artifactId === captionArtifactB.artifactId),
  );
});
