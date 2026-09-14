import { putTestSource } from "../support/source-fixture.js";
import assert from "node:assert/strict";
import {
  appendFile,
  copyFile,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  groupCompatibleSectionRequirements,
  MediaAcquirer,
  type SectionAcquisitionOutcome,
  type SectionBatchRequirement,
} from "../../src/acquisition/media.js";
import { FrameAcquirer } from "../../src/acquisition/frames.js";
import { loadConfig } from "../../src/config.js";
import {
  createInvestigationRef,
  remoteSourceRef,
  youtubeRemoteIdentity,
} from "../../src/core/ids.js";
import { EvidenceService } from "../../src/evidence/service.js";
import type { ResolvedSource } from "../../src/sources/types.js";
import { BlobStore } from "../../src/store/blob-store.js";
import { SqliteStore } from "../../src/store/sqlite-store.js";
import { type ProcessResult, runChecked } from "../../src/subprocess/runner.js";

const SECTION_PREFIX = "URMA_SECTION\t";

function source(videoId = "yP0axVHdP-U", formatId = "hls"): ResolvedSource {
  const sourceRef = remoteSourceRef(youtubeRemoteIdentity(videoId));
  return {
    sourceRef,
    kind: "remote",
    identity: { basis: "extractor", namespace: "youtube", id: videoId },
    snapshotRef: { sourceRef, revision: `v1:test:${videoId}` },
    canonicalKey: videoId,
    canonicalLocator: `https://www.youtube.com/watch?v=${videoId}`,
    revision: `v1:test:${videoId}`,
    observedAt: new Date(0).toISOString(),
    title: "Batch fixture",
    durationMs: 120_000,
    metadataDurationMs: 120_000,
    timeline: {
      finite: true,
      durationMs: 120_000,
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
    captionTracks: [],
    formats: [
      {
        id: formatId,
        ext: "mp4",
        protocol: "m3u8_native",
        width: 320,
        height: 180,
        fps: 2,
        videoCodec: "h264",
        audioCodec: "none",
        estimatedBytes: null,
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

function processResult(
  args: readonly string[],
  stdout = "",
  code = 0,
): ProcessResult {
  return {
    executable: "fake-yt-dlp",
    args,
    code,
    stdout: Buffer.from(stdout),
    stderr: Buffer.alloc(0),
    wallMs: 1,
  };
}

function rangeArguments(
  args: readonly string[],
): Array<{ startMs: number; endMs: number }> {
  const ranges: Array<{ startMs: number; endMs: number }> = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--download-sections") continue;
    const match = /^\*([0-9]+(?:\.[0-9]+)?)-([0-9]+(?:\.[0-9]+)?)$/u.exec(
      String(args[index + 1]),
    );
    assert(match, `invalid section argument ${String(args[index + 1])}`);
    ranges.push({
      startMs: Math.round(Number(match[1]) * 1_000),
      endMs: Math.round(Number(match[2]) * 1_000),
    });
  }
  return ranges;
}

function emission(startMs: number, endMs: number, filepath: string): string {
  return `${SECTION_PREFIX}${JSON.stringify(startMs / 1_000)}\t${
    JSON.stringify(endMs / 1_000)
  }\t${JSON.stringify(filepath)}`;
}

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "urma-media-batch-"));
  const debugFile = path.join(directory, "debug.jsonl");
  const config = loadConfig({
    URMA_DATA_DIR: path.join(directory, "data"),
    URMA_FFPROBE: "ffprobe",
    URMA_YTDLP: "fake-yt-dlp",
    URMA_DEBUG: "0",
  });
  const store = await SqliteStore.open(path.join(config.dataDir, "urma.db"));
  const blobs = new BlobStore(path.join(config.dataDir, "blobs"));
  await blobs.initialize();
  const ref = createInvestigationRef("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
  const resolved = source();
  const now = new Date(0).toISOString();
  putTestSource(store, {
    sourceRef: resolved.sourceRef,
    kind: resolved.kind,
    canonicalKey: resolved.canonicalKey,
    revision: resolved.revision,
    title: resolved.title,
    durationMs: resolved.durationMs,
    metadata: {
      canonicalLocator: resolved.canonicalLocator,
      chapters: resolved.chapters,
      captionTracks: resolved.captionTracks,
      formats: resolved.formats,
      capabilities: resolved.capabilities,
      safeMetadata: resolved.safeMetadata,
    },
  });
  store.createInvestigation({
    investigationRef: ref,
    sourceRef: resolved.sourceRef,
    sourceRevision: resolved.revision,
    durationMs: resolved.durationMs,
    createdAt: now,
    updatedAt: now,
  });
  const video = path.join(directory, "valid.mp4");
  await runChecked(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=320x180:rate=2:duration=5",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-y",
      video,
    ],
    { timeoutMs: 30_000 },
  );
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, debugFile, config, store, blobs, ref, resolved, video };
}

function requirements(
  resolved: ResolvedSource,
  investigationRef: ReturnType<typeof createInvestigationRef>,
  count: number,
): SectionBatchRequirement[] {
  return Array.from({ length: count }, (_, index) => ({
    source: resolved,
    investigationRef,
    startMs: 1_000 + index * 5_000,
    endMs: 5_001 + index * 5_000,
  }));
}

test("compatibility grouping is stable and separates source or format policy", () => {
  const config = loadConfig({ URMA_YTDLP: "yt-dlp" });
  const ref = createInvestigationRef("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
  const first = source("yP0axVHdP-U", "hls-a");
  const second = source("9OxIBSzfcBw", "hls-a");
  const changedPolicy = source("yP0axVHdP-U", "hls-b");
  const input: SectionBatchRequirement[] = [
    { source: first, investigationRef: ref, startMs: 10_000, endMs: 14_001 },
    { source: first, investigationRef: ref, startMs: 20_000, endMs: 24_001 },
    { source: second, investigationRef: ref, startMs: 30_000, endMs: 34_001 },
    {
      source: changedPolicy,
      investigationRef: ref,
      startMs: 40_000,
      endMs: 44_001,
    },
  ];
  assert.deepEqual(
    groupCompatibleSectionRequirements(config, input).map(
      (group) => group.length,
    ),
    [2, 1, 1],
  );
});

for (const count of [4, 8, 12]) {
  test(`constructs one exact multi-section invocation for ${count} requirements`, async (t) => {
    const ctx = await fixture(t);
    const requested = requirements(ctx.resolved, ctx.ref, count);
    const calls: readonly string[][] = [];
    const mutableCalls = calls as string[][];
    const downloader = {
      run: async (args: readonly string[]) => {
        mutableCalls.push([...args]);
        const outputDirectory = String(args[args.indexOf("--paths") + 1]);
        const lines: string[] = [];
        for (const range of [...rangeArguments(args)].reverse()) {
          const filename = `media-${(range.startMs / 1_000).toFixed(3)}-${
            (range.endMs / 1_000).toFixed(3)
          }.mp4`;
          const filepath = path.join(outputDirectory, filename);
          await copyFile(ctx.video, filepath);
          lines.push(emission(range.startMs, range.endMs, filepath));
        }
        return processResult(args, `${lines.join("\n")}\n`);
      },
    };
    const outcomes = await new MediaAcquirer(
      ctx.config,
      ctx.store,
      ctx.blobs,
      downloader,
    ).sections(requested);
    assert(outcomes.every((outcome) => outcome.status === "fulfilled"));
    assert.equal(mutableCalls.length, 1);
    assert.deepEqual(
      rangeArguments(mutableCalls[0]!),
      requested.map(({ startMs, endMs }) => ({ startMs, endMs })),
    );
    assert.deepEqual(
      outcomes.map((outcome) => outcome.requirement.startMs),
      requested.map((item) => item.startMs),
    );
  });
}

test("one section keeps the existing single-section path and exact interval", async (t) => {
  const ctx = await fixture(t);
  const requested = requirements(ctx.resolved, ctx.ref, 1);
  const calls: string[][] = [];
  const downloader = {
    run: async (args: readonly string[]) => {
      calls.push([...args]);
      const outputDirectory = String(args[args.indexOf("--paths") + 1]);
      await copyFile(ctx.video, path.join(outputDirectory, "media.mp4"));
      return processResult(args);
    },
  };
  const [outcome] = await new MediaAcquirer(
    ctx.config,
    ctx.store,
    ctx.blobs,
    downloader,
  ).sections(requested);
  assert.equal(outcome?.status, "fulfilled");
  assert.equal(calls.length, 1);
  assert.deepEqual(rangeArguments(calls[0]!), [
    { startMs: requested[0]!.startMs, endMs: requested[0]!.endMs },
  ]);
  assert.equal(calls[0]!.includes("--print"), false);
});

test("duplicate exact requirements are acquired once and returned in request order", async (t) => {
  const ctx = await fixture(t);
  const base = requirements(ctx.resolved, ctx.ref, 2);
  const requested = [base[1]!, base[0]!, base[1]!];
  let calls = 0;
  const downloader = {
    run: async (args: readonly string[]) => {
      calls += 1;
      const outputDirectory = String(args[args.indexOf("--paths") + 1]);
      const lines: string[] = [];
      for (const range of rangeArguments(args)) {
        const filepath = path.join(
          outputDirectory,
          `media-${(range.startMs / 1_000).toFixed(3)}-${
            (range.endMs / 1_000).toFixed(3)
          }.mp4`,
        );
        await copyFile(ctx.video, filepath);
        lines.push(emission(range.startMs, range.endMs, filepath));
      }
      return processResult(args, `${lines.join("\n")}\n`);
    },
  };
  const outcomes = await new MediaAcquirer(
    ctx.config,
    ctx.store,
    ctx.blobs,
    downloader,
  ).sections(requested);
  assert.equal(calls, 1);
  assert.deepEqual(
    outcomes.map((outcome) => outcome.requirement.startMs),
    requested.map((item) => item.startMs),
  );
  assert.equal(outcomes[0]?.status, "fulfilled");
  assert.equal(outcomes[2]?.status, "fulfilled");
  if (
    outcomes[0]?.status === "fulfilled" &&
    outcomes[2]?.status === "fulfilled"
  ) {
    assert.equal(
      outcomes[0].value.artifact.artifactId,
      outcomes[2].value.artifact.artifactId,
    );
  }
});

test("exit zero with one invalid mismapped artifact preserves valid neighbors and falls back only once", async (t) => {
  const ctx = await fixture(t);
  const requested = requirements(ctx.resolved, ctx.ref, 3);
  const calls: string[][] = [];
  const downloader = {
    run: async (args: readonly string[]) => {
      calls.push([...args]);
      const outputDirectory = String(args[args.indexOf("--paths") + 1]);
      const ranges = rangeArguments(args);
      if (ranges.length === 1) {
        await copyFile(ctx.video, path.join(outputDirectory, "media.mp4"));
        return processResult(args);
      }
      const lines: string[] = [];
      for (const [index, range] of ranges.entries()) {
        if (index === 1) {
          const wrongEndMs = range.endMs + 9_000;
          const filepath = path.join(
            outputDirectory,
            `media-${(range.startMs / 1_000).toFixed(3)}-${
              (wrongEndMs / 1_000).toFixed(3)
            }.mp4`,
          );
          await writeFile(filepath, Buffer.alloc(262));
          lines.push(emission(range.startMs, wrongEndMs, filepath));
        } else {
          const filepath = path.join(
            outputDirectory,
            `media-${(range.startMs / 1_000).toFixed(3)}-${
              (range.endMs / 1_000).toFixed(3)
            }.mp4`,
          );
          await copyFile(ctx.video, filepath);
          lines.push(emission(range.startMs, range.endMs, filepath));
        }
      }
      return processResult(args, `${lines.reverse().join("\n")}\n`, 0);
    },
  };
  const outcomes = await new MediaAcquirer(
    ctx.config,
    ctx.store,
    ctx.blobs,
    downloader,
  ).sections(requested);
  assert(outcomes.every((outcome) => outcome.status === "fulfilled"));
  assert.equal(calls.length, 2);
  assert.equal(rangeArguments(calls[0]!).length, 3);
  assert.deepEqual(rangeArguments(calls[1]!), [
    { startMs: requested[1]!.startMs, endMs: requested[1]!.endMs },
  ]);
  const acquisitions = ctx.store.listAcquisitions(ctx.ref);
  assert.equal(
    acquisitions.filter((item) => item.status === "succeeded").length,
    3,
  );
  assert.equal(
    acquisitions.filter((item) => item.status === "failed").length,
    1,
  );
});

test("partial batch failure retries only unresolved sections and preserves valid siblings", async (t) => {
  const ctx = await fixture(t);
  const requested = requirements(ctx.resolved, ctx.ref, 4);
  const calls: string[][] = [];
  const downloader = {
    run: async (args: readonly string[]) => {
      calls.push([...args]);
      const outputDirectory = String(args[args.indexOf("--paths") + 1]);
      const ranges = rangeArguments(args);
      if (ranges.length === 1) {
        await copyFile(ctx.video, path.join(outputDirectory, "media.mp4"));
        return processResult(args);
      }
      const lines: string[] = [];
      for (const index of [3, 1, 0]) {
        const range = ranges[index]!;
        const filepath = path.join(
          outputDirectory,
          `media-${(range.startMs / 1_000).toFixed(3)}-${
            (range.endMs / 1_000).toFixed(3)
          }.mp4`,
        );
        if (index === 1) await writeFile(filepath, "not media");
        else await copyFile(ctx.video, filepath);
        lines.push(emission(range.startMs, range.endMs, filepath));
      }
      return processResult(args, `${lines.join("\n")}\n`);
    },
  };
  const outcomes = await new MediaAcquirer(
    ctx.config,
    ctx.store,
    ctx.blobs,
    downloader,
  ).sections(requested);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 3);
  assert.equal(outcomes[1]?.status, "rejected");
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.slice(1).map((args) => rangeArguments(args)[0]),
    [{ startMs: requested[2]!.startMs, endMs: requested[2]!.endMs }],
  );
  assert.equal(
    calls
      .slice(1)
      .some(
        (args) => rangeArguments(args)[0]?.startMs === requested[0]!.startMs,
      ),
    false,
  );
  assert.equal(
    calls
      .slice(1)
      .some(
        (args) => rangeArguments(args)[0]?.startMs === requested[3]!.startMs,
      ),
    false,
  );
});

test("mismatched section starts and ends are independently unmapped and never accepted by position", async (t) => {
  const ctx = await fixture(t);
  const requested = requirements(ctx.resolved, ctx.ref, 3);
  const calls: string[][] = [];
  const downloader = {
    run: async (args: readonly string[]) => {
      calls.push([...args]);
      const outputDirectory = String(args[args.indexOf("--paths") + 1]);
      const ranges = rangeArguments(args);
      if (ranges.length === 1) {
        await copyFile(ctx.video, path.join(outputDirectory, "media.mp4"));
        return processResult(args);
      }
      const actual = [
        { startMs: ranges[0]!.startMs + 9_000, endMs: ranges[0]!.endMs },
        ranges[1]!,
        { startMs: ranges[2]!.startMs, endMs: ranges[2]!.endMs + 9_000 },
      ];
      const lines: string[] = [];
      for (const range of actual.reverse()) {
        const filepath = path.join(
          outputDirectory,
          `media-${(range.startMs / 1_000).toFixed(3)}-${
            (range.endMs / 1_000).toFixed(3)
          }.mp4`,
        );
        await copyFile(ctx.video, filepath);
        lines.push(emission(range.startMs, range.endMs, filepath));
      }
      return processResult(args, `${lines.join("\n")}\n`);
    },
  };
  const outcomes = await new MediaAcquirer(
    ctx.config,
    ctx.store,
    ctx.blobs,
    downloader,
  ).sections(requested);
  assert(outcomes.every((outcome) => outcome.status === "fulfilled"));
  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.slice(1).map((args) => rangeArguments(args)[0]?.startMs),
    [requested[0]!.startMs, requested[2]!.startMs],
  );
});

test("a per-section byte-ceiling breach cannot hide inside the larger batch directory budget", async (t) => {
  const ctx = await fixture(t);
  const config = loadConfig({
    ...process.env,
    URMA_DATA_DIR: ctx.config.dataDir,
    URMA_FFPROBE: "ffprobe",
    URMA_YTDLP: "fake-yt-dlp",
    URMA_MAX_TARGETED_MEDIA_BYTES: "4096",
  });
  let calls = 0;
  const downloader = {
    run: async (args: readonly string[]) => {
      calls += 1;
      const outputDirectory = String(args[args.indexOf("--paths") + 1]);
      const ranges = rangeArguments(args);
      await writeFile(
        path.join(
          outputDirectory,
          `media-${(ranges[0]!.startMs / 1_000).toFixed(3)}-${
            (ranges[0]!.endMs / 1_000).toFixed(3)
          }.mp4`,
        ),
        Buffer.alloc(5_000),
      );
      await writeFile(
        path.join(
          outputDirectory,
          `media-${(ranges[1]!.startMs / 1_000).toFixed(3)}-${
            (ranges[1]!.endMs / 1_000).toFixed(3)
          }.mp4`,
        ),
        Buffer.alloc(100),
      );
      return processResult(args);
    },
  };
  const outcomes = await new MediaAcquirer(
    config,
    ctx.store,
    ctx.blobs,
    downloader,
  ).sections(requirements(ctx.resolved, ctx.ref, 2));
  assert.equal(calls, 1);
  assert(
    outcomes.every(
      (outcome) =>
        outcome.status === "rejected" &&
        outcome.reason instanceof Error &&
        "code" in outcome.reason &&
        outcome.reason.code === "MEDIA_BUDGET_EXCEEDED",
    ),
  );
  assert.equal(ctx.store.cacheStats().artifacts, 0);
});

test("non-zero batch result and thrown process failure preserve independently verifiable filename-mapped outputs", async (t) => {
  const ctx = await fixture(t);
  for (const throwsAfterOutput of [false, true]) {
    const isolated = throwsAfterOutput ? await fixture(t) : ctx;
    let calls = 0;
    const downloader = {
      run: async (args: readonly string[]) => {
        calls += 1;
        const outputDirectory = String(args[args.indexOf("--paths") + 1]);
        for (const range of rangeArguments(args)) {
          await copyFile(
            isolated.video,
            path.join(
              outputDirectory,
              `media-${(range.startMs / 1_000).toFixed(3)}-${
                (range.endMs / 1_000).toFixed(3)
              }.mp4`,
            ),
          );
        }
        if (throwsAfterOutput) {
          throw new Error("simulated checked-run non-zero exit");
        }
        return processResult(args, "", 7);
      },
    };
    const outcomes = await new MediaAcquirer(
      isolated.config,
      isolated.store,
      isolated.blobs,
      downloader,
    ).sections(requirements(isolated.resolved, isolated.ref, 2));
    assert(outcomes.every((outcome) => outcome.status === "fulfilled"));
    assert.equal(calls, 1);
  }
});

test("full batch startup failure falls back each unresolved section without recursion", async (t) => {
  const ctx = await fixture(t);
  const requested = requirements(ctx.resolved, ctx.ref, 3);
  const calls: string[][] = [];
  const downloader = {
    run: async (args: readonly string[]) => {
      calls.push([...args]);
      const ranges = rangeArguments(args);
      if (ranges.length > 1) throw new Error("simulated startup failure");
      const outputDirectory = String(args[args.indexOf("--paths") + 1]);
      await copyFile(ctx.video, path.join(outputDirectory, "media.mp4"));
      return processResult(args);
    },
  };
  const outcomes = await new MediaAcquirer(
    ctx.config,
    ctx.store,
    ctx.blobs,
    downloader,
  ).sections(requested);
  assert(outcomes.every((outcome) => outcome.status === "fulfilled"));
  assert.equal(calls.length, 4);
  assert.deepEqual(
    calls.slice(1).map((args) => rangeArguments(args).length),
    [1, 1, 1],
  );
});

test("ambiguous output metadata is never guessed and only unresolved requirements fall back", async (t) => {
  const ctx = await fixture(t);
  const requested = requirements(ctx.resolved, ctx.ref, 2);
  const calls: string[][] = [];
  const downloader = {
    run: async (args: readonly string[]) => {
      calls.push([...args]);
      const outputDirectory = String(args[args.indexOf("--paths") + 1]);
      const ranges = rangeArguments(args);
      if (ranges.length === 1) {
        await copyFile(ctx.video, path.join(outputDirectory, "media.mp4"));
        return processResult(args);
      }
      const first = ranges[0]!;
      const lines: string[] = [];
      for (const suffix of ["a", "b"]) {
        const filepath = path.join(
          outputDirectory,
          `media-${(first.startMs / 1_000).toFixed(3)}-${
            (first.endMs / 1_000).toFixed(3)
          }-${suffix}.mp4`,
        );
        await copyFile(ctx.video, filepath);
        lines.push(emission(first.startMs, first.endMs, filepath));
      }
      return processResult(args, `${lines.join("\n")}\n`);
    },
  };
  const outcomes = await new MediaAcquirer(
    ctx.config,
    ctx.store,
    ctx.blobs,
    downloader,
  ).sections(requested);
  assert(outcomes.every((outcome) => outcome.status === "fulfilled"));
  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.slice(1).map((args) => rangeArguments(args)[0]?.startMs),
    requested.map((item) => item.startMs),
  );
});

test("batched and individual production frame paths preserve early, middle, and late exact-frame identity and offsets", async (t) => {
  const batched = await fixture(t);
  const individual = await fixture(t);
  const timesMs = [90_000, 1_000, 60_000];
  const batchCalls: string[][] = [];
  const individualCalls: string[][] = [];

  const downloader = (
    ctx: Awaited<ReturnType<typeof fixture>>,
    calls: string[][],
  ) => ({
    run: async (args: readonly string[]) => {
      calls.push([...args]);
      const outputDirectory = String(args[args.indexOf("--paths") + 1]);
      const ranges = rangeArguments(args);
      if (ranges.length === 1 && !args.includes("--print")) {
        const filepath = path.join(outputDirectory, "media.mp4");
        await copyFile(ctx.video, filepath);
        await appendFile(
          filepath,
          `interval:${ranges[0]!.startMs}:${ranges[0]!.endMs}`,
        );
        return processResult(args);
      }
      const lines: string[] = [];
      for (const range of [...ranges].reverse()) {
        const filepath = path.join(
          outputDirectory,
          `media-${(range.startMs / 1_000).toFixed(3)}-${
            (range.endMs / 1_000).toFixed(3)
          }.mp4`,
        );
        await copyFile(ctx.video, filepath);
        await appendFile(filepath, `interval:${range.startMs}:${range.endMs}`);
        lines.push(emission(range.startMs, range.endMs, filepath));
      }
      return processResult(args, `${lines.join("\n")}\n`);
    },
  });

  class IndividualSections extends MediaAcquirer {
    override async sections(
      items: readonly SectionBatchRequirement[],
      signal?: AbortSignal,
    ): Promise<SectionAcquisitionOutcome[]> {
      const outcomes: SectionAcquisitionOutcome[] = [];
      for (const requirement of items) {
        try {
          outcomes.push({
            requirement,
            status: "fulfilled",
            value: await this.section(
              requirement.source,
              requirement.investigationRef,
              requirement.startMs,
              requirement.endMs,
              signal,
            ),
          });
        } catch (reason) {
          outcomes.push({ requirement, status: "rejected", reason });
        }
      }
      return outcomes;
    }
  }

  const batchedFrames = await new FrameAcquirer(
    batched.config,
    batched.store,
    batched.blobs,
    new MediaAcquirer(
      batched.config,
      batched.store,
      batched.blobs,
      downloader(batched, batchCalls),
    ),
  ).get(batched.resolved, batched.ref, timesMs);
  const individualFrames = await new FrameAcquirer(
    individual.config,
    individual.store,
    individual.blobs,
    new IndividualSections(
      individual.config,
      individual.store,
      individual.blobs,
      downloader(individual, individualCalls),
    ),
  ).get(individual.resolved, individual.ref, timesMs);
  assert.equal(batchCalls.length, 1);
  assert.equal(individualCalls.length, 3);

  for (const [index, observed] of batchedFrames.entries()) {
    const baseline = individualFrames[index]!;
    assert.equal(observed.atMs, timesMs[index]);
    assert.deepEqual(
      await batched.blobs.read(
        observed.artifact.artifactId,
        observed.artifact.blobPath,
        10 * 1024 * 1024,
      ),
      await individual.blobs.read(
        baseline.artifact.artifactId,
        baseline.artifact.blobPath,
        10 * 1024 * 1024,
      ),
    );
    const expectedStartMs = Math.max(0, observed.atMs - 2_000);
    const expectedEndMs = Math.min(
      batched.resolved.durationMs,
      observed.atMs + 2_001,
    );
    const transportId = observed.artifact.producer.transportArtifactId;
    const transport = batched.store
      .listArtifacts(batched.resolved.sourceRef, batched.resolved.revision)
      .find((artifact) => artifact.artifactId === transportId);
    assert(transport);
    assert.deepEqual(
      {
        startMs: transport.startMs,
        endMs: transport.endMs,
        localOffsetMs: observed.atMs - transport.startMs!,
      },
      {
        startMs: expectedStartMs,
        endMs: expectedEndMs,
        localOffsetMs: observed.atMs - expectedStartMs,
      },
    );
  }
});

test("remote panel acquisition batches once and later individual presentation hits canonical exact-frame cache", async (t) => {
  const ctx = await fixture(t);
  let calls = 0;
  const downloader = {
    run: async (args: readonly string[]) => {
      calls += 1;
      const outputDirectory = String(args[args.indexOf("--paths") + 1]);
      const lines: string[] = [];
      for (const range of rangeArguments(args)) {
        const filepath = path.join(
          outputDirectory,
          `media-${(range.startMs / 1_000).toFixed(3)}-${
            (range.endMs / 1_000).toFixed(3)
          }.mp4`,
        );
        await copyFile(ctx.video, filepath);
        await appendFile(filepath, `interval:${range.startMs}:${range.endMs}`);
        lines.push(emission(range.startMs, range.endMs, filepath));
      }
      return processResult(args, `${lines.join("\n")}\n`);
    },
  };
  const service = new EvidenceService(ctx.config, ctx.store, ctx.blobs);
  (service as unknown as { frames: FrameAcquirer }).frames = new FrameAcquirer(
    ctx.config,
    ctx.store,
    ctx.blobs,
    new MediaAcquirer(ctx.config, ctx.store, ctx.blobs, downloader),
  );
  const timesMs = [1_000, 60_000, 90_000];
  const panel = await service.getFrames({
    investigationRef: ctx.ref,
    request: { kind: "points", timesMs },
    presentation: "panel",
  });
  assert.equal("presentation" in panel ? panel.presentation : null, "panel");
  assert.equal(calls, 1);
  const individual = await service.getFrames({
    investigationRef: ctx.ref,
    request: { kind: "points", timesMs: [timesMs[2]!, timesMs[0]!] },
    presentation: "individual",
  });
  assert.equal("frames" in individual, true);
  if ("frames" in individual) {
    assert(individual.frames.every((frame) => frame.cacheHit));
  }
  assert.equal(calls, 1);
});

test("batch diagnostics distinguish logical work, outer invocation, validation, and fallback", async (t) => {
  const ctx = await fixture(t);
  const previousDebugFile = process.env.URMA_DEBUG_FILE;
  process.env.URMA_DEBUG_FILE = ctx.debugFile;
  t.after(() => {
    if (previousDebugFile === undefined) delete process.env.URMA_DEBUG_FILE;
    else process.env.URMA_DEBUG_FILE = previousDebugFile;
  });
  const requested = requirements(ctx.resolved, ctx.ref, 2);
  let batch = true;
  const downloader = {
    run: async (args: readonly string[]) => {
      const outputDirectory = String(args[args.indexOf("--paths") + 1]);
      rangeArguments(args);
      if (batch) {
        batch = false;
        return processResult(args);
      }
      await copyFile(ctx.video, path.join(outputDirectory, "media.mp4"));
      return processResult(args);
    },
  };
  await new MediaAcquirer(
    { ...ctx.config, debug: true },
    ctx.store,
    ctx.blobs,
    downloader,
  ).sections(requested);
  const events = (await readFile(ctx.debugFile, "utf8"))
    .trim()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const summary = events.find(
    (event) => event.event === "bounded-section-batching",
  );
  assert(summary);
  assert.equal(summary.logicalSectionRequirements, 2);
  assert.equal(summary.outerYtDlpInvocations, 3);
  assert.equal(summary.multiSectionYtDlpInvocations, 1);
  assert.equal(summary.batchSectionsMissingUnmapped, 2);
  assert.equal(summary.fallbackSectionsSuccessful, 2);
});
