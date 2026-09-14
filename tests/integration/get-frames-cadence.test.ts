import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  type CallToolResult,
  Client,
  InMemoryTransport,
} from "@modelcontextprotocol/client";
import { openUrma } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { parseInvestigationRef } from "../../src/core/ids.js";
import { buildMcpServer } from "../../src/mcp/server.js";
import { runChecked } from "../../src/subprocess/runner.js";

type IndividualOutput = Readonly<{
  kind: "exact_points";
  frames: readonly Readonly<{
    atMs: number;
    artifactId: string;
  }>[];
}>;

type ScheduledSlot = Readonly<{
  index: number;
  requestedAtMs: number;
  status: "success" | "error" | "unfinished";
  artifactId?: string;
}>;

type ScheduledOutput = Readonly<{
  kind: "scheduled_exact_points";
  continuous: false;
  observations: "discrete-points";
  schedule: Readonly<{
    startMs: number;
    endMs: number;
    cadenceMs: number;
    totalTargets: number;
  }>;
  page: Readonly<{
    startIndex: number;
    endIndexExclusive: number;
    pageSize: number;
  }>;
  slots: readonly ScheduledSlot[];
  counts: Readonly<{
    successes: number;
    errors: number;
    unfinished: number;
  }>;
  scheduleComplete: boolean;
  nextCursor: string | null;
  presentation: "individual" | "panel";
  cells?: readonly Readonly<{
    index: number;
    panelIndex: number | null;
    requestedAtMs: number;
    status: "success" | "error" | "unfinished";
    artifactId?: string;
  }>[];
  panel?:
    | Readonly<{
      artifactId: string;
      cellCount: number;
      derived: true;
      canonical: false;
    }>
    | null;
}>;

function structured<T>(result: CallToolResult, label: string): T {
  assert.equal(
    result.isError,
    undefined,
    `${label} failed: ${JSON.stringify(result.content)}`,
  );
  assert(result.structuredContent, `${label} omitted structuredContent`);
  return result.structuredContent as T;
}

test("fixed cadence preserves canonical exact frames, panel mapping, and honest timing", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "urma-frame-cadence-"),
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
      "testsrc2=s=640x360:d=5:r=4",
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
  const server = buildMcpServer(app.evidence, app.store, app.blobs, app.config);
  const client = new Client({
    name: "urma-frame-cadence-test",
    version: "1.0.0",
  });
  const [clientTransport, serverTransport] = InMemoryTransport
    .createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  t.after(async () => {
    await client.close();
    await server.close();
    app.close();
    await rm(directory, { recursive: true, force: true });
  });

  const inspection = structured<{
    investigationRef: string;
    source: Readonly<{ durationMs: number }>;
  }>(
    await client.callTool({
      name: "inspect_video",
      arguments: { source: video },
    }),
    "inspect_video",
  );
  const { investigationRef } = inspection;
  const durationMs = inspection.source.durationMs;

  const explicit = structured<IndividualOutput>(
    await client.callTool({
      name: "get_frames",
      arguments: {
        investigationRef,
        request: { kind: "points", timesMs: [500, 1_500] },
      },
    }),
    "explicit warm-up",
  );

  const scheduled = structured<ScheduledOutput>(
    await client.callTool({
      name: "get_frames",
      arguments: {
        investigationRef,
        request: {
          kind: "cadence",
          startMs: 500,
          endMs: 3_500,
          cadenceMs: 1_000,
        },
      },
    }),
    "cadence individual",
  );
  assert.equal(scheduled.continuous, false);
  assert.equal(scheduled.observations, "discrete-points");
  assert.deepEqual(
    scheduled.slots.map((slot) => ({
      index: slot.index,
      atMs: slot.requestedAtMs,
    })),
    [
      { index: 0, atMs: 500 },
      { index: 1, atMs: 1_500 },
      { index: 2, atMs: 2_500 },
    ],
  );
  assert(scheduled.slots.every((slot) => slot.status === "success"));
  assert.deepEqual(
    scheduled.slots.slice(0, 2).map((slot) => slot.artifactId),
    explicit.frames.map((frame) => frame.artifactId),
  );

  const single = structured<IndividualOutput>(
    await client.callTool({
      name: "get_frames",
      arguments: {
        investigationRef,
        request: { kind: "points", timesMs: [2_500] },
      },
    }),
    "cadence warm-up",
  );
  assert.equal(single.frames[0]?.artifactId, scheduled.slots[2]?.artifactId);

  const nearEnd = durationMs - 500;
  const nearEndExplicit = structured<IndividualOutput>(
    await client.callTool({
      name: "get_frames",
      arguments: {
        investigationRef,
        request: { kind: "points", timesMs: [nearEnd] },
      },
    }),
    "near-end explicit",
  );
  const nearEndScheduled = structured<ScheduledOutput>(
    await client.callTool({
      name: "get_frames",
      arguments: {
        investigationRef,
        request: {
          kind: "cadence",
          startMs: nearEnd,
          endMs: durationMs,
          cadenceMs: 1_000,
        },
      },
    }),
    "near-end cadence",
  );
  assert.deepEqual(
    nearEndScheduled.slots.map((slot) => slot.requestedAtMs),
    [nearEnd],
  );
  assert.equal(
    nearEndScheduled.slots[0]?.artifactId,
    nearEndExplicit.frames[0]?.artifactId,
  );

  const panelResult = await client.callTool({
    name: "get_frames",
    arguments: {
      investigationRef,
      presentation: "panel",
      request: {
        kind: "cadence",
        startMs: 500,
        endMs: 3_500,
        cadenceMs: 1_000,
      },
    },
  });
  const panel = structured<ScheduledOutput>(panelResult, "cadence panel");
  assert.equal(panel.presentation, "panel");
  assert(panel.panel);
  assert.equal(panel.panel.cellCount, 3);
  assert.deepEqual(
    panel.cells?.map((cell) => ({
      index: cell.index,
      panelIndex: cell.panelIndex,
      requestedAtMs: cell.requestedAtMs,
      artifactId: cell.artifactId,
    })),
    scheduled.slots.map((slot, index) => ({
      index: slot.index,
      panelIndex: index + 1,
      requestedAtMs: slot.requestedAtMs,
      artifactId: slot.artifactId,
    })),
  );
  assert.equal(
    panelResult.content.filter((item) => item.type === "image").length,
    1,
    "panel presentation should inline the derived panel, not duplicate every canonical frame",
  );

  const firstContinuationPage = structured<ScheduledOutput>(
    await client.callTool({
      name: "get_frames",
      arguments: {
        investigationRef,
        pageSize: 2,
        request: {
          kind: "cadence",
          startMs: 500,
          endMs: 4_500,
          cadenceMs: 1_000,
        },
      },
    }),
    "cadence continuation first page",
  );
  assert.equal(firstContinuationPage.page.startIndex, 0);
  assert.equal(firstContinuationPage.page.endIndexExclusive, 2);
  assert(firstContinuationPage.nextCursor);
  const changedContinuationPage = structured<ScheduledOutput>(
    await client.callTool({
      name: "get_frames",
      arguments: {
        investigationRef,
        cursor: firstContinuationPage.nextCursor,
        pageSize: 1,
        presentation: "panel",
      },
    }),
    "cadence continuation with changed page size and presentation",
  );
  assert.equal(changedContinuationPage.page.startIndex, 2);
  assert.equal(changedContinuationPage.page.endIndexExclusive, 3);
  assert.deepEqual(
    changedContinuationPage.slots.map((slot) => slot.requestedAtMs),
    [2_500],
    "continuation must retain the original schedule rather than resampling the remaining interval",
  );
  assert.equal(changedContinuationPage.presentation, "panel");
  assert(changedContinuationPage.panel);

  const investigation = app.store.getInvestigation(
    parseInvestigationRef(investigationRef),
  );
  assert(investigation);
  const artifacts = app.store.listArtifacts(
    investigation.sourceRef,
    investigation.sourceRevision,
  );
  for (const slot of scheduled.slots) {
    const artifact = artifacts.find(
      (candidate) => candidate.artifactId === slot.artifactId,
    );
    assert(artifact);
    assert.equal(artifact.kind, "frame");
    assert.equal(artifact.role, "evidence");
    assert.equal(artifact.producer.version, "frame-extractor");
    assert.equal(artifact.params.atMs, slot.requestedAtMs);
  }
});
