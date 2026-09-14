import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../../src/config.js";
import { UrmaError } from "../../src/core/errors.js";
import { deterministicRequestKey } from "../../src/core/request-key.js";
import {
  artifactIdFromSha256,
  createInvestigationRef,
  localSourceRef,
  type ArtifactId,
  type InvestigationRef,
} from "../../src/core/ids.js";
import { EvidenceService } from "../../src/evidence/service.js";
import type { ResolvedSource } from "../../src/sources/types.js";
import { BlobStore } from "../../src/store/blob-store.js";
import { SqliteStore } from "../../src/store/sqlite-store.js";
import type { StoredArtifact } from "../../src/store/store.js";
import { putTestSource } from "../support/source-fixture.js";
import { FrameAcquirer } from "../../src/acquisition/frames.js";

type FramesResult = Awaited<ReturnType<EvidenceService["getFrames"]>>;

function exactArtifactId(result: FramesResult): ArtifactId {
  if (result.kind !== "exact_points" || result.frames === undefined) {
    throw new Error(`Expected one exact frame, received ${result.kind}`);
  }
  const frame = result.frames[0];
  if (!frame) throw new Error("Exact frame result was empty");
  return frame.artifactId;
}

const REVISION = "local:identical-frame-concurrency";
const DURATION_MS = 10_000;
const AT_MS = 1_000;
const EMPTY_LOCAL_SNAPSHOT = {
  version: "local-snapshot-v1" as const,
  video: {
    artifactId: artifactIdFromSha256("0".repeat(64)),
    sha256: "0".repeat(64),
    byteSize: 1,
    blobPath: path.join("00", "00", "0".repeat(64)),
    extension: null,
  },
  caption: null,
};

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "urma-frame-provenance-concurrency-"),
  );
  const config = loadConfig({ URMA_DATA_DIR: path.join(directory, "data") });
  const store = await SqliteStore.open(path.join(config.dataDir, "urma.db"));
  const blobs = new BlobStore(path.join(config.dataDir, "blobs"));
  await blobs.initialize();

  const sourcePathA = path.join(directory, "source-a.mp4");
  const sourcePathB = path.join(directory, "source-b.mp4");
  const sourcePathC = path.join(directory, "source-c.mp4");
  const sourceA = localSourceRef(sourcePathA);
  const sourceB = localSourceRef(sourcePathB);
  const sourceC = localSourceRef(sourcePathC);
  const investigationA = createInvestigationRef(
    "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  );
  const investigationB = createInvestigationRef(
    "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  );
  const investigationC = createInvestigationRef(
    "cccccccc-cccc-cccc-cccc-cccccccccccc",
  );
  const now = new Date(0).toISOString();
  for (const [sourceRef, sourcePath, title] of [
    [sourceA, sourcePathA, "Source A"],
    [sourceB, sourcePathB, "Source B"],
    [sourceC, sourcePathC, "Source C"],
  ] as const) {
    putTestSource(store, {
      sourceRef,
      kind: "local",
      canonicalKey: sourcePath,
      revision: REVISION,
      title,
      durationMs: DURATION_MS,
      metadata: {
        safeMetadata: { localSnapshot: EMPTY_LOCAL_SNAPSHOT },
      },
    });
  }
  store.createInvestigation({
    investigationRef: investigationA,
    sourceRef: sourceA,
    sourceRevision: REVISION,
    durationMs: DURATION_MS,
    createdAt: now,
    updatedAt: now,
  });
  store.createInvestigation({
    investigationRef: investigationB,
    sourceRef: sourceB,
    sourceRevision: REVISION,
    durationMs: DURATION_MS,
    createdAt: now,
    updatedAt: now,
  });
  store.createInvestigation({
    investigationRef: investigationC,
    sourceRef: sourceC,
    sourceRevision: REVISION,
    durationMs: DURATION_MS,
    createdAt: now,
    updatedAt: now,
  });

  const service = new EvidenceService(config, store, blobs);
  let extractionCount = 0;
  let failProducer = false;
  let releaseProducer!: () => void;
  const producerGate = new Promise<void>((resolve) => {
    releaseProducer = resolve;
  });
  let notifyProducerStarted!: () => void;
  const producerStarted = new Promise<void>((resolve) => {
    notifyProducerStarted = resolve;
  });

  const fakeFrames = {
    async get(
      source: ResolvedSource,
      _ref: InvestigationRef,
      timesMs: readonly number[],
    ): Promise<Array<{ atMs: number; artifact: StoredArtifact; cacheHit: boolean }>> {
      extractionCount += 1;
      notifyProducerStarted();
      await producerGate;
      if (failProducer) throw new Error("shared frame acquisition failed");
      const atMs = timesMs[0]!;
      const blob = await blobs.put(Buffer.from("shared-jpeg", "utf8"));
      const artifact: StoredArtifact = {
        artifactId: blob.artifactId,
        sourceRef: source.sourceRef,
        sourceRevision: source.revision,
        kind: "frame",
        role: "evidence",
        mimeType: "image/jpeg",
        sha256: blob.sha256,
        byteSize: blob.byteSize,
        blobPath: blob.relativePath,
        startMs: atMs,
        endMs: atMs,
        params: { atMs, format: "jpeg" },
        producer: { version: "test-frame-extractor" },
        createdAt: now,
      };
      store.putArtifact(
        artifact,
        {
          requestKey: deterministicRequestKey(
            source.revision,
            "frame",
            { sourceRef: source.sourceRef, atMs, format: "jpeg" },
            "frame-extractor",
          ),
          operation: "frame",
        },
      );
      return [{ atMs, artifact, cacheHit: false }];
    },
  };
  (service as unknown as { frames: FrameAcquirer }).frames =
    fakeFrames as unknown as FrameAcquirer;

  t.after(() => {
    store.close();
    return rm(directory, { recursive: true, force: true });
  });
  return {
    service,
    store,
    sourceA,
    sourceB,
    sourceC,
    investigationA,
    investigationB,
    investigationC,
    producerStarted,
    releaseProducer,
    setFailProducer(value: boolean) {
      failProducer = value;
    },
    get extractionCount() {
      return extractionCount;
    },
  };
}

test("concurrent identical-frame waiters need source-specific occurrences", async (t) => {
  const ctx = await fixture(t);
  const request = {
    request: { kind: "points" as const, timesMs: [AT_MS] },
  };
  const first = ctx.service.getFrames({
    investigationRef: ctx.investigationA,
    ...request,
  });
  await ctx.producerStarted;
  const second = ctx.service.getFrames({
    investigationRef: ctx.investigationB,
    ...request,
  });
  ctx.releaseProducer();
  const [resultA, resultB] = await Promise.all([first, second]);

  const artifactIdA = exactArtifactId(resultA);
  const artifactIdB = exactArtifactId(resultB);
  assert.equal(ctx.extractionCount, 1);
  assert.equal(artifactIdA, artifactIdB);
  const artifactsA = ctx.store.listArtifacts(ctx.sourceA, REVISION);
  const artifactsB = ctx.store.listArtifacts(ctx.sourceB, REVISION);
  assert.equal(artifactsA.length, 1);
  assert.equal(artifactsB.length, 1);
  assert.equal(artifactsA[0]?.sourceRef, ctx.sourceA);
  assert.equal(artifactsB[0]?.sourceRef, ctx.sourceB);
  assert.equal(artifactsA[0]?.sourceRevision, REVISION);
  assert.equal(artifactsB[0]?.sourceRevision, REVISION);
  assert.equal(artifactsA[0]?.artifactId, artifactIdA);
  assert.equal(artifactsB[0]?.artifactId, artifactIdB);
  assert.equal(ctx.store.listPresentations(ctx.investigationA).length, 1);
  assert.equal(ctx.store.listPresentations(ctx.investigationB).length, 1);
  assert(ctx.store.isArtifactPresented(ctx.investigationA, artifactIdA));
  assert(ctx.store.isArtifactPresented(ctx.investigationB, artifactIdB));
  assert.equal(ctx.store.cacheStats().artifacts, 1);
});

test("three concurrent identical-frame waiters each receive provenance", async (t) => {
  const ctx = await fixture(t);
  const request = {
    request: { kind: "points" as const, timesMs: [AT_MS] },
  };
  const first = ctx.service.getFrames({
    investigationRef: ctx.investigationA,
    ...request,
  });
  await ctx.producerStarted;
  const second = ctx.service.getFrames({
    investigationRef: ctx.investigationB,
    ...request,
  });
  const third = ctx.service.getFrames({
    investigationRef: ctx.investigationC,
    ...request,
  });
  ctx.releaseProducer();
  const results = await Promise.all([first, second, third]);
  const artifactIds = results.map(exactArtifactId);

  assert.equal(ctx.extractionCount, 1);
  assert.equal(new Set(artifactIds).size, 1);
  for (const [sourceRef, investigationRef] of [
    [ctx.sourceA, ctx.investigationA],
    [ctx.sourceB, ctx.investigationB],
    [ctx.sourceC, ctx.investigationC],
  ] as const) {
    const artifacts = ctx.store.listArtifacts(sourceRef, REVISION);
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0]?.sourceRef, sourceRef);
    assert.equal(artifacts[0]?.sourceRevision, REVISION);
    assert.equal(artifacts[0]?.artifactId, artifactIds[0]);
    assert.equal(ctx.store.listPresentations(investigationRef).length, 1);
    assert(
      ctx.store.isArtifactPresented(
        investigationRef,
        artifacts[0]!.artifactId,
      ),
    );
  }
  assert.equal(ctx.store.cacheStats().artifacts, 1);
});

test("same-source duplicate waiters keep one idempotent occurrence", async (t) => {
  const ctx = await fixture(t);
  const request = {
    request: { kind: "points" as const, timesMs: [AT_MS] },
  };
  const first = ctx.service.getFrames({
    investigationRef: ctx.investigationA,
    ...request,
  });
  await ctx.producerStarted;
  const second = ctx.service.getFrames({
    investigationRef: ctx.investigationA,
    ...request,
  });
  assert.equal(ctx.service.singleflight.size, 1);
  ctx.releaseProducer();
  const [resultA, resultB] = await Promise.all([first, second]);

  const artifactIdA = exactArtifactId(resultA);
  const artifactIdB = exactArtifactId(resultB);
  assert.equal(ctx.extractionCount, 1);
  assert.equal(artifactIdA, artifactIdB);
  assert.equal(ctx.store.listArtifacts(ctx.sourceA, REVISION).length, 1);
  assert.equal(ctx.store.listPresentations(ctx.investigationA).length, 2);
  assert(ctx.store.isArtifactPresented(ctx.investigationA, artifactIdA));
  assert.equal(ctx.store.cacheStats().artifacts, 1);
});

test("shared frame failure creates no waiter occurrence or presentation", async (t) => {
  const ctx = await fixture(t);
  ctx.setFailProducer(true);
  const request = {
    request: { kind: "points" as const, timesMs: [AT_MS] },
  };
  const first = ctx.service.getFrames({
    investigationRef: ctx.investigationA,
    ...request,
  });
  await ctx.producerStarted;
  const second = ctx.service.getFrames({
    investigationRef: ctx.investigationB,
    ...request,
  });
  ctx.releaseProducer();
  const results = await Promise.allSettled([first, second]);

  assert(results.every((result) => result.status === "rejected"));
  assert.equal(ctx.store.listArtifacts(ctx.sourceA, REVISION).length, 0);
  assert.equal(ctx.store.listArtifacts(ctx.sourceB, REVISION).length, 0);
  assert.equal(ctx.store.listPresentations(ctx.investigationA).length, 0);
  assert.equal(ctx.store.listPresentations(ctx.investigationB).length, 0);
  assert.equal(ctx.store.cacheStats().artifacts, 0);
});

test("canceled waiter does not admit a shared result", async (t) => {
  const ctx = await fixture(t);
  const request = {
    request: { kind: "points" as const, timesMs: [AT_MS] },
  };
  const first = ctx.service.getFrames({
    investigationRef: ctx.investigationA,
    ...request,
  });
  await ctx.producerStarted;
  const controller = new AbortController();
  const second = ctx.service.getFrames(
    {
      investigationRef: ctx.investigationB,
      ...request,
    },
    controller.signal,
  );
  assert.equal(ctx.service.singleflight.size, 1);
  controller.abort();
  ctx.releaseProducer();
  const [resultA, resultB] = await Promise.allSettled([first, second]);

  assert.equal(resultA.status, "fulfilled");
  assert.equal(resultB.status, "rejected");
  if (resultB.status === "rejected") {
    assert(resultB.reason instanceof UrmaError);
    assert.equal(resultB.reason.code, "CANCELLED");
  }
  assert.equal(ctx.store.listArtifacts(ctx.sourceA, REVISION).length, 1);
  assert.equal(ctx.store.listArtifacts(ctx.sourceB, REVISION).length, 0);
  assert.equal(ctx.store.listPresentations(ctx.investigationA).length, 1);
  assert.equal(ctx.store.listPresentations(ctx.investigationB).length, 0);
});
