import { putTestSource } from "../support/source-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FrameAcquirer } from "../../src/acquisition/frames.js";
import { loadConfig } from "../../src/config.js";
import { UrmaError } from "../../src/core/errors.js";
import { deterministicRequestKey } from "../../src/core/request-key.js";
import {
  createInvestigationRef,
  localSourceRef,
  remoteSourceRef,
} from "../../src/core/ids.js";
import { EvidenceService } from "../../src/evidence/service.js";
import type { ResolvedSource } from "../../src/sources/types.js";
import { BlobStore } from "../../src/store/blob-store.js";
import { SqliteStore } from "../../src/store/sqlite-store.js";
import type { StoredArtifact } from "../../src/store/store.js";

type FramesOutput = Awaited<ReturnType<EvidenceService["getFrames"]>>;
type ScheduleOutput = Extract<
  FramesOutput,
  { kind: "scheduled_exact_points" }
>;

function scheduleOutput(output: FramesOutput): ScheduleOutput {
  if (output.kind !== "scheduled_exact_points") {
    throw new Error(`Expected scheduled frame output, received ${output.kind}`);
  }
  return output;
}

async function fixture(
  t: test.TestContext,
  options: Readonly<{ largeRemoteFormat?: boolean }> = {},
) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "urma-frame-schedule-"),
  );
  const config = loadConfig({ URMA_DATA_DIR: path.join(directory, "data") });
  const store = await SqliteStore.open(path.join(config.dataDir, "urma.db"));
  const blobs = new BlobStore(path.join(config.dataDir, "blobs"));
  await blobs.initialize();
  const locator = path.join(directory, "fixture.mp4");
  const remoteFixture = options.largeRemoteFormat === true;
  const sourceRef = remoteFixture
    ? remoteSourceRef({
      basis: "extractor",
      namespace: "fixture",
      id: "large-cursor-fixture",
    })
    : localSourceRef(locator);
  const ref = createInvestigationRef("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
  const canonicalKey = remoteFixture ? "large-cursor-fixture" : locator;
  const formats = remoteFixture
    ? [{
      id: `format-${"x".repeat(1_500)}`,
      ext: "mp4",
      protocol: "https",
      width: 640,
      height: 360,
      fps: 30,
      videoCodec: "h264",
      audioCodec: "aac",
      estimatedBytes: 1_000_000,
      rows: null,
      columns: null,
    }]
    : [];
  const resolved: ResolvedSource = {
    sourceRef,
    kind: remoteFixture ? "remote" : "local",
    identity: remoteFixture
      ? { basis: "extractor", namespace: "fixture", id: canonicalKey }
      : null,
    snapshotRef: { sourceRef, revision: "local:test-revision" },
    canonicalKey,
    canonicalLocator: remoteFixture
      ? "https://fixture.example/video/large-cursor-fixture"
      : locator,
    revision: "local:test-revision",
    observedAt: new Date(0).toISOString(),
    title: "schedule fixture",
    durationMs: 120_000,
    metadataDurationMs: 120_000,
    timeline: {
      finite: true,
      durationMs: 120_000,
      basis: "container",
      validatedAt: new Date(0).toISOString(),
    },
    extractor: remoteFixture ? "fixture" : null,
    extractorKey: remoteFixture ? "fixture" : null,
    liveState: "finite",
    safeOrigins: remoteFixture ? ["https://fixture.example"] : [],
    resolverVersion: "fixture",
    normalizationVersion: "local-v1",
    policyVersion: "fixture",
    chapters: [],
    captionTracks: [],
    formats,
    capabilities: {
      nativeCaptions: false,
      chapters: false,
      nativeStoryboard: false,
      targetedMedia: false,
      audio: false,
    },
    safeMetadata: {},
  };
  const now = new Date(0).toISOString();
  putTestSource(store, {
    sourceRef,
    kind: resolved.kind,
    canonicalKey: locator,
    revision: resolved.revision,
    title: resolved.title,
    durationMs: resolved.durationMs,
    metadata: {
      canonicalLocator: remoteFixture
        ? "https://fixture.example/video/large-cursor-fixture"
        : locator,
      chapters: [],
      captionTracks: [],
      formats,
      capabilities: resolved.capabilities,
      safeMetadata: remoteFixture
        ? {}
        : {
          localSnapshot: {
            version: "local-snapshot-v1",
            video: {
              artifactId: `urma:artifact:sha256:${"0".repeat(64)}`,
              sha256: "0".repeat(64),
              byteSize: 1,
              blobPath: path.join("00", "00", "0".repeat(64)),
              extension: null,
            },
            caption: null,
          },
        },
    },
  });
  store.createInvestigation({
    investigationRef: ref,
    sourceRef,
    sourceRevision: resolved.revision,
    durationMs: resolved.durationMs,
    createdAt: now,
    updatedAt: now,
  });
  const service = new EvidenceService(config, store, blobs);
  const calls: number[][] = [];
  const errors = new Map<number, unknown>();
  let unfinishedAt: number | null = null;
  let unfinishedOnce = false;
  let shareArtifact = false;
  const artifacts = new Map<number, StoredArtifact>();
  const ensureArtifact = async (atMs: number): Promise<StoredArtifact> => {
    const existing = artifacts.get(atMs);
    if (existing) return existing;
    const blob = await blobs.put(Buffer.from(`jpeg-${atMs}`, "utf8"));
    const artifact: StoredArtifact = {
      artifactId: blob.artifactId,
      sourceRef,
      sourceRevision: resolved.revision,
      kind: "frame",
      role: "evidence",
      mimeType: "image/jpeg",
      sha256: blob.sha256,
      byteSize: blob.byteSize,
      blobPath: blob.relativePath,
      startMs: atMs,
      endMs: atMs,
      params: { atMs, format: "jpeg" },
      producer: {
        version: "frame-extractor",
        transportArtifactId: null,
      },
      createdAt: new Date(0).toISOString(),
    };
    store.putArtifact(
      artifact,
      {
        requestKey: deterministicRequestKey(
          resolved.revision,
          "frame",
          { atMs, format: "jpeg" },
          "frame-extractor",
        ),
        operation: "frame",
      },
    );
    artifacts.set(atMs, artifact);
    return artifact;
  };
  const fakeFrames = {
    async getOutcomes(
      _source: ResolvedSource,
      _investigationRef: typeof ref,
      timesMs: readonly number[],
    ) {
      calls.push([...timesMs]);
      const outcomes = [];
      for (const atMs of timesMs) {
        const error = errors.get(atMs);
        if (error !== undefined) {
          outcomes.push({ status: "error" as const, atMs, error });
          continue;
        }
        if (unfinishedAt === atMs && !unfinishedOnce) {
          unfinishedOnce = true;
          outcomes.push({ status: "unfinished" as const, atMs });
          continue;
        }
        const artifactAtMs = shareArtifact ? 0 : atMs;
        const cacheHit = artifacts.has(artifactAtMs);
        outcomes.push({
          status: "success" as const,
          atMs,
          artifact: await ensureArtifact(artifactAtMs),
          cacheHit,
        });
      }
      return outcomes;
    },
    async get(
      _source: ResolvedSource,
      _investigationRef: typeof ref,
      timesMs: readonly number[],
    ) {
      const outcomes = await this.getOutcomes(
        _source,
        _investigationRef,
        timesMs,
      );
      return outcomes.map((outcome) => {
        if (outcome.status === "success") return outcome;
        throw outcome.status === "error"
          ? outcome.error
          : new Error("unfinished");
      });
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
    ref,
    calls,
    errors,
    setUnfinishedAt(value: number | null) {
      unfinishedAt = value;
      unfinishedOnce = false;
    },
    setSharedArtifact(value: boolean) {
      shareArtifact = value;
    },
  };
}

test("cadence pages derive stable targets and allow page-size changes", async (t) => {
  const ctx = await fixture(t);
  const first = scheduleOutput(
    await ctx.service.getFrames({
      investigationRef: ctx.ref,
      request: { kind: "cadence", startMs: 0, endMs: 30_000, cadenceMs: 1_000 },
    }),
  );
  assert.equal(first.schedule.totalTargets, 30);
  assert.deepEqual(
    first.slots.map((slot) => slot.requestedAtMs),
    Array.from({ length: 12 }, (_, index) => index * 1_000),
  );
  assert.equal(first.page.startIndex, 0);
  assert.equal(first.page.endIndexExclusive, 12);
  assert.equal(first.scheduleComplete, false);
  assert.equal(first.counts.successes, 12);
  assert.equal(first.counts.errors, 0);
  assert.equal(first.counts.unfinished, 0);
  assert.equal(first.continuationFrontier, 12);
  assert(first.nextCursor);

  const second = scheduleOutput(
    await ctx.service.getFrames({
      investigationRef: ctx.ref,
      cursor: first.nextCursor,
      pageSize: 5,
      presentation: "individual",
    }),
  );
  assert.equal(second.page.startIndex, 12);
  assert.equal(second.page.endIndexExclusive, 17);
  assert.deepEqual(
    second.slots.map((slot) => slot.requestedAtMs),
    [12_000, 13_000, 14_000, 15_000, 16_000],
  );
  assert.equal(second.schedule.startMs, first.schedule.startMs);
  assert.equal(second.schedule.cadenceMs, first.schedule.cadenceMs);
  assert.notEqual(second.nextCursor, first.nextCursor);
  const replay = scheduleOutput(
    await ctx.service.getFrames({
      investigationRef: ctx.ref,
      cursor: first.nextCursor,
      pageSize: 5,
      presentation: "individual",
    }),
  );
  assert.deepEqual(
    replay.slots.map((slot) => ({
      index: slot.index,
      requestedAtMs: slot.requestedAtMs,
      status: slot.status,
      artifactId: slot.status === "success" ? slot.artifactId : null,
    })),
    second.slots.map((slot) => ({
      index: slot.index,
      requestedAtMs: slot.requestedAtMs,
      status: slot.status,
      artifactId: slot.status === "success" ? slot.artifactId : null,
    })),
  );
  assert.equal(replay.nextCursor, second.nextCursor);
  assert.equal(ctx.calls.length, 3);
  assert.deepEqual(ctx.calls[1], [12_000, 13_000, 14_000, 15_000, 16_000]);
  assert.deepEqual(ctx.calls[2], ctx.calls[1]);
});

test("a thirty-target schedule continues as twelve, twelve, and six without redistribution", async (t) => {
  const ctx = await fixture(t);
  const pages = [];
  let cursor: string | undefined;
  for (let page = 0; page < 3; page += 1) {
    const output = scheduleOutput(
      await ctx.service.getFrames({
        investigationRef: ctx.ref,
        ...(cursor === undefined
          ? {
            request: {
              kind: "cadence" as const,
              startMs: 0,
              endMs: 30_000,
              cadenceMs: 1_000,
            },
          }
          : { cursor }),
      }),
    );
    pages.push(output);
    if (page < 2) assert(output.nextCursor);
    cursor = output.nextCursor ?? undefined;
  }
  assert.deepEqual(
    pages.map((
      output,
    ) => [output.page.startIndex, output.page.endIndexExclusive]),
    [
      [0, 12],
      [12, 24],
      [24, 30],
    ],
  );
  assert.deepEqual(
    pages.flatMap((output) => output.slots.map((slot) => slot.requestedAtMs)),
    Array.from({ length: 30 }, (_, index) => index * 1_000),
  );
  assert.equal(pages[2]?.nextCursor, null);
  assert.deepEqual(ctx.calls, [
    Array.from({ length: 12 }, (_, index) => index * 1_000),
    Array.from({ length: 12 }, (_, index) => (index + 12) * 1_000),
    Array.from({ length: 6 }, (_, index) => (index + 24) * 1_000),
  ]);
});

test("cadence admission rejects oversized and pathological schedules before frame work", async (t) => {
  const ctx = await fixture(t);
  await assert.rejects(
    ctx.service.getFrames({
      investigationRef: ctx.ref,
      request: { kind: "cadence", startMs: 0, endMs: 121, cadenceMs: 1 },
    }),
    (error: unknown) => {
      assert(error instanceof UrmaError);
      assert.equal(error.code, "OUTPUT_LIMIT_EXCEEDED");
      assert.match(error.message, /121.*120|120.*121/u);
      assert.equal(error.detail.computedTargetCount, 121);
      assert.equal(error.detail.applicableMaximum, 120);
      return true;
    },
  );
  await assert.rejects(
    ctx.service.getFrames({
      investigationRef: ctx.ref,
      request: { kind: "cadence", startMs: 0, endMs: 72_000, cadenceMs: 1 },
    }),
    /72000.*120|120.*72000/u,
  );
  await assert.rejects(
    ctx.service.getFrames({
      investigationRef: ctx.ref,
      request: { kind: "cadence", startMs: 0, endMs: 4, cadenceMs: 1 },
      maxTargets: 3,
    }),
    (error: unknown) => {
      assert(error instanceof UrmaError);
      assert.equal(error.code, "OUTPUT_LIMIT_EXCEEDED");
      assert.equal(error.detail.computedTargetCount, 4);
      assert.equal(error.detail.applicableMaximum, 3);
      return true;
    },
  );
  assert.equal(ctx.calls.length, 0);
});

test("cadence slots retain target errors and resume from the first unfinished index", async (t) => {
  const ctx = await fixture(t);
  ctx.errors.set(2_000, new UrmaError("FRAME_EXTRACTION_FAILED", "bad target"));
  ctx.setUnfinishedAt(3_000);
  const first = scheduleOutput(
    await ctx.service.getFrames({
      investigationRef: ctx.ref,
      request: { kind: "cadence", startMs: 0, endMs: 8_000, cadenceMs: 1_000 },
      pageSize: 5,
    }),
  );
  assert.deepEqual(
    first.slots.map((slot) => slot.status),
    ["success", "success", "error", "unfinished", "success"],
  );
  assert.equal(first.scheduleComplete, false);
  assert.equal(first.continuationFrontier, 3);
  assert.equal(first.remainingTargetCount, 5);
  assert(first.nextCursor);

  const second = scheduleOutput(
    await ctx.service.getFrames({
      investigationRef: ctx.ref,
      cursor: first.nextCursor,
      pageSize: 5,
    }),
  );
  assert.equal(second.page.startIndex, 3);
  assert.deepEqual(
    second.slots.map((slot) => slot.requestedAtMs),
    [3_000, 4_000, 5_000, 6_000, 7_000],
  );
  assert.equal(second.counts.errors, 0);
  assert.equal(second.scheduleComplete, true);
  assert.equal(second.nextCursor, null);
});

test("cadence cursors reject tampering instead of rebinding evidence", async (t) => {
  const ctx = await fixture(t);
  const first = scheduleOutput(
    await ctx.service.getFrames({
      investigationRef: ctx.ref,
      request: { kind: "cadence", startMs: 10, endMs: 2_010, cadenceMs: 333 },
      pageSize: 2,
    }),
  );
  assert(first.nextCursor);
  const cursor = `${first.nextCursor.slice(0, -1)}${
    first.nextCursor.endsWith("A") ? "B" : "A"
  }`;
  await assert.rejects(
    ctx.service.getFrames({ investigationRef: ctx.ref, cursor }),
    (error: unknown) => {
      assert(error instanceof UrmaError);
      assert.equal(error.code, "INVALID_SOURCE");
      return true;
    },
  );
});

test("cadence-only controls cannot be attached to explicit requests or combined with a cursor", async (t) => {
  const ctx = await fixture(t);
  await assert.rejects(
    ctx.service.getFrames({
      investigationRef: ctx.ref,
      request: { kind: "points", timesMs: [0] },
      pageSize: 1,
    }),
    (error: unknown) => {
      assert(error instanceof UrmaError);
      assert.equal(error.code, "INVALID_SOURCE");
      return true;
    },
  );
  const first = scheduleOutput(
    await ctx.service.getFrames({
      investigationRef: ctx.ref,
      request: { kind: "cadence", startMs: 0, endMs: 30_000, cadenceMs: 1_000 },
    }),
  );
  assert(first.nextCursor);
  await assert.rejects(
    ctx.service.getFrames({
      investigationRef: ctx.ref,
      cursor: first.nextCursor,
      request: { kind: "cadence", startMs: 0, endMs: 30_000, cadenceMs: 1_000 },
    }),
    (error: unknown) => {
      assert(error instanceof UrmaError);
      assert.equal(error.code, "INVALID_SOURCE");
      return true;
    },
  );
});

test("explicit and cadence requests submit the same current-page target plan for one, four, and twelve points", async (t) => {
  const ctx = await fixture(t);
  for (const count of [1, 4, 12]) {
    const targets = Array.from({ length: count }, (_, index) => index * 1_000);
    await ctx.service.getFrames({
      investigationRef: ctx.ref,
      request: { kind: "points", timesMs: targets },
    });
    assert.equal(ctx.calls.length, 1);
    const explicitPlan = ctx.calls[0];
    ctx.calls.length = 0;
    await ctx.service.getFrames({
      investigationRef: ctx.ref,
      request: {
        kind: "cadence",
        startMs: 0,
        endMs: count * 1_000,
        cadenceMs: 1_000,
      },
      pageSize: count,
    });
    assert.equal(ctx.calls.length, 1);
    assert.deepEqual(ctx.calls[0], explicitPlan);
    ctx.calls.length = 0;
  }
});

test("scheduled slots remain distinct when existing canonical identity shares one frame resource", async (t) => {
  const ctx = await fixture(t);
  ctx.setSharedArtifact(true);
  const output = scheduleOutput(
    await ctx.service.getFrames({
      investigationRef: ctx.ref,
      request: { kind: "cadence", startMs: 0, endMs: 3_000, cadenceMs: 1_000 },
    }),
  );
  assert.deepEqual(
    output.slots.map((slot) => slot.index),
    [0, 1, 2],
  );
  assert.deepEqual(
    output.slots.map((slot) => slot.requestedAtMs),
    [0, 1_000, 2_000],
  );
  assert.equal(
    new Set(
      output.slots
        .filter((slot) => slot.status === "success")
        .map((slot) => slot.artifactId),
    ).size,
    1,
  );
  assert.equal(ctx.calls.length, 1);
});

test("a cancelled cadence request does not start page or future-page work", async (t) => {
  const ctx = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    ctx.service.getFrames(
      {
        investigationRef: ctx.ref,
        request: {
          kind: "cadence",
          startMs: 0,
          endMs: 30_000,
          cadenceMs: 1_000,
        },
      },
      controller.signal,
    ),
    (error: unknown) => {
      assert(error instanceof UrmaError);
      assert.equal(error.code, "CANCELLED");
      return true;
    },
  );
  assert.deepEqual(ctx.calls, []);
});

test("cadence continuation cursors stay within the MCP field budget for long remote representations", async (t) => {
  const ctx = await fixture(t, { largeRemoteFormat: true });
  const first = scheduleOutput(
    await ctx.service.getFrames({
      investigationRef: ctx.ref,
      request: { kind: "cadence", startMs: 0, endMs: 30_000, cadenceMs: 1_000 },
      pageSize: 1,
    }),
  );
  assert(first.nextCursor);
  assert(first.nextCursor.length <= 1_024);
  const second = scheduleOutput(
    await ctx.service.getFrames({
      investigationRef: ctx.ref,
      cursor: first.nextCursor,
      pageSize: 1,
    }),
  );
  assert.equal(second.page.startIndex, 1);
  assert.equal(second.slots[0]?.requestedAtMs, 1_000);
});
