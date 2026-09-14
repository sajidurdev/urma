import assert from "node:assert/strict";
import test from "node:test";
import {
  chooseTrack,
  parseJson3Captions,
  parseSrtCaptions,
  parseVttCaptions,
} from "../../src/acquisition/transcript.js";
import {
  captionTrackRef,
  remoteSourceRef,
  youtubeRemoteIdentity,
} from "../../src/core/ids.js";
import { searchInput } from "../../src/mcp/schemas.js";
import {
  hydrateCaptionTracks,
  makeCaptionTrack,
} from "../../src/sources/caption-tracks.js";

test("JSON3 and VTT caption parsers preserve integer millisecond timestamps", () => {
  const json = parseJson3Captions(
    JSON.stringify({
      events: [
        {
          tStartMs: 1250,
          dDurationMs: 500,
          segs: [{ utf8: "Hello &amp; <i>world</i>" }],
        },
      ],
    }),
    "t",
  );
  assert.deepEqual(json, [
    {
      trackId: "t",
      startMs: 1250,
      endMs: 1750,
      text: "Hello & world",
      ordinal: 0,
    },
  ]);
  const vtt = parseVttCaptions(
    "WEBVTT\n\n00:00:02.000 --> 00:00:03.250\nSecond cue",
    "t",
  );
  assert.deepEqual(vtt[0], {
    trackId: "t",
    startMs: 2000,
    endMs: 3250,
    text: "Second cue",
    ordinal: 0,
  });
  assert.deepEqual(
    parseSrtCaptions(
      "1\n00:00:04,500 --> 00:00:05,750\nSRT cue\n",
      "t",
    )[0],
    {
      trackId: "t",
      startMs: 4500,
      endMs: 5750,
      text: "SRT cue",
      ordinal: 0,
    },
  );
});
test("caption policy prefers English manual then deterministic alternatives", () => {
  const sourceRef = remoteSourceRef(youtubeRemoteIdentity("yP0axVHdP-U"));
  assert.equal(
    chooseTrack([
      {
        trackRef: captionTrackRef(sourceRef, "r1", "en", "automatic", null),
        language: "en",
        kind: "automatic",
        displayName: null,
        formats: ["vtt"],
        providerTrackId: null,
      },
      {
        trackRef: captionTrackRef(sourceRef, "r1", "en-GB", "manual", null),
        language: "en-GB",
        kind: "manual",
        displayName: null,
        formats: ["vtt"],
        providerTrackId: null,
      },
    ])?.kind,
    "manual",
  );
  assert.equal(chooseTrack([]), null);
});
test("caption policy prefers trustworthy original language within the best available kind", () => {
  const sourceRef = remoteSourceRef(youtubeRemoteIdentity("yP0axVHdP-U"));
  const tracks = [
    {
      trackRef: captionTrackRef(sourceRef, "r1", "en", "manual", null),
      language: "en",
      kind: "manual" as const,
      formats: ["vtt"],
      providerTrackId: null,
      displayName: "English",
    },
    {
      trackRef: captionTrackRef(sourceRef, "r1", "ja", "manual", null),
      language: "ja",
      kind: "manual" as const,
      formats: ["vtt"],
      providerTrackId: null,
      displayName: "Japanese",
    },
  ];
  assert.equal(chooseTrack(tracks, "ja")?.language, "ja");
});
test("caption provenance preserves unknown kind and provider identity without merging tracks", () => {
  const sourceRef = remoteSourceRef(youtubeRemoteIdentity("yP0axVHdP-U"));
  const track = makeCaptionTrack(sourceRef, "r1", {
    language: "fr-CA",
    kind: "unknown",
    displayName: "French",
    formats: ["vtt"],
    providerTrackId: "provider-fr",
  });
  const hydrated = hydrateCaptionTracks(sourceRef, "r1", [track]);
  assert.equal(hydrated.length, 1);
  assert.equal(hydrated[0]!.trackRef, track.trackRef);
  assert.equal(hydrated[0]!.kind, "unknown");
  assert.equal(hydrated[0]!.providerTrackId, "provider-fr");
});

test("search MCP input accepts exactly one bounded single or batch query form", () => {
  const investigationRef = `urma:investigation:${"a".repeat(32)}`;
  const base = { investigationRef };
  assert.equal(searchInput.safeParse({ ...base, query: "foo" }).success, true);
  assert.equal(
    searchInput.safeParse({ ...base, queries: ["foo", "bar"] }).success,
    true,
  );
  for (
    const value of [
      base,
      { ...base, query: "foo", queries: ["bar"] },
      { ...base, queries: [] },
      { ...base, query: "   " },
      { ...base, queries: ["foo", ""] },
      { ...base, queries: Array.from({ length: 21 }, () => "foo") },
      { ...base, query: "x".repeat(257) },
      { ...base, queries: ["x".repeat(257)] },
      { ...base, query: 42 },
      { ...base, queries: "foo" },
    ]
  ) {
    assert.equal(
      searchInput.safeParse(value).success,
      false,
      `expected invalid search input: ${JSON.stringify(value)}`,
    );
  }
  const duplicate = searchInput.safeParse({ ...base, queries: ["foo", "foo"] });
  assert.equal(duplicate.success, true);
});
