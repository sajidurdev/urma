import { putTestSource } from "../support/source-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  artifactIdFromSha256,
  createInvestigationRef,
  remoteSourceRef,
  youtubeRemoteIdentity,
} from "../../src/core/ids.js";
import { deriveInvestigationState } from "../../src/evidence/state.js";
import { SqliteStore } from "../../src/store/sqlite-store.js";
import { startAcquisition } from "../../src/acquisition/records.js";

test("source-wide cache never becomes investigation evidence without presentation", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "urma-state-"));
  const store = await SqliteStore.open(path.join(directory, "urma.db"));
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const sourceRef = remoteSourceRef(youtubeRemoteIdentity("yP0axVHdP-U"));
  const revision = "v1:test:yP0axVHdP-U";
  const now = new Date(0).toISOString();
  const a = createInvestigationRef("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
  const b = createInvestigationRef("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
  putTestSource(store, {
    sourceRef,
    kind: "remote",
    canonicalKey: "yP0axVHdP-U",
    revision,
    title: "Fixture",
    durationMs: 120_000,
    metadata: {},
  });
  store.createInvestigation({
    investigationRef: a,
    sourceRef,
    sourceRevision: revision,
    durationMs: 120_000,
    createdAt: now,
    updatedAt: now,
  });
  store.createInvestigation({
    investigationRef: b,
    sourceRef,
    sourceRevision: revision,
    durationMs: 120_000,
    createdAt: now,
    updatedAt: now,
  });
  const artifactId = artifactIdFromSha256("a".repeat(64));
  store.putArtifact({
    artifactId,
    sourceRef,
    sourceRevision: revision,
    kind: "media_section",
    role: "transport",
    mimeType: "video/mp4",
    sha256: "a".repeat(64),
    byteSize: 100,
    blobPath: path.join("aa", "aa", "a".repeat(64)),
    startMs: 40_000,
    endMs: 50_000,
    params: {},
    producer: { version: "test" },
    createdAt: now,
  });
  store.addPresentation({
    id: "parent",
    investigationRef: a,
    artifactId: null,
    modality: "visual",
    evidenceKind: "sparse",
    startMs: 0,
    endMs: 120_000,
    pointsMs: [0, 60_000, 119_999],
    metadata: {},
    presentedAt: now,
  });
  store.addPresentation({
    id: "child",
    investigationRef: a,
    artifactId: null,
    modality: "visual",
    evidenceKind: "sparse",
    startMs: 60_000,
    endMs: 120_000,
    pointsMs: [60_000, 90_000, 119_999],
    metadata: {},
    presentedAt: now,
  });
  store.addPresentation({
    id: "point",
    investigationRef: a,
    artifactId,
    modality: "visual",
    evidenceKind: "point",
    startMs: 45_000,
    endMs: 45_000,
    pointsMs: [45_000],
    metadata: {},
    presentedAt: now,
  });
  const acquisition = startAcquisition(store, {
    sourceRef,
    sourceRevision: revision,
    investigationRef: a,
    operation: "acquire-media-section",
    requestKey: "section",
    method: "yt-dlp-bounded-section",
  });
  acquisition.succeed({ networkBytes: null, networkAccountingComplete: false });
  const stateA = deriveInvestigationState(store, a);
  const stateB = deriveInvestigationState(store, b);
  assert.equal(stateA.evidence.sparseVisualSets.length, 2);
  assert.equal(stateA.evidence.exactVisualPoints.length, 1);
  assert.equal(stateA.cache.continuousMediaIntervals.length, 1);
  assert.equal(stateA.network.measuredBytes, null);
  assert.equal(stateA.network.unknownAcquisitionCount, 1);
  assert.equal(stateB.cache.continuousMediaIntervals.length, 1);
  assert.equal(stateB.evidence.sparseVisualSets.length, 0);
  assert.equal(stateB.evidence.exactVisualPoints.length, 0);
  assert.deepEqual(stateB.largestUnsampledVisualGaps, [
    { startMs: 0, endMs: 120_000 },
  ]);
  assert.equal(stateB.network.measuredBytes, 0);
});
