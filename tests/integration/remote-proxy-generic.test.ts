import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { connect } from "node:net";
import { loadConfig } from "../../src/config.js";
import { SafeProxy } from "../../src/remote/egress.js";
import { Ffmpeg } from "../../src/subprocess/ffmpeg.js";
import { Ffprobe } from "../../src/subprocess/ffprobe.js";
import { SourceResolver } from "../../src/sources/resolver.js";
import { SqliteStore } from "../../src/store/sqlite-store.js";

async function listenFixture(bytes: Buffer): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
  const server = createServer((request, response) => {
    if (request.url === "/redirect.mp4") {
      response.writeHead(302, { location: "http://public.example.test/video.mp4" });
      response.end();
      return;
    }
    if (request.url !== "/video.mp4") {
      response.writeHead(404);
      response.end();
      return;
    }
    const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/u);
    const start = range ? Number(range[1]) : 0;
    const requestedEnd = range?.[2] ? Number(range[2]) : bytes.length - 1;
    const end = Math.min(bytes.length - 1, requestedEnd);
    if (!Number.isSafeInteger(start) || start < 0 || start > end || end >= bytes.length) {
      response.writeHead(416);
      response.end();
      return;
    }
    const body = bytes.subarray(start, end + 1);
    response.writeHead(range ? 206 : 200, {
      "accept-ranges": "bytes",
      "content-length": body.length,
      "content-type": "video/mp4",
      ...(range ? { "content-range": `bytes ${start}-${end}/${bytes.length}` } : {}),
    });
    if (request.method !== "HEAD") response.end(body);
    else response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  return { server, port: address.port };
}

test("generic direct MP4 resolution uses the local Safe Proxy end to end", async (t) => {
  const bytes = await readFile(path.resolve("tests/fixtures/opaque-case-j.mp4"));
  const fixture = await listenFixture(bytes);
  const proxy = new SafeProxy({
    lookup: async (hostname) => {
      assert.equal(hostname, "public.example.test");
      return [{ address: "93.184.216.34", family: 4 }];
    },
    dial: (address, _port, family) => {
      assert.equal(address, "93.184.216.34");
      return connect({ host: "127.0.0.1", port: fixture.port, family });
    },
  });
  const directory = await mkdtemp(path.join(os.tmpdir(), "urma-proxy-e2e-"));
  const config = loadConfig({ URMA_DATA_DIR: path.join(directory, "data") });
  const store = await SqliteStore.open(path.join(config.dataDir, "urma.db"));
  t.after(() => store.close());
  t.after(() => proxy.close());
  t.after(() => fixture.server.close());
  t.after(() => rm(directory, { recursive: true, force: true }));

  const resolver = new SourceResolver(config, store, { safeProxy: proxy });
  const result = await resolver.resolve("http://public.example.test/video.mp4");
  assert.equal(result.cacheHit, false);
  assert.equal(result.source.kind, "remote");
  assert.equal(result.source.remoteAcquisition, "safe-proxy");
  assert.match(result.source.sourceRef, /^urma:source:remote:v1:[0-9a-f]{64}$/u);
  assert.equal(result.source.timeline.finite, true);
  assert.equal(result.source.durationMs > 0, true);
  assert.equal(result.source.timeline.basis, "progressive");
  assert.equal(proxy.logs.length > 0, true);
  assert.equal(proxy.logs.every((entry) => entry.address === "93.184.216.34"), true);
  assert.equal(proxy.logs.every((entry) => entry.outcome === "connected"), true);

  const redirected = await resolver.resolve("http://public.example.test/redirect.mp4");
  assert.equal(redirected.source.kind, "remote");
  assert.equal(redirected.source.timeline.finite, true);
  assert.equal(redirected.source.durationMs > 0, true);
  assert.equal(
    proxy.logs.some((entry) => entry.origin === "http://public.example.test"),
    true,
  );
});

test("remote ffprobe and ffmpeg use the same Safe Proxy and restrictive profile", async (t) => {
  const bytes = await readFile(path.resolve("tests/fixtures/opaque-case-j.mp4"));
  const fixture = await listenFixture(bytes);
  const directory = await mkdtemp(path.join(os.tmpdir(), "urma-proxy-media-"));
  const config = loadConfig({ URMA_DATA_DIR: path.join(directory, "data") });
  const proxy = new SafeProxy({
    lookup: async (hostname) => {
      assert.equal(hostname, "public.example.test");
      return [{ address: "93.184.216.34", family: 4 }];
    },
    dial: (address, _port, family) => {
      assert.equal(address, "93.184.216.34");
      return connect({ host: "127.0.0.1", port: fixture.port, family });
    },
  });
  t.after(() => proxy.close());
  t.after(() => fixture.server.close());
  t.after(() => rm(directory, { recursive: true, force: true }));

  const context = { safeProxy: proxy } as const;
  const input = "http://public.example.test/video.mp4";
  const probe = await new Ffprobe(config, context).inspect(input);
  assert(
    Array.isArray(probe.streams) &&
      (probe.streams as Array<Record<string, unknown>>).some((stream) => stream.codec_type === "video"),
  );
  const output = path.join(directory, "frame.jpg");
  await new Ffmpeg(config, context).extractJpeg(input, 100, output);
  const jpeg = await readFile(output);
  assert.equal(jpeg[0], 0xff);
  assert.equal(jpeg[1], 0xd8);
  assert.equal(proxy.logs.length > 0, true);
  assert.equal(proxy.logs.every((entry) => entry.address === "93.184.216.34"), true);
  assert.equal(proxy.logs.every((entry) => entry.outcome === "connected"), true);
});
