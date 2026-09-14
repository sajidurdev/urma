import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRemoteResolution } from "../../src/remote/normalize.js";

const timeline = {
  finite: true as const,
  durationMs: 12_345,
  basis: "hls" as const,
  validatedAt: new Date(0).toISOString(),
};

function metadata(overrides: Record<string, unknown> = {}) {
  return {
    _type: "video",
    extractor: "fixture",
    extractor_key: "fixture",
    id: "video-1",
    title: "Fixture video",
    duration: 12.4,
    formats: [
      {
        format_id: "hls-360",
        ext: "mp4",
        protocol: "m3u8_native",
        width: 640,
        height: 360,
        fps: 30,
        vcodec: "h264",
        acodec: "aac",
        filesize: 1000,
        url: "https://media.example.test/video.m3u8",
      },
    ],
    subtitles: {
      en: [
        { ext: "vtt", name: "English", url: "https://media.example.test/en.vtt" },
        { ext: "srt", name: "English SRT", url: "https://media.example.test/en.srt" },
      ],
    },
    automatic_captions: {
      en: [{ ext: "vtt", name: "English auto", url: "https://media.example.test/en-auto.vtt" }],
    },
    ...overrides,
  };
}

test("generic normalization preserves snapshot duration, candidate identity, origins, and caption variants", () => {
  const source = normalizeRemoteResolution(
    {
      inputUrl: "https://example.test/watch/alias",
      canonicalUrl: "https://example.test/watch/video-1",
      metadata: metadata(),
      timeline,
      redirectUrls: ["https://redirect.example.test/watch/video-1"],
    },
    "v1:fixture",
  );
  assert.equal(source.kind, "remote");
  assert.equal(source.remoteAcquisition, "safe-proxy");
  assert.equal(source.identity?.basis, "extractor");
  assert.equal(source.durationMs, 12_345);
  assert.equal(source.metadataDurationMs, 12_400);
  assert.equal(source.timeline.basis, "hls");
  assert.equal(source.formats.length, 1);
  assert.match(String(source.formats[0]?.candidateKey), /^urma:candidate:/u);
  assert.equal(source.captionTracks.length, 3);
  assert.notEqual(
    source.captionTracks[0]?.providerTrackId,
    source.captionTracks[1]?.providerTrackId,
  );
  assert.deepEqual(source.safeOrigins, [
    "https://example.test",
    "https://media.example.test",
    "https://redirect.example.test",
  ]);
  assert.equal(JSON.stringify(source).includes("media.example.test/video.m3u8"), false);
});

test("generic normalization supports locator identity when yt-dlp has no stable extractor id", () => {
  const source = normalizeRemoteResolution(
    {
      inputUrl: "https://example.test/video.mp4",
      canonicalUrl: "https://example.test/video.mp4",
      metadata: metadata({ id: undefined, extractor: undefined, extractor_key: undefined }),
      timeline: { ...timeline, basis: "progressive" },
    },
    "v1:locator",
  );
  assert.equal(source.identity?.basis, "locator");
  assert.equal(source.canonicalKey, "https://example.test/video.mp4");
});

test("generic normalization rejects prohibited result classes, destinations, and media without video", () => {
  assert.throws(
    () => normalizeRemoteResolution({
      inputUrl: "https://example.test/watch",
      canonicalUrl: "https://example.test/watch",
      metadata: metadata({ _type: "playlist" }),
      timeline,
    }, "v1:playlist"),
    /multi-entry|excluded/u,
  );
  assert.throws(
    () => normalizeRemoteResolution({
      inputUrl: "https://example.test/watch",
      canonicalUrl: "https://example.test/watch",
      metadata: metadata({ formats: [{ format_id: "audio", vcodec: "none", acodec: "aac" }] }),
      timeline,
    }, "v1:audio"),
    /video representation/u,
  );
  assert.throws(
    () => normalizeRemoteResolution({
      inputUrl: "https://example.test/watch",
      canonicalUrl: "https://example.test/watch",
      metadata: metadata(),
      timeline,
      deliveryUrls: ["http://169.254.169.254/metadata"],
    }, "v1:ssrf"),
    /private|reserved|local|disallowed/u,
  );
  assert.throws(
    () => normalizeRemoteResolution({
      inputUrl: "https://example.test/watch",
      canonicalUrl: "https://example.test/watch",
      metadata: metadata({ entries: [{ id: "one" }] }),
      timeline,
    }, "v1:entries"),
    /multiple entries|multi-entry/u,
  );
});
