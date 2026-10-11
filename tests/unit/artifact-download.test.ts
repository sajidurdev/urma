import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { downloadAndVerifyArtifact, type ArtifactFetch, type DownloadOptions } from "../../src/distribution/download.js";
import { RELEASE_MANIFESTS } from "../../src/distribution/manifest.js";
import { UrmaError } from "../../src/core/errors.js";

const payload = Buffer.from("pinned artifact fixture");
const artifact = {
  ...RELEASE_MANIFESTS["macos-x64"].ffprobe,
  url: "https://fixtures.invalid/pinned/ffprobe.zip",
  archiveBytes: payload.length,
  archiveSha256: createHash("sha256").update(payload).digest("hex"),
};

async function prepareDownload(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "urma-download-retry-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
  t.mock.method(Math, "random", () => 0);
  return path.join(root, "artifact.zip");
}

function startDownload(destination: string, fetchImpl: ArtifactFetch, options: DownloadOptions = {}) {
  const firstRequest = Promise.withResolvers<void>();
  const result = downloadAndVerifyArtifact(artifact, destination, {
    ...options,
    fetchImpl: async (...args) => {
      firstRequest.resolve();
      return await fetchImpl(...args);
    },
  });
  void result.catch(() => undefined);
  return { result, started: firstRequest.promise.then(async () => await setImmediate()) };
}

async function advanceTime(t: TestContext, milliseconds: number): Promise<void> {
  t.mock.timers.tick(milliseconds);
  await setImmediate();
}

test("artifact download recovers from HTTP 429 without retrying before Retry-After", async (t) => {
  const destination = await prepareDownload(t);
  const requestedAt: number[] = [];
  let cancelled = false;
  const download = startDownload(destination, async () => {
    requestedAt.push(Date.now());
    if (requestedAt.length === 1) {
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
        status: 429,
        headers: { "retry-after": "5" },
      });
    }
    return new Response(payload);
  });
  await download.started;
  await advanceTime(t, 4_999);
  assert.equal(requestedAt.length, 1);
  await advanceTime(t, 1);
  await download.result;
  assert.equal(requestedAt[1]! - requestedAt[0]!, 5_000);
  assert.equal(cancelled, true);
  assert.deepEqual(await readFile(destination), payload);
});

test("artifact download honors an HTTP-date Retry-After and adds jitter", async (t) => {
  const destination = await prepareDownload(t);
  t.mock.method(Math, "random", () => 0.5);
  const retryAt = new Date(Date.now() + 5_000).toUTCString();
  const requestedAt: number[] = [];
  const download = startDownload(destination, async () => {
    requestedAt.push(Date.now());
    return requestedAt.length === 1
      ? new Response("busy", { status: 503, headers: { "retry-after": retryAt } })
      : new Response(payload);
  });
  await download.started;
  await advanceTime(t, 5_124);
  assert.equal(requestedAt.length, 1);
  await advanceTime(t, 1);
  await download.result;
  assert.equal(requestedAt[1]! - requestedAt[0]!, 5_125);
  assert.deepEqual(await readFile(destination), payload);
});

test("artifact download backs off exponentially for temporary gateway failures", async (t) => {
  const destination = await prepareDownload(t);
  t.mock.method(Math, "random", () => 0.5);
  const statuses = [502, 503, 504, 200];
  const requestedAt: number[] = [];
  const download = startDownload(destination, async () => {
    const status = statuses[requestedAt.length]!;
    requestedAt.push(Date.now());
    return new Response(status === 200 ? payload : Buffer.from("busy"), { status });
  });
  await download.started;
  for (const [index, delayMs] of [1_125, 2_250, 4_500].entries()) {
    await advanceTime(t, delayMs - 1);
    assert.equal(requestedAt.length, index + 1);
    await advanceTime(t, 1);
    assert.equal(requestedAt.length, index + 2);
    assert.equal(requestedAt[index + 1]! - requestedAt[index]!, delayMs);
  }
  await download.result;
  assert.deepEqual(await readFile(destination), payload);
});

test("rate-limited artifact downloads wait thirty seconds when Retry-After is unusable", async (t) => {
  for (const value of [undefined, "invalid", "-1", "1.5", "0", "Wed, 01 Jan 2020 00:00:00 GMT"]) {
    await t.test(String(value), async (t) => {
      const destination = await prepareDownload(t);
      let requests = 0;
      const download = startDownload(destination, async () => {
        requests += 1;
        return requests === 1
          ? new Response("busy", { status: 429, headers: value === undefined ? {} : { "retry-after": value } })
          : new Response(payload);
      });
      await download.started;
      await advanceTime(t, 29_999);
      assert.equal(requests, 1);
      await advanceTime(t, 1);
      await download.result;
      assert.equal(requests, 2);
    });
  }
});

test("artifact download stops after four rate-limited attempts and removes the partial file", async (t) => {
  const destination = await prepareDownload(t);
  let requests = 0;
  let cancelled = 0;
  const download = startDownload(destination, async () => {
    requests += 1;
    return new Response(new ReadableStream({ cancel() { cancelled += 1; } }), { status: 429 });
  });
  await download.started;
  for (const delayMs of [30_000, 60_000, 120_000]) await advanceTime(t, delayMs);
  await assert.rejects(download.result, (error: unknown) => {
    assert(error instanceof UrmaError);
    assert.equal(error.code, "ARTIFACT_DOWNLOAD_FAILED");
    assert.match(error.message, /HTTP 429.*4 attempt/u);
    return true;
  });
  assert.equal(requests, 4);
  assert.equal(cancelled, 4);
  await assert.rejects(access(destination), { code: "ENOENT" });
  await advanceTime(t, 10 * 60_000);
  assert.equal(requests, 4);
});

test("rate-limited artifact downloads recover after a longer cooldown with jitter", async (t) => {
  const destination = await prepareDownload(t);
  t.mock.method(Math, "random", () => 0.5);
  const startedAt = Date.now();
  const requestedAt: number[] = [];
  const download = startDownload(destination, async () => {
    requestedAt.push(Date.now());
    return Date.now() - startedAt < 60_000
      ? new Response("rate limited", { status: 429 })
      : new Response(payload);
  });
  await download.started;
  for (const [index, delayMs] of [33_750, 67_500].entries()) {
    await advanceTime(t, delayMs - 1);
    assert.equal(requestedAt.length, index + 1);
    await advanceTime(t, 1);
    assert.equal(requestedAt.length, index + 2);
  }
  await download.result;
  assert.deepEqual(await readFile(destination), payload);
});

test("artifact failure diagnostics identify the mirror and rate-limit headers without URL credentials", async (t) => {
  const destination = await prepareDownload(t);
  const response = new Response("busy", { status: 429, headers: {
    "retry-after": "3600", "ratelimit-reset": "3600", "x-ratelimit-reset": "1800003600",
  } });
  Object.defineProperty(response, "url", {
    value: "https://name:password@mirror.invalid:4242/pub/ffprobe.zip?token=secret#private",
  });
  await assert.rejects(startDownload(destination, async () => response).result, (error: unknown) => {
    assert(error instanceof UrmaError);
    assert.match(error.message, /response origin=https:\/\/mirror\.invalid:4242/u);
    assert.match(error.message, /retry-after="3600"/u);
    assert.match(error.message, /ratelimit-reset="3600"/u);
    assert.match(error.message, /x-ratelimit-reset="1800003600"/u);
    assert.doesNotMatch(error.message, /name:password|token=secret|#private/u);
    return true;
  });
  await assert.rejects(access(destination), { code: "ENOENT" });
});

test("artifact download cancels backoff when the overall download deadline expires", async (t) => {
  const destination = await prepareDownload(t);
  const response = Promise.withResolvers<Response>();
  let requests = 0;
  let signal: AbortSignal | undefined;
  const download = startDownload(destination, async (_url, init) => {
    requests += 1;
    signal = init?.signal ?? undefined;
    return await response.promise;
  }, { timeoutMs: 2_000 });
  await download.started;
  await advanceTime(t, 1_500);
  response.resolve(new Response("busy", { status: 503 }));
  await setImmediate();
  await advanceTime(t, 500);
  await assert.rejects(download.result, (error: unknown) => error instanceof UrmaError && error.code === "ARTIFACT_DOWNLOAD_FAILED");
  assert.equal(signal?.aborted, true);
  await assert.rejects(access(destination), { code: "ENOENT" });
  await advanceTime(t, 10_000);
  assert.equal(requests, 1);
});

test("artifact download refuses a Retry-After that exceeds its time budget", async (t) => {
  for (const value of ["3600", "9".repeat(400), "Thu, 01 Jan 2099 00:00:00 GMT"]) {
    await t.test(value.slice(0, 40), async (t) => {
      const destination = await prepareDownload(t);
      let requests = 0;
      const download = startDownload(destination, async () => {
        requests += 1;
        return new Response("busy", { status: 429, headers: { "retry-after": value } });
      });
      await assert.rejects(download.result, /retry delay exceeds the remaining download timeout/u);
      assert.equal(requests, 1);
      await assert.rejects(access(destination), { code: "ENOENT" });
    });
  }
});

test("artifact download does not retry permanent HTTP or integrity failures", async (t) => {
  const cases = [
    { name: "HTTP 403", response: () => new Response("forbidden", { status: 403 }), code: "ARTIFACT_DOWNLOAD_FAILED" },
    { name: "HTTP 404", response: () => new Response("missing", { status: 404 }), code: "ARTIFACT_DOWNLOAD_FAILED" },
    { name: "HTTP 500", response: () => new Response("error", { status: 500 }), code: "ARTIFACT_DOWNLOAD_FAILED" },
    { name: "pinned size mismatch", response: () => new Response(payload, { headers: { "content-length": "1" } }), code: "ARTIFACT_DOWNLOAD_FAILED" },
    { name: "pinned hash mismatch", response: () => new Response(Buffer.alloc(payload.length)), code: "ARTIFACT_HASH_MISMATCH" },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async (t) => {
      const destination = await prepareDownload(t);
      let requests = 0;
      const download = startDownload(destination, async () => {
        requests += 1;
        return scenario.response();
      });
      await assert.rejects(download.result, (error: unknown) => error instanceof UrmaError && error.code === scenario.code);
      await advanceTime(t, 10 * 60_000);
      assert.equal(requests, 1);
      await assert.rejects(access(destination), { code: "ENOENT" });
    });
  }
});
