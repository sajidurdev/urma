import { putTestSource } from "../support/source-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openUrma } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { runChecked } from "../../src/subprocess/runner.js";
import { makeCaptionTrack } from "../../src/sources/caption-tracks.js";
import type { ResolvedSource } from "../../src/sources/types.js";
import { transcriptTrackId } from "../../src/acquisition/transcript.js";
import {
  remoteSourceRef,
  youtubeRemoteIdentity,
} from "../../src/core/ids.js";

async function localVideoFixture(withCaptions = true) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "urma-evidence-"));
  const video = path.join(directory, "fixture.mp4");
  await runChecked(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=320x180:d=4:r=2",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-y",
      video,
    ],
    { timeoutMs: 30_000 },
  );
  if (withCaptions) {
    await writeFile(
      path.join(directory, "fixture.vtt"),
      "WEBVTT\n\n00:00:00.500 --> 00:00:01.500\nA blue chart appears\n\n00:00:02.000 --> 00:00:03.000\nThe chart disappears\n",
    );
  }
  return { directory, video };
}

test("direct Evidence API reuses source cache without cross-investigation transcript evidence", async (t) => {
  const fixture = await localVideoFixture();
  const config = loadConfig({
    URMA_DATA_DIR: path.join(fixture.directory, "data"),
    URMA_LOCAL_ROOTS: fixture.directory,
  });
  const app = await openUrma(config);
  t.after(async () => {
    app.close();
    await rm(fixture.directory, { recursive: true, force: true });
  });
  const first = await app.evidence.inspectVideo({ source: fixture.video });
  assert.equal(first.capabilities.nativeCaptions, true);
  const searchA = await app.evidence.searchTranscript({
    investigationRef: first.investigationRef,
    query: "blue chart",
    mode: "phrase",
    limit: 5,
  });
  assert.equal(searchA.hits.length, 1);
  const readA = await app.evidence.readTranscript({
    investigationRef: first.investigationRef,
    startMs: 0,
    endMs: 4000,
  });
  assert.equal(readA.segments.length, 2);
  assert.equal(
    app.evidence.state(first.investigationRef).evidence.transcriptSearches,
    1,
  );
  const second = await app.evidence.inspectVideo({ source: first.sourceRef });
  assert.equal(second.sourceRef, first.sourceRef);
  assert.notEqual(second.investigationRef, first.investigationRef);
  assert.equal(second.cache.transcriptTracks, 1);
  assert.equal(
    app.evidence.state(second.investigationRef).evidence.transcriptSearches,
    0,
  );
  assert.equal(
    app.evidence.state(second.investigationRef).evidence.transcriptRanges
      .length,
    0,
  );
  await app.evidence.searchTranscript({
    investigationRef: second.investigationRef,
    query: "disappears",
  });
  assert.equal(
    app.evidence.state(second.investigationRef).evidence.transcriptSearches,
    1,
  );
  const whole = await app.evidence.getOverview({
    investigationRef: second.investigationRef,
  });
  assert.equal(whole.requestedCount, 12);
  assert.equal(whole.actualCount, 12);
  assert.equal(whole.role, "locator");
  const zoom = await app.evidence.getOverview({
    investigationRef: second.investigationRef,
    startMs: 1000,
    endMs: 3000,
  });
  assert.equal(zoom.actualCount, 12);
  assert.equal(
    app.evidence.state(second.investigationRef).evidence.sparseVisualSets
      .length,
    2,
  );
  const exact = await app.evidence.getFrames({
    investigationRef: second.investigationRef,
    request: { kind: "points", timesMs: [500, 2500] },
  });
  assert.equal(exact.kind, "exact_points");
  assert.equal(
    app.evidence.state(second.investigationRef).evidence.exactVisualPoints
      .length,
    2,
  );
  const burst = await app.evidence.getFrames({
    investigationRef: second.investigationRef,
    request: { kind: "burst", startMs: 1000, endMs: 3000, count: 3 },
  });
  assert.equal(burst.kind, "ordered_points");
  assert.equal(burst.continuousMotion, false);
  assert.equal(
    app.evidence.state(second.investigationRef).evidence.orderedVisualSets
      .length,
    1,
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  await writeFile(
    path.join(fixture.directory, "fixture.vtt"),
    "WEBVTT\n\n00:00:00.500 --> 00:00:01.500\nRevised caption evidence\n",
  );
  const refreshed = await app.evidence.inspectVideo({
    source: second.sourceRef,
    freshness: "refresh",
  });
  assert.equal(refreshed.sourceRef, first.sourceRef);
  assert.notEqual(refreshed.investigationRef, second.investigationRef);
  assert.notEqual(
    refreshed.source.snapshotRevision,
    second.source.snapshotRevision,
  );
  assert.equal(
    app.evidence.state(second.investigationRef).evidence.exactVisualPoints
      .length,
    2,
  );
  const pinnedOldSnapshot = await app.evidence.searchTranscript({
    investigationRef: second.investigationRef,
    query: "blue",
  });
  assert.equal(pinnedOldSnapshot.hits.length, 1);
});

test("caption absence is a clean capability result and never invokes STT", async (t) => {
  const fixture = await localVideoFixture(false);
  const app = await openUrma(
    loadConfig({
      URMA_DATA_DIR: path.join(fixture.directory, "data"),
      URMA_LOCAL_ROOTS: fixture.directory,
    }),
  );
  t.after(async () => {
    app.close();
    await rm(fixture.directory, { recursive: true, force: true });
  });
  const inspected = await app.evidence.inspectVideo({ source: fixture.video });
  assert.equal(inspected.capabilities.nativeCaptions, false);
  await assert.rejects(
    app.evidence.searchTranscript({
      investigationRef: inspected.investigationRef,
      query: "speech",
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "CAPTIONS_UNAVAILABLE",
  );
});

test("opaque local sourceRef resolves after restart without serializing its configured root", async (t) => {
  const fixture = await localVideoFixture();
  const config = loadConfig({
    URMA_DATA_DIR: path.join(fixture.directory, "data"),
    URMA_LOCAL_ROOTS: fixture.directory,
  });
  let app = await openUrma(config);
  t.after(async () => {
    app.close();
    await rm(fixture.directory, { recursive: true, force: true });
  });
  const first = await app.evidence.inspectVideo({ source: fixture.video });
  assert.match(first.sourceRef, /^urma:source:local:[0-9a-f]{32}$/);
  assert.equal(String(first.sourceRef).includes(fixture.video), false);
  assert.equal(
    JSON.stringify(first)
      .toLowerCase()
      .includes(fixture.directory.toLowerCase()),
    false,
  );
  app.close();
  app = await openUrma(config);
  const reopened = await app.evidence.inspectVideo({ source: first.sourceRef });
  assert.equal(reopened.sourceRef, first.sourceRef);
  assert.equal(
    JSON.stringify(reopened)
      .toLowerCase()
      .includes(fixture.directory.toLowerCase()),
    false,
  );
});

test("literal phrase/term search remains bounded; >200 transcript segments continue losslessly", async (t) => {
  const fixture = await localVideoFixture(false);
  const stamp = (value: number) =>
    `00:00:${String(Math.floor(value / 1000)).padStart(2, "0")}.${
      String(value % 1000).padStart(3, "0")
    }`;
  const cues = Array.from({ length: 205 }, (_, index) => {
    const start = index * 10;
    return `${stamp(start)} --> ${
      stamp(start + 5)
    }\nalpha beta exact phrase cue ${index}`;
  });
  await writeFile(
    path.join(fixture.directory, "fixture.vtt"),
    `WEBVTT\n\n${cues.join("\n\n")}\n`,
  );
  const app = await openUrma(
    loadConfig({
      URMA_DATA_DIR: path.join(fixture.directory, "data"),
      URMA_LOCAL_ROOTS: fixture.directory,
    }),
  );
  t.after(async () => {
    app.close();
    await rm(fixture.directory, { recursive: true, force: true });
  });
  const inspected = await app.evidence.inspectVideo({ source: fixture.video });
  const phrase = await app.evidence.searchTranscript({
    investigationRef: inspected.investigationRef,
    query: "exact phrase",
    mode: "phrase",
    limit: 20,
  });
  assert.equal(phrase.hits.length, 20);
  assert(phrase.hits.every((hit) => hit.text.includes("exact phrase")));
  assert.deepEqual(
    phrase.hits.map((hit) => hit.startMs),
    [...phrase.hits.map((hit) => hit.startMs)].sort((a, b) => a - b),
  );
  const investigation = app.store.getInvestigation(inspected.investigationRef)!;
  const caption = app.store
    .listArtifacts(inspected.sourceRef, investigation.sourceRevision)
    .find((item) => item.kind === "caption")!;
  const captionPath = await app.blobs.verify(
    caption.artifactId,
    caption.blobPath,
  );
  await writeFile(captionPath, "corrupt");
  await assert.rejects(
    app.evidence.searchTranscript({
      investigationRef: inspected.investigationRef,
      query: "beta alpha",
      mode: "terms",
      limit: 7,
    }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "MEDIA_INVALID",
  );
  await app.blobs.putFile(path.join(fixture.directory, "fixture.vtt"));
  const terms = await app.evidence.searchTranscript({
    investigationRef: inspected.investigationRef,
    query: "beta alpha",
    mode: "terms",
    limit: 7,
  });
  assert.equal(terms.hits.length, 7);
  await app.blobs.verify(caption.artifactId, caption.blobPath);
  const miss = await app.evidence.searchTranscript({
    investigationRef: inspected.investigationRef,
    query: "alpha gamma",
    mode: "terms",
  });
  assert.equal(miss.hits.length, 0);
  assert.match(miss.missMeaning ?? "", /caption track/);
  const first = await app.evidence.readTranscript({
    investigationRef: inspected.investigationRef,
    startMs: 0,
    endMs: 4000,
  });
  assert.equal(first.segments.length, 200);
  assert.equal(first.partial, true);
  assert(first.nextCursor);
  const second = await app.evidence.readTranscript({
    investigationRef: inspected.investigationRef,
    startMs: 0,
    endMs: 4000,
    cursor: first.nextCursor,
  });
  assert.equal(second.segments.length, 5);
  assert.equal(second.partial, false);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(
    [...first.segments, ...second.segments].map((segment) => segment.text),
    cues.map((cue) => cue.split("\n")[1]),
  );
  assert.equal(
    new Set(
      [...first.segments, ...second.segments].map((segment) => segment.startMs),
    ).size,
    205,
  );
  await assert.rejects(
    app.evidence.readTranscript({
      investigationRef: inspected.investigationRef,
      startMs: 1,
      endMs: 4000,
      cursor: first.nextCursor,
    }),
    /does not belong/,
  );
  await assert.rejects(
    app.evidence.readTranscript({
      investigationRef: inspected.investigationRef,
      startMs: 4000,
      endMs: 4001,
    }),
    /source duration/,
  );
});

test("batched transcript search merges duplicate and overlapping spans under one bounded result budget", async (t) => {
  const fixture = await localVideoFixture(false);
  const stamp = (value: number) =>
    `00:00:${String(Math.floor(value / 1000)).padStart(2, "0")}.${
      String(value % 1000).padStart(3, "0")
    }`;
  const initial = [
    `${stamp(500)} --> ${stamp(1500)}\nalpha shared passage`,
    `${stamp(1000)} --> ${stamp(2000)}\nbeta overlapping passage`,
    `${stamp(2500)} --> ${stamp(3500)}\ngamma separate passage`,
  ];
  await writeFile(
    path.join(fixture.directory, "fixture.vtt"),
    `WEBVTT\n\n${initial.join("\n\n")}\n`,
  );
  const app = await openUrma(
    loadConfig({
      URMA_DATA_DIR: path.join(fixture.directory, "data"),
      URMA_LOCAL_ROOTS: fixture.directory,
    }),
  );
  t.after(async () => {
    app.close();
    await rm(fixture.directory, { recursive: true, force: true });
  });
  const inspected = await app.evidence.inspectVideo({ source: fixture.video });
  const single = await app.evidence.searchTranscript({
    investigationRef: inspected.investigationRef,
    query: "alpha",
    limit: 5,
  });
  assert.equal("queries" in single, false);
  assert.equal(single.hits.length, 1);
  const batchResult = await app.evidence.searchTranscript({
    investigationRef: inspected.investigationRef,
    queries: ["alpha", "shared", "beta", "gamma", "alpha"],
    limit: 5,
  });
  assert.equal("queries" in batchResult, true);
  if (!("queries" in batchResult)) {
    throw new Error("batch search returned the single-query shape");
  }
  const batch = batchResult;
  assert.deepEqual(batch.queries, ["alpha", "shared", "beta", "gamma"]);
  assert.equal(batch.partial, false);
  assert.equal(batch.hits.length, 2);
  const merged = batch.hits.find((hit) => hit.startMs === 500)!;
  assert.equal(merged.endMs, 2000);
  assert.match(merged.text, /alpha shared passage/u);
  assert.match(merged.text, /beta overlapping passage/u);
  assert.deepEqual(merged.matchedQueries, ["alpha", "shared", "beta"]);
  const separate = batch.hits.find((hit) => hit.startMs === 2500)!;
  assert.deepEqual(separate.matchedQueries, ["gamma"]);
  const repeatedResult = await app.evidence.searchTranscript({
    investigationRef: inspected.investigationRef,
    queries: ["alpha", "shared", "beta", "gamma", "alpha"],
    limit: 5,
  });
  assert.equal("queries" in repeatedResult, true);
  if (!("queries" in repeatedResult)) {
    throw new Error("repeated batch search returned the single-query shape");
  }
  const repeated = repeatedResult;
  assert.deepEqual(repeated.queries, batch.queries);
  assert.deepEqual(repeated.hits, batch.hits);
  assert.equal(repeated.partial, batch.partial);
  assert.equal(repeated.omittedHits, batch.omittedHits);

  const boundedCues: Array<string> = [];
  for (let queryIndex = 0; queryIndex < 20; queryIndex++) {
    const term = `term${String(queryIndex).padStart(2, "0")}`;
    for (let copy = 0; copy < 2; copy++) {
      const start = (queryIndex * 2 + copy) * 80;
      boundedCues.push(
        `${stamp(start)} --> ${
          stamp(start + 50)
        }\n${term} bounded evidence ${copy}`,
      );
    }
  }
  await writeFile(
    path.join(fixture.directory, "fixture.vtt"),
    `WEBVTT\n\n${boundedCues.join("\n\n")}\n`,
  );
  const boundedInspection = await app.evidence.inspectVideo({
    source: fixture.video,
  });
  const boundedResult = await app.evidence.searchTranscript({
    investigationRef: boundedInspection.investigationRef,
    queries: Array.from(
      { length: 20 },
      (_, index) => `term${String(index).padStart(2, "0")}`,
    ),
    limit: 5,
  });
  assert.equal("queries" in boundedResult, true);
  if (!("queries" in boundedResult)) {
    throw new Error("bounded batch search returned the single-query shape");
  }
  const bounded = boundedResult;
  assert.equal(bounded.queries.length, 20);
  assert.equal(bounded.hits.length <= 20, true);
  assert.equal(bounded.partial, true);
  assert.deepEqual(
    {
      candidateHitCount: bounded.candidateHitCount,
      candidateCountComplete: bounded.candidateCountComplete,
      omittedHits: bounded.omittedHits,
      hits: bounded.hits.length,
    },
    {
      candidateHitCount: 40,
      candidateCountComplete: true,
      omittedHits: 20,
      hits: 20,
    },
  );
  assert.equal(bounded.returnedCharacters <= 16_000, true);
  assert.equal(JSON.stringify(bounded).length <= 40_000, true);
  const largeCues = [
    `${stamp(500)} --> ${stamp(1500)}\nlong-a ${"x".repeat(9_000)}`,
    `${stamp(2000)} --> ${stamp(3000)}\nlong-b ${"y".repeat(9_000)}`,
  ];
  await writeFile(
    path.join(fixture.directory, "fixture.vtt"),
    `WEBVTT\n\n${largeCues.join("\n\n")}\n`,
  );
  const characterInspection = await app.evidence.inspectVideo({
    source: fixture.video,
  });
  const characterResult = await app.evidence.searchTranscript({
    investigationRef: characterInspection.investigationRef,
    queries: ["long-a", "long-b"],
    limit: 5,
  });
  assert.equal("queries" in characterResult, true);
  if (!("queries" in characterResult)) {
    throw new Error(
      "character-budget batch search returned the single-query shape",
    );
  }
  assert.equal(characterResult.hits.length, 1);
  assert.equal(characterResult.partial, true);
  assert.equal(characterResult.omittedHits, 1);
  assert.equal(characterResult.returnedCharacters <= 16_000, true);
});

test("multilingual tracks are exposed, explicitly selectable, cursor-bound, and investigation-recorded", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "urma-multilingual-"));
  const app = await openUrma(
    loadConfig({ URMA_DATA_DIR: path.join(directory, "data") }),
  );
  t.after(async () => {
    app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const seed = async (videoId: string, withSegments: boolean) => {
    const sourceRef = remoteSourceRef(youtubeRemoteIdentity(videoId));
    const revision = `v1:test:${videoId}`;
    const tracks = [
      makeCaptionTrack(sourceRef, revision, {
        language: "en",
        kind: "manual",
        displayName: "English",
        formats: ["vtt"],
        providerTrackId: null,
      }),
      makeCaptionTrack(sourceRef, revision, {
        language: "ja",
        kind: "manual",
        displayName: "日本語",
        formats: ["vtt"],
        providerTrackId: null,
      }),
    ];
    const resolved: ResolvedSource = {
      sourceRef,
      kind: "remote",
      identity: { basis: "extractor", namespace: "youtube", id: videoId },
      snapshotRef: { sourceRef, revision },
      canonicalKey: videoId,
      canonicalLocator: `https://www.youtube.com/watch?v=${videoId}`,
      revision,
      observedAt: new Date(0).toISOString(),
      title: "Multilingual fixture",
      durationMs: 10_000,
      metadataDurationMs: 10_000,
      timeline: {
        finite: true,
        durationMs: 10_000,
        basis: "container",
        validatedAt: new Date(0).toISOString(),
      },
      extractor: "youtube",
      extractorKey: videoId,
      liveState: "finite",
      safeOrigins: ["https://www.youtube.com"],
      resolverVersion: "fixture",
      normalizationVersion: "remote-normalization-v1",
      policyVersion: "fixture",
      chapters: [],
      captionTracks: tracks,
      formats: [],
      capabilities: {
        nativeCaptions: true,
        chapters: false,
        nativeStoryboard: false,
        targetedMedia: false,
        audio: false,
      },
      safeMetadata: {
        originalLanguage: "ja",
        titlePartial: false,
        chapterCount: 0,
        chaptersPartial: false,
      },
    };
    putTestSource(app.store, {
      sourceRef,
      kind: "remote",
      canonicalKey: videoId,
      revision,
      title: resolved.title,
      durationMs: resolved.durationMs,
      metadata: {
        canonicalLocator: resolved.canonicalLocator,
        chapters: [],
        captionTracks: tracks,
        formats: [],
        capabilities: resolved.capabilities,
        safeMetadata: resolved.safeMetadata,
      },
    });
    if (withSegments) {
      for (const track of tracks) {
        const trackId = transcriptTrackId(track.trackRef);
        const label = track.language === "ja"
          ? "日本語 証拠"
          : "English evidence";
        const segments = Array.from({ length: 205 }, (_, ordinal) => ({
          trackId,
          startMs: ordinal * 40,
          endMs: ordinal * 40 + 20,
          text: `${label} ${ordinal}`,
          ordinal,
        }));
        const body = Buffer.from(
          `WEBVTT\n\n00:00:00.000 --> 00:00:00.090\n${label}\n`,
        );
        const blob = await app.blobs.put(body);
        const now = new Date(0).toISOString();
        app.store.putTranscript(
          {
            id: trackId,
            sourceRef,
            sourceRevision: revision,
            language: track.language,
            kind: track.kind,
            providerTrackId: null,
            acquiredAt: now,
            metadata: {
              trackRef: track.trackRef,
              displayName: track.displayName,
            },
          },
          segments,
        );
        app.store.putArtifact(
          {
            artifactId: blob.artifactId,
            sourceRef,
            sourceRevision: revision,
            kind: "caption",
            role: "evidence",
            mimeType: "text/vtt",
            sha256: blob.sha256,
            byteSize: blob.byteSize,
            blobPath: blob.relativePath,
            startMs: 0,
            endMs: 6_000,
            params: {
              trackId,
              trackRef: track.trackRef,
              language: track.language,
              kind: track.kind,
            },
            producer: { version: "fixture" },
            createdAt: now,
          },
          {
            requestKey: `caption:${videoId}:${track.language}`,
            operation: "transcript",
          },
        );
      }
    }
    return { resolved, tracks };
  };
  const first = await seed("aaaaaaaaaaa", true);
  const other = await seed("bbbbbbbbbbb", false);
  const inspected = await app.evidence.inspectVideo({
    source: first.resolved.sourceRef,
  });
  assert.equal(inspected.captionTrackCount, 2);
  assert.equal(inspected.captionTracksPartial, false);
  assert.deepEqual(
    inspected.captionTracks.map((track) => track.language),
    ["en", "ja"],
  );
  const en = inspected.captionTracks.find((track) => track.language === "en")!;
  const ja = inspected.captionTracks.find((track) => track.language === "ja")!;
  const defaultResult = await app.evidence.searchTranscript({
    investigationRef: inspected.investigationRef,
    query: "日本語",
  });
  assert.equal(
    defaultResult.track.trackRef,
    ja.trackRef,
    "trustworthy original-language metadata must control the deterministic default",
  );
  const japanese = await app.evidence.searchTranscript({
    investigationRef: inspected.investigationRef,
    query: "日本語",
    trackRef: ja.trackRef,
  });
  assert.equal(japanese.hits.length, 5);
  assert.equal(japanese.track.language, "ja");
  assert.equal(japanese.partial, true);
  assert.equal(japanese.omittedHits, null);
  const japaneseBatchResult = await app.evidence.searchTranscript({
    investigationRef: inspected.investigationRef,
    queries: ["日本語", "証拠"],
    trackRef: ja.trackRef,
  });
  assert.equal("queries" in japaneseBatchResult, true);
  if (!("queries" in japaneseBatchResult)) {
    throw new Error("CJK batch search returned the single-query shape");
  }
  assert.equal(japaneseBatchResult.hits.length, 5);
  assert.equal(japaneseBatchResult.partial, true);
  assert.equal(japaneseBatchResult.omittedHits, null);
  assert(
    japaneseBatchResult.hits.every(
      (hit) =>
        hit.matchedQueries.includes("日本語") &&
        hit.matchedQueries.includes("証拠"),
    ),
  );
  const english = await app.evidence.searchTranscript({
    investigationRef: inspected.investigationRef,
    query: "English",
    trackRef: en.trackRef,
  });
  assert.equal(english.hits.length, 5);
  assert.equal(english.track.language, "en");
  const miss = await app.evidence.searchTranscript({
    investigationRef: inspected.investigationRef,
    query: "日本語",
    trackRef: en.trackRef,
  });
  assert.equal(miss.hits.length, 0);
  assert.match(miss.missMeaning ?? "", /selected caption track/);
  await assert.rejects(
    app.evidence.searchTranscript({
      investigationRef: inspected.investigationRef,
      query: "x",
      trackRef: `urma:track:${"f".repeat(32)}`,
    }),
    /unavailable for this source revision/,
  );
  await assert.rejects(
    app.evidence.searchTranscript({
      investigationRef: inspected.investigationRef,
      query: "x",
      trackRef: other.tracks[0]!.trackRef,
    }),
    /unavailable for this source revision/,
  );
  const firstPage = await app.evidence.readTranscript({
    investigationRef: inspected.investigationRef,
    startMs: 0,
    endMs: 10_000,
    trackRef: ja.trackRef,
  });
  assert.equal(firstPage.segments.length, 200);
  assert(firstPage.nextCursor);
  await assert.rejects(
    app.evidence.readTranscript({
      investigationRef: inspected.investigationRef,
      startMs: 0,
      endMs: 10_000,
      trackRef: en.trackRef,
      cursor: firstPage.nextCursor,
    }),
    /does not belong to this track/,
  );
  const secondPage = await app.evidence.readTranscript({
    investigationRef: inspected.investigationRef,
    startMs: 0,
    endMs: 10_000,
    trackRef: ja.trackRef,
    cursor: firstPage.nextCursor,
  });
  assert.equal(secondPage.segments.length, 5);
  const recorded = app.evidence.state(inspected.investigationRef).evidence
    .transcriptTracks;
  assert.deepEqual(
    new Set(recorded.map((track) => track.trackRef)),
    new Set([en.trackRef, ja.trackRef]),
  );
});

test("read_transcript returns 200 short segments when the character ceiling permits", async (t) => {
  const fixture = await localVideoFixture(false);
  const stamp = (value: number) =>
    `00:00:${String(Math.floor(value / 1000)).padStart(2, "0")}.${
      String(value % 1000).padStart(3, "0")
    }`;
  const expected = Array.from({ length: 200 }, (_, ordinal) => {
    const start = ordinal * 10;
    return { startMs: start, endMs: start + 5, text: `raw cue ${ordinal}` };
  });
  await writeFile(
    path.join(fixture.directory, "fixture.vtt"),
    `WEBVTT\n\n${
      expected.map((segment) =>
        `${stamp(segment.startMs)} --> ${stamp(segment.endMs)}\n${segment.text}`
      ).join("\n\n")
    }\n`,
  );
  const app = await openUrma(
    loadConfig({
      URMA_DATA_DIR: path.join(fixture.directory, "data"),
      URMA_LOCAL_ROOTS: fixture.directory,
    }),
  );
  t.after(async () => {
    app.close();
    await rm(fixture.directory, { recursive: true, force: true });
  });
  const inspected = await app.evidence.inspectVideo({ source: fixture.video });
  const result = await app.evidence.readTranscript({
    investigationRef: inspected.investigationRef,
    startMs: 0,
    endMs: 4000,
  });
  assert.deepEqual(result.segments, expected);
  assert.equal(result.partial, false);
  assert.equal(result.nextCursor, null);
});

test("read_transcript keeps the 16,000-character ceiling and paginates by cursor", async (t) => {
  const fixture = await localVideoFixture(false);
  const stamp = (value: number) =>
    `00:00:${String(Math.floor(value / 1000)).padStart(2, "0")}.${
      String(value % 1000).padStart(3, "0")
    }`;
  const expected = Array.from({ length: 4 }, (_, ordinal) => {
    const start = ordinal * 100;
    return {
      startMs: start,
      endMs: start + 50,
      text: `character cue ${ordinal} ${"x".repeat(4_990)}`,
    };
  });
  await writeFile(
    path.join(fixture.directory, "fixture.vtt"),
    `WEBVTT\n\n${
      expected.map((segment) =>
        `${stamp(segment.startMs)} --> ${stamp(segment.endMs)}\n${segment.text}`
      ).join("\n\n")
    }\n`,
  );
  const app = await openUrma(
    loadConfig({
      URMA_DATA_DIR: path.join(fixture.directory, "data"),
      URMA_LOCAL_ROOTS: fixture.directory,
    }),
  );
  t.after(async () => {
    app.close();
    await rm(fixture.directory, { recursive: true, force: true });
  });
  const inspected = await app.evidence.inspectVideo({ source: fixture.video });
  const first = await app.evidence.readTranscript({
    investigationRef: inspected.investigationRef,
    startMs: 0,
    endMs: 4000,
  });
  assert.equal(first.segments.length, 3);
  assert.equal(first.partial, true);
  assert(first.nextCursor);
  assert(
    first.segments.reduce((total, segment) => total + segment.text.length, 0) <=
      16_000,
  );
  assert.deepEqual(first.segments, expected.slice(0, 3));
  const second = await app.evidence.readTranscript({
    investigationRef: inspected.investigationRef,
    startMs: 0,
    endMs: 4000,
    cursor: first.nextCursor,
  });
  assert.deepEqual(second.segments, expected.slice(3));
  assert.equal(second.partial, false);
  assert.equal(second.nextCursor, null);
});

test("read_transcript keeps a single page for 50 segments", async (t) => {
  const fixture = await localVideoFixture(false);
  const stamp = (value: number) =>
    `00:00:${String(Math.floor(value / 1000)).padStart(2, "0")}.${
      String(value % 1000).padStart(3, "0")
    }`;
  const expected = Array.from({ length: 50 }, (_, ordinal) => {
    const start = ordinal * 20;
    return { startMs: start, endMs: start + 10, text: `legacy cue ${ordinal}` };
  });
  await writeFile(
    path.join(fixture.directory, "fixture.vtt"),
    `WEBVTT\n\n${
      expected.map((segment) =>
        `${stamp(segment.startMs)} --> ${stamp(segment.endMs)}\n${segment.text}`
      ).join("\n\n")
    }\n`,
  );
  const app = await openUrma(
    loadConfig({
      URMA_DATA_DIR: path.join(fixture.directory, "data"),
      URMA_LOCAL_ROOTS: fixture.directory,
    }),
  );
  t.after(async () => {
    app.close();
    await rm(fixture.directory, { recursive: true, force: true });
  });
  const inspected = await app.evidence.inspectVideo({ source: fixture.video });
  const result = await app.evidence.readTranscript({
    investigationRef: inspected.investigationRef,
    startMs: 0,
    endMs: 4000,
  });
  assert.deepEqual(result.segments, expected);
  assert.equal(result.partial, false);
  assert.equal(result.nextCursor, null);
  assert.deepEqual(Object.keys(result).sort(), [
    "nextCursor",
    "partial",
    "requestedRange",
    "returnedRange",
    "segments",
    "stateSummary",
    "track",
  ]);
  assert.deepEqual(Object.keys(result.track).sort(), [
    "displayName",
    "kind",
    "language",
    "providerTrackId",
    "trackRef",
  ]);
});
