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

if (process.env.URMA_LIVE_YOUTUBE !== "1") {
  process.stderr.write(
    "Urma live test skipped: set URMA_LIVE_YOUTUBE=1 to permit the public YouTube engineering path.\n",
  );
  process.exit(0);
}

const source = process.env.URMA_LIVE_SOURCE ??
  "https://www.youtube.com/watch?v=yP0axVHdP-U";
const query = process.env.URMA_LIVE_QUERY ?? "Ray tracing";
const temporary = await mkdtemp(path.join(os.tmpdir(), "urma-live-"));
const dataDir = path.join(temporary, "data");
const serverPath = path.resolve("dist/tests/support/stdio-entry.js");

function withoutDeno(pathValue: string): string {
  return pathValue
    .split(path.delimiter)
    .filter(
      (entry) =>
        !/(?:^|[\\/])deno(?:\.exe)?$/iu.test(entry) &&
        !/DenoLand\.Deno/iu.test(entry),
    )
    .join(path.delimiter);
}

const baseEnvironment = {
  ...getDefaultEnvironment(),
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  ),
};
delete baseEnvironment.URMA_DENO;
delete baseEnvironment.URMA_YTDLP;
delete baseEnvironment.URMA_FFMPEG;
delete baseEnvironment.URMA_FFPROBE;
const environment = {
  ...baseEnvironment,
  PATH: withoutDeno(baseEnvironment.PATH ?? process.env.PATH ?? ""),
  URMA_DATA_DIR: dataDir,
  URMA_LOCAL_ROOTS: "",
};
const denoProbe = spawnSync(
  process.platform === "win32" ? "deno.exe" : "deno",
  ["--version"],
  { env: environment, encoding: "utf8", windowsHide: true },
);
assert.equal(
  (denoProbe.error as NodeJS.ErrnoException | undefined)?.code,
  "ENOENT",
  "the live release gate must run with Deno unavailable",
);

async function connect() {
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
    name: "urma-live-engineering",
    version: "1.0.0",
  });
  await client.connect(transport);
  return { client, transport, getStderr: () => stderr };
}

async function callTool(
  client: Client,
  params: Parameters<Client["callTool"]>[0],
) {
  return await client.callTool(params, { timeout: 240_000 });
}

function structured(result: {
  structuredContent?: Record<string, unknown>;
}): Record<string, unknown> {
  assert(
    result.structuredContent,
    "MCP tool result must contain structuredContent",
  );
  return result.structuredContent;
}
function assertSuccess(
  result: { isError?: boolean | undefined; content?: unknown },
  operation: string,
): void {
  assert.equal(
    result.isError,
    undefined,
    `${operation} failed: ${JSON.stringify(result.content)}`,
  );
}

let first: Awaited<ReturnType<typeof connect>> | null = null;
let second: Awaited<ReturnType<typeof connect>> | null = null;
try {
  first = await connect();
  const inspectedResult = await callTool(first.client, {
    name: "inspect_video",
    arguments: { source },
  });
  assertSuccess(inspectedResult, "inspect_video");
  const inspected = structured(
    inspectedResult as { structuredContent?: Record<string, unknown> },
  );
  const sourceRef = String(inspected.sourceRef);
  const investigationRef = String(inspected.investigationRef);
  assert(sourceRef.startsWith("urma:source:remote:v1:"));
  assert(investigationRef.startsWith("urma:investigation:"));
  const durationMs = Number(
    (inspected.source as Record<string, unknown>).durationMs,
  );
  assert(
    Number.isSafeInteger(durationMs) && durationMs >= 900_000,
    `Expected a long public fixture, received durationMs=${String(durationMs)}`,
  );
  const captionTracks = inspected.captionTracks as Array<
    Record<string, unknown>
  >;
  assert(
    captionTracks.length > 0,
    "Expected caption discovery to return at least one native track",
  );
  const trackRef = String(captionTracks[0]!.trackRef);
  const searchResult = await callTool(first.client, {
    name: "search_transcript",
    arguments: { investigationRef, query, mode: "phrase", limit: 5, trackRef },
  });
  assertSuccess(searchResult, "search_transcript");
  const search = structured(
    searchResult as { structuredContent?: Record<string, unknown> },
  );
  const hits = search.hits as Array<Record<string, unknown>>;
  assert(
    hits.length > 0,
    `Expected public fixture captions to contain ${JSON.stringify(query)}`,
  );
  const atMs = Number(hits[0]!.startMs);
  const readResult = await callTool(first.client, {
    name: "read_transcript",
    arguments: {
      investigationRef,
      startMs: Math.max(0, atMs - 1000),
      endMs: Math.min(durationMs, atMs + 5000),
      trackRef,
    },
  });
  assertSuccess(readResult, "read_transcript");
  const read = structured(
    readResult as { structuredContent?: Record<string, unknown> },
  );
  assert(
    (read.segments as unknown[]).length > 0,
    "Expected transcript retrieval to return at least one caption segment",
  );
  const overviewResult = await callTool(first.client, {
    name: "get_overview",
    arguments: { investigationRef },
  });
  assertSuccess(overviewResult, "get_overview");
  const overview = structured(
    overviewResult as { structuredContent?: Record<string, unknown> },
  );
  assert.equal(overview.actualCount, 12);
  const framesResult = await callTool(first.client, {
    name: "get_frames",
    arguments: {
      investigationRef,
      request: { kind: "points", timesMs: [atMs] },
    },
  });
  assertSuccess(framesResult, "get_frames exact remote frame");
  const frames = structured(
    framesResult as { structuredContent?: Record<string, unknown> },
  );
  const frameList = frames.frames as Array<Record<string, unknown>>;
  assert.equal(frameList.length, 1);
  assert.equal(
    (frameList[0] as Record<string, unknown>).mimeType,
    "image/jpeg",
  );
  const burstStart = Math.max(0, atMs - 5000);
  const burstEnd = Math.min(durationMs, atMs + 5000);
  const burstResult = await callTool(first.client, {
    name: "get_frames",
    arguments: {
      investigationRef,
      request: {
        kind: "burst",
        startMs: burstStart,
        endMs: burstEnd,
        count: 3,
      },
    },
  });
  assertSuccess(burstResult, "get_frames ordered burst");
  const burst = structured(
    burstResult as { structuredContent?: Record<string, unknown> },
  );
  const burstFrames = burst.frames as Array<Record<string, unknown>>;
  assert.equal(burstFrames.length, 3);
  assert(
    burstFrames.every(
      (frame, index) =>
        index === 0 ||
        Number(frame.atMs) > Number(burstFrames[index - 1]!.atMs),
    ),
    "Ordered burst timestamps must increase",
  );
  const lateFrameAtMs = durationMs - 1000;
  const lateFrameResult = await callTool(first.client, {
    name: "get_frames",
    arguments: {
      investigationRef,
      request: { kind: "points", timesMs: [lateFrameAtMs] },
    },
  });
  assertSuccess(lateFrameResult, "get_frames long-source late frame");
  const lateFrame = structured(
    lateFrameResult as { structuredContent?: Record<string, unknown> },
  );
  assert.equal((lateFrame.frames as unknown[]).length, 1);
  const stateUri = `urma://investigation/${
    investigationRef.slice("urma:investigation:".length)
  }/state`;
  const stateResult = await first.client.readResource({ uri: stateUri });
  const stateText = (stateResult.contents[0] as { text: string }).text;
  const state = JSON.parse(stateText) as Record<string, unknown>;
  assert.equal(state.sourceRef, sourceRef);
  assert.equal(state.investigationRef, investigationRef);
  const artifactUri = String(frameList[0]!.resource);
  const artifact = await first.client.readResource({ uri: artifactUri });
  assert.equal(artifact.contents[0]?.mimeType, "image/jpeg");
  const firstPayload = JSON.stringify({
    inspected,
    search,
    read,
    overview,
    frames,
    burst,
    lateFrame,
    state,
  });
  assert(firstPayload.length < 8 * 1024 * 1024);
  assert(
    !/[?&](?:sig|signature|token|expire|x-goog-[^=]+)=/i.test(firstPayload),
    "Model-facing payload leaked a signed delivery URL",
  );
  await first.client.close();
  first = null;

  second = await connect();
  const reopened = await second.client.readResource({ uri: artifactUri });
  assert.equal(reopened.contents[0]?.mimeType, "image/jpeg");
  const secondInspectResult = await callTool(second.client, {
    name: "inspect_video",
    arguments: { source: sourceRef },
  });
  assertSuccess(secondInspectResult, "second inspect_video");
  const secondInspect = structured(
    secondInspectResult as { structuredContent?: Record<string, unknown> },
  );
  assert.equal(secondInspect.sourceRef, sourceRef);
  assert.notEqual(secondInspect.investigationRef, investigationRef);
  const secondStateUri = String(secondInspect.stateResource);
  const secondStateResult = await second.client.readResource({
    uri: secondStateUri,
  });
  const secondState = JSON.parse(
    (secondStateResult.contents[0] as { text: string }).text,
  ) as {
    evidence: {
      sparseVisualSets: unknown[];
      exactVisualPoints: unknown[];
      orderedVisualSets: unknown[];
    };
    cache: { storyboard: boolean; reusableArtifacts: number };
  };
  assert.equal(secondState.cache.storyboard, true);
  assert(secondState.cache.reusableArtifacts > 0);
  assert.equal(secondState.evidence.sparseVisualSets.length, 0);
  assert.equal(secondState.evidence.exactVisualPoints.length, 0);
  assert.equal(secondState.evidence.orderedVisualSets.length, 0);
  const secondPayload = JSON.stringify(secondInspect);
  assert(secondPayload.length < 256 * 1024);
  assert(
    !/[?&](?:sig|signature|token|expire|x-goog-[^=]+)=/i.test(secondPayload),
  );
  process.stdout.write(
    `${
      JSON.stringify({
        sourceRef,
        firstInvestigationRef: investigationRef,
        secondInvestigationRef: secondInspect.investigationRef,
        durationMs,
        captionTracks: captionTracks.length,
        transcriptHits: hits.length,
        transcriptSegments: (read.segments as unknown[]).length,
        overviewCells: overview.actualCount,
        frameAtMs: atMs,
        orderedBurstFrames: burstFrames.length,
        lateFrameAtMs,
        artifactUri,
        denoAvailable: false,
        restartCache: {
          storyboard: secondState.cache.storyboard,
          reusableArtifacts: secondState.cache.reusableArtifacts,
        },
        secondInvestigationVisualEvidence: { sparse: 0, exact: 0, ordered: 0 },
      })
    }\n`,
  );
} finally {
  await first?.client.close().catch(() => undefined);
  await second?.client.close().catch(() => undefined);
  await rm(temporary, { recursive: true, force: true });
}
