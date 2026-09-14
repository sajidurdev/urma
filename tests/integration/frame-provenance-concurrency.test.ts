import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openUrma } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { Ffmpeg } from "../../src/subprocess/ffmpeg.js";

test("real identical local frames share one extraction and admit both sources", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "urma-frame-provenance-probe-"),
  );
  const fixture = path.resolve("tests", "fixtures", "opaque-case-j.mp4");
  const videoA = path.join(directory, "source-a.mp4");
  const videoB = path.join(directory, "source-b.mp4");
  await copyFile(fixture, videoA);
  await copyFile(fixture, videoB);
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

  const originalExtractJpeg = Ffmpeg.prototype.extractJpeg;
  let physicalExtractionCount = 0;
  let releaseProducer!: () => void;
  const producerGate = new Promise<void>((resolve) => {
    releaseProducer = resolve;
  });
  let notifyProducerStarted!: () => void;
  const producerStarted = new Promise<void>((resolve) => {
    notifyProducerStarted = resolve;
  });
  Ffmpeg.prototype.extractJpeg = async function (
    this: Ffmpeg,
    media: string,
    atMs: number,
    output: string,
    signal?: AbortSignal,
  ): Promise<void> {
    physicalExtractionCount += 1;
    notifyProducerStarted();
    await producerGate;
    await originalExtractJpeg.call(this, media, atMs, output, signal);
  };
  t.after(() => {
    Ffmpeg.prototype.extractJpeg = originalExtractJpeg;
  });

  const request = {
    request: { kind: "points" as const, timesMs: [1_000] },
  };
  const first = app.evidence.getFrames({
    investigationRef: inspectedA.investigationRef,
    ...request,
  });
  await producerStarted;
  const second = app.evidence.getFrames({
    investigationRef: inspectedB.investigationRef,
    ...request,
  });
  releaseProducer();
  const [framesA, framesB] = await Promise.all([first, second]);

  assert.equal(framesA.kind, "exact_points");
  assert.equal(framesB.kind, "exact_points");
  if (framesA.kind !== "exact_points" || framesB.kind !== "exact_points") {
    throw new Error("Concurrent probe did not return exact_points");
  }
  assert.equal(physicalExtractionCount, 1);
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
  assert.equal(frameA.sourceRevision, inspectedA.source.snapshotRevision);
  assert.equal(frameB.sourceRevision, inspectedB.source.snapshotRevision);
  assert.equal(framesA.frames?.[0]?.artifactId, frameA.artifactId);
  assert.equal(framesB.frames?.[0]?.artifactId, frameB.artifactId);
  assert(
    app.store.listPresentations(inspectedA.investigationRef).some(
      (presentation) => presentation.artifactId === frameA.artifactId,
    ),
  );
  assert(
    app.store.listPresentations(inspectedB.investigationRef).some(
      (presentation) => presentation.artifactId === frameB.artifactId,
    ),
  );
});
