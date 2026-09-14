import { putTestSource } from "../support/source-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EvidenceService } from "../../src/evidence/service.js";
import { StoryboardAcquirer } from "../../src/acquisition/storyboard.js";
import { loadConfig } from "../../src/config.js";
import {
  createInvestigationRef,
  remoteSourceRef,
  youtubeRemoteIdentity,
} from "../../src/core/ids.js";
import { deterministicRequestKey } from "../../src/core/request-key.js";
import type { ResolvedSource } from "../../src/sources/types.js";
import { candidateKeyForSourceFormat } from "../../src/sources/candidates.js";
import { runChecked } from "../../src/subprocess/runner.js";
import { BlobStore } from "../../src/store/blob-store.js";
import type { StoredArtifact } from "../../src/store/store.js";
import { SqliteStore } from "../../src/store/sqlite-store.js";

async function storyboardFixture(t: test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "urma-overview-"));
  const config = loadConfig({
    URMA_DATA_DIR: path.join(directory, "data"),
    URMA_FFMPEG: "ffmpeg",
  });
  const store = await SqliteStore.open(path.join(config.dataDir, "urma.db"));
  const blobs = new BlobStore(path.join(config.dataDir, "blobs"));
  await blobs.initialize();
  const sourceRef = remoteSourceRef(youtubeRemoteIdentity("yP0axVHdP-U"));
  const source: ResolvedSource = {
    sourceRef,
    kind: "remote",
    identity: { basis: "extractor", namespace: "youtube", id: "yP0axVHdP-U" },
    snapshotRef: { sourceRef, revision: "v1:test:yP0axVHdP-U" },
    canonicalKey: "yP0axVHdP-U",
    canonicalLocator: "https://www.youtube.com/watch?v=yP0axVHdP-U",
    revision: "v1:test:yP0axVHdP-U",
    observedAt: new Date(0).toISOString(),
    title: "Storyboard fixture",
    durationMs: 20_000,
    metadataDurationMs: 20_000,
    timeline: {
      finite: true,
      durationMs: 20_000,
      basis: "container",
      validatedAt: new Date(0).toISOString(),
    },
    extractor: "youtube",
    extractorKey: "yP0axVHdP-U",
    liveState: "finite",
    safeOrigins: ["https://www.youtube.com"],
    resolverVersion: "fixture",
    normalizationVersion: "remote-normalization-v1",
    policyVersion: "fixture",
    chapters: [],
    captionTracks: [],
    formats: [
      {
        id: "sb0",
        ext: "mhtml",
        protocol: "mhtml",
        width: 32,
        height: 18,
        fps: 0.2,
        videoCodec: null,
        audioCodec: null,
        estimatedBytes: null,
        rows: 1,
        columns: 2,
      },
    ],
    capabilities: {
      nativeCaptions: false,
      chapters: false,
      nativeStoryboard: true,
      targetedMedia: false,
      audio: false,
    },
    safeMetadata: {},
  };
  putTestSource(store, {
    sourceRef,
    kind: source.kind,
    canonicalKey: source.canonicalKey,
    revision: source.revision,
    title: source.title,
    durationMs: source.durationMs,
    metadata: {
      canonicalLocator: source.canonicalLocator,
      chapters: source.chapters,
      captionTracks: source.captionTracks,
      formats: source.formats,
      capabilities: source.capabilities,
      safeMetadata: source.safeMetadata,
    },
  });
  const investigationRef = createInvestigationRef(
    "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  );
  const now = new Date(0).toISOString();
  store.createInvestigation({
    investigationRef,
    sourceRef,
    sourceRevision: source.revision,
    durationMs: source.durationMs,
    createdAt: now,
    updatedAt: now,
  });
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    config,
    store,
    blobs,
    source,
    investigationRef,
    evidence: new EvidenceService(config, store, blobs),
  };
}

function mhtml(
  boundary: string,
  sheets: readonly { durationSeconds: number; bytes: Buffer }[],
): Buffer {
  const parts = sheets.map(({ durationSeconds, bytes }) =>
    Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${bytes.length}\r\nX.yt-dlp.Duration: ${
          durationSeconds.toFixed(6)
        }\r\n\r\n`,
      ),
      bytes,
      Buffer.from("\r\n"),
    ])
  );
  return Buffer.concat([
    Buffer.from(
      `Content-Type: multipart/related; boundary="${boundary}"\r\n\r\n`,
    ),
    ...parts,
    Buffer.from(`--${boundary}--\r\n`),
  ]);
}

test("scoped storyboard selection stays global and inside a window across a sheet boundary", async (t) => {
  const fixture = await storyboardFixture(t);
  const jpegPath = path.join(fixture.directory, "sheet.jpg");
  await runChecked(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=64x18:d=1:r=1",
      "-frames:v",
      "1",
      "-y",
      jpegPath,
    ],
    { timeoutMs: 30_000 },
  );
  const jpeg = await readFile(jpegPath);
  const blob = await fixture.blobs.put(
    mhtml("boundary", [
      { durationSeconds: 10, bytes: jpeg },
      { durationSeconds: 10, bytes: jpeg },
    ]),
  );
  const artifact: StoredArtifact = {
    artifactId: blob.artifactId,
    sourceRef: fixture.source.sourceRef,
    sourceRevision: fixture.source.revision,
    kind: "storyboard",
    role: "locator",
    mimeType: "multipart/related",
    sha256: blob.sha256,
    byteSize: blob.byteSize,
    blobPath: blob.relativePath,
    startMs: 0,
    endMs: fixture.source.durationMs,
    params: {
      candidateKey: candidateKeyForSourceFormat(fixture.source, fixture.source.formats[0]!),
      formatId: "sb0",
    },
    producer: {
      version: "storyboard-parser",
      cellWidth: 32,
      cellHeight: 18,
      fps: 0.2,
      columns: 2,
      rows: 1,
    },
    createdAt: new Date(0).toISOString(),
  };
  fixture.store.putArtifact(artifact, {
    requestKey: deterministicRequestKey(
      fixture.source.revision,
      "storyboard",
      {
        candidateKey: candidateKeyForSourceFormat(fixture.source, fixture.source.formats[0]!),
        formatId: "sb0",
      },
      "storyboard-parser",
    ),
    operation: "storyboard",
  });
  const working = await mkdtemp(path.join(fixture.directory, "work-"));
  try {
    const cases: readonly [
      number,
      number,
      readonly number[],
      readonly number[],
    ][] = [
      [5_000, 9_500, [5_000, 9_000], [5_000]],
      [9_500, 10_500, [9_500, 10_000, 10_400], [10_000]],
      [10_500, 16_000, [10_500, 15_000], [15_000]],
    ];
    for (const [startMs, endMs, requested, expected] of cases) {
      const result = await new StoryboardAcquirer(
        fixture.config,
        fixture.store,
        fixture.blobs,
      ).cells(
        fixture.source,
        fixture.investigationRef,
        requested,
        working,
        undefined,
        { startMs, endMs },
      );
      assert(result.pointsMs.length > 0);
      assert(
        result.pointsMs.every((point) => point >= startMs && point < endMs),
        `selected timestamps escaped the requested interval: ${
          result.pointsMs.join(",")
        }`,
      );
      assert.deepEqual(result.pointsMs, expected);
      assert.deepEqual(
        result.samples.map((sample) => [
          sample.fragmentIndex,
          sample.cellIndex,
        ]),
        expected.map((point) => [
          point >= 10_000 ? 1 : 0,
          point % 10_000 === 0 ? 0 : 1,
        ]),
      );
      assert.equal(result.cacheHit, true);
    }
    assert.equal(
      fixture.store.listAcquisitions(fixture.investigationRef).length,
      0,
    );
  } finally {
    await rm(working, { recursive: true, force: true });
  }
});

test("overview contract identifies irregular storyboard samples and repeated narrowing", async (t) => {
  const fixture = await storyboardFixture(t);
  const jpegPath = path.join(fixture.directory, "irregular-sheet.jpg");
  await runChecked(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=64x18:d=1:r=1",
      "-frames:v",
      "1",
      "-y",
      jpegPath,
    ],
    { timeoutMs: 30_000 },
  );
  const jpeg = await readFile(jpegPath);
  const blob = await fixture.blobs.put(
    mhtml("irregular-boundary", [
      { durationSeconds: 7, bytes: jpeg },
      { durationSeconds: 13, bytes: jpeg },
    ]),
  );
  const storyboard: StoredArtifact = {
    artifactId: blob.artifactId,
    sourceRef: fixture.source.sourceRef,
    sourceRevision: fixture.source.revision,
    kind: "storyboard",
    role: "locator",
    mimeType: "multipart/related",
    sha256: blob.sha256,
    byteSize: blob.byteSize,
    blobPath: blob.relativePath,
    startMs: 0,
    endMs: fixture.source.durationMs,
    params: {
      candidateKey: candidateKeyForSourceFormat(fixture.source, fixture.source.formats[0]!),
      formatId: "sb0",
    },
    producer: {
      version: "storyboard-parser",
      cellWidth: 32,
      cellHeight: 18,
      fps: 0.2,
      columns: 2,
      rows: 1,
    },
    createdAt: new Date(0).toISOString(),
  };
  fixture.store.putArtifact(storyboard, {
    requestKey: deterministicRequestKey(
      fixture.source.revision,
      "storyboard",
      {
        candidateKey: candidateKeyForSourceFormat(fixture.source, fixture.source.formats[0]!),
        formatId: "sb0",
      },
      "storyboard-parser",
    ),
    operation: "storyboard",
  });

  const wide = await fixture.evidence.getOverview({
    investigationRef: fixture.investigationRef,
  });
  assert.equal(wide.source, "native-storyboard");
  assert.deepEqual(
    wide.cells.map((cell) => cell.timestampMs),
    [0, 5_000, 7_000, 12_000],
  );
  assert.deepEqual(
    wide.observedCoverage.adjacentSpacingMs,
    [5_000, 2_000, 5_000],
  );
  assert.equal(wide.sampling.resolutionMs, null);
  assert.deepEqual(
    wide.cells.map((cell) => [
      cell.provenance.fragmentIndex,
      cell.provenance.cellIndex,
    ]),
    [
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ],
  );
  assert(
    wide.cells.every(
      (cell) =>
        cell.provenance.kind === "storyboard" &&
        cell.provenance.timing === "nominal",
    ),
  );
  assert(
    wide.cells.every(
      (cell) => cell.provenance.sourceArtifactId === storyboard.artifactId,
    ),
  );
  assert(
    wide.cells.every(
      (cell) =>
        cell.artifactId === wide.artifact.artifactId &&
        cell.resource === wide.artifact.resource,
    ),
  );

  const differentSubset = await fixture.evidence.getOverview({
    investigationRef: fixture.investigationRef,
    startMs: 5_500,
    endMs: 8_000,
  });
  assert.deepEqual(
    differentSubset.cells.map((cell) => cell.timestampMs),
    [7_000],
  );
  assert.equal(
    differentSubset.sampling.sampleReuse.relation,
    "different-subset",
  );
  assert.equal(
    differentSubset.sampling.sampleReuse.reusedUnderlyingSamples,
    true,
  );
  assert.deepEqual(differentSubset.requestedInterval, {
    startMs: 5_500,
    endMs: 8_000,
  });

  const sameSamples = await fixture.evidence.getOverview({
    investigationRef: fixture.investigationRef,
    startMs: 6_000,
    endMs: 7_500,
  });
  assert.deepEqual(
    sameSamples.cells.map((cell) => cell.timestampMs),
    [7_000],
  );
  assert.equal(sameSamples.sampling.sampleReuse.relation, "same-samples");
  assert.equal(sameSamples.sampling.sampleReuse.reusedUnderlyingSamples, true);
  assert.deepEqual(sameSamples.observedCoverage.sampleTimestampsMs, [7_000]);
  assert.deepEqual(sameSamples.observedCoverage.adjacentSpacingMs, []);

  const boundary = await fixture.evidence.getOverview({
    investigationRef: fixture.investigationRef,
    startMs: 7_000,
    endMs: 12_000,
  });
  assert.deepEqual(
    boundary.cells.map((cell) => cell.timestampMs),
    [7_000],
  );
  assert(
    boundary.cells.every(
      (cell) => cell.timestampMs >= 7_000 && cell.timestampMs < 12_000,
    ),
  );
  const repeated = await fixture.evidence.getOverview({
    investigationRef: fixture.investigationRef,
    startMs: 6_000,
    endMs: 7_500,
  });
  assert.equal(repeated.cacheHit, true);
  assert.equal(repeated.artifact.artifactId, sameSamples.artifact.artifactId);
  assert.deepEqual(repeated.cells, sameSamples.cells);
  assert.deepEqual(repeated.sampling, sameSamples.sampling);

  const state = fixture.evidence.state(fixture.investigationRef);
  assert.equal(state.evidence.overviewSets.length, 5);
  assert.equal(
    state.evidence.overviewSets.at(-1)?.sampleReuse.relation,
    "same-samples",
  );
  assert.deepEqual(
    state.evidence.overviewSets[0]?.observedCoverage.sampleTimestampsMs,
    [0, 5_000, 7_000, 12_000],
  );
});
