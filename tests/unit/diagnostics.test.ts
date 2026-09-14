import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  debugFromEnvironment,
  diagnosticLog,
  withExactFrameDiagnostics,
} from "../../src/core/diagnostics.js";
import { UrmaError } from "../../src/core/errors.js";

test("enabled diagnostics mirror the same JSON event to stderr and an appended JSONL file", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "urma-diagnostics-"));
  const file = path.join(directory, "debug.jsonl");
  const disabledFile = path.join(directory, "disabled.jsonl");
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const previousDebug = process.env.URMA_DEBUG;
  const previousFile = process.env.URMA_DEBUG_FILE;
  const originalWrite = process.stderr.write;
  let stderr = "";
  process.env.URMA_DEBUG = "1";
  process.env.URMA_DEBUG_FILE = file;
  process.stderr.write = ((chunk: Uint8Array | string) => {
    stderr += typeof chunk === "string"
      ? chunk
      : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;
  try {
    diagnosticLog(debugFromEnvironment(), "test", { count: 1, ok: true });
    const firstLine = (await readFile(file, "utf8")).trim();
    const stderrLine = stderr.trim();
    assert.match(stderrLine, /^Urma debug \{/u);
    const stderrEvent = JSON.parse(
      stderrLine.slice("Urma debug ".length),
    ) as Record<string, unknown>;
    const fileEvent = JSON.parse(firstLine) as Record<string, unknown>;
    assert.deepEqual(fileEvent, stderrEvent);
    assert.equal(fileEvent.event, "test");
    assert.equal(fileEvent.count, 1);
    assert.equal(typeof fileEvent.timestamp, "string");
    diagnosticLog(debugFromEnvironment(), "appended", { count: 2 });
    const lines = (await readFile(file, "utf8")).trim().split(/\r?\n/u);
    assert.equal(lines.length, 2);
    assert.equal(
      (JSON.parse(lines[1]!) as Record<string, unknown>).event,
      "appended",
    );
    process.env.URMA_DEBUG_FILE = directory;
    assert.doesNotThrow(() =>
      diagnosticLog(debugFromEnvironment(), "unwritable", { count: 3 })
    );
    process.env.URMA_DEBUG = "0";
    process.env.URMA_DEBUG_FILE = disabledFile;
    diagnosticLog(debugFromEnvironment(), "disabled", { count: 3 });
    await assert.rejects(readFile(disabledFile, "utf8"));
  } finally {
    process.stderr.write = originalWrite;
    if (previousDebug === undefined) delete process.env.URMA_DEBUG;
    else process.env.URMA_DEBUG = previousDebug;
    if (previousFile === undefined) delete process.env.URMA_DEBUG_FILE;
    else process.env.URMA_DEBUG_FILE = previousFile;
  }
});

test("exact-frame diagnostics correlate batched cache, fallback, and subprocess timing without changing the operation result", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "urma-exact-diagnostics-"),
  );
  const file = path.join(directory, "debug.jsonl");
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const previousFile = process.env.URMA_DEBUG_FILE;
  process.env.URMA_DEBUG_FILE = file;
  t.after(() => {
    if (previousFile === undefined) delete process.env.URMA_DEBUG_FILE;
    else process.env.URMA_DEBUG_FILE = previousFile;
  });
  const result = await withExactFrameDiagnostics(
    true,
    {
      requestKind: "points",
      presentation: "individual",
      requestedTimestampsMs: [1_000, 2_000],
    },
    async (trace) => {
      assert(trace);
      trace.setSource(
        "urma:source:remote:v1:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        120_000,
      );
      trace.markExactFrameCache(0, 1_000, false);
      trace.markExactFrameCache(1, 2_000, true);
      trace.markCacheStatus(0, 1_000, "bounded", "miss");
      trace.markCacheStatus(0, 1_000, "reusable", "miss");
      trace.markRequestedSection(0, 1_000, 0, 3_001);
      trace.markFrameSelection(0, 1_000, {
        path: "bounded-section",
        transportCacheHit: false,
        sectionStartMs: 0,
        sectionEndMs: 3_001,
        physicalSeekMs: 1_000,
        coverage: {
          startSeconds: 0,
          endSeconds: 3,
          startPts: "0",
          endPts: "3000",
          durationTs: "3000",
          timeBase: "1/1000",
        },
      });
      trace.markFallback(
        0,
        1_000,
        "targeted-media-unavailable-missing-targeted-output",
      );
      trace.markFrameStatus(0, 1_000, "succeeded");
      trace.recordSubprocess("yt-dlp", 12, "yt-dlp-acquisition");
      trace.recordSubprocess("ffprobe", 3, "ffprobe-media-probe");
      trace.recordSubprocess("ffmpeg", 5, "ffmpeg-exact-frame");
      trace.addNewTransportArtifactBytes(42);
      trace.addStage("remoteBoundedAcquisitionMs", 20);
      trace.addStage("ffmpegExactFrameExtractionMs", 5);
      return "unchanged";
    },
  );
  assert.equal(result, "unchanged");
  const events = (await readFile(file, "utf8"))
    .trim()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const summary = events.find((event) => event.event === "exact-frame-request");
  const items = events.filter((event) => event.event === "exact-frame-item");
  assert(summary);
  assert.equal(items.length, 2);
  assert.equal(typeof summary.correlationId, "string");
  assert(items.every((item) => item.correlationId === summary.correlationId));
  assert.equal(
    summary.sourceRef,
    "urma:source:remote:v1:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  );
  assert.equal(summary.requestedTimestampsMs, "1000,2000");
  assert.equal(summary.exactFrameCacheHits, 1);
  assert.equal(summary.exactFrameCacheMisses, 1);
  assert.equal(summary.boundedArtifactCacheMisses, 1);
  assert.equal(summary.fallbackOccurred, true);
  assert.equal(
    summary.fallbackReasonCategory,
    "targeted-media-unavailable-missing-targeted-output",
  );
  assert.equal(summary.ytDlpProcessCount, 1);
  assert.equal(summary.ffprobeProcessCount, 1);
  assert.equal(summary.ffmpegProcessCount, 1);
  assert.equal(summary.newTransportArtifactBytes, 42);
  assert.equal(typeof summary.requestTotalMs, "number");
  assert.equal(typeof summary.remoteBoundedAcquisitionMs, "number");
  const fallbackItem = items.find((item) => item.frameIndex === 0);
  assert(fallbackItem);
  assert.equal(fallbackItem.fallbackOccurred, true);
  assert.equal(fallbackItem.extractionPath, "bounded-section");
  assert.equal(fallbackItem.sectionBounds, "0-3001");
  assert.equal(fallbackItem.physicalSeekMs, 1000);
  assert.equal(
    items.find((item) => item.frameIndex === 1)?.extractionPath,
    "exact-cache",
  );
  assert(!JSON.stringify(events).includes(directory));
});

test("disabled exact-frame diagnostics pass null and emit no trace", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "urma-exact-diagnostics-disabled-"),
  );
  const file = path.join(directory, "debug.jsonl");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const value = await withExactFrameDiagnostics(
    false,
    { requestKind: "points" },
    async (trace) => {
      assert.equal(trace, null);
      return 7;
    },
  );
  assert.equal(value, 7);
  await assert.rejects(readFile(file, "utf8"));
});

test("exact-frame failure diagnostics retain correlation and cancellation code", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "urma-exact-diagnostics-failure-"),
  );
  const file = path.join(directory, "debug.jsonl");
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const previousFile = process.env.URMA_DEBUG_FILE;
  process.env.URMA_DEBUG_FILE = file;
  t.after(() => {
    if (previousFile === undefined) delete process.env.URMA_DEBUG_FILE;
    else process.env.URMA_DEBUG_FILE = previousFile;
  });
  await assert.rejects(
    withExactFrameDiagnostics(
      true,
      { requestKind: "points", requestedTimestampsMs: [3_000] },
      async (trace) => {
        assert(trace);
        trace.setSource(
          "urma:source:remote:v1:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
          60_000,
        );
        throw new UrmaError("CANCELLED", "cancelled for diagnostics test");
      },
    ),
  );
  const events = (await readFile(file, "utf8"))
    .trim()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const summary = events.find((event) => event.event === "exact-frame-request");
  const item = events.find((event) => event.event === "exact-frame-item");
  assert(summary);
  assert(item);
  assert.equal(summary.status, "cancelled");
  assert.equal(summary.finalCode, "CANCELLED");
  assert.equal(item.status, "cancelled");
  assert.equal(item.finalCode, "CANCELLED");
  assert.equal(item.correlationId, summary.correlationId);
});
