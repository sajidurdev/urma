import { putTestSource } from "../support/source-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { openUrma } from "../../src/app.js";
import { transcriptTrackId } from "../../src/acquisition/transcript.js";
import { loadConfig } from "../../src/config.js";
import {
  createInvestigationRef,
  remoteSourceRef,
  youtubeRemoteIdentity,
} from "../../src/core/ids.js";
import { makeCaptionTrack } from "../../src/sources/caption-tracks.js";
import type { CaptionTrackSummary } from "../../src/sources/types.js";
import type { TranscriptKind } from "../../src/core/model.js";

type TrackFixture = Readonly<{
  language: string;
  kind: TranscriptKind;
  displayName: string | null;
  providerTrackId: string | null;
  texts: readonly string[];
  spans?: readonly Readonly<{ startMs: number; endMs: number; text: string }>[];
}>;

type SearchFixture = Readonly<{
  app: Awaited<ReturnType<typeof openUrma>>;
  investigationRef: ReturnType<typeof createInvestigationRef>;
  tracks: readonly CaptionTrackSummary[];
}>;

const createdAt = new Date(0).toISOString();

async function fixture(
  t: TestContext,
  options: Readonly<{
    tracks?: readonly TrackFixture[];
    originalLanguage?: string | null;
    durationMs?: number;
  }> = {},
): Promise<SearchFixture> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "urma-search-completeness-"),
  );
  const app = await openUrma(
    loadConfig({ URMA_DATA_DIR: path.join(directory, "data") }),
  );
  t.after(async () => {
    app.close();
    await rm(directory, { recursive: true, force: true });
  });

  const sourceRef = remoteSourceRef(youtubeRemoteIdentity("aaaaaaaaaaa"));
  const revision = "v1:test:aaaaaaaaaaa";
  const trackFixtures = options.tracks ?? [
    {
      language: "en",
      kind: "manual",
      displayName: "English",
      providerTrackId: "manual-en",
      texts: [],
    },
  ];
  const tracks = trackFixtures.map(
    ({ language, kind, displayName, providerTrackId }) =>
      makeCaptionTrack(sourceRef, revision, {
        language,
        kind,
        displayName,
        formats: ["vtt"],
        providerTrackId,
      }),
  );
  const durationMs = Math.max(
    options.durationMs ?? 0,
    ...trackFixtures.map((track) =>
      Math.max(
        track.texts.length * 10 + 1,
        ...(track.spans?.map((span) => span.endMs + 1) ?? []),
      )
    ),
    60_000,
  );
  putTestSource(app.store, {
    sourceRef,
    kind: "remote",
    canonicalKey: "aaaaaaaaaaa",
    revision,
    title: "Transcript fixture",
    durationMs,
    metadata: {
      canonicalLocator: "https://www.youtube.com/watch?v=aaaaaaaaaaa",
      chapters: [],
      captionTracks: tracks,
      formats: [],
      capabilities: {
        nativeCaptions: tracks.length > 0,
        chapters: false,
        nativeStoryboard: false,
        targetedMedia: false,
        audio: false,
      },
      safeMetadata: { originalLanguage: options.originalLanguage ?? null },
    },
  });
  const investigationRef = createInvestigationRef();
  app.store.createInvestigation({
    investigationRef,
    sourceRef,
    sourceRevision: revision,
    durationMs,
    createdAt,
    updatedAt: createdAt,
  });

  for (const [index, track] of tracks.entries()) {
    const sourceTrack = trackFixtures[index]!;
    const trackId = transcriptTrackId(track.trackRef);
    const segments = sourceTrack.spans?.map((span, ordinal) => ({
      trackId,
      startMs: span.startMs,
      endMs: span.endMs,
      text: span.text,
      ordinal,
    })) ??
      sourceTrack.texts.map((text, ordinal) => ({
        trackId,
        startMs: ordinal * 10,
        endMs: ordinal * 10 + 5,
        text,
        ordinal,
      }));
    const blob = await app.blobs.put(
      Buffer.from(`fixture caption ${track.trackRef}`),
    );
    app.store.putTranscript(
      {
        id: trackId,
        sourceRef,
        sourceRevision: revision,
        language: track.language,
        kind: track.kind,
        providerTrackId: track.providerTrackId,
        acquiredAt: createdAt,
        metadata: { trackRef: track.trackRef, displayName: track.displayName },
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
        endMs: durationMs,
        params: {
          trackId,
          trackRef: track.trackRef,
          language: track.language,
          kind: track.kind,
          providerTrackId: track.providerTrackId,
        },
        producer: { version: "fixture" },
        createdAt,
      },
      { requestKey: `fixture-caption-${index}`, operation: "transcript" },
    );
  }
  return { app, investigationRef, tracks };
}

test("single search reports exact omission when the result cap hides eligible literal matches", async (t) => {
  const context = await fixture(t, {
    tracks: [
      {
        language: "en",
        kind: "manual",
        displayName: "English",
        providerTrackId: "manual-en",
        texts: Array.from(
          { length: 21 },
          (_, index) => `literal evidence ${index}`,
        ),
      },
    ],
  });
  assert.equal(context.app.store.ftsEnabled, true);
  const result = await context.app.evidence.searchTranscript({
    investigationRef: context.investigationRef,
    query: "literal evidence",
    limit: 20,
  });
  assert.equal(result.scope, "selected-caption-track");
  assert.deepEqual(
    result.hits.map((hit) => hit.startMs),
    Array.from({ length: 20 }, (_, index) => index * 10),
  );
  assert.equal(result.candidateHitCount, 21);
  assert.equal(result.candidateCountComplete, true);
  assert.equal(result.omittedHits, 1);
  assert.equal(result.partial, true);
});

test("FTS-shaped term search reports candidate-cap truncation instead of trusting a hidden LIMIT", async (t) => {
  const context = await fixture(t, {
    tracks: [
      {
        language: "en",
        kind: "manual",
        displayName: "English",
        providerTrackId: "manual-en",
        texts: Array.from(
          { length: 101 },
          (_, index) => `candidate overflow ${index}`,
        ),
      },
    ],
  });
  assert.equal(context.app.store.ftsEnabled, true);
  const result = await context.app.evidence.searchTranscript({
    investigationRef: context.investigationRef,
    query: "candidate overflow",
    mode: "terms",
    limit: 5,
  });
  assert.equal(result.hits.length, 5);
  assert.equal(result.candidateHitCount, 100);
  assert.equal(result.candidateCountComplete, false);
  assert.equal(result.omittedHits, null);
  assert.equal(result.partial, true);
});

test("substring fallback remains literal and bounded when FTS tokenization is insufficient", async (t) => {
  const context = await fixture(t, {
    tracks: [
      {
        language: "en",
        kind: "manual",
        displayName: "English",
        providerTrackId: "manual-en",
        texts: Array.from(
          { length: 101 },
          (_, index) => `concatenate fallback ${index}`,
        ),
      },
    ],
  });
  assert.equal(context.app.store.ftsEnabled, true);
  const result = await context.app.evidence.searchTranscript({
    investigationRef: context.investigationRef,
    query: "cat",
    limit: 5,
  });
  assert.equal(
    result.hits.every((hit) => hit.text.includes("concatenate")),
    true,
  );
  assert.equal(result.candidateCountComplete, false);
  assert.equal(result.omittedHits, null);
  assert.equal(result.partial, true);
});

test("CJK fallback reports bounded truncation instead of implying a complete miss", async (t) => {
  const context = await fixture(t, {
    tracks: [
      {
        language: "ja",
        kind: "automatic",
        displayName: "日本語",
        providerTrackId: "auto-ja",
        texts: Array.from(
          { length: 101 },
          (_, index) => `日本語 証拠 ${index}`,
        ),
      },
    ],
  });
  const result = await context.app.evidence.searchTranscript({
    investigationRef: context.investigationRef,
    query: "日本語",
    limit: 5,
  });
  assert.equal(result.hits.length, 5);
  assert.equal(result.candidateCountComplete, false);
  assert.equal(result.omittedHits, null);
  assert.equal(result.partial, true);
  assert.equal(result.missMeaning, null);
});

test("the segment-scan bound avoids unbounded work and makes a tail-only match incomplete", async (t) => {
  const texts = Array.from({ length: 10_001 }, () => "unrelated caption");
  texts[10_000] = "tail-only evidence";
  const context = await fixture(t, {
    tracks: [
      {
        language: "en",
        kind: "manual",
        displayName: "English",
        providerTrackId: "manual-en",
        texts,
      },
    ],
  });
  const result = await context.app.evidence.searchTranscript({
    investigationRef: context.investigationRef,
    query: "tail-only evidence",
    limit: 5,
  });
  assert.equal(result.hits.length, 0);
  assert.equal(result.candidateHitCount, 0);
  assert.equal(result.candidateCountComplete, false);
  assert.equal(result.omittedHits, null);
  assert.equal(result.partial, true);
  assert.match(result.missMeaning ?? "", /bounded search/u);
});

test("batch search merges overlapping spans while remaining complete when every per-query result fits", async (t) => {
  const context = await fixture(t, {
    tracks: [
      {
        language: "en",
        kind: "manual",
        displayName: "English",
        providerTrackId: "manual-en",
        texts: [],
        spans: [
          { startMs: 500, endMs: 1_500, text: "alpha shared passage" },
          { startMs: 1_000, endMs: 2_000, text: "beta overlapping passage" },
          { startMs: 2_500, endMs: 3_500, text: "gamma separate passage" },
        ],
      },
    ],
  });
  const result = await context.app.evidence.searchTranscript({
    investigationRef: context.investigationRef,
    queries: ["alpha", "shared", "beta", "gamma"],
    limit: 5,
  });
  assert.equal("queries" in result, true);
  if (!("queries" in result)) throw new Error("expected batch search output");
  assert.equal(result.hits.length, 2);
  assert.equal(result.candidateHitCount, 2);
  assert.equal(result.candidateCountComplete, true);
  assert.equal(result.omittedHits, 0);
  assert.equal(result.partial, false);
  assert.deepEqual(result.hits[0]!.matchedQueries, ["alpha", "shared", "beta"]);
});

test("batch global unique-hit cap reports exact omissions after deduplication", async (t) => {
  const texts: string[] = [];
  for (let index = 0; index < 20; index += 1) {
    const query = `batch-${String(index).padStart(2, "0")}`;
    texts.push(`${query} first`, `${query} second`);
  }
  const context = await fixture(t, {
    tracks: [
      {
        language: "en",
        kind: "manual",
        displayName: "English",
        providerTrackId: "manual-en",
        texts,
      },
    ],
  });
  const result = await context.app.evidence.searchTranscript({
    investigationRef: context.investigationRef,
    queries: Array.from(
      { length: 20 },
      (_, index) => `batch-${String(index).padStart(2, "0")}`,
    ),
    limit: 5,
  });
  assert.equal("queries" in result, true);
  if (!("queries" in result)) throw new Error("expected batch search output");
  assert.equal(result.hits.length, 20);
  assert.equal(result.candidateHitCount, 40);
  assert.equal(result.candidateHitCount > result.hits.length, true);
  assert.equal(result.candidateCountComplete, true);
  assert.equal(result.omittedHits, 20);
  assert.equal(result.partial, true);
});

test("batch text ceiling reports exact omitted candidates and never partial false", async (t) => {
  const context = await fixture(t, {
    tracks: [
      {
        language: "en",
        kind: "manual",
        displayName: "English",
        providerTrackId: "manual-en",
        texts: [`long-a ${"x".repeat(9_000)}`, `long-b ${"y".repeat(9_000)}`],
      },
    ],
  });
  const result = await context.app.evidence.searchTranscript({
    investigationRef: context.investigationRef,
    queries: ["long-a", "long-b"],
    limit: 5,
  });
  assert.equal("queries" in result, true);
  if (!("queries" in result)) throw new Error("expected batch search output");
  assert.equal(result.hits.length, 1);
  assert.equal(result.candidateHitCount, 2);
  assert.equal(result.candidateCountComplete, true);
  assert.equal(result.omittedHits, 1);
  assert.equal(result.partial, true);
  assert.equal(result.returnedCharacters <= 16_000, true);
});

test("overlapping text that cannot fit one merged candidate is explicitly partial", async (t) => {
  const context = await fixture(t, {
    tracks: [
      {
        language: "en",
        kind: "manual",
        displayName: "English",
        providerTrackId: "manual-en",
        texts: [],
        spans: [
          { startMs: 1_000, endMs: 3_000, text: `first ${"a".repeat(7_998)}` },
          { startMs: 2_000, endMs: 4_000, text: `second ${"b".repeat(7_997)}` },
        ],
      },
    ],
  });
  const result = await context.app.evidence.searchTranscript({
    investigationRef: context.investigationRef,
    queries: ["first", "second"],
    limit: 5,
  });
  assert.equal("queries" in result, true);
  if (!("queries" in result)) throw new Error("expected batch search output");
  assert.equal(result.hits.length, 0);
  assert.equal(result.candidateHitCount, 1);
  assert.equal(result.candidateCountComplete, true);
  assert.equal(result.omittedHits, 1);
  assert.equal(result.returnedCharacters, 0);
  assert.equal(result.partial, true);
});

test("exactly-at-limit and complete zero-match searches are distinguishable from truncation", async (t) => {
  const context = await fixture(t, {
    tracks: [
      {
        language: "en",
        kind: "manual",
        displayName: "English",
        providerTrackId: "manual-en",
        texts: Array.from(
          { length: 20 },
          (_, index) => `exact boundary ${index}`,
        ),
      },
    ],
  });
  const exact = await context.app.evidence.searchTranscript({
    investigationRef: context.investigationRef,
    query: "exact boundary",
    limit: 20,
  });
  assert.equal(exact.hits.length, 20);
  assert.equal(exact.candidateHitCount, 20);
  assert.equal(exact.candidateCountComplete, true);
  assert.equal(exact.omittedHits, 0);
  assert.equal(exact.partial, false);
  const miss = await context.app.evidence.searchTranscript({
    investigationRef: context.investigationRef,
    query: "not present",
    limit: 20,
  });
  assert.equal(miss.hits.length, 0);
  assert.equal(miss.candidateHitCount, 0);
  assert.equal(miss.candidateCountComplete, true);
  assert.equal(miss.omittedHits, 0);
  assert.equal(miss.partial, false);
  assert.match(miss.missMeaning ?? "", /selected caption track/u);
});

test("track identity, language, kind, and provider identity stay aligned across search and read", async (t) => {
  const context = await fixture(t, {
    originalLanguage: "ja",
    tracks: [
      {
        language: "en",
        kind: "manual",
        displayName: "English manual",
        providerTrackId: "manual-en",
        texts: ["English manual evidence"],
      },
      {
        language: "en",
        kind: "manual",
        displayName: "English manual alternate",
        providerTrackId: "manual-en-alt",
        texts: ["English alternate manual evidence"],
      },
      {
        language: "en",
        kind: "automatic",
        displayName: "English automatic",
        providerTrackId: "auto-en",
        texts: ["English automatic evidence"],
      },
      {
        language: "ja",
        kind: "manual",
        displayName: "日本語 manual",
        providerTrackId: "manual-ja",
        texts: ["日本語 手動証拠"],
      },
    ],
  });
  const japanese = await context.app.evidence.searchTranscript({
    investigationRef: context.investigationRef,
    query: "日本語",
  });
  assert.equal(japanese.track.language, "ja");
  assert.equal(japanese.track.kind, "manual");
  assert.equal(japanese.track.providerTrackId, "manual-ja");
  const alternate = await context.app.evidence.searchTranscript({
    investigationRef: context.investigationRef,
    query: "alternate",
    trackRef: context.tracks[1]!.trackRef,
  });
  assert.equal(alternate.track.trackRef, context.tracks[1]!.trackRef);
  assert.equal(alternate.track.kind, "manual");
  assert.equal(alternate.track.providerTrackId, "manual-en-alt");
  const automatic = await context.app.evidence.searchTranscript({
    investigationRef: context.investigationRef,
    query: "automatic",
    trackRef: context.tracks[2]!.trackRef,
  });
  assert.equal(automatic.track.trackRef, context.tracks[2]!.trackRef);
  assert.equal(automatic.track.kind, "automatic");
  assert.equal(automatic.track.providerTrackId, "auto-en");
  const read = await context.app.evidence.readTranscript({
    investigationRef: context.investigationRef,
    startMs: 0,
    endMs: 1_000,
    trackRef: context.tracks[2]!.trackRef,
  });
  assert.equal(read.track.trackRef, automatic.track.trackRef);
  assert.equal(read.track.providerTrackId, automatic.track.providerTrackId);
  assert.equal(read.segments[0]!.text, "English automatic evidence");
  assert.equal(
    context.app.evidence
      .state(context.investigationRef)
      .evidence.transcriptTracks.find(
        (track) => track.trackRef === automatic.track.trackRef,
      )?.providerTrackId,
    "auto-en",
  );
});

test("no transcript track is an availability error, not a complete zero-match search", async (t) => {
  const context = await fixture(t, { tracks: [] });
  await assert.rejects(
    context.app.evidence.searchTranscript({
      investigationRef: context.investigationRef,
      query: "anything",
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "CAPTIONS_UNAVAILABLE",
  );
});
