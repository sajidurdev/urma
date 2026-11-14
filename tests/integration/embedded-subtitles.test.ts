import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { openUrma } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { runChecked } from "../../src/subprocess/runner.js";
import { Ffmpeg } from "../../src/subprocess/ffmpeg.js";
import { UrmaError } from "../../src/core/errors.js";
import { parseEmbeddedCaption } from "../../src/sources/caption-tracks.js";
import { buildMcpServer } from "../../src/mcp/server.js";

async function fixture(t: test.TestContext, codec = "subrip", offset = 0, multiple = false, resourceBytes?: number) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "urma-embedded-"));
  const first = path.join(directory, "first.srt"), second = path.join(directory, "second.srt");
  await writeFile(first, "1\n00:00:00,100 --> 00:00:00,800\nEmbedded English text\n");
  await writeFile(second, "1\n00:00:00,200 --> 00:00:00,900\nFrench default text\n");
  const video = path.join(directory, `fixture.${codec === "mov_text" ? "mp4" : "mkv"}`);
  await runChecked("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=64x32:d=1:r=4", "-i", first,
    ...(multiple ? ["-i", second] : []), "-map", "0:v:0", "-map", "1:s:0", ...(multiple ? ["-map", "2:s:0"] : []),
    "-c:v", "libx264", "-c:s", codec, "-metadata:s:s:0", "language=eng", "-disposition:s:0", multiple ? "0" : "default",
    ...(multiple ? ["-metadata:s:s:1", "language=fra", "-disposition:s:1", "default"] : []), "-output_ts_offset", String(offset), "-y", video], { timeoutMs: 30_000 });
  const base = loadConfig({ URMA_DATA_DIR: path.join(directory, "data"), URMA_LOCAL_ROOTS: directory });
  const config = resourceBytes ? { ...base, limits: { ...base.limits, resourceBytes } } : base;
  const app = await openUrma(config), server = buildMcpServer(app.evidence, app.store, app.blobs, app.config);
  const client = new Client({ name: "embedded-subtitle-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await Promise.all([client.connect(a), server.connect(b)]);
  t.after(async () => { await client.close(); await server.close(); app.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, video, app, client };
}

for (const [codec, offset] of [["subrip", 0], ["webvtt", 7], ["mov_text", 7]] as const) {
  test(`embedded ${codec} captions retain container-relative timing with origin ${offset}s`, async (t) => {
    const { app, client, video } = await fixture(t, codec, offset);
    const inspection = await client.callTool({ name: "inspect_video", arguments: { source: video } });
    assert(!inspection.isError);
    const { investigationRef, sourceRef, captionTracks, source } = inspection.structuredContent as unknown as Awaited<ReturnType<typeof app.evidence.inspectVideo>>;
    assert.equal(captionTracks.length, 1); assert.equal(captionTracks[0]?.embedded?.codec, codec);
    assert.equal(captionTracks[0]?.kind, "unknown"); assert.equal(captionTracks[0]?.language, "eng");
    assert.equal(app.store.listTranscriptTracks(sourceRef, source.snapshotRevision).length, 0, "inspection does not extract subtitles");
    if (codec === "mov_text") await writeFile(video, "original file replaced before subtitle acquisition");
    const search = await client.callTool({ name: "search_transcript", arguments: { investigationRef, query: "Embedded English", mode: "phrase" } });
    assert(!search.isError, JSON.stringify(search.content));
    const output = search.structuredContent as { track: { embedded: { streamIndex: number } }; hits: { startMs: number; endMs: number }[] };
    assert.equal(output.track.embedded.streamIndex, 1);
    assert.deepEqual(output.hits.map((hit) => [hit.startMs, hit.endMs]), [[100, 800]]);
    const read = await client.callTool({ name: "read_transcript", arguments: { investigationRef, startMs: 0, endMs: 1000 } });
    assert(!read.isError, JSON.stringify(read.content));
    const artifact = app.store.listArtifacts(sourceRef, source.snapshotRevision).find((item) => item.kind === "caption")!;
    assert.equal(artifact.producer.timeline, "container-origin-relative");
    assert(artifact.producer.inputArtifactId);
    await client.readResource({ uri: `urma://investigation/${investigationRef.split(":").at(-1)}/artifact/${artifact.sha256}` });
    await writeFile(video, "original file replaced after inspection");
    const second = await app.evidence.inspectVideo({ source: sourceRef });
    const reused = await app.evidence.transcripts.ensure((await app.evidence.resolver.resolve(sourceRef)).source, second.investigationRef);
    assert(reused.cacheHit); assert.equal(reused.segments[0]?.startMs, 100);
  });
}

test("container defaults, explicit tracks, sidecars, and unsupported codecs remain distinct", async (t) => {
  const { app, video, directory } = await fixture(t, "subrip", 0, true);
  const inspected = await app.evidence.inspectVideo({ source: video });
  assert.equal(inspected.captionTracks.length, 2);
  const request = { investigationRef: inspected.investigationRef, startMs: 0, endMs: 1000 };
  const chosen = await app.evidence.readTranscript(request);
  assert.equal(chosen.track.embedded?.streamIndex, 2);
  const english = await app.evidence.readTranscript({ ...request, trackRef: inspected.captionTracks[0]!.trackRef });
  assert.equal(english.track.embedded?.streamIndex, 1);
  await writeFile(path.join(directory, "fixture.vtt"), "WEBVTT\n\n00:00.100 --> 00:00.800\nSidecar priority\n");
  const withSidecar = await app.evidence.inspectVideo({ source: video });
  assert.equal(withSidecar.captionTracks.length, 3);
  const sidecar = await app.evidence.readTranscript({ ...request, investigationRef: withSidecar.investigationRef });
  assert.equal(sidecar.track.kind, "sidecar");
  const embedded = withSidecar.captionTracks.find((track) => track.embedded?.streamIndex === 1)!;
  const explicit = await app.evidence.readTranscript({ ...request, investigationRef: withSidecar.investigationRef, trackRef: embedded.trackRef });
  assert.equal(explicit.track.embedded?.streamIndex, 1);
  for (const codec of ["ass", "dvd_subtitle", "hdmv_pgs_subtitle", "dvb_subtitle"]) assert.equal(parseEmbeddedCaption({ streamIndex: 1, codec, default: true }), undefined);
  for (const streamIndex of [-1, .5, NaN, Infinity]) assert.equal(parseEmbeddedCaption({ streamIndex, codec: "subrip", default: true }), undefined);
});

test("refresh discovers embedded tracks without rewriting an older local snapshot", async (t) => {
  const { app, video, directory } = await fixture(t);
  const inspected = await app.evidence.inspectVideo({ source: video });
  const source = app.store.getSource(inspected.sourceRef)!;
  const snapshot = app.store.getSnapshot(inspected.sourceRef, inspected.source.snapshotRevision)!;
  const locator = app.store.getLocator(inspected.sourceRef, snapshot.descriptor.reopenLocatorDigest as string)!;
  const legacyRevision = `local:v2:${"1".repeat(64)}`;
  const upgraded = await openUrma(loadConfig({ URMA_DATA_DIR: path.join(directory, "upgraded-data"), URMA_LOCAL_ROOTS: directory }));
  try {
    upgraded.store.putSourceSnapshot({ source: { ...source, latestRevision: legacyRevision },
      snapshot: { ...snapshot, revision: legacyRevision, descriptor: { ...snapshot.descriptor, captionTracks: [] } }, locators: [locator] });
    const before = await upgraded.evidence.inspectVideo({ source: inspected.sourceRef });
    assert.equal(before.captionTracks.length, 0);
    const after = await upgraded.evidence.inspectVideo({ source: inspected.sourceRef, freshness: "refresh" });
    assert.match(after.source.snapshotRevision, /^local:v3:/u);
    assert.equal(after.sourceRef, before.sourceRef);
    assert.equal(after.captionTracks.length, 1);
    assert.deepEqual(upgraded.store.getSnapshot(inspected.sourceRef, legacyRevision)?.descriptor.captionTracks, []);
    await assert.rejects(upgraded.evidence.readTranscript({ investigationRef: before.investigationRef, startMs: 0, endMs: 1000 }), /no supported/iu);
    const read = await upgraded.evidence.readTranscript({ investigationRef: after.investigationRef, startMs: 0, endMs: 1000 });
    assert(read.track.embedded);
  } finally { upgraded.close(); }
});

test("embedded extraction cancellation and byte limits do not commit transcript rows", async (t) => {
  const limited = await fixture(t, "subrip", 0, false, 32);
  const inspected = await limited.app.evidence.inspectVideo({ source: limited.video });
  await assert.rejects(limited.app.evidence.readTranscript({ investigationRef: inspected.investigationRef, startMs: 0, endMs: 1000 }), (error: unknown) => error instanceof UrmaError && error.code === "OUTPUT_LIMIT_EXCEEDED");
  assert.equal(limited.app.store.listTranscriptTracks(inspected.sourceRef, inspected.source.snapshotRevision).length, 0);
  const normal = await fixture(t);
  const next = await normal.app.evidence.inspectVideo({ source: normal.video });
  const controller = new AbortController(); let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const decoder = t.mock.method(Ffmpeg.prototype, "textSubtitles", async (_input: string, _index: number, signal?: AbortSignal) => {
    started(); await new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new UrmaError("CANCELLED", "Embedded subtitle test cancelled")), { once: true })); return Buffer.alloc(0);
  });
  const pending = normal.app.evidence.readTranscript({ investigationRef: next.investigationRef, startMs: 0, endMs: 1000 }, controller.signal);
  await ready; controller.abort(); await assert.rejects(pending, /cancelled/u); decoder.mock.restore();
  assert.equal(normal.app.store.listTranscriptTracks(next.sourceRef, next.source.snapshotRevision).length, 0);
  const recovered = await normal.app.evidence.readTranscript({ investigationRef: next.investigationRef, startMs: 0, endMs: 1000 });
  assert.equal(recovered.track.embedded?.codec, "subrip");
});
