import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
import { buildMcpServer } from "../../src/mcp/server.js";
import { runChecked } from "../../src/subprocess/runner.js";

function structured<T>(result: CallToolResult, label: string): T {
  assert.equal(
    result.isError,
    undefined,
    `${label} failed: ${JSON.stringify(result.content)}`,
  );
  assert(result.structuredContent, `${label} omitted structuredContent`);
  return result.structuredContent as T;
}

async function readEvents(file: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(file, "utf8");
  return text.trim() === "" ? [] : text
    .trim()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("exact-frame MCP diagnostics are correlated, cache-aware, failure-visible, and outside the public result", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "urma-exact-frame-diagnostics-mcp-"),
  );
  const video = path.join(directory, "fixture.mp4");
  const debugFile = path.join(directory, "debug.jsonl");
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
  const previousDebugFile = process.env.URMA_DEBUG_FILE;
  const previousWrite = process.stderr.write;
  process.env.URMA_DEBUG_FILE = debugFile;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  const app = await openUrma(
    loadConfig({
      URMA_DATA_DIR: path.join(directory, "data"),
      URMA_LOCAL_ROOTS: directory,
      URMA_DEBUG: "1",
    }),
  );
  const server = buildMcpServer(app.evidence, app.store, app.blobs, app.config);
  const client = new Client({
    name: "urma-exact-frame-diagnostics-test",
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
    process.stderr.write = previousWrite;
    if (previousDebugFile === undefined) delete process.env.URMA_DEBUG_FILE;
    else process.env.URMA_DEBUG_FILE = previousDebugFile;
    await rm(directory, { recursive: true, force: true });
  });

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
  const firstResult = await client.callTool({
    name: "get_frames",
    arguments: {
      investigationRef: inspection.investigationRef,
      request: { kind: "points", timesMs: [500, 1_500] },
    },
  });
  const first = structured<{
    kind: string;
    continuousMotion: false;
    frames: readonly unknown[];
    investigationRef: string;
    stateResource: string;
  }>(firstResult, "first get_frames");
  assert.deepEqual(Object.keys(first).sort(), [
    "continuousMotion",
    "frames",
    "investigationRef",
    "kind",
    "stateResource",
  ]);
  assert.equal(first.frames.length, 2);
  const secondResult = await client.callTool({
    name: "get_frames",
    arguments: {
      investigationRef: inspection.investigationRef,
      request: { kind: "points", timesMs: [500] },
    },
  });
  const second = structured<{ frames: readonly unknown[] }>(
    secondResult,
    "warm get_frames",
  );
  assert.equal(second.frames.length, 1);
  const failedResult = await client.callTool({
    name: "get_frames",
    arguments: {
      investigationRef: "urma:investigation:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      request: { kind: "points", timesMs: [500] },
    },
  });
  assert.equal(failedResult.isError, true);

  const events = await readEvents(debugFile);
  const summaries = events.filter(
    (event) => event.event === "exact-frame-request",
  );
  assert.equal(summaries.length, 3);
  const firstSummary = summaries[0]!;
  const secondSummary = summaries[1]!;
  const failedSummary = summaries[2]!;
  assert.equal(firstSummary.sourceRef, inspection.sourceRef);
  assert.equal(firstSummary.requestedTimestampsMs, "500,1500");
  assert.equal(firstSummary.exactFrameCacheHits, 0);
  assert.equal(firstSummary.exactFrameCacheMisses, 2);
  assert.equal(
    firstSummary.extractionPath,
    "500:local-direct,1500:local-direct",
  );
  assert.equal(firstSummary.remoteAcquisitionOccurred, false);
  assert.equal(firstSummary.ffmpegProcessCount, 2);
  assert.equal(typeof firstSummary.sourceResolutionMs, "number");
  assert.equal(typeof firstSummary.exactFrameCacheLookupMs, "number");
  assert.equal(typeof firstSummary.ffmpegExactFrameExtractionMs, "number");
  assert.equal(typeof firstSummary.jpegValidationMs, "number");
  assert.equal(
    typeof firstSummary.canonicalExactFrameArtifactCommitMs,
    "number",
  );
  assert.equal(typeof firstSummary.serviceResultConstructionMs, "number");
  assert.equal(typeof firstSummary.mcpResultConstructionMs, "number");
  assert.equal(secondSummary.sourceRef, inspection.sourceRef);
  assert.equal(secondSummary.requestedTimestampsMs, "500");
  assert.equal(secondSummary.exactFrameCacheHits, 1);
  assert.equal(secondSummary.exactFrameCacheMisses, 0);
  assert.equal(secondSummary.extractionPath, "500:exact-cache");
  assert.equal(secondSummary.ffmpegProcessCount, 0);
  assert.equal(secondSummary.remoteAcquisitionOccurred, false);
  assert.equal(failedSummary.status, "failed");
  assert.equal(failedSummary.finalCode, "INVALID_SOURCE");
  assert.equal(typeof failedSummary.requestTotalMs, "number");
  assert.equal(typeof failedSummary.mcpResultConstructionMs, "number");

  const items = events.filter((event) => event.event === "exact-frame-item");
  assert.equal(items.length, 3);
  assert(
    items
      .slice(0, 2)
      .every((item) => item.correlationId === firstSummary.correlationId),
  );
  assert.equal(items[0]?.extractionPath, "local-direct");
  assert.equal(items[1]?.extractionPath, "local-direct");
  assert.equal(items[2]?.correlationId, secondSummary.correlationId);
  const firstMcpResult = events.find(
    (event) =>
      event.event === "mcp-result" &&
      event.correlationId === firstSummary.correlationId,
  );
  const firstPresentation = events.find(
    (event) =>
      event.event === "get-frames-presentation" &&
      event.correlationId === firstSummary.correlationId,
  );
  const failedMcpResult = events.find(
    (event) =>
      event.event === "mcp-result" &&
      event.correlationId === failedSummary.correlationId,
  );
  assert(firstMcpResult);
  assert(firstPresentation);
  assert(failedMcpResult);
  assert(!JSON.stringify(events).includes(directory));
});
