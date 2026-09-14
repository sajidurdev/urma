import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openUrma } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { runChecked } from "../../src/subprocess/runner.js";

async function localVideoFixture(t: test.TestContext) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "urma-scoped-overview-"),
  );
  const video = path.join(directory, "fixture.mp4");
  await runChecked(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=320x180:d=6:r=2",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-y",
      video,
    ],
    { timeoutMs: 30_000 },
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
  return app.evidence
    .inspectVideo({ source: video })
    .then((inspected) => ({ app, inspected }));
}

function timestamps(output: {
  cells: readonly { timestampMs: number }[];
}): number[] {
  return output.cells.map((cell) => cell.timestampMs);
}

function assertScoped(
  output: {
    interval: { startMs: number; endMs: number };
    actualCount: number;
    cells: readonly { index: number; timestampMs: number }[];
  },
  startMs: number,
  endMs: number,
): void {
  assert.deepEqual(output.interval, { startMs, endMs });
  assert(output.actualCount >= 1 && output.actualCount <= 12);
  assert.deepEqual(
    output.cells.map((cell) => cell.index),
    output.cells.map((_, index) => index),
  );
  const points = timestamps(output);
  assert.deepEqual(
    points,
    [...points].sort((a, b) => a - b),
  );
  assert(
    points.every((point) => point >= startMs && point < endMs),
    `timestamps escaped [${startMs},${endMs}): ${points.join(",")}`,
  );
}

function assertTemporalContract(
  output: {
    requestedInterval: { startMs: number; endMs: number };
    timebase: string;
    observedCoverage: {
      kind: string;
      continuous: boolean;
      sampleTimestampsMs: readonly number[];
      adjacentSpacingMs: readonly number[];
    };
    sampling: {
      resolutionMs: number | null;
      adjacentSpacingMs: readonly number[];
      sampleReuse: { relation: string; reusedUnderlyingSamples: boolean };
    };
    cells: readonly {
      timestampMs: number;
      artifactId: string;
      resource: string;
      provenance: {
        kind: string;
        timing: string;
        sourceArtifactId: string | null;
        fragmentIndex: number | null;
        cellIndex: number | null;
      };
    }[];
    artifact: { artifactId: string; resource: string };
  },
  startMs: number,
  endMs: number,
  relation: string,
  reusedUnderlyingSamples: boolean,
): void {
  const points = timestamps(output);
  assert.deepEqual(output.requestedInterval, { startMs, endMs });
  assert.equal(output.timebase, "source-global");
  assert.equal(output.observedCoverage.kind, "sample-points-only");
  assert.equal(output.observedCoverage.continuous, false);
  assert.deepEqual(output.observedCoverage.sampleTimestampsMs, points);
  const spacing = points.slice(1).map((point, index) => point - points[index]!);
  assert.deepEqual(output.observedCoverage.adjacentSpacingMs, spacing);
  assert.deepEqual(output.sampling.adjacentSpacingMs, spacing);
  assert.equal(
    output.sampling.resolutionMs,
    null,
    "the contract must not invent one fixed resolution",
  );
  assert.equal(output.sampling.sampleReuse.relation, relation);
  assert.equal(
    output.sampling.sampleReuse.reusedUnderlyingSamples,
    reusedUnderlyingSamples,
  );
  assert(
    output.cells.every(
      (cell) => cell.artifactId === output.artifact.artifactId,
    ),
  );
  assert(
    output.cells.every((cell) => cell.resource === output.artifact.resource),
  );
  assert(
    output.cells.every(
      (cell) => cell.timestampMs >= startMs && cell.timestampMs < endMs,
    ),
  );
}

test("get_overview supports bounded hierarchical navigation with a stable 12-cell budget", async (t) => {
  const { app, inspected } = await localVideoFixture(t);
  const duration = inspected.source.durationMs;
  assert(duration >= 5_000);

  const whole = await app.evidence.getOverview({
    investigationRef: inspected.investigationRef,
  });
  assertScoped(whole, 0, duration);
  assert.equal(whole.requestedCount, 12);
  assert.equal(whole.actualCount, 12);
  assertTemporalContract(whole, 0, duration, "not-scoped", false);

  const explicitWhole = await app.evidence.getOverview({
    investigationRef: inspected.investigationRef,
    startMs: 0,
    endMs: duration,
  });
  assertScoped(explicitWhole, 0, duration);
  assert.deepEqual(timestamps(explicitWhole), timestamps(whole));
  assert.equal(explicitWhole.artifact.artifactId, whole.artifact.artifactId);
  assert.equal(explicitWhole.cacheHit, true);
  assertTemporalContract(explicitWhole, 0, duration, "not-scoped", true);

  const middleStart = Math.floor(duration / 3);
  const middleEnd = Math.floor((duration * 2) / 3);
  const middle = await app.evidence.getOverview({
    investigationRef: inspected.investigationRef,
    startMs: middleStart,
    endMs: middleEnd,
  });
  assertScoped(middle, middleStart, middleEnd);
  assert.equal(middle.actualCount, 12);
  assertTemporalContract(
    middle,
    middleStart,
    middleEnd,
    "new-decoded-samples",
    false,
  );

  const smallStart = 1_000;
  const smallEnd = 1_500;
  const small = await app.evidence.getOverview({
    investigationRef: inspected.investigationRef,
    startMs: smallStart,
    endMs: smallEnd,
  });
  assertScoped(small, smallStart, smallEnd);
  assert.equal(small.actualCount, 12);
  assertTemporalContract(
    small,
    smallStart,
    smallEnd,
    "new-decoded-samples",
    false,
  );

  const fromBeginning = await app.evidence.getOverview({
    investigationRef: inspected.investigationRef,
    endMs: 1_000,
  });
  assertScoped(fromBeginning, 0, 1_000);
  assertTemporalContract(fromBeginning, 0, 1_000, "new-decoded-samples", false);
  const fromEnd = await app.evidence.getOverview({
    investigationRef: inspected.investigationRef,
    startMs: duration - 1_000,
  });
  assertScoped(fromEnd, duration - 1_000, duration);
  assertTemporalContract(
    fromEnd,
    duration - 1_000,
    duration,
    "new-decoded-samples",
    false,
  );
  const tiny = await app.evidence.getOverview({
    investigationRef: inspected.investigationRef,
    startMs: 0,
    endMs: 1,
  });
  assertScoped(tiny, 0, 1);
  assert.equal(tiny.actualCount, 1);
  assertTemporalContract(tiny, 0, 1, "new-decoded-samples", false);

  const repeatedSmall = await app.evidence.getOverview({
    investigationRef: inspected.investigationRef,
    startMs: smallStart,
    endMs: smallEnd,
  });
  assert.equal(repeatedSmall.cacheHit, true);
  assert.equal(repeatedSmall.artifact.artifactId, small.artifact.artifactId);
  assertTemporalContract(
    repeatedSmall,
    smallStart,
    smallEnd,
    "same-samples",
    true,
  );
  const overviewCalls = app.store
    .listAcquisitions(inspected.investigationRef)
    .filter((entry) => entry.operation === "tool:get_overview");
  assert.equal(overviewCalls.at(-1)?.metadata.cacheHit, true);
  assert.equal(overviewCalls.at(-1)?.metadata.imageCount, 12);
});

test("get_overview rejects invalid temporal scopes without producing evidence", async (t) => {
  const { app, inspected } = await localVideoFixture(t);
  const duration = inspected.source.durationMs;
  const cases: readonly [
    string,
    { startMs?: number; endMs?: number },
    RegExp,
  ][] = [
    [
      "negative start",
      { startMs: -1, endMs: 1_000 },
      /startMs must be a non-negative safe integer/,
    ],
    [
      "negative end",
      { startMs: 0, endMs: -1 },
      /endMs must be a non-negative safe integer/,
    ],
    ["equal bounds", { startMs: 1_000, endMs: 1_000 }, /startMs < endMs/],
    ["reversed bounds", { startMs: 2_000, endMs: 1_000 }, /startMs < endMs/],
    [
      "end beyond duration",
      { startMs: 0, endMs: duration + 1 },
      /exceeds source durationMs/,
    ],
    ["start at duration", { startMs: duration }, /startMs < endMs/],
    [
      "NaN start",
      { startMs: Number.NaN, endMs: 1_000 },
      /startMs must be a non-negative safe integer/,
    ],
    [
      "infinite end",
      { startMs: 0, endMs: Number.POSITIVE_INFINITY },
      /endMs must be a non-negative safe integer/,
    ],
  ];
  for (const [label, scope, message] of cases) {
    await assert.rejects(
      app.evidence.getOverview({
        investigationRef: inspected.investigationRef,
        ...scope,
      }),
      message,
      label,
    );
  }
  assert.equal(
    app.evidence.state(inspected.investigationRef).evidence.sparseVisualSets
      .length,
    0,
  );
});
