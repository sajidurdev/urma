import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { openUrma } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { UrmaError } from "../../src/core/errors.js";
import { remoteSourceRef, youtubeRemoteIdentity } from "../../src/core/ids.js";
import { makeCaptionTrack } from "../../src/sources/caption-tracks.js";
import { YtDlp } from "../../src/subprocess/ytdlp.js";
import { buildMcpServer } from "../../src/mcp/server.js";
import { putTestSource } from "../support/source-fixture.js";

const originalBody = "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\noriginal caption\n";
const changedBody = originalBody.replace("original", "revised");

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "urma-caption-recovery-"));
  const app = await openUrma(loadConfig({
    URMA_DATA_DIR: path.join(directory, "data"),
    URMA_YTDLP: process.execPath,
  }));
  t.after(async () => {
    app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const provider = { body: originalBody, downloads: 0 };
  t.mock.method(YtDlp.prototype, "run", async (args: readonly string[]) => {
    assert(args.includes("--skip-download"));
    const output = args[args.indexOf("--paths") + 1];
    assert(output);
    await writeFile(path.join(output, "caption.en.vtt"), provider.body);
    provider.downloads++;
    return {
      executable: "fake-caption-provider", args, code: 0,
      stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), wallMs: 1,
    };
  });
  const sourceRef = remoteSourceRef(youtubeRemoteIdentity("aaaaaaaaaaa"));
  const revision = "caption-snapshot-a";
  const seed = (sourceRevision: string) => {
    const track = makeCaptionTrack(sourceRef, sourceRevision, {
      language: "en", kind: "manual", displayName: "English",
      formats: ["vtt"], providerTrackId: "stable-provider-track",
    });
    putTestSource(app.store, {
      sourceRef, kind: "remote", canonicalKey: "aaaaaaaaaaa",
      revision: sourceRevision, title: "Caption recovery", durationMs: 2_000,
      metadata: {
        captionTracks: [track],
        capabilities: { nativeCaptions: true, chapters: false, nativeStoryboard: false, targetedMedia: false, audio: false },
      },
    });
  };
  seed(revision);
  const inspected = await app.evidence.inspectVideo({ source: sourceRef });
  const read = () => app.evidence.readTranscript({
    investigationRef: inspected.investigationRef, startMs: 0, endMs: 1_000,
  });
  await read();
  const artifact = app.store.listArtifacts(sourceRef, revision).find(item => item.kind === "caption");
  const track = app.store.listTranscriptTracks(sourceRef, revision)[0];
  assert(artifact);
  assert(track);
  const rows = app.store.listTranscriptSegments(track.id);
  return { app, provider, sourceRef, revision, seed, inspected, read, artifact, track, rows };
}

function requiresRefresh(error: unknown): boolean {
  assert(error instanceof UrmaError);
  assert.equal(error.code, "SOURCE_UNAVAILABLE");
  assert.equal(error.detail.refreshRequired, true);
  assert.match(error.message, /refresh/iu);
  return true;
}

for (const state of ["missing", "corrupt"] as const) {
  test(`${state} caption cache rejects changed downloads without mutating evidence`, async (t) => {
    const ctx = await fixture(t);
    ctx.provider.body = changedBody;
    // A healthy cache still presents the original acquired evidence.
    assert.equal((await ctx.read()).segments[0]?.text, "original caption");
    assert.equal(ctx.provider.downloads, 1);
    const file = ctx.app.blobs.pathForHash(ctx.artifact.sha256);
    if (state === "missing") await rm(file);
    else await writeFile(file, "corrupt cache bytes");

    await assert.rejects(ctx.read(), requiresRefresh);
    assert.equal(ctx.provider.downloads, 2);
    assert.deepEqual(ctx.app.store.listTranscriptSegments(ctx.track.id), ctx.rows);
    assert.equal(ctx.app.store.listArtifacts(ctx.sourceRef, ctx.revision).filter(item => item.kind === "caption").length, 1);
    assert(ctx.app.store.listPresentations(ctx.inspected.investigationRef).every(item => item.artifactId === ctx.artifact.artifactId));

    // Restoring the original blob must restore matching text and provenance.
    await ctx.app.blobs.put(Buffer.from(originalBody));
    assert.equal((await ctx.read()).segments[0]?.text, "original caption");
    const oldSearch = await ctx.app.evidence.searchTranscript({ investigationRef: ctx.inspected.investigationRef, query: "original caption" });
    const newSearch = await ctx.app.evidence.searchTranscript({ investigationRef: ctx.inspected.investigationRef, query: "revised caption" });
    assert.equal(oldSearch.hits.length, 1);
    assert.equal(newSearch.hits.length, 0);
    assert.deepEqual(await ctx.app.blobs.read(ctx.artifact.artifactId, ctx.artifact.blobPath, 1_024), Buffer.from(originalBody));
  });

  test(`${state} caption cache repairs identical bytes without replacing cue rows`, async (t) => {
    const ctx = await fixture(t);
    const file = ctx.app.blobs.pathForHash(ctx.artifact.sha256);
    if (state === "missing") await rm(file);
    else await writeFile(file, "corrupt cache bytes");
    assert.equal((await ctx.read()).segments[0]?.text, "original caption");
    assert.equal(ctx.provider.downloads, 2);
    assert.deepEqual(ctx.app.store.listTranscriptSegments(ctx.track.id), ctx.rows);
    assert.equal(ctx.app.store.listTranscriptTracks(ctx.sourceRef, ctx.revision)[0]?.acquiredAt, ctx.track.acquiredAt);
  });
}

test("caption recovery rejects byte changes even when the parsed cues are unchanged", async (t) => {
  const ctx = await fixture(t);
  ctx.provider.body = `${originalBody}\n`;
  await rm(ctx.app.blobs.pathForHash(ctx.artifact.sha256));
  await assert.rejects(ctx.read(), requiresRefresh);
  assert.deepEqual(ctx.app.store.listTranscriptSegments(ctx.track.id), ctx.rows);
});

function makeLegacy(ctx: Awaited<ReturnType<typeof fixture>>, changeRows = false): void {
  const database = new DatabaseSync(path.join(ctx.app.config.dataDir, "urma.db"));
  try {
    const metadata = { ...ctx.track.metadata };
    delete metadata.captionArtifactId;
    database.prepare("UPDATE transcript_tracks SET metadata_json=? WHERE id=?").run(JSON.stringify(metadata), ctx.track.id);
    if (changeRows) database.prepare("UPDATE transcript_segments SET text=? WHERE track_id=?").run("revised caption", ctx.track.id);
  } finally {
    database.close();
  }
}

test("a consistent legacy caption cache gains a content binding without rewriting cues", async (t) => {
  const ctx = await fixture(t);
  makeLegacy(ctx);
  assert.equal((await ctx.read()).segments[0]?.text, "original caption");
  assert.equal(ctx.provider.downloads, 1);
  assert.deepEqual(ctx.app.store.listTranscriptSegments(ctx.track.id), ctx.rows);
  assert.equal(ctx.app.store.listTranscriptTracks(ctx.sourceRef, ctx.revision)[0]?.metadata.captionArtifactId, ctx.artifact.artifactId);
});

test("legacy caption rows that contradict their artifact require refresh before presentation", async (t) => {
  const ctx = await fixture(t);
  makeLegacy(ctx, true);
  const before = ctx.app.store.listPresentations(ctx.inspected.investigationRef);
  await assert.rejects(ctx.read(), requiresRefresh);
  assert.equal(ctx.provider.downloads, 1);
  assert.deepEqual(ctx.app.store.listPresentations(ctx.inspected.investigationRef), before);
});

test("conflicting legacy caption artifacts require refresh instead of selecting the first", async (t) => {
  const ctx = await fixture(t);
  makeLegacy(ctx);
  const different = await ctx.app.blobs.put(Buffer.from(changedBody));
  ctx.app.store.putArtifact({
    ...ctx.artifact, artifactId: different.artifactId, sha256: different.sha256,
    blobPath: different.relativePath, byteSize: different.byteSize,
  });
  await assert.rejects(ctx.read(), requiresRefresh);
  assert.equal(ctx.provider.downloads, 1);
});

test("a new source snapshot accepts revised captions while the old investigation stays pinned", async (t) => {
  const ctx = await fixture(t);
  ctx.provider.body = changedBody;
  ctx.seed("caption-snapshot-b");
  const inspected = await ctx.app.evidence.inspectVideo({ source: ctx.sourceRef });
  const revised = await ctx.app.evidence.readTranscript({ investigationRef: inspected.investigationRef, startMs: 0, endMs: 1_000 });
  assert.equal(revised.segments[0]?.text, "revised caption");
  assert.notEqual(revised.track.trackRef, ctx.track.metadata.trackRef);
  assert.equal((await ctx.read()).segments[0]?.text, "original caption");
});

test("caption content stays pinned when artifact persistence fails after storing the cues", async (t) => {
  const ctx = await fixture(t);
  const revision = "caption-partial-write";
  ctx.seed(revision);
  const inspected = await ctx.app.evidence.inspectVideo({ source: ctx.sourceRef });
  const read = () => ctx.app.evidence.readTranscript({ investigationRef: inspected.investigationRef, startMs: 0, endMs: 1_000 });
  const failure = t.mock.method(ctx.app.store, "putArtifact", () => {
    throw new UrmaError("CACHE_WRITE_FAILED", "Simulated artifact persistence failure");
  });
  await assert.rejects(read(), (error: unknown) => error instanceof UrmaError && error.code === "CACHE_WRITE_FAILED");
  failure.mock.restore();
  const pinned = ctx.app.store.listTranscriptTracks(ctx.sourceRef, revision)[0];
  assert(pinned);
  assert.equal(pinned.metadata.captionArtifactId, ctx.artifact.artifactId);
  assert.equal(ctx.app.store.listArtifacts(ctx.sourceRef, revision).length, 0);
  const rows = ctx.app.store.listTranscriptSegments(pinned.id);
  ctx.provider.body = changedBody;
  await assert.rejects(read(), requiresRefresh);
  assert.deepEqual(ctx.app.store.listTranscriptSegments(pinned.id), rows);
  ctx.provider.body = originalBody;
  assert.equal((await read()).segments[0]?.text, "original caption");
  assert.deepEqual(ctx.app.store.listTranscriptSegments(pinned.id), rows);
  assert.equal(ctx.app.store.listArtifacts(ctx.sourceRef, revision).length, 1);
});

test("MCP reports changed caption recovery as an actionable refresh error", async (t) => {
  const ctx = await fixture(t);
  const server = buildMcpServer(ctx.app.evidence, ctx.app.store, ctx.app.blobs, ctx.app.config);
  const client = new Client({ name: "caption-recovery-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    await rm(ctx.app.blobs.pathForHash(ctx.artifact.sha256));
    ctx.provider.body = changedBody;
    const result = await client.callTool({
      name: "read_transcript",
      arguments: { investigationRef: ctx.inspected.investigationRef, startMs: 0, endMs: 1_000 },
    });
    assert.equal(result.isError, true);
    const text = result.content.find(item => item.type === "text");
    assert(text?.type === "text");
    const error = JSON.parse(text.text) as { code: string; retryable: boolean; detail: string };
    assert.equal(error.code, "SOURCE_UNAVAILABLE");
    assert.equal(error.retryable, false);
    assert.match(error.detail, /freshness=refresh/u);
    assert.deepEqual(ctx.app.store.listTranscriptSegments(ctx.track.id), ctx.rows);
  } finally {
    await client.close();
    await server.close();
  }
});
