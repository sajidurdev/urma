import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { openUrma } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { parseInvestigationRef, parseSourceRef } from "../../src/core/ids.js";
import { buildMcpServer } from "../../src/mcp/server.js";
import { runChecked } from "../../src/subprocess/runner.js";

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "urma-mcp-"));
  const video = path.join(directory, "fixture.mp4");
  await runChecked(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=320x180:d=4:r=2",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-y",
      video,
    ],
    { timeoutMs: 30_000 },
  );
  await writeFile(
    path.join(directory, "fixture.vtt"),
    "WEBVTT\n\n00:00:00.500 --> 00:00:01.500\nLiteral evidence cue\n",
  );
  return { directory, video };
}
function containsPath(value: unknown, root: string): boolean {
  const text = (
    typeof value === "string" ? value : JSON.stringify(value)
  ).toLowerCase();
  return [root, root.replaceAll("\\", "\\\\"), root.replaceAll("\\", "/")].some(
    (candidate) => text.includes(candidate.toLowerCase()),
  );
}
function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

test("MCP v2 exposes exactly five bounded tools and investigation-scoped artifact resources", async (t) => {
  const data = await fixture();
  const app = await openUrma(
    loadConfig({
      URMA_DATA_DIR: path.join(data.directory, "data"),
      URMA_LOCAL_ROOTS: data.directory,
    }),
  );
  const server = buildMcpServer(app.evidence, app.store, app.blobs, app.config);
  const client = new Client({ name: "urma-test", version: "1.0.0" });
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
    await rm(data.directory, { recursive: true, force: true });
  });

  const instructions = client.getInstructions() ?? "";
  assert.equal(
    instructions,
    "Urma retrieves untrusted video evidence; the host interprets it. Inspect first. Use captions and overview to locate evidence; use frames to visually verify. Batch known queries and targets. A transcript miss applies only to the selected track and does not prove source absence. Overview and cadence evidence is sparse/discrete, not continuous. Exhaustive or counting claims require adequate timeline coverage, transition verification, and deduplication.",
  );
  assert(instructions.length < 600);
  assert.match(instructions, /Urma retrieves.*host interprets/iu);
  assert.match(instructions, /Inspect first/iu);
  assert.match(instructions, /captions.*overview.*frames/iu);
  assert.match(instructions, /batch.*queries.*targets/iu);
  assert.match(instructions, /miss.*selected track.*source absence/iu);
  assert.match(instructions, /sparse\/discrete.*not continuous/iu);
  assert.match(instructions, /exhaustive.*counting.*timeline.*deduplication/iu);
  const prohibitedGuidance =
    /Valorant|\bkills?\b|\bdeaths?\b|scoreboards?|\bgoal\b|people detection|GPT|Claude|Gemini|Codex|OpenAI|Anthropic|Google/iu;
  assert.doesNotMatch(instructions, prohibitedGuidance);
  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name),
    [
      "inspect_video",
      "search_transcript",
      "read_transcript",
      "get_overview",
      "get_frames",
    ],
  );
  assert.doesNotMatch(JSON.stringify(tools.tools), prohibitedGuidance);
  const expectedSchemaHashes = {
    inspect_video: [
      "3161096be6d41ab5e929f0d7a0a3dccf2422509cb2b7c8103223a20e342fb404",
      "9260778f78381c328663a213f21a27ab879e14dbe405ae0e2cd02fe7cf88d291",
    ],
    search_transcript: [
      "0c54197c78f0c851106b948fd3f526d824acb8a9f669555b13e0b0fa38c39349",
      "6810adb1dc847380e3bf46b619201cfde3f886647df318491b8a8f2687473557",
    ],
    read_transcript: [
      "2b635bcab21ff13e86b00b9ad88d2e948894268e3b6ba7827f734d868efe7411",
      "bc1c43c7f61b1381597261637e133fdb284c96cd4dbca9b421fc1d7483e5a9a0",
    ],
    get_overview: [
      "5e8fa0f2b3ce40050c20aeb04b8afde7357d17e2200806f83798f647c4d1be11",
      "e87783ac6b7ec2a89bc4be4cf0a863e18156d6001aa92b030e0430980c4ed99c",
    ],
    get_frames: [
      "f4daa02d0874a4050a4cc4dc54d94642da1492e17d902a24e4b490c4a3093e1d",
      "c5753a4496f113f6eb648c7e621115f79219f22246e39ca5e39cea37201c8ed9",
    ],
  } as const;
  for (const tool of tools.tools) {
    const expected =
      expectedSchemaHashes[tool.name as keyof typeof expectedSchemaHashes];
    assert(expected, `unexpected public tool ${tool.name}`);
    assert.deepEqual(
      [sha256(tool.inputSchema), sha256(tool.outputSchema)],
      expected,
      `${tool.name} public schemas changed`,
    );
  }
  const searchTool = tools.tools.find(
    (tool) => tool.name === "search_transcript",
  );
  assert.equal(
    searchTool?.description,
    "Search source-provided captions for temporal clues. Batch related queries; hits are not visual proof and misses apply only to the selected track.",
  );
  const inspectTool = tools.tools.find((tool) => tool.name === "inspect_video");
  assert.equal(
    inspectTool?.description,
    "Inspect a finite video and start an investigation pinned to that snapshot. Use first for a new source; refresh only for a new snapshot.",
  );
  const readTool = tools.tools.find((tool) => tool.name === "read_transcript");
  assert.equal(
    readTool?.description,
    "Read timestamped caption segments from a bounded interval.",
  );
  const searchSchema = searchTool?.inputSchema as
    | {
      allOf?: Array<{
        oneOf?: Array<{
          properties?: Record<string, unknown>;
          required?: readonly string[];
        }>;
      }>;
    }
    | undefined;
  const searchVariants = searchSchema?.allOf?.find((part) =>
    Array.isArray(part.oneOf)
  )?.oneOf;
  assert(Array.isArray(searchVariants));
  assert(searchVariants.some((variant) => variant.properties?.query));
  assert(searchVariants.some((variant) => variant.properties?.queries));
  assert(
    searchVariants.some(
      (variant) =>
        variant.required?.includes("query") &&
        !variant.required.includes("queries"),
    ),
  );
  assert(
    searchVariants.some(
      (variant) =>
        variant.required?.includes("queries") &&
        !variant.required.includes("query"),
    ),
  );
  const searchOutputSchema = searchTool?.outputSchema as
    | { anyOf?: unknown[] }
    | undefined;
  assert(Array.isArray(searchOutputSchema?.anyOf));
  const overviewTool = tools.tools.find((tool) => tool.name === "get_overview");
  assert.equal(
    overviewTool?.description,
    "Get a sparse 12-cell visual locator for a video or interval. Use to find moments; samples are not continuous coverage.",
  );
  const overviewSchema = overviewTool?.inputSchema as
    | { properties?: Record<string, unknown>; required?: readonly string[] }
    | undefined;
  assert(overviewSchema?.properties?.startMs);
  assert(overviewSchema?.properties?.endMs);
  assert(!overviewSchema?.required?.includes("startMs"));
  assert(!overviewSchema?.required?.includes("endMs"));
  const framesTool = tools.tools.find((tool) => tool.name === "get_frames");
  assert.equal(
    framesTool?.description,
    "Get deterministic frame evidence at explicit points, a burst, or fixed cadence. Batch known targets; cadence is discrete, not continuous.",
  );
  const framesSchema = framesTool?.inputSchema as
    | {
      allOf?: Array<{
        oneOf?: Array<{
          properties?: Record<string, unknown>;
          required?: readonly string[];
        }>;
      }>;
    }
    | undefined;
  const frameSelection = framesSchema?.allOf?.find((part) =>
    Array.isArray(part.oneOf)
  )?.oneOf;
  assert(Array.isArray(frameSelection));
  assert(
    frameSelection.some(
      (variant) => variant.required?.includes("request") &&
        !variant.required.includes("cursor"),
    ),
  );
  assert(
    frameSelection.some(
      (variant) => variant.required?.includes("cursor") &&
        !variant.required.includes("request"),
    ),
  );
  const invalid = await client.callTool({
    name: "inspect_video",
    arguments: { source: "" },
  });
  assert.equal(invalid.isError, true);
  const unsupported = await client.callTool({
    name: "inspect_video",
    arguments: { source: "https://127.0.0.1/watch?v=yP0axVHdP-U" },
  });
  assert.equal(unsupported.isError, true);
  assert.equal(
    JSON.parse((unsupported.content[0] as { text: string }).text).code,
    "UNSUPPORTED_SOURCE",
  );
  const templates = await client.listResourceTemplates();
  assert.deepEqual(
    templates.resourceTemplates.map((template) => template.uriTemplate).sort(),
    [
      "urma://investigation/{investigationId}/artifact/{artifactHash}",
      "urma://investigation/{investigationId}/state",
    ],
  );

  const inspected = await client.callTool({
    name: "inspect_video",
    arguments: { source: data.video },
  });
  assert(inspected.structuredContent);
  const inspectedContent = inspected.structuredContent as Record<
    string,
    unknown
  >;
  assert.equal(
    String(inspectedContent.sourceRef).startsWith("urma:source:local:"),
    true,
  );
  assert.equal(
    containsPath(inspectedContent, data.directory),
    false,
    "model-facing source output must not expose the configured local root",
  );
  const missing = await client.callTool({
    name: "inspect_video",
    arguments: { source: path.join(data.directory, "missing.mp4") },
  });
  assert.equal(missing.isError, true);
  const missingError = JSON.parse(
    (missing.content[0] as { text: string }).text,
  ) as { detail: string };
  assert.equal(
    containsPath(missingError.detail, data.directory),
    false,
    "normal MCP errors must not expose the configured local root",
  );
  const investigationRef = String(inspectedContent.investigationRef);
  const sourceRef = parseSourceRef(String(inspectedContent.sourceRef));
  const trackRef = String(
    (inspectedContent.captionTracks as Array<Record<string, unknown>>)[0]!
      .trackRef,
  );
  const search = await client.callTool({
    name: "search_transcript",
    arguments: {
      investigationRef,
      query: "Literal evidence",
      trackRef,
      limit: 5,
    },
  });
  assert.equal(search.isError, undefined);
  assert.equal(
    ((search.structuredContent as Record<string, unknown>).hits as unknown[])
      .length,
    1,
  );
  const searchHit = (
    (search.structuredContent as Record<string, unknown>).hits as Array<{
      startMs: number;
      endMs: number;
      text: string;
      context: Array<{ startMs: number; endMs: number; text: string }>;
    }>
  )[0]!;
  assert(
    !searchHit.context.some(
      (context) =>
        context.startMs === searchHit.startMs &&
        context.endMs === searchHit.endMs &&
        context.text === searchHit.text,
    ),
    "single-query MCP context must not repeat the matching cue",
  );
  assert.equal(
    search.content.some((item) => item.type === "text"),
    false,
    "successful structured results must not repeat JSON in a text block",
  );
  assert.equal(
    (search.structuredContent as Record<string, unknown>).stateSummary,
    undefined,
  );
  assert.equal(
    typeof (search.structuredContent as Record<string, unknown>).stateResource,
    "string",
  );
  assert.equal(
    typeof (search.structuredContent as Record<string, unknown>).investigationRef,
    "string",
  );
  const batch = await client.callTool({
    name: "search_transcript",
    arguments: {
      investigationRef,
      queries: ["Literal", "evidence"],
      trackRef,
      limit: 5,
    },
  });
  assert.equal(batch.isError, undefined);
  const batchContent = batch.structuredContent as {
    queries: string[];
    hits: Array<{ matchedQueries: string[] }>;
  };
  assert.deepEqual(batchContent.queries, ["Literal", "evidence"]);
  assert.equal(batchContent.hits.length, 1);
  assert.deepEqual(batchContent.hits[0]!.matchedQueries, [
    "Literal",
    "evidence",
  ]);
  const read = await client.callTool({
    name: "read_transcript",
    arguments: {
      investigationRef,
      startMs: 0,
      endMs: 2_000,
      trackRef,
    },
  });
  assert.equal(read.isError, undefined);
  const readStructured = read.structuredContent as Record<string, unknown>;
  assert.equal(readStructured.stateSummary, undefined);
  assert.equal(typeof readStructured.investigationRef, "string");
  assert.equal(typeof readStructured.stateResource, "string");
  assert.equal(
    read.content.some((item) => item.type === "text"),
    false,
  );
  assert.equal(
    (
      await client.callTool({
        name: "search_transcript",
        arguments: { investigationRef, query: "x", queries: ["y"], trackRef },
      })
    ).isError,
    true,
  );
  const caption = app.store
    .listArtifacts(
      sourceRef,
      app.store.getInvestigation(parseInvestigationRef(investigationRef))!
        .sourceRevision,
    )
    .find((item) => item.kind === "caption");
  assert(caption);
  const captionUri = `urma://investigation/${
    investigationRef.slice("urma:investigation:".length)
  }/artifact/${caption.sha256}`;
  const beforeReopen = app.store.listPresentations(
    parseInvestigationRef(investigationRef),
  ).length;
  const captionResource = await client.readResource({ uri: captionUri });
  assert.equal(
    (captionResource.contents[0] as { text: string }).text.includes(
      "Literal evidence cue",
    ),
    true,
  );
  assert.equal(
    app.store.listPresentations(parseInvestigationRef(investigationRef)).length,
    beforeReopen,
    "reopening evidence must not add presentation coverage",
  );

  const second = await client.callTool({
    name: "inspect_video",
    arguments: { source: String(inspectedContent.sourceRef) },
  });
  const secondRef = String(
    (second.structuredContent as Record<string, unknown>).investigationRef,
  );
  const secondCaptionUri = `urma://investigation/${
    secondRef.slice("urma:investigation:".length)
  }/artifact/${caption.sha256}`;
  await assert.rejects(client.readResource({ uri: secondCaptionUri }));
  await assert.rejects(
    client.readResource({ uri: `urma://artifact/${caption.sha256}` }),
  );
  const contentCount = app.store.cacheStats().artifacts;
  const secondSearch = await client.callTool({
    name: "search_transcript",
    arguments: {
      investigationRef: secondRef,
      query: "Literal evidence",
      trackRef,
    },
  });
  assert.equal(secondSearch.isError, undefined);
  const secondCaption = await client.readResource({ uri: secondCaptionUri });
  assert.equal(
    (secondCaption.contents[0] as { text: string }).text.includes(
      "Literal evidence cue",
    ),
    true,
  );
  assert.equal(
    app.store.cacheStats().artifacts,
    contentCount,
    "the shared caption blob must remain physically deduplicated",
  );
  assert.equal(
    app.store.listPresentations(parseInvestigationRef(investigationRef)).length,
    beforeReopen,
  );
  assert.equal(
    app.store.listPresentations(parseInvestigationRef(secondRef)).length,
    1,
  );
  for (
    const manipulated of [
      `urma://investigation/${
        secondRef.slice("urma:investigation:".length)
      }/artifact/../${caption.sha256}`,
      `urma://investigation/${
        secondRef.slice("urma:investigation:".length)
      }/artifact/${caption.sha256}/extra`,
      `urma://investigation/${"A".repeat(32)}/artifact/${caption.sha256}`,
    ]
  ) {
    await assert.rejects(client.readResource({ uri: manipulated }));
  }

  const overview = await client.callTool({
    name: "get_overview",
    arguments: { investigationRef },
  });
  const overviewStructured = overview.structuredContent as Record<
    string,
    unknown
  >;
  assert.equal(overviewStructured.stateSummary, undefined);
  assert.equal(overviewStructured.interval, undefined);
  assert.equal(overviewStructured.requestedCount, undefined);
  assert.equal(
    (overviewStructured.sampling as Record<string, unknown>).resolutionMs,
    undefined,
  );
  assert(overview.content.some((item) => item.type === "image"));
  assert(overview.content.some((item) => item.type === "resource_link"));
  const overviewArtifact = (
    overview.structuredContent as Record<string, unknown>
  ).artifact as Record<string, unknown>;
  const artifact = await client.readResource({
    uri: String(overviewArtifact.resource),
  });
  assert.equal(artifact.contents[0]?.mimeType, "image/jpeg");
  assert.equal(
    typeof (artifact.contents[0] as { blob: string }).blob,
    "string",
  );
  const scopedOverview = await client.callTool({
    name: "get_overview",
    arguments: { investigationRef, startMs: 1_000, endMs: 3_000 },
  });
  assert.equal(scopedOverview.isError, undefined);
  const scopedContent = scopedOverview.structuredContent as {
    requestedInterval: { startMs: number; endMs: number };
    timebase: string;
    observedCoverage: {
      kind: string;
      continuous: boolean;
      sampleTimestampsMs: readonly number[];
    };
    sampling: {
      sampleReuse: { relation: string };
    };
    cells: readonly {
      timestampMs: number;
      provenance: { kind: string; timing: string };
    }[];
    artifact: { artifactId: string; resource: string };
  };
  assert.deepEqual(scopedContent.requestedInterval, {
    startMs: 1_000,
    endMs: 3_000,
  });
  assert.equal(scopedContent.timebase, "source-global");
  assert.equal(scopedContent.observedCoverage.kind, "sample-points-only");
  assert.equal(scopedContent.observedCoverage.continuous, false);
  assert.deepEqual(
    scopedContent.observedCoverage.sampleTimestampsMs,
    scopedContent.cells.map((cell) => cell.timestampMs),
  );
  assert(
    scopedContent.cells.every(
      (cell) => cell.timestampMs >= 1_000 && cell.timestampMs < 3_000,
    ),
  );
  assert(
    scopedContent.cells.every(
      (cell) =>
        cell.provenance.kind === "decoded" &&
        cell.provenance.timing === "nominal",
      ),
  );
  const frames = await client.callTool({
    name: "get_frames",
    arguments: {
      investigationRef,
      request: { kind: "burst", startMs: 500, endMs: 3000, count: 3 },
    },
  });
  const frameStructured = frames.structuredContent as Record<string, unknown>;
  assert.equal(frameStructured.stateSummary, undefined);
  assert.equal(
    (frameStructured.frames as Array<Record<string, unknown>>)[0]?.mimeType,
    undefined,
  );
  assert.equal(
    (frameStructured.frames as Array<Record<string, unknown>>)[0]?.byteSize,
    undefined,
  );
  assert(frames.content.some((item) => item.type === "image"));
  const state = await client.readResource({
    uri: `urma://investigation/${
      investigationRef.slice("urma:investigation:".length)
    }/state`,
  });
  const parsed = JSON.parse(
    (state.contents[0] as { text: string }).text,
  ) as Record<string, unknown>;
  assert.equal(parsed.investigationRef, investigationRef);
  assert.equal(containsPath(parsed, data.directory), false);
  const reopenable = parsed.reopenableResources as string[];
  assert.equal(
    reopenable.filter((uri) => uri.includes("/artifact/")).length >= 5,
    true,
    "caption, overview, and every ordered burst frame must be reopenable in this investigation",
  );
  assert(
    reopenable.every((uri) =>
      uri.startsWith(
        `urma://investigation/${
          investigationRef.slice("urma:investigation:".length)
        }/`,
      )
    ),
  );
  assert.equal(
    (
      await client.callTool({
        name: "search_transcript",
        arguments: { investigationRef, query: "x", limit: 21 },
      })
    ).isError,
    true,
  );
  assert.equal(
    (
      await client.callTool({
        name: "get_frames",
        arguments: {
          investigationRef,
          request: {
            kind: "points",
            timesMs: Array.from({ length: 13 }, (_, index) => index),
          },
        },
      })
    ).isError,
    true,
  );
  assert.equal(
    (
      await client.callTool({
        name: "read_transcript",
        arguments: { investigationRef, startMs: 3000, endMs: 1000 },
      })
    ).isError,
    true,
  );
});
