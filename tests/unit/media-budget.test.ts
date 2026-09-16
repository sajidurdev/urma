import { putTestSource } from "../support/source-fixture.js";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MediaAcquirer,
  mediaBudgetBytes,
} from "../../src/acquisition/media.js";
import { Singleflight } from "../../src/acquisition/singleflight.js";
import { assertExpectedRemoteBytes } from "../../src/acquisition/remote-budget.js";
import { loadConfig } from "../../src/config.js";
import {
  createInvestigationRef,
  remoteSourceRef,
  youtubeRemoteIdentity,
} from "../../src/core/ids.js";
import type { ResolvedSource } from "../../src/sources/types.js";
import { BlobStore } from "../../src/store/blob-store.js";
import { SqliteStore } from "../../src/store/sqlite-store.js";
import { type ProcessResult, runChecked } from "../../src/subprocess/runner.js";

function result(args: readonly string[]): ProcessResult {
  return {
    executable: "fake-yt-dlp",
    args,
    code: 0,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    wallMs: 1,
  };
}
function source(estimatedBytes: number | null): ResolvedSource {
  const sourceRef = remoteSourceRef(youtubeRemoteIdentity("yP0axVHdP-U"));
  return {
    sourceRef,
    kind: "remote",
    identity: { basis: "extractor", namespace: "youtube", id: "yP0axVHdP-U" },
    snapshotRef: { sourceRef, revision: "v1:test:yP0axVHdP-U" },
    canonicalKey: "yP0axVHdP-U",
    canonicalLocator: "https://www.youtube.com/watch?v=yP0axVHdP-U",
    revision: "v1:test:yP0axVHdP-U",
    observedAt: new Date(0).toISOString(),
    title: "Fixture",
    durationMs: 2_000,
    metadataDurationMs: 2_000,
    timeline: {
      finite: true,
      durationMs: 2_000,
      basis: "container",
      validatedAt: new Date(0).toISOString(),
    },
    extractor: "youtube",
    extractorKey: "yP0axVHdP-U",
    liveState: "finite",
    safeOrigins: ["https://www.youtube.com"],
    resolverVersion: "fixture",
    normalizationVersion: "remote-normalization-v1",
    policyVersion: "fixture",
    chapters: [],
    captionTracks: [],
    formats: [
      {
        id: "hls",
        ext: "mp4",
        protocol: "m3u8_native",
        width: 320,
        height: 144,
        fps: 2,
        videoCodec: "h264",
        audioCodec: "none",
        estimatedBytes,
        rows: null,
        columns: null,
      },
    ],
    capabilities: {
      nativeCaptions: false,
      chapters: false,
      nativeStoryboard: false,
      targetedMedia: true,
      audio: false,
    },
    safeMetadata: {},
  };
}
function progressiveSource(budget: number): ResolvedSource {
  const resolved = source(null);
  return {
    ...resolved,
    formats: [
      {
        id: "p1080",
        ext: "mp4",
        protocol: "https",
        width: 1920,
        height: 1080,
        fps: 30,
        videoCodec: "h264",
        audioCodec: "none",
        estimatedBytes: budget + 1,
        rows: null,
        columns: null,
      },
      {
        id: "p720",
        ext: "mp4",
        protocol: "https",
        width: 1280,
        height: 720,
        fps: 30,
        videoCodec: "h264",
        audioCodec: "none",
        estimatedBytes: budget - 1,
        rows: null,
        columns: null,
      },
    ],
  };
}
async function context(
  t: test.TestContext,
  environment: NodeJS.ProcessEnv = {},
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "urma-budget-"));
  const config = loadConfig({
    URMA_DATA_DIR: path.join(directory, "data"),
    URMA_FFPROBE: "ffprobe",
    URMA_YTDLP: process.execPath,
    ...environment,
  });
  const store = await SqliteStore.open(path.join(config.dataDir, "urma.db"));
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const blobs = new BlobStore(path.join(config.dataDir, "blobs"));
  await blobs.initialize();
  const resolved = source(null);
  const ref = createInvestigationRef("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
  const now = new Date(0).toISOString();
  putTestSource(store, {
    sourceRef: resolved.sourceRef,
    kind: resolved.kind,
    canonicalKey: resolved.canonicalKey,
    revision: resolved.revision,
    title: resolved.title,
    durationMs: resolved.durationMs,
    metadata: {},
  });
  store.createInvestigation({
    investigationRef: ref,
    sourceRef: resolved.sourceRef,
    sourceRevision: resolved.revision,
    durationMs: resolved.durationMs,
    createdAt: now,
    updatedAt: now,
  });
  return { directory, config, store, blobs, ref };
}

test("v0.1 safety budgets retain their permanent default ceilings", () => {
  const limits = loadConfig({}).limits;
  assert.equal(limits.maxTargetedMediaBytes, 64 * 1024 * 1024);
  assert.equal(limits.maxNavigationCopyBytes, 256 * 1024 * 1024);
  assert.equal(limits.maxReusableEvidenceMediaBytes, 512 * 1024 * 1024);
  assert.equal(limits.maxRemoteAcquisitionWallMs, 180_000);
});

test("known-size targeted media is rejected before acquisition and never promotes cache state", async (t) => {
  const ctx = await context(t, { URMA_MAX_TARGETED_MEDIA_BYTES: "1024" });
  let runs = 0;
  const downloader = {
    run: async (args: readonly string[]) => {
      runs += 1;
      return result(args);
    },
  };
  const acquirer = new MediaAcquirer(
    ctx.config,
    ctx.store,
    ctx.blobs,
    downloader,
  );
  await assert.rejects(
    acquirer.section(source(10_000), ctx.ref, 0, 2_000),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "MEDIA_BUDGET_EXCEEDED",
  );
  assert.equal(runs, 0);
  assert.equal(ctx.store.cacheStats().artifacts, 0);
  const acquisitions = ctx.store.listAcquisitions(ctx.ref);
  assert.equal(acquisitions.length, 1);
  assert.equal(acquisitions[0]?.status, "failed");
  assert.equal(acquisitions[0]?.errorCode, "MEDIA_BUDGET_EXCEEDED");
});
test("remote byte ceilings allow exactly-at-limit and reject limit plus one", () => {
  assert.doesNotThrow(() => assertExpectedRemoteBytes(1024, 1024, "fixture"));
  assert.throws(
    () => assertExpectedRemoteBytes(1025, 1024, "fixture"),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "MEDIA_BUDGET_EXCEEDED",
  );
});

test("unknown-size overflow aborts the process tree, cleans temp output, and gives singleflight observers one failure", async (t) => {
  const ctx = await context(t, {
    URMA_MAX_TARGETED_MEDIA_BYTES: "4096",
    URMA_MAX_REMOTE_ACQUISITION_WALL_MS: "10000",
  });
  const marker = path.join(ctx.directory, "descendant.pid");
  let runs = 0;
  let descendant = 0;
  t.after(() => {
    if (descendant > 0) {
      try {
        process.kill(descendant, "SIGKILL");
      } catch {}
    }
  });
  const code =
    "const{spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(process.argv[2],String(child.pid));const out=fs.createWriteStream(process.argv[1]);const chunk=Buffer.alloc(65536);setInterval(()=>out.write(chunk),5);";
  const downloader = {
    run: async (args: readonly string[], options: { signal?: AbortSignal }) => {
      runs += 1;
      const index = args.indexOf("--paths");
      const directory = String(args[index + 1]);
      return await runChecked(
        process.execPath,
        ["-e", code, path.join(directory, "media.part"), marker],
        { signal: options.signal, timeoutMs: 10_000 },
      );
    },
  };
  const acquirer = new MediaAcquirer(
    ctx.config,
    ctx.store,
    ctx.blobs,
    downloader,
  );
  const flight = new Singleflight();
  const acquire = () =>
    flight.run(
      "overflow",
      undefined,
      (signal) => acquirer.section(source(null), ctx.ref, 0, 2_000, signal),
    );
  const [first, second] = await Promise.allSettled([acquire(), acquire()]);
  for (const observed of [first, second]) {
    assert.equal(observed.status, "rejected");
    assert.equal(
      (observed as PromiseRejectedResult).reason.code,
      "MEDIA_BUDGET_EXCEEDED",
    );
  }
  assert.equal(runs, 1);
  assert.equal(flight.size, 0);
  assert.equal(ctx.store.cacheStats().artifacts, 0);
  assert.equal(
    ctx.store.listAcquisitions(ctx.ref)[0]?.errorCode,
    "MEDIA_BUDGET_EXCEEDED",
  );
  assert.deepEqual(await readdir(path.join(ctx.config.dataDir, "tmp")), []);
  for (let attempt = 0; attempt < 50; attempt++) {
    const raw = await readFile(marker, "utf8").catch(() => "");
    descendant = Number(raw);
    if (Number.isInteger(descendant) && descendant > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert(descendant > 0, "descendant PID marker was not written");
  const alive = () => {
    try {
      process.kill(descendant, 0);
      return true;
    } catch {
      return false;
    }
  };
  for (let attempt = 0; attempt < 100 && alive(); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(
    alive(),
    false,
    "remote acquisition descendant survived byte-budget termination",
  );
});

test("ordinary bounded section succeeds below the byte ceiling", async (t) => {
  const ctx = await context(t, {
    URMA_MAX_TARGETED_MEDIA_BYTES: String(4 * 1024 * 1024),
  });
  const video = path.join(ctx.directory, "bounded.mp4");
  await runChecked(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=320x180:d=2:r=2",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-y",
      video,
    ],
    { timeoutMs: 30_000 },
  );
  const downloader = {
    run: async (args: readonly string[]) => {
      const index = args.indexOf("--paths");
      await copyFile(video, path.join(String(args[index + 1]), "media.mp4"));
      return result(args);
    },
  };
  const acquired = await new MediaAcquirer(
    ctx.config,
    ctx.store,
    ctx.blobs,
    downloader,
  ).section(source(null), ctx.ref, 0, 2_000);
  assert.equal(acquired.artifact.kind, "media_section");
  assert.equal(acquired.cacheHit, false);
  assert.equal(ctx.store.cacheStats().artifacts, 1);
  await ctx.blobs.verify(
    acquired.artifact.artifactId,
    acquired.artifact.blobPath,
  );
});

test("navigation-copy and reusable-evidence budgets are independently enforced", async (t) => {
  const ctx = await context(t, {
    URMA_MAX_TARGETED_MEDIA_BYTES: "3000",
    URMA_MAX_NAVIGATION_COPY_BYTES: "1000",
    URMA_MAX_REUSABLE_EVIDENCE_MEDIA_BYTES: "2000",
  });
  assert.equal(mediaBudgetBytes(ctx.config, "media_section"), 3000);
  assert.equal(mediaBudgetBytes(ctx.config, "navigation_media"), 1000);
  assert.equal(mediaBudgetBytes(ctx.config, "evidence_media"), 2000);
  const downloader = { run: async (args: readonly string[]) => result(args) };
  const acquirer = new MediaAcquirer(
    ctx.config,
    ctx.store,
    ctx.blobs,
    downloader,
  );
  await assert.rejects(
    acquirer.navigation(source(1500), ctx.ref),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "MEDIA_BUDGET_EXCEEDED",
  );
  await assert.rejects(
    acquirer.reusableEvidence(source(2500), ctx.ref),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "MEDIA_BUDGET_EXCEEDED",
  );
  assert.equal(ctx.store.cacheStats().artifacts, 0);
});

test("reusable evidence selects the highest-fidelity progressive format that fits its byte budget", async (t) => {
  const budget = 1024 * 1024;
  const ctx = await context(t, {
    URMA_MAX_REUSABLE_EVIDENCE_MEDIA_BYTES: String(budget),
  });
  const video = path.join(ctx.directory, "reusable.mp4");
  await runChecked(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=320x180:d=2:r=2",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-y",
      video,
    ],
    { timeoutMs: 30_000 },
  );
  let runs = 0;
  const downloader = {
    run: async (args: readonly string[]) => {
      runs += 1;
      const formatIndex = args.indexOf("-f");
      assert.equal(args[formatIndex + 1], "p720");
      const pathsIndex = args.indexOf("--paths");
      await copyFile(
        video,
        path.join(String(args[pathsIndex + 1]), "media.mp4"),
      );
      return result(args);
    },
  };
  const acquired = await new MediaAcquirer(
    ctx.config,
    ctx.store,
    ctx.blobs,
    downloader,
  ).reusableEvidence(progressiveSource(budget), ctx.ref);
  assert.equal(runs, 1);
  assert.equal(acquired.artifact.kind, "evidence_media");
  assert.equal(acquired.artifact.producer.formatId, "p720");
});
