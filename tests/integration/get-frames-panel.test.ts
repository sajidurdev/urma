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
import { parseInvestigationRef, parseSourceRef } from "../../src/core/ids.js";
import { buildMcpServer } from "../../src/mcp/server.js";
import { runChecked } from "../../src/subprocess/runner.js";

type IndividualOutput = Readonly<{
  kind: "exact_points";
  continuousMotion: false;
  frames: readonly Readonly<{
    index: number;
    atMs: number;
    artifactId: string;
    resource: string;
  }>[];
}>;

type PanelOutput = Readonly<{
  kind: "exact_points";
  continuousMotion: false;
  presentation: "panel";
  cells: readonly Readonly<{
    index: number;
    timestampMs: number;
    artifactId: string;
    resource: string;
  }>[];
  panel: Readonly<{
    artifactId: string;
    resource: string;
    width: number;
    height: number;
    cellCount: number;
    derived: true;
    canonical: false;
  }>;
  investigationRef: string;
  stateResource: string;
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

test("get_frames panel is bounded, ordered, canonical-resource mapped, and cache-escalatable", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "urma-frame-panel-"));
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
  const flatVideo = path.join(directory, "flat.mp4");
  await runChecked(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=320x180:d=4:r=2",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-y",
      flatVideo,
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
    name: "urma-frame-panel-test",
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

  const tools = await client.listTools();
  const framesTool = tools.tools.find((tool) => tool.name === "get_frames");
  assert(framesTool);
  assert.equal(
    framesTool.description,
    "Get deterministic frame evidence at explicit points, a burst, or fixed cadence. Batch known targets; cadence is discrete, not continuous.",
  );
  const inputSchema = framesTool.inputSchema as {
    properties?: Record<string, unknown>;
    allOf?: Array<{ properties?: Record<string, unknown> }>;
    required?: readonly string[];
  };
  assert(
    inputSchema.properties?.presentation ||
      inputSchema.allOf?.some((part) => part.properties?.presentation),
  );
  assert(!inputSchema.required?.includes("presentation"));

  const inspection = structured<{
    investigationRef: string;
    sourceRef: string;
  }>(
    await client.callTool({
      name: "inspect_video",
      arguments: { source: video },
    }),
    "inspect_video",
  );
  const investigationRef = inspection.investigationRef;

  const flatInspection = structured<{
    investigationRef: string;
  }>(
    await client.callTool({
      name: "inspect_video",
      arguments: { source: flatVideo },
    }),
    "flat inspect_video",
  );
  const repeatedResult = await client.callTool({
    name: "get_frames",
    arguments: {
      investigationRef: flatInspection.investigationRef,
      request: { kind: "points", timesMs: [500, 1_500] },
    },
  });
  const repeated = structured<IndividualOutput>(
    repeatedResult,
    "repeated-artifact individual frames",
  );
  assert.equal(repeated.frames[0]?.artifactId, repeated.frames[1]?.artifactId);
  assert.equal(
    repeatedResult.content.filter((item) => item.type === "resource_link")
      .length,
    1,
    "one canonical resource link is enough when requested targets share it",
  );
  const repeatedLink = repeatedResult.content.find(
    (item): item is Extract<typeof item, { type: "resource_link" }> =>
      item.type === "resource_link",
  );
  assert.equal(repeatedLink?.uri, repeated.frames[0]?.resource);
  assert.equal(
    repeatedResult.content.filter((item) => item.type === "image").length,
    1,
    "identical canonical JPEG bytes are inlined only once",
  );

  const repeatedPanelResult = await client.callTool({
    name: "get_frames",
    arguments: {
      investigationRef: flatInspection.investigationRef,
      presentation: "panel",
      request: { kind: "points", timesMs: [500, 1_500] },
    },
  });
  const repeatedPanel = structured<PanelOutput>(
    repeatedPanelResult,
    "repeated-artifact panel frames",
  );
  assert.equal(repeatedPanel.cells[0]?.artifactId, repeatedPanel.cells[1]?.artifactId);
  const repeatedPanelCanonicalLinks = repeatedPanelResult.content.filter(
    (item): item is Extract<typeof item, { type: "resource_link" }> =>
      item.type === "resource_link" && item.name.startsWith("Exact frame"),
  );
  assert.equal(repeatedPanelCanonicalLinks.length, 1);
  assert.equal(
    repeatedPanelCanonicalLinks[0]?.uri,
    repeatedPanel.cells[0]?.resource,
  );
  assert.equal(
    repeatedPanelResult.content.filter((item) => item.type === "image").length,
    1,
  );

  const omitted = structured<IndividualOutput>(
    await client.callTool({
      name: "get_frames",
      arguments: {
        investigationRef,
        request: { kind: "points", timesMs: [500, 1_500] },
      },
    }),
    "omitted presentation",
  );
  assert.deepEqual(Object.keys(omitted).sort(), [
    "continuousMotion",
    "frames",
    "investigationRef",
    "kind",
    "stateResource",
  ]);
  assert.equal(omitted.frames.length, 2);
  const omittedResult = await client.callTool({
    name: "get_frames",
    arguments: {
      investigationRef,
      request: { kind: "points", timesMs: [500, 1_500] },
    },
  });
  assert.equal(
    omittedResult.content.filter((item) => item.type === "image").length,
    2,
  );

  const explicitResult = await client.callTool({
    name: "get_frames",
    arguments: {
      investigationRef,
      presentation: "individual",
      request: { kind: "points", timesMs: [500, 1_500] },
    },
  });
  const explicit = structured<IndividualOutput>(
    explicitResult,
    "explicit individual",
  );
  assert.deepEqual(Object.keys(explicit).sort(), Object.keys(omitted).sort());
  assert.deepEqual(
    explicit.frames.map(({ atMs, artifactId }) => ({ atMs, artifactId })),
    omitted.frames.map(({ atMs, artifactId }) => ({ atMs, artifactId })),
  );
  assert.equal(
    explicitResult.content.filter((item) => item.type === "image").length,
    2,
  );

  const requested = [2_500, 500, 1_500];
  const panelResult = await client.callTool({
    name: "get_frames",
    arguments: {
      investigationRef,
      presentation: "panel",
      request: { kind: "points", timesMs: requested },
    },
  });
  const panel = structured<PanelOutput>(panelResult, "panel");
  assert.equal(panel.presentation, "panel");
  assert.deepEqual(
    panel.cells.map((cell) => cell.index),
    [1, 2, 3],
  );
  assert.deepEqual(
    panel.cells.map((cell) => cell.timestampMs),
    requested,
    "panel mapping must preserve request order without sorting",
  );
  assert.equal(panel.panel.cellCount, requested.length);
  assert.deepEqual(
    { width: panel.panel.width, height: panel.panel.height },
    { width: 960, height: 212 },
  );
  assert.equal(panel.panel.derived, true);
  assert.equal(panel.panel.canonical, false);
  assert.equal(panel.investigationRef, investigationRef);
  assert.match(panel.stateResource, /^urma:\/\/investigation\/.+\/state$/u);
  assert.equal(
    panelResult.content.filter((item) => item.type === "image").length,
    1,
  );
  const canonicalLinks = panelResult.content.filter(
    (item): item is Extract<typeof item, { type: "resource_link" }> =>
      item.type === "resource_link" && item.name.startsWith("Exact frame"),
  );
  assert.equal(canonicalLinks.length, requested.length);
  assert.deepEqual(
    canonicalLinks.map((item) => item.uri),
    panel.cells.map((cell) => cell.resource),
  );

  for (const cell of panel.cells) {
    const resource = await client.readResource({ uri: cell.resource });
    assert.equal(resource.contents[0]?.mimeType, "image/jpeg");
    assert.equal(
      typeof (resource.contents[0] as { blob?: unknown }).blob,
      "string",
    );
  }
  const panelResource = await client.readResource({
    uri: panel.panel.resource,
  });
  assert.equal(panelResource.contents[0]?.mimeType, "image/jpeg");

  const selected = structured<IndividualOutput>(
    await client.callTool({
      name: "get_frames",
      arguments: {
        investigationRef,
        presentation: "individual",
        request: { kind: "points", timesMs: [2_500, 1_500] },
      },
    }),
    "panel escalation",
  );
  assert.deepEqual(
    selected.frames.map((frame) => frame.artifactId),
    [panel.cells[0]!.artifactId, panel.cells[2]!.artifactId],
  );

  const sourceRef = parseSourceRef(inspection.sourceRef);
  const revision = app.store.getInvestigation(
    parseInvestigationRef(investigationRef),
  )!.sourceRevision;
  const artifacts = app.store.listArtifacts(sourceRef, revision);
  const canonical = artifacts.filter((artifact) => artifact.kind === "frame");
  assert(
    canonical.every(
      (artifact) =>
        artifact.role === "evidence" &&
        artifact.producer.version === "frame-extractor",
    ),
  );
  const derived = artifacts.find(
    (artifact) => artifact.artifactId === panel.panel.artifactId,
  );
  assert(derived);
  assert.equal(derived.kind, "frame_panel");
  assert.equal(derived.role, "locator");
  assert.equal(derived.params.canonical, false);
  assert.deepEqual(
    derived.params.artifactIds,
    panel.cells.map((cell) => cell.artifactId),
  );

  const one = structured<PanelOutput>(
    await client.callTool({
      name: "get_frames",
      arguments: {
        investigationRef,
        presentation: "panel",
        request: { kind: "points", timesMs: [3_000] },
      },
    }),
    "one-cell panel",
  );
  assert.deepEqual(
    {
      width: one.panel.width,
      height: one.panel.height,
      cellCount: one.panel.cellCount,
    },
    { width: 320, height: 212, cellCount: 1 },
  );

  const five = structured<PanelOutput>(
    await client.callTool({
      name: "get_frames",
      arguments: {
        investigationRef,
        presentation: "panel",
        request: { kind: "points", timesMs: [100, 600, 1_100, 1_600, 2_100] },
      },
    }),
    "partial-row panel",
  );
  assert.deepEqual(
    {
      width: five.panel.width,
      height: five.panel.height,
      cellCount: five.panel.cellCount,
    },
    { width: 960, height: 424, cellCount: 5 },
  );

  const twelveTimes = Array.from(
    { length: 12 },
    (_, index) => 100 + index * 350,
  );
  const maximum = structured<PanelOutput>(
    await client.callTool({
      name: "get_frames",
      arguments: {
        investigationRef,
        presentation: "panel",
        request: { kind: "points", timesMs: twelveTimes },
      },
    }),
    "maximum panel",
  );
  assert.deepEqual(
    {
      width: maximum.panel.width,
      height: maximum.panel.height,
      cellCount: maximum.panel.cellCount,
    },
    { width: 1_280, height: 636, cellCount: 12 },
  );
  const aboveMaximum = await client.callTool({
    name: "get_frames",
    arguments: {
      investigationRef,
      presentation: "panel",
      request: {
        kind: "points",
        timesMs: Array.from({ length: 13 }, (_, index) => index),
      },
    },
  });
  assert.equal(aboveMaximum.isError, true);
  assert.match(
    (aboveMaximum.content[0] as { text: string }).text,
    /Invalid arguments for tool get_frames/iu,
  );
});
