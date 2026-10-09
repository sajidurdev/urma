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
  const [refreshed, concurrentlyRefreshed] = await Promise.all([
    resolver.resolve(inputUrl, undefined, "refresh"),
    resolver.resolve(inputUrl, undefined, "refresh"),
  ]);
  assert.equal(refreshed.cacheHit, false);
  assert.equal(counter.calls, 3);
  assert.equal(refreshed.source.sourceRef, first.source.sourceRef);
  assert.notEqual(refreshed.source.revision, first.source.revision);
  assert.equal(concurrentlyRefreshed.cacheHit, false);
  assert.equal(concurrentlyRefreshed.source.sourceRef, first.source.sourceRef);
  assert.notEqual(concurrentlyRefreshed.source.revision, refreshed.source.revision);
  assert(store.getSnapshot(first.source.sourceRef, first.source.revision));
  assert(store.getSnapshot(refreshed.source.sourceRef, refreshed.source.revision));
  assert(store.getSnapshot(concurrentlyRefreshed.source.sourceRef, concurrentlyRefreshed.source.revision));

  const reopened = new SourceResolver(config, store);
  const reopenedSource = await reopened.resolve(first.source.sourceRef);
  assert.equal(reopenedSource.cacheHit, true);
  await assert.rejects(
    reopened.resolve(first.source.sourceRef, undefined, "refresh"),
    /local Safe Proxy/u,
  );
});

test("generic resolver coalesces concurrent cold reuse and keeps observer cancellation local", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "urma-resolver-singleflight-"));
  const config = loadConfig({ URMA_DATA_DIR: path.join(directory, "data") });
  const store = await SqliteStore.open(path.join(config.dataDir, "urma.db"));
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  let calls = 0;
  let upstreamSignal: AbortSignal | undefined;
  let started!: () => void;
  let release!: () => void;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const resolver = new SourceResolver(config, store, null, async (input, signal) => {
    calls += 1;
    upstreamSignal = signal;
    started();
    await gate;
    return await provider({ calls: 0 })(input, signal);
  });

  const firstController = new AbortController();
  const first = resolver.resolve(inputUrl, firstController.signal);
  await began;
  const second = resolver.resolve(inputUrl);
  const third = resolver.resolve(inputUrl);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);

  firstController.abort();
  await assert.rejects(
    first,
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "CANCELLED",
  );
  assert.equal(upstreamSignal?.aborted, false);

  release();
  const [resolved, alsoResolved] = await Promise.all([second, third]);
  assert.equal(resolved.cacheHit, false);
  assert.equal(alsoResolved.cacheHit, false);
  assert.equal(calls, 1);
  assert.equal(upstreamSignal?.aborted, false);
  assert.equal(alsoResolved.source.sourceRef, resolved.source.sourceRef);
  assert.equal(alsoResolved.source.revision, resolved.source.revision);
});

test("cancelled cold resolver work cannot overwrite a later replacement snapshot", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "urma-resolver-late-save-"));
  const config = loadConfig({ URMA_DATA_DIR: path.join(directory, "data") });
  const store = await SqliteStore.open(path.join(config.dataDir, "urma.db"));
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  let calls = 0;
  let startedOld!: () => void;
  let releaseOld!: () => void;
  const oldStarted = new Promise<void>((resolve) => {
    startedOld = resolve;
  });
  const oldGate = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  const resolutionProvider: RemoteResolutionProvider = async (input) => {
    calls += 1;
    if (calls === 1) {
      startedOld();
      await oldGate;
    }
    return await provider({ calls: 0 })(input);
  };
  const resolver = new SourceResolver(config, store, null, resolutionProvider);
  const controller = new AbortController();
  const old = resolver.resolve(inputUrl, controller.signal);
  await oldStarted;
  controller.abort();
  await assert.rejects(
    old,
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "CANCELLED",
  );

  const replacement = await resolver.resolve(inputUrl);
  const replacementRevision = replacement.source.revision;
  assert.equal(calls, 2);
  assert.equal(store.getLatestSnapshot(replacement.source.sourceRef)?.revision, replacementRevision);

  // The cancelled provider ignores abort and returns after the replacement saved.
  releaseOld();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.getLatestSnapshot(replacement.source.sourceRef)?.revision, replacementRevision);
});

test("generic resolver can retry after a failed cold remote resolution", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "urma-resolver-retry-"));
  const config = loadConfig({ URMA_DATA_DIR: path.join(directory, "data") });
  const store = await SqliteStore.open(path.join(config.dataDir, "urma.db"));
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  let calls = 0;
  const resolutionProvider: RemoteResolutionProvider = async (input) => {
    calls += 1;
    if (calls === 1) throw new Error("temporary resolver failure");
    return await provider({ calls: 0 })(input);
  };
  const resolver = new SourceResolver(config, store, null, resolutionProvider);
  await assert.rejects(resolver.resolve(inputUrl), /temporary resolver failure/u);
  const retried = await resolver.resolve(inputUrl);
  assert.equal(calls, 2);
  assert.equal(retried.cacheHit, false);
  assert(store.getSnapshot(retried.source.sourceRef, retried.source.revision));
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
