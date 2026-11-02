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
  summarizeSamplingGaps,
  uniformPointsMs,
} from "../../src/core/coverage.js";
import { Singleflight } from "../../src/acquisition/singleflight.js";
import { chooseFrameTransport } from "../../src/acquisition/transport-policy.js";
import type { ResolvedSource } from "../../src/sources/types.js";
import { deterministicRequestKey } from "../../src/core/request-key.js";

test("source references distinguish local paths and reject legacy YouTube forms", () => {
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

test("sampling gaps include scoped boundaries and sort reported points without changing them", () => {
  const points = [6_000, 3_000, 6_000, 0, 10_000];
  assert.deepEqual(summarizeSamplingGaps(1_000, 10_000, points, "nominal"), {
    scope: "response",
    interval: { startMs: 1_000, endMs: 10_000 },
    timestampBasis: "nominal",
    largestGaps: [
      { startMs: 6_000, endMs: 10_000, durationSeconds: 4 },
      { startMs: 3_000, endMs: 6_000, durationSeconds: 3 },
      { startMs: 1_000, endMs: 3_000, durationSeconds: 2 },
    ],
  });
  assert.deepEqual(points, [6_000, 3_000, 6_000, 0, 10_000]);
});

test("sampling gaps handle no returned frames, tiny scopes, and safe integer boundaries", () => {
  const cases: [number, number, number[], unknown][] = [
    [1_000, 3_000, [], [
      { startMs: 1_000, endMs: 3_000, durationSeconds: 2 },
    ]],
    [1_000, 1_001, [1_000], [
      { startMs: 1_000, endMs: 1_001, durationSeconds: 0.001 },
    ]],
    [Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER, [], [
      {
        startMs: Number.MAX_SAFE_INTEGER - 1,
        endMs: Number.MAX_SAFE_INTEGER,
        durationSeconds: 0.001,
      },
    ]],
  ];
  for (const [startMs, endMs, points, expected] of cases) {
    const summary = summarizeSamplingGaps(startMs, endMs, points, "requested");
    assert.equal(summary.timestampBasis, "requested");
    assert.deepEqual(summary.largestGaps, expected);
  }
  assert.throws(
    () => summarizeSamplingGaps(1, 1, [], "requested"), /startMs < endMs/,
  );
});

test("sampling gaps return at most five intervals with earlier ties first", () => {
  const summary = summarizeSamplingGaps(
    0, 8_000, [7_000, 6_000, 5_000, 4_000, 3_000, 2_000, 1_000, 0], "requested",
  );
  assert.deepEqual(summary.largestGaps, [
    { startMs: 0, endMs: 1_000, durationSeconds: 1 },
    { startMs: 1_000, endMs: 2_000, durationSeconds: 1 },
    { startMs: 2_000, endMs: 3_000, durationSeconds: 1 },
    { startMs: 3_000, endMs: 4_000, durationSeconds: 1 },
    { startMs: 4_000, endMs: 5_000, durationSeconds: 1 },
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

test("singleflight detaches a cancelled pending entry before an immediate retry", async () => {
  const flight = new Singleflight();
  const controller = new AbortController();
  let oldRuns = 0;
  let replacementRuns = 0;
  let startedOld!: () => void;
  let releaseOld!: () => void;
  let releaseReplacement!: () => void;
  const oldStarted = new Promise<void>((resolve) => {
    startedOld = resolve;
  });
  const oldGate = new Promise<string>((resolve) => {
    releaseOld = () => resolve("stale");
  });
  const replacementGate = new Promise<string>((resolve) => {
    releaseReplacement = () => resolve("fresh");
  });

  const oldObserver = flight.run("retry-race", controller.signal, async () => {
    oldRuns += 1;
    startedOld();
    return await oldGate;
  });
  await oldStarted;
  controller.abort();
  await assert.rejects(
    oldObserver,
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "CANCELLED",
  );

  const replacement = flight.run("retry-race", undefined, async () => {
    replacementRuns += 1;
    return await replacementGate;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(oldRuns, 1);
  assert.equal(replacementRuns, 1);

  // The old worker ignores abort and settles after the replacement is installed.
  releaseOld();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(flight.size, 1);

  releaseReplacement();
  assert.equal(await replacement, "fresh");
  assert.equal(flight.size, 0);
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
