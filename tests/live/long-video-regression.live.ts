import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/client/stdio";
import {
  type ArtifactId,
  parseInvestigationRef,
  parseSourceRef,
  remoteSourceRef,
  youtubeRemoteIdentity,
} from "../../src/core/ids.js";
import { BlobStore } from "../../src/store/blob-store.js";
import { SqliteStore } from "../../src/store/sqlite-store.js";

const sourceId = "QnnItukxRAI";
const source = `https://www.youtube.com/watch?v=${sourceId}`;
const expectedDurationMs = 28_403_000;
const requests = [
  { label: "04:30:30", atMs: 16_230_000 },
  { label: "06:55:30", atMs: 24_930_000 },
] as const;

if (process.env.URMA_LONG_VIDEO_REGRESSION !== "1") {
  process.stderr.write(
    "Urma long-video regression skipped: set URMA_LONG_VIDEO_REGRESSION=1 to permit the public YouTube release gate.\n",
  );
  process.exit(0);
}

type ToolResult = Readonly<{
  isError?: boolean;
  content?: unknown;
  structuredContent?: Record<string, unknown>;
}>;
type FrameRecord = {
  requestedLabel: string;
  requestedMs: number;
  returnedMs: number;
  artifactId: string;
  resource: string;
  wallMs: number;
  cacheHit: boolean;
  mediaIntervalsBefore: number;
  mediaIntervalsAfter: number;
  newMediaAcquisition: boolean;
  formatId: string | null;
  height: number | null;
  protocol: string | null;
  mediaAcquisitionWallMs: number | null;
  mediaAcquisitionStatus: string | null;
  jpegValid: boolean;
  denoAvailable: false;
  nodeJsRuntime: true;
  timeoutOrRetry: "none";
};

function withoutDeno(pathValue: string): string {
  return pathValue
    .split(path.delimiter)
    .filter((entry) => entry.length > 0 && !/deno/iu.test(entry))
    .join(path.delimiter);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 150 && processIsAlive(pid); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(
    processIsAlive(pid),
    false,
    `Urma stdio process ${pid} survived MCP client shutdown`,
  );
}

function structured(
  result: ToolResult,
  operation: string,
): Record<string, unknown> {
  assert.notEqual(result.isError, true, `${operation} returned an MCP error`);
  assert(
    result.structuredContent,
    `${operation} did not return structuredContent`,
  );
  return result.structuredContent;
}

function record(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert(value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function numberField(
  value: Record<string, unknown>,
  key: string,
): number | null {
  const number = Number(value[key]);
  return Number.isFinite(number) ? number : null;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/https?:\/\/[^\s"']+/giu, "<url>").slice(0, 500);
}

async function readState(
  client: Client,
  uri: string,
): Promise<Record<string, unknown>> {
  const result = await client.readResource({ uri });
  const item = result.contents[0] as { text?: string } | undefined;
  const text = item?.text;
  if (typeof text !== "string") {
    throw new Error("investigation state resource must be JSON text");
  }
  return JSON.parse(text) as Record<string, unknown>;
}

async function readJpeg(client: Client, uri: string): Promise<number> {
  const result = await client.readResource({ uri });
  const item = result.contents[0] as
    | { mimeType?: string; blob?: string }
    | undefined;
  assert.equal(
    item?.mimeType,
    "image/jpeg",
    "exact frame resource must be JPEG",
  );
  const blob = item?.blob;
  if (typeof blob !== "string") {
    throw new Error("exact frame resource must contain binary content");
  }
  const bytes = Buffer.from(blob, "base64");
  assert(bytes.length > 4, "exact frame JPEG is unexpectedly small");
  assert.equal(bytes[0], 0xff, "exact frame JPEG has no SOI marker");
  assert.equal(bytes[1], 0xd8, "exact frame JPEG has no SOI marker");
  assert.equal(bytes.at(-2), 0xff, "exact frame JPEG has no EOI marker");
  assert.equal(bytes.at(-1), 0xd9, "exact frame JPEG has no EOI marker");
  return bytes.length;
}

const temporary = await mkdtemp(
  path.join(os.tmpdir(), "urma-long-regression-"),
);
const dataDir = path.join(temporary, "data");
const serverPath = path.resolve("dist/tests/support/stdio-entry.js");
const baseEnvironment = {
  ...getDefaultEnvironment(),
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  ),
};
delete baseEnvironment.URMA_DENO;
delete baseEnvironment.URMA_FFMPEG;
delete baseEnvironment.URMA_FFPROBE;
delete baseEnvironment.URMA_YTDLP;
delete baseEnvironment.DENO_DIR;
delete baseEnvironment.DENO_INSTALL_ROOT;
const environment = {
  ...baseEnvironment,
  PATH: withoutDeno(baseEnvironment.PATH ?? process.env.PATH ?? ""),
  URMA_DATA_DIR: dataDir,
  URMA_LOCAL_ROOTS: "",
};
try {
  const denoProbe = spawnSync(
    process.platform === "win32" ? "deno.exe" : "deno",
    ["--version"],
    { env: environment, encoding: "utf8", windowsHide: true },
  );
  assert.equal(
    (denoProbe.error as NodeJS.ErrnoException | undefined)?.code,
    "ENOENT",
    "Deno must be unresolvable from the effective release-test PATH",
  );
  assert.equal(
    denoProbe.status,
    null,
    "Deno must not execute in the release test",
  );
} catch (error) {
  await rm(temporary, { recursive: true, force: true });
  throw error;
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  cwd: process.cwd(),
  env: environment,
  stderr: "pipe",
});
let stderr = "";
transport.stderr?.on("data", (chunk: Buffer) => {
  stderr += chunk.toString("utf8");
});
const client = new Client({
  name: "urma-long-video-regression",
  version: "1.0.0",
});
let serverPid: number | null = null;
const frameResults: FrameRecord[] = [];
let sourceRef = "";
let investigationRef = "";
let sourceDurationMs = 0;
let captionTrackCount = 0;
let cacheStats: ReturnType<SqliteStore["cacheStats"]> | null = null;
let databaseOpened = false;
let blobChecks = 0;

try {
  await client.connect(transport);
  serverPid = transport.pid;
  assert.equal(typeof serverPid, "number");

  const inspected = structured(
    (await client.callTool({
      name: "inspect_video",
      arguments: { source },
    })) as ToolResult,
    "inspect_video",
  );
  sourceRef = String(inspected.sourceRef);
  investigationRef = String(inspected.investigationRef);
  assert.equal(sourceRef, remoteSourceRef(youtubeRemoteIdentity(sourceId)));
  assert.match(investigationRef, /^urma:investigation:[0-9a-f]{32}$/u);
  const sourceMetadata = record(inspected.source);
  sourceDurationMs = Number(sourceMetadata.durationMs);
  assert(
    Number.isSafeInteger(sourceDurationMs) && sourceDurationMs >= 24_930_001,
    `long-video source duration is too short: ${String(sourceDurationMs)}`,
  );
  assert(
    Math.abs(sourceDurationMs - expectedDurationMs) <= 120_000,
    `resolved source duration changed materially: ${String(sourceDurationMs)}`,
  );
  captionTrackCount = Number(inspected.captionTrackCount);
  assert(Number.isSafeInteger(captionTrackCount) && captionTrackCount >= 0);
  const initialCache = record(inspected.cache);
  const initialMediaIntervals = Number(
    initialCache.continuousMediaIntervalCount,
  );
  assert(
    Number.isSafeInteger(initialMediaIntervals) && initialMediaIntervals === 0,
    "fresh long-video test data must have no cached media intervals before frame acquisition",
  );
  const stateResource = String(inspected.stateResource);

  for (const request of requests) {
    const started = performance.now();
    const result = structured(
      (await client.callTool({
        name: "get_frames",
        arguments: {
          investigationRef,
          request: { kind: "points", timesMs: [request.atMs] },
        },
      })) as ToolResult,
      `get_frames ${request.label}`,
    );
    const frames = result.frames as Array<Record<string, unknown>>;
    assert.equal(
      frames.length,
      1,
      `get_frames ${request.label} must return one frame`,
    );
    const frame = frames[0]!;
    const returnedMs = Number(frame.atMs);
    assert.equal(
      returnedMs,
      request.atMs,
      `get_frames ${request.label} returned the wrong evidence timestamp`,
    );
    assert.equal(frame.mimeType, "image/jpeg");
    assert.equal(
      frame.cacheHit,
      false,
      `fresh long-video frame ${request.label} unexpectedly came from cache`,
    );
    const artifactId = String(frame.artifactId);
    const resource = String(frame.resource);
    const jpegBytes = await readJpeg(client, resource);
    const state = await readState(client, stateResource);
    const cache = record(state.cache);
    const intervals = cache.continuousMediaIntervals;
    const intervalList = Array.isArray(intervals) ? intervals : [];
    const mediaIntervalsAfter = intervalList.length;
    const mediaIntervalsBefore = frameResults.at(-1)?.mediaIntervalsAfter ??
      initialMediaIntervals;
    assert(
      mediaIntervalsAfter > mediaIntervalsBefore,
      `get_frames ${request.label} did not create a new media cache interval`,
    );
    frameResults.push({
      requestedLabel: request.label,
      requestedMs: request.atMs,
      returnedMs,
      artifactId,
      resource,
      wallMs: Math.round(performance.now() - started),
      cacheHit: false,
      mediaIntervalsBefore,
      mediaIntervalsAfter,
      newMediaAcquisition: true,
      formatId: null,
      height: null,
      protocol: null,
      mediaAcquisitionWallMs: null,
      mediaAcquisitionStatus: null,
      jpegValid: jpegBytes > 4,
      denoAvailable: false,
      nodeJsRuntime: true,
      timeoutOrRetry: "none",
    });
  }

  await client.close();
  const connectedPid = serverPid;
  if (typeof connectedPid !== "number") {
    throw new Error("MCP transport did not expose the Urma process PID");
  }
  await waitForProcessExit(connectedPid);
  serverPid = null;

  const store = await SqliteStore.open(path.join(dataDir, "urma.db"));
  try {
    databaseOpened = true;
    cacheStats = store.cacheStats();
    const revision = String(sourceMetadata.snapshotRevision);
    const artifacts = store.listArtifacts(parseSourceRef(sourceRef), revision);
    const acquisitions = store.listAcquisitions(
      parseInvestigationRef(investigationRef),
    );
    assert(
      acquisitions.every((acquisition) => acquisition.status === "succeeded"),
      "long-video regression must not leave a failed or running acquisition record",
    );
    for (const frame of frameResults) {
      const storedFrame = store.getArtifact(frame.artifactId as ArtifactId);
      assert(storedFrame, `stored frame ${frame.requestedLabel} is missing`);
      assert.equal(storedFrame.mimeType, "image/jpeg");
      const transportId = storedFrame.producer.transportArtifactId;
      assert.equal(
        typeof transportId,
        "string",
        `stored frame ${frame.requestedLabel} has no transport parent`,
      );
      const transportArtifact = store.getArtifact(transportId as ArtifactId);
      assert(
        transportArtifact,
        `transport artifact for ${frame.requestedLabel} is missing`,
      );
      assert(
        transportArtifact.kind === "media_section" ||
          transportArtifact.kind === "evidence_media",
      );
      const formatId = transportArtifact.producer.formatId;
      frame.formatId = typeof formatId === "string" ? formatId : null;
      frame.height = numberField(transportArtifact.producer, "height");
      frame.protocol = typeof transportArtifact.producer.protocol === "string"
        ? transportArtifact.producer.protocol
        : null;
      const mediaAcquisition = acquisitions.find(
        (acquisition) =>
          acquisition.metadata.artifactId === transportArtifact.artifactId,
      );
      frame.mediaAcquisitionWallMs = mediaAcquisition?.wallMs ?? null;
      frame.mediaAcquisitionStatus = mediaAcquisition?.status ?? null;
      const blobStore = new BlobStore(path.join(dataDir, "blobs"));
      await blobStore.verify(storedFrame.artifactId, storedFrame.blobPath);
      await blobStore.verify(
        transportArtifact.artifactId,
        transportArtifact.blobPath,
      );
      blobChecks += 2;
    }
    assert.equal(
      artifacts.filter((artifact) => artifact.kind === "frame").length,
      2,
    );
    assert.equal(
      artifacts.filter(
        (artifact) =>
          artifact.kind === "media_section" ||
          artifact.kind === "evidence_media",
      ).length,
      2,
    );
  } finally {
    store.close();
  }
} catch (error) {
  process.stderr.write(
    `Urma long-video regression failed: ${safeError(error)}\n`,
  );
  throw error;
} finally {
  await client.close().catch(() => undefined);
  if (serverPid !== null) {
    await waitForProcessExit(serverPid).catch((error) => {
      process.stderr.write(
        `Urma long-video shutdown check failed: ${safeError(error)}\n`,
      );
    });
  }
  await rm(temporary, { recursive: true, force: true });
}

assert.equal(serverPid, null);
process.stdout.write(
  `${
    JSON.stringify({
      sourceRef,
      sourceDurationMs,
      captionTrackCount,
      investigationRef,
      requests: frameResults,
      denoAvailable: false,
      denoProcessCount: 0,
      nodeRuntimeArgument: `--js-runtimes node:${process.execPath}`,
      ytdlpObsoleteFlagPresent: false,
      stdioServerPidExited: true,
      stderrBytes: Buffer.byteLength(stderr),
      databaseOpened,
      cacheStats,
      blobChecks,
    })
  }\n`,
);
