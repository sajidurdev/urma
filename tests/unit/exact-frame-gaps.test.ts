import { putTestSource } from "../support/source-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  type ArtifactId,
  artifactIdFromSha256,
  createInvestigationRef,
  remoteSourceRef,
  youtubeRemoteIdentity,
} from "../../src/core/ids.js";
import { largestExactFrameGaps } from "../../src/core/coverage.js";
import {
  compactState,
  deriveInvestigationState,
} from "../../src/evidence/state.js";
import { stateSummarySchema } from "../../src/mcp/schemas.js";
import { SqliteStore } from "../../src/store/sqlite-store.js";

test("exact-frame gap calculation is bounded, unique, deterministic, and boundary-aware", () => {
  assert.deepEqual(largestExactFrameGaps(10_000, [8_000, 2_000, 2_000]), [
    { startMs: 2_000, endMs: 8_000 },
    { startMs: 0, endMs: 2_000 },
    { startMs: 8_000, endMs: 10_000 },
  ]);
  assert.equal(
    largestExactFrameGaps(
      10_000,
      [0, 1_000, 2_000, 3_000, 4_000, 5_000, 6_000, 7_000, 8_000, 9_000],
    ).length,
    3,
  );
});

test("compact state derives exact-frame gaps only from presented canonical point and panel/burst frames", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "urma-exact-frame-gaps-"),
  );
  const store = await SqliteStore.open(path.join(directory, "urma.db"));
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  const sourceRef = remoteSourceRef(youtubeRemoteIdentity("yP0axVHdP-U"));
  const revision = "v1:test:yP0axVHdP-U";
  const investigationRef = createInvestigationRef(
    "cccccccc-cccc-cccc-cccc-cccccccccccc",
  );
  const durationMs = 3_541_000;
  const now = new Date(0).toISOString();
  putTestSource(store, {
    sourceRef,
    kind: "remote",
    canonicalKey: "yP0axVHdP-U",
    revision,
    title: "Fixture",
    durationMs,
    metadata: {},
  });
  store.createInvestigation({
    investigationRef,
    sourceRef,
    sourceRevision: revision,
    durationMs,
    createdAt: now,
    updatedAt: now,
  });

  let artifactIndex = 0;
  const frameIds = new Map<number, ArtifactId>();
  const putFrame = (atMs: number): ArtifactId => {
    const sha256 = artifactIndex.toString(16).padStart(64, "0");
    artifactIndex += 1;
    const artifactId = artifactIdFromSha256(sha256);
    frameIds.set(atMs, artifactId);
    store.putArtifact({
      artifactId,
      sourceRef,
      sourceRevision: revision,
      kind: "frame",
      role: "evidence",
      mimeType: "image/jpeg",
      sha256,
      byteSize: 100,
      blobPath: path.join("aa", "aa", sha256),
      startMs: atMs,
      endMs: atMs,
      params: { atMs, format: "jpeg" },
      producer: { version: "frame-extractor" },
      createdAt: now,
    });
    return artifactId;
  };

  const exactTimes = [
    0,
    540_000,
    1_200_000,
    1_770_000,
    2_160_000,
    2_640_000,
    3_480_000,
    3_540_000,
  ];
  for (const atMs of exactTimes) putFrame(atMs);
  putFrame(3_000_000); // cached, but never presented

  let presentationIndex = 0;
  const presentPoint = (atMs: number): void => {
    store.addPresentation({
      id: `point-${presentationIndex++}`,
      investigationRef,
      artifactId: frameIds.get(atMs)!,
      modality: "visual",
      evidenceKind: "point",
      startMs: atMs,
      endMs: atMs,
      pointsMs: [atMs],
      metadata: { atMs, role: "evidence" },
      presentedAt: now,
    });
  };
  for (const atMs of exactTimes.slice(0, 6)) presentPoint(atMs);
  presentPoint(2_640_000); // repeated presentation must not shrink a gap

  const panelTimes = [3_480_000, 3_540_000];
  store.addPresentation({
    id: `panel-${presentationIndex++}`,
    investigationRef,
    artifactId: null,
    modality: "visual",
    evidenceKind: "ordered_points",
    startMs: panelTimes[0]!,
    endMs: durationMs,
    pointsMs: panelTimes,
    metadata: {
      artifactIds: panelTimes.map((atMs) => frameIds.get(atMs)!),
      presentation: "panel",
      role: "evidence",
      continuousMotion: false,
    },
    presentedAt: now,
  });

  const beforeOverview = compactState(
    deriveInvestigationState(store, investigationRef),
  );
  store.addPresentation({
    id: `overview-${presentationIndex}`,
    investigationRef,
    artifactId: null,
    modality: "visual",
    evidenceKind: "sparse",
    startMs: 2_640_000,
    endMs: 3_480_000,
    pointsMs: [3_000_000],
    metadata: { role: "locator", source: "native-storyboard" },
    presentedAt: now,
  });
  const afterOverview = compactState(
    deriveInvestigationState(store, investigationRef),
  );
  const expected = [
    { startMs: 2_640_000, endMs: 3_480_000 },
    { startMs: 540_000, endMs: 1_200_000 },
    { startMs: 1_200_000, endMs: 1_770_000 },
  ];

  assert.deepEqual(beforeOverview.visual.largestExactFrameGaps, expected);
  assert.deepEqual(afterOverview.visual.largestExactFrameGaps, expected);
  assert.notDeepEqual(
    afterOverview.visual.largestUnsampledGaps,
    beforeOverview.visual.largestUnsampledGaps,
  );
  assert.deepEqual(
    stateSummarySchema.parse(afterOverview).visual.largestExactFrameGaps,
    expected,
  );
});
