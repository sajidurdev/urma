import assert from "node:assert/strict";
import test from "node:test";
import {
  admitValidatedTimeline,
  assertValidatedTimelinesAgree,
  validateFiniteHlsManifest,
  validateFiniteTransportMetadata,
  validateProgressiveProbe,
  validateStaticDashManifest,
} from "../../src/sources/timeline.js";

test("finite HLS validation requires ENDLIST and sums bounded segments", () => {
  const timeline = validateFiniteHlsManifest(
    "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:1.25,\na.ts\n#EXTINF:2.5,\nb.ts\n#EXT-X-ENDLIST\n",
  );
  assert.equal(timeline.basis, "hls");
  assert.equal(timeline.durationMs, 3_750);
  assert.throws(() => validateFiniteHlsManifest("#EXTM3U\n#EXTINF:2,\na.ts\n"), /not finite/u);
  assert.throws(() => validateFiniteHlsManifest("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\na.m3u8\n#EXT-X-ENDLIST\n"), /master/u);
});

test("static DASH and staged progressive probes establish finite timelines", () => {
  const dash = validateStaticDashManifest(
    '<MPD type="static" mediaPresentationDuration="PT1M2.5S"><Period /></MPD>',
  );
  assert.equal(dash.basis, "dash");
  assert.equal(dash.durationMs, 62_500);
  assert.throws(() => validateStaticDashManifest('<MPD type="dynamic" mediaPresentationDuration="PT1S" />'), /dynamic/u);
  assert.equal(
    validateProgressiveProbe({
      format: { duration: "4.25" },
      streams: [{ codec_type: "video", duration: "4.25" }],
    }).durationMs,
    4_250,
  );
});

test("validated transport duration wins over metadata and later contradictions are rejected", () => {
  const validated = validateFiniteHlsManifest("#EXTM3U\n#EXTINF:3.2,\na.ts\n#EXT-X-ENDLIST\n");
  const admitted = admitValidatedTimeline(9_999, validated);
  assert.equal(admitted.durationMs, 3_200);
  assert.equal(admitted.metadataDurationMs, 9_999);
  assert.doesNotThrow(() => assertValidatedTimelinesAgree(validated, validated));
  assert.throws(
    () => assertValidatedTimelinesAgree(validated, { ...validated, durationMs: 3_300 }),
    /contradicts/u,
  );
});

test("transport metadata validation is bounded to one finite HLS/DASH result", () => {
  const timeline = validateFiniteTransportMetadata(
    { _type: "video", duration: 12.345, live_status: "not_live" },
    "hls",
  );
  assert.equal(timeline.durationMs, 12_345);
  assert.throws(
    () => validateFiniteTransportMetadata({ _type: "video", duration: 12, is_live: true }, "hls"),
    /live|upcoming/iu,
  );
  assert.throws(
    () => validateFiniteTransportMetadata({ _type: "playlist", duration: 12 }, "dash"),
    /multiple entries|one video/iu,
  );
});
