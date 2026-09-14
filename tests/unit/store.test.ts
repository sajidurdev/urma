import { putTestSource } from "../support/source-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  artifactIdFromSha256,
  createInvestigationRef,
  remoteSourceRef,
  sha256,
  youtubeRemoteIdentity,
} from "../../src/core/ids.js";
import { BlobStore } from "../../src/store/blob-store.js";
import { SqliteStore } from "../../src/store/sqlite-store.js";
import { Singleflight } from "../../src/acquisition/singleflight.js";
import { deriveInvestigationState } from "../../src/evidence/state.js";
import { materializeResolvedSource } from "../../src/sources/resolver.js";
import { SCHEMA_VERSION } from "../../src/store/schema.js";

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "urma-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("SQLite source cache persists while investigations remain isolated across restart", async (t) => {
  const directory = await fixture(t);
  const dbPath = path.join(directory, "urma.db");
  const sourceRef = remoteSourceRef(youtubeRemoteIdentity("yP0axVHdP-U"));
  const a = createInvestigationRef("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
  const b = createInvestigationRef("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
  let store = await SqliteStore.open(dbPath);
  putTestSource(store,
    {
      sourceRef,
      kind: "remote",
      canonicalKey: "yP0axVHdP-U",
      revision: "v1:test:yP0axVHdP-U",
      title: "Fixture",
      durationMs: 120000,
      metadata: {},
    },
    [{ alias: "https://youtu.be/yP0axVHdP-U" }],
  );
  const now = new Date(0).toISOString();
  store.createInvestigation({
    investigationRef: a,
    sourceRef,
    sourceRevision: "v1:test:yP0axVHdP-U",
    durationMs: 120_000,
    createdAt: now,
    updatedAt: now,
  });
  store.createInvestigation({
    investigationRef: b,
    sourceRef,
    sourceRevision: "v1:test:yP0axVHdP-U",
    durationMs: 120_000,
    createdAt: now,
    updatedAt: now,
  });
  store.addPresentation({
    id: "p-a",
    investigationRef: a,
    artifactId: null,
    modality: "visual",
    evidenceKind: "sparse",
    startMs: 0,
    endMs: 120000,
    pointsMs: [0, 60000, 119999],
    metadata: { role: "locator" },
    presentedAt: now,
  });
  store.close();
  store = await SqliteStore.open(dbPath);
  assert.equal(
    store.getLocator(sourceRef, sha256("https://youtu.be/yP0axVHdP-U"))?.sourceRef,
    sourceRef,
  );
  assert.equal(store.listPresentations(a).length, 1);
  assert.equal(store.listPresentations(b).length, 0);
  assert.equal(
    deriveInvestigationState(store, a).evidence.sparseVisualSets.length,
    1,
  );
  assert.equal(
    deriveInvestigationState(store, b).evidence.sparseVisualSets.length,
    0,
  );
  assert.equal(store.ftsEnabled, true);
  store.close();
});

test("investigations remain pinned when a logical source receives a refreshed snapshot", async (t) => {
  const directory = await fixture(t);
  const store = await SqliteStore.open(path.join(directory, "urma.db"));
  const sourceRef = remoteSourceRef(youtubeRemoteIdentity("yP0axVHdP-U"));
  const firstRevision = "v1:first";
  const secondRevision = "v1:second";
  putTestSource(store, {
    sourceRef,
    kind: "remote",
    canonicalKey: "yP0axVHdP-U",
    revision: firstRevision,
    title: "Snapshot A",
    durationMs: 120_000,
    metadata: {},
  });
  const firstInvestigation = createInvestigationRef(
    "11111111-1111-1111-1111-111111111111",
  );
  const now = new Date(0).toISOString();
  store.createInvestigation({
    investigationRef: firstInvestigation,
    sourceRef,
    sourceRevision: firstRevision,
    durationMs: 120_000,
    createdAt: now,
    updatedAt: now,
  });

  putTestSource(store, {
    sourceRef,
    kind: "remote",
    canonicalKey: "yP0axVHdP-U",
    revision: secondRevision,
    title: "Snapshot B",
    durationMs: 180_000,
    metadata: {},
  });
  const secondInvestigation = createInvestigationRef(
    "22222222-2222-2222-2222-222222222222",
  );
  store.createInvestigation({
    investigationRef: secondInvestigation,
    sourceRef,
    sourceRevision: secondRevision,
    durationMs: 180_000,
    createdAt: now,
    updatedAt: now,
  });

  const stored = store.getSource(sourceRef);
  assert(stored);
  const pinnedA = store.getSnapshot(sourceRef, firstRevision);
  const pinnedB = store.getSnapshot(sourceRef, secondRevision);
  assert(pinnedA);
  assert(pinnedB);
  const sourceA = materializeResolvedSource(store, stored, pinnedA);
  const sourceB = materializeResolvedSource(store, stored, pinnedB);
  assert.equal(sourceA.title, "Snapshot A");
  assert.equal(sourceA.durationMs, 120_000);
  assert.equal(sourceA.revision, firstRevision);
  assert.equal(sourceB.title, "Snapshot B");
  assert.equal(sourceB.durationMs, 180_000);
  assert.equal(sourceB.revision, secondRevision);
  assert.equal(store.getLatestSnapshot(sourceRef)?.revision, secondRevision);
  assert.equal(store.getInvestigation(firstInvestigation)?.sourceRevision, firstRevision);
  assert.equal(store.getInvestigation(secondInvestigation)?.sourceRevision, secondRevision);
  store.close();
});

test("transcript storage uses FTS when available and deterministic literal fallback semantics", async (t) => {
  const directory = await fixture(t);
  const store = await SqliteStore.open(path.join(directory, "urma.db"));
  const sourceRef = remoteSourceRef(youtubeRemoteIdentity("yP0axVHdP-U"));
  const now = new Date(0).toISOString();
  putTestSource(store, {
    sourceRef,
    kind: "remote",
    canonicalKey: "yP0axVHdP-U",
    revision: "r1",
    title: "Fixture",
    durationMs: 20000,
    metadata: {},
  });
  store.putTranscript(
    {
      id: "track",
      sourceRef,
      sourceRevision: "r1",
      language: "en",
      kind: "manual",
      providerTrackId: null,
      acquiredAt: now,
      metadata: {},
    },
    [
      {
        trackId: "track",
        startMs: 0,
        endMs: 2000,
        text: "A blue chart appears",
        ordinal: 0,
      },
      {
        trackId: "track",
        startMs: 5000,
        endMs: 7000,
        text: "Only narration here",
        ordinal: 1,
      },
    ],
  );
  assert.equal(
    store.searchTranscriptSegments("track", '"blue chart"', 5)[0]?.startMs,
    0,
  );
  assert.equal(store.listTranscriptSegments("track", 4000, 8000).length, 1);
  store.close();
});

test("store rejects obsolete pre-launch schemas instead of migrating them", async (t) => {
  const directory = await fixture(t);
  const database = new DatabaseSync(path.join(directory, "urma.db"));
  database.exec(
    "CREATE TABLE schema_meta (version INTEGER NOT NULL); INSERT INTO schema_meta(version) VALUES(2);",
  );
  database.close();
  await assert.rejects(
    SqliteStore.open(path.join(directory, "urma.db")),
    /unsupported schema 2/u,
  );
});

test("store rejects the previous development schema after the RC provenance break", async (t) => {
  const directory = await fixture(t);
  const database = new DatabaseSync(path.join(directory, "urma.db"));
  database.exec(
    "CREATE TABLE schema_meta (version INTEGER NOT NULL); INSERT INTO schema_meta(version) VALUES(4);",
  );
  database.close();
  await assert.rejects(
    SqliteStore.open(path.join(directory, "urma.db")),
    /unsupported schema 4/u,
  );
});

test("store rejects an unfinished schema bootstrap instead of resuming it", async (t) => {
  const directory = await fixture(t);
  const database = new DatabaseSync(path.join(directory, "urma.db"));
  database.exec(
    "CREATE TABLE schema_meta (version INTEGER NOT NULL); INSERT INTO schema_meta(version) VALUES(0);",
  );
  database.close();
  await assert.rejects(
    SqliteStore.open(path.join(directory, "urma.db")),
    /unsupported schema 0/u,
  );
});

test("store rejects a current-version database whose tables do not match the fresh schema", async (t) => {
  const directory = await fixture(t);
  const database = new DatabaseSync(path.join(directory, "urma.db"));
  database.exec(
    `CREATE TABLE schema_meta (version INTEGER NOT NULL); INSERT INTO schema_meta(version) VALUES(${SCHEMA_VERSION}); CREATE TABLE sources (id TEXT);`,
  );
  database.close();
  await assert.rejects(
    SqliteStore.open(path.join(directory, "urma.db")),
    /incompatible schema.*fresh data directory/u,
  );
});

test("blob identity is content SHA-256 and failed validation never promotes a final artifact", async (t) => {
  const directory = await fixture(t);
  const blobs = new BlobStore(path.join(directory, "blobs"));
  const bytes = Buffer.from("artifact bytes");
  const first = await blobs.put(bytes);
  const second = await blobs.put(bytes);
  assert.equal(first.artifactId, second.artifactId);
  assert.equal(
    (await readFile(first.absolutePath)).toString(),
    "artifact bytes",
  );
  await assert.rejects(
    blobs.put(Buffer.from("bad"), () => {
      throw new Error("invalid fixture");
    }),
  );
  assert.equal(await blobs.cleanTemps(), 0);
});

test("corrupted content-addressed blob is rejected", async (t) => {
  const directory = await fixture(t);
  const blobs = new BlobStore(path.join(directory, "blobs"));
  const stored = await blobs.put(Buffer.from("valid"));
  await writeFile(stored.absolutePath, "corrupt");
  await assert.rejects(
    blobs.read(stored.artifactId, stored.relativePath, 1024),
    /failed SHA-256 validation/,
  );
  const recovered = await blobs.put(Buffer.from("valid"));
  assert.equal(recovered.artifactId, stored.artifactId);
  assert.equal(
    (
      await blobs.read(recovered.artifactId, recovered.relativePath, 1024)
    ).toString(),
    "valid",
  );
});

test("concurrent identical artifact acquisition promotes content once", async (t) => {
  const directory = await fixture(t);
  const blobs = new BlobStore(path.join(directory, "blobs"));
  const flight = new Singleflight();
  let writes = 0;
  const acquire = () =>
    flight.run("artifact:fixture", undefined, async () => {
      writes += 1;
      return await blobs.put(Buffer.from("one artifact"));
    });
  const [first, second] = await Promise.all([acquire(), acquire()]);
  assert.equal(writes, 1);
  assert.equal(first.artifactId, second.artifactId);
  assert.equal(flight.size, 0);
});

test("identical content keeps source-specific artifact occurrence provenance", async (t) => {
  const directory = await fixture(t);
  const store = await SqliteStore.open(path.join(directory, "urma.db"));
  const a = remoteSourceRef(youtubeRemoteIdentity("aaaaaaaaaaa"));
  const b = remoteSourceRef(youtubeRemoteIdentity("bbbbbbbbbbb"));
  const now = new Date(0).toISOString();
  for (const sourceRef of [a, b]) {
    putTestSource(store, {
      sourceRef,
      kind: "remote",
      canonicalKey: sourceRef.slice(-11),
      revision: `revision:${sourceRef}`,
      title: "Fixture",
      durationMs: 10_000,
      metadata: {},
    });
  }
  const sha = "c".repeat(64);
  const artifactId = artifactIdFromSha256(sha);
  const make = (sourceRef: typeof a, atMs: number) => ({
    artifactId,
    sourceRef,
    sourceRevision: `revision:${sourceRef}`,
    kind: "frame" as const,
    role: "evidence" as const,
    mimeType: "image/jpeg",
    sha256: sha,
    byteSize: 123,
    blobPath: path.join("cc", "cc", sha),
    startMs: atMs,
    endMs: atMs,
    params: { atMs },
    producer: { version: "test" },
    createdAt: now,
  });
  store.putArtifact(make(a, 1000), {
    requestKey: "request-a",
    operation: "frame",
  });
  store.putArtifact(make(b, 2000), {
    requestKey: "request-b",
    operation: "frame",
  });
  assert.equal(store.getArtifactByRequest("request-a")?.sourceRef, a);
  assert.equal(store.getArtifactByRequest("request-a")?.startMs, 1000);
  assert.equal(store.getArtifactByRequest("request-b")?.sourceRef, b);
  assert.equal(store.getArtifactByRequest("request-b")?.startMs, 2000);
  assert.equal(store.listArtifacts(a, "revision:" + a).length, 1);
  assert.equal(store.listArtifacts(b, "revision:" + b).length, 1);
  assert.equal(store.cacheStats().artifacts, 1);
  store.close();
});
