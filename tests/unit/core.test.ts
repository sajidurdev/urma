import assert from "node:assert/strict";
import test from "node:test";
import {
  artifactIdFromSha256,
  createInvestigationRef,
  localSourceRef,
  parseInvestigationRef,
  parseSourceRef,
  remoteSourceRef,
  youtubeRemoteIdentity,
} from "../../src/core/ids.js";
import {
  createOrderedVisualSet,
  createSparseVisualSet,
  largestUnsampledGaps,
  uniformPointsMs,
} from "../../src/core/coverage.js";
import { Singleflight } from "../../src/acquisition/singleflight.js";
import { chooseFrameTransport } from "../../src/acquisition/transport-policy.js";
import type { ResolvedSource } from "../../src/sources/types.js";
import { deterministicRequestKey } from "../../src/core/request-key.js";

test("provider identity makes equivalent YouTube forms share one sourceRef", () => {
  assert.equal(
    remoteSourceRef(youtubeRemoteIdentity("yP0axVHdP-U")),
    remoteSourceRef(youtubeRemoteIdentity("yP0axVHdP-U")),
  );
  assert.notEqual(
    localSourceRef("C:/video/a.mp4"),
    localSourceRef("C:/video/b.mp4"),
  );
  const remoteRef = remoteSourceRef(youtubeRemoteIdentity("yP0axVHdP-U"));
  assert.equal(parseSourceRef(remoteRef), remoteRef);
  assert.throws(() => parseSourceRef("urma:source:youtube:yP0axVHdP-U"));
  assert.throws(() => parseSourceRef("urma:source:youtube:not-valid"));
});

test("investigations are explicit opaque identities", () => {
  const ref = createInvestigationRef("12345678-1234-1234-1234-123456789abc");
  assert.equal(ref, "urma:investigation:12345678123412341234123456789abc");
  assert.equal(parseInvestigationRef(ref), ref);
  assert.throws(() => parseInvestigationRef("urma:investigation:active"));
});

test("uniform overview is fixed at twelve unique chronological points when possible", () => {
  const points = uniformPointsMs(0, 120_000);
  assert.equal(points.length, 12);
  assert.deepEqual(
    points,
    [...points].sort((a, b) => a - b),
  );
  assert(points.every((point) => point >= 0 && point < 120_000));
  assert.deepEqual(uniformPointsMs(0, 3), [0, 1, 2]);
});

test("nested sparse coverage remains two distinct evidence sets", () => {
  const parent = createSparseVisualSet(
    0,
    1_200_000,
    uniformPointsMs(0, 1_200_000),
    null,
  );
  const child = createSparseVisualSet(
    600_000,
    1_200_000,
    uniformPointsMs(600_000, 1_200_000),
    null,
  );
  assert.equal([parent, child].length, 2);
  assert.deepEqual(
    [parent, child].map((entry) => [entry.startMs, entry.endMs]),
    [
      [0, 1_200_000],
      [600_000, 1_200_000],
    ],
  );
});

test("ordered burst is sparse and never represented as a continuous interval", () => {
  const ids = [1, 2, 3].map((value) =>
    artifactIdFromSha256(String(value).repeat(64))
  );
  const burst = createOrderedVisualSet(
    1_000,
    4_000,
    [1_000, 2_000, 3_000],
    ids,
  );
  assert.equal(burst.kind, "ordered_points");
  assert.deepEqual(burst.pointsMs, [1_000, 2_000, 3_000]);
  assert.throws(() =>
    createOrderedVisualSet(1_000, 4_000, [1_000, 1_000], ids.slice(0, 2))
  );
});

test("remaining gaps derive only from presented point timestamps", () => {
  assert.deepEqual(largestUnsampledGaps(10_000, [2_000, 8_000], 2), [
    { startMs: 2_000, endMs: 8_000 },
    { startMs: 0, endMs: 2_000 },
  ]);
});

test("singleflight runs identical work once and one observer can cancel independently", async () => {
  const flight = new Singleflight();
  let runs = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const firstController = new AbortController();
  const worker = async (signal: AbortSignal) => {
    runs += 1;
    await gate;
    assert.equal(signal.aborted, false);
    return "artifact";
  };
  const first = flight.run("same", firstController.signal, worker);
  const second = flight.run("same", undefined, worker);
  firstController.abort();
  release();
  await assert.rejects(
    first,
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "CANCELLED",
  );
  assert.equal(await second, "artifact");
  assert.equal(runs, 1);
  assert.equal(flight.size, 0);
});

test("singleflight cancels shared work only when all observers detach and permits retry", async () => {
  const flight = new Singleflight();
  let runs = 0;
  const worker = (signal: AbortSignal) =>
    new Promise<string>((_resolve, reject) => {
      runs += 1;
      signal.addEventListener(
        "abort",
        () => reject(new Error("worker aborted")),
        { once: true },
      );
    });
  const a = new AbortController();
  const b = new AbortController();
  const first = flight.run("cancel-all", a.signal, worker);
  const second = flight.run("cancel-all", b.signal, worker);
  await new Promise((resolve) => setImmediate(resolve));
  a.abort();
  assert.equal(flight.size, 1);
  b.abort();
  await Promise.all([assert.rejects(first), assert.rejects(second)]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runs, 1);
  assert.equal(flight.size, 0);
  await assert.rejects(
    flight.run("retry", undefined, async () => {
      throw new Error("failure");
    }),
    /failure/,
  );
  assert.equal(
    await flight.run("retry", undefined, async () => "recovered"),
    "recovered",
  );
});

test("frame transport policy is deterministic and never selects progressive remote seeks", () => {
  const base = {
    kind: "remote",
    formats: [],
    capabilities: {},
  } as unknown as ResolvedSource;
  assert.equal(chooseFrameTransport(base).primary, "reusable-evidence");
  const hls = {
    ...base,
    formats: [
      {
        id: "hls",
        ext: "mp4",
        protocol: "m3u8_native",
        videoCodec: "avc1",
        audioCodec: null,
        width: 640,
        height: 360,
        fps: null,
        estimatedBytes: null,
        rows: null,
        columns: null,
      },
    ],
  } as unknown as ResolvedSource;
  assert.deepEqual(chooseFrameTransport(hls), {
    primary: "hls-bounded-section",
    fallback: "none",
    basis: "targetable-hls-advertised",
  });
  const progressive = {
    ...base,
    formats: [
      {
        id: "http",
        ext: "mp4",
        protocol: "https",
        videoCodec: "avc1",
        audioCodec: null,
        width: 640,
        height: 360,
        fps: null,
        estimatedBytes: 1000,
        rows: null,
        columns: null,
      },
    ],
  } as unknown as ResolvedSource;
  assert.equal(chooseFrameTransport(progressive).primary, "reusable-evidence");
});

test("request identity includes the producer identifier and remains distinct from content identity", () => {
  const first = deterministicRequestKey(
    "revision",
    "frame",
    { atMs: 1000 },
    "frame-extractor",
  );
  const second = deterministicRequestKey(
    "revision",
    "frame",
    { atMs: 2000 },
    "frame-extractor",
  );
  const changedProducer = deterministicRequestKey(
    "revision",
    "frame",
    { atMs: 1000 },
    "alternate-frame-extractor",
  );
  assert.notEqual(first, second);
  assert.notEqual(first, changedProducer);
  assert(!first.startsWith("urma:artifact:"));
});

test("singleflight removes observer abort listeners after settlement", async () => {
  const flight = new Singleflight();
  const controller = new AbortController();
  const signal = controller.signal;
  let added = 0;
  let removed = 0;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  Object.defineProperty(signal, "addEventListener", {
    value: (...args: Parameters<AbortSignal["addEventListener"]>) => {
      added += 1;
      return add(...args);
    },
  });
  Object.defineProperty(signal, "removeEventListener", {
    value: (...args: Parameters<AbortSignal["removeEventListener"]>) => {
      removed += 1;
      return remove(...args);
    },
  });
  assert.equal(
    await flight.run("listeners", signal, async () => "done"),
    "done",
  );
  assert.equal(added, 1);
  assert.equal(removed, 1);
});
