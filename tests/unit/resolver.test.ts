import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../../src/config.js";
import { SourceResolver, type RemoteResolutionProvider } from "../../src/sources/resolver.js";
import { SqliteStore } from "../../src/store/sqlite-store.js";

const inputUrl = "https://example.test/watch/fixture";

function provider(counter: { calls: number }): RemoteResolutionProvider {
  return async (input) => {
    counter.calls += 1;
    return {
      inputUrl: input,
      canonicalUrl: inputUrl,
      metadata: {
        _type: "video",
        extractor: "fixture",
        extractor_key: "fixture",
        id: "fixture-video",
        title: "Fixture remote",
        duration: 3,
        formats: [{
          format_id: "video",
          ext: "mp4",
          protocol: "https",
          width: 320,
          height: 180,
          vcodec: "h264",
          acodec: "none",
          url: "https://media.example.test/video.mp4",
        }],
      },
      timeline: {
        finite: true,
        durationMs: 3_000,
        basis: "progressive",
        validatedAt: new Date().toISOString(),
      },
    };
  };
}

test("generic resolver fixture injection preserves reuse and explicit refresh semantics", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "urma-resolver-"));
  const config = loadConfig({ URMA_DATA_DIR: path.join(directory, "data") });
  const store = await SqliteStore.open(path.join(config.dataDir, "urma.db"));
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const counter = { calls: 0 };
  const resolver = new SourceResolver(config, store, null, provider(counter));
  const first = await resolver.resolve(inputUrl);
  assert.equal(first.cacheHit, false);
  assert.equal(counter.calls, 1);
  const reused = await resolver.resolve(inputUrl);
  assert.equal(reused.cacheHit, true);
  assert.equal(counter.calls, 1);
  assert.equal(reused.source.sourceRef, first.source.sourceRef);
  assert.equal(reused.source.revision, first.source.revision);
  const refreshed = await resolver.resolve(inputUrl, undefined, "refresh");
  assert.equal(refreshed.cacheHit, false);
  assert.equal(counter.calls, 2);
  assert.equal(refreshed.source.sourceRef, first.source.sourceRef);
  assert.notEqual(refreshed.source.revision, first.source.revision);
  assert(store.getSnapshot(first.source.sourceRef, first.source.revision));
  assert(store.getSnapshot(refreshed.source.sourceRef, refreshed.source.revision));

  const reopened = new SourceResolver(config, store);
  const reopenedSource = await reopened.resolve(first.source.sourceRef);
  assert.equal(reopenedSource.cacheHit, true);
  await assert.rejects(
    reopened.resolve(first.source.sourceRef, undefined, "refresh"),
    /local Safe Proxy/u,
  );
});

test("generic URL admission requires the local Safe Proxy for real resolution", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "urma-resolver-disabled-"));
  const config = loadConfig({ URMA_DATA_DIR: path.join(directory, "data") });
  const store = await SqliteStore.open(path.join(config.dataDir, "urma.db"));
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  await assert.rejects(
    new SourceResolver(config, store).resolve("https://media.example.test/video.mp4"),
    /local Safe Proxy/u,
  );
});
