import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { VisualAnalyzer } from "../../src/acquisition/visual-analysis.js";
import { loadConfig } from "../../src/config.js";
import { BlobStore } from "../../src/store/blob-store.js";
import { Ffmpeg } from "../../src/subprocess/ffmpeg.js";
import { runChecked } from "../../src/subprocess/runner.js";

test("visual jobs reject excess concurrency and release their slots after cancellation or errors", async () => {
  const analyzer = new VisualAnalyzer(loadConfig({}), new BlobStore("unused-visual-budget-test"));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const a = analyzer.withBudget(undefined, async () => await gate);
  const b = analyzer.withBudget(undefined, async () => await gate);
  await assert.rejects(analyzer.withBudget(undefined, async () => {}), /two simultaneous/u);
  release(); await Promise.all([a, b]);
  const controller = new AbortController();
  const cancelled = analyzer.withBudget(controller.signal, async (budget) => {
    await new Promise<void>((resolve) => budget.signal.addEventListener("abort", () => resolve(), { once: true }));
    budget.remainingMs();
  });
  controller.abort();
  await assert.rejects(cancelled, /cancelled/u);
  await assert.rejects(analyzer.withBudget(undefined, async () => { throw new Error("decode failure"); }), /decode failure/u);
  assert.equal(await analyzer.withBudget(undefined, async () => 42), 42);
  assert.equal((await analyzer.hints([])).decodedFrames, 0);
});

test("RGB decoding enforces frame/byte/thread limits and rejects malformed or unproven timestamp data", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "urma-rgb-budget-"));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const file = path.join(directory, "input.jpg"); await writeFile(file, "fixture input");
  let mode: "ok" | "partial" | "missing-pts" = "ok";
  let calls = 0;
  const ffmpeg = new Ffmpeg(loadConfig({}), null, async (executable, args, options) => {
    calls++;
    assert.equal(options?.maxStdoutBytes, 4 * 64 * 36 * 3);
    assert.equal(options?.timeoutMs, 2000);
    assert(args.includes("-max_pixels"));
    assert.equal(args[args.indexOf("-max_alloc") + 1], "67108864");
    assert.equal(args[args.indexOf("-max_pixels") + 1], "8388608");
    assert(args.includes("-copyts") && args.includes("-start_at_zero"));
    assert(!args.includes("-skip_frame"), "fine decoding never relies on keyframes");
    assert.match(args[args.indexOf("-vf") + 1]!, /scdet=threshold=7/u);
    return { executable, args, code: 0, wallMs: 1,
      stdout: Buffer.alloc(64 * 36 * 3 - (mode === "partial" ? 1 : 0)),
      stderr: Buffer.from(mode === "missing-pts" ? "" : "    title : [Parsed_showinfo_4] config in time_base: 1/10\n    title : [Parsed_showinfo_4] n: 0 pts: 0 pts_time:0 fmt:rgb24 sar:1/1 s:64x36 i:P iskey:1\n    title : [Parsed_metadata_3] lavfi.scd.score=99.000\n[Parsed_showinfo_4] config in time_base: 1/1000, frame_rate: 10/1\n[Parsed_metadata_3] lavfi.scd.score=11.000\n[Parsed_showinfo_4] n: 0 pts: 920 pts_time:0.92 fmt:rgb24 sar:1/1 s:64x36 i:P iskey:0 type:P\n"),
    };
  });
  const dimensions = { width: 64, height: 36, aspectRatioError: 0 };
  const options = { seekMs: 0, endMs: 2000, maxFrames: 4, scene: true, sceneThreshold: 7, timeoutMs: 2000 };
  const result = await ffmpeg.rgbFrames(file, dimensions, options);
  assert.equal(result[0]?.presentationTimeMs, 920); assert.equal(result[0]?.sceneScore, 11);
  mode = "partial"; await assert.rejects(ffmpeg.rgbFrames(file, dimensions, options), /RGB output/u);
  mode = "missing-pts"; await assert.rejects(ffmpeg.rgbFrames(file, dimensions, options), /RGB output/u);
  await assert.rejects(ffmpeg.rgbFrames(file, dimensions, { ...options, maxFrames: 241 }), /1-240/u);
  assert.equal(calls, 3, "malformed budgets cannot start a decoder");
});

test("analysis deadlines stop work and release the shared grouping/hints job slot", async () => {
  const config = loadConfig({});
  const analyzer = new VisualAnalyzer({ ...config, limits: { ...config.limits, mediaTimeoutMs: 10 } }, new BlobStore("unused-visual-deadline-test"));
  await assert.rejects(analyzer.withBudget(undefined, async (budget) => {
    await new Promise<void>((resolve) => {
      const keepAlive = setTimeout(resolve, 1000);
      budget.signal.addEventListener("abort", () => { clearTimeout(keepAlive); resolve(); }, { once: true });
    });
    budget.remainingMs();
  }), /exceeded its 10 ms deadline/u);
  assert.equal(await analyzer.withBudget(undefined, async () => 42), 42);
});

test("the native decoder rejects input images above the analysis pixel budget", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "urma-rgb-pixel-cap-"));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const file = path.join(directory, "large.jpg");
  await runChecked("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=3000x3000",
    "-frames:v", "1", "-y", file], { timeoutMs: 30_000 });
  await assert.rejects(new Ffmpeg(loadConfig({})).rgbFrames(file,
    { width: 144, height: 144, aspectRatioError: 0 }, { seekMs: 0, endMs: 1000, maxFrames: 1, timeoutMs: 2000 }), /8388608/u);
});

test("subtitle decoding validates stream indices and uses bounded descriptor-only input", async () => {
  const config = loadConfig({}); let calls = 0;
  const ffmpeg = new Ffmpeg(config, null, async (executable, args, options) => {
    calls++;
    assert.equal(args[args.indexOf("-map") + 1], "0:2");
    assert.equal(args[args.indexOf("-protocol_whitelist") + 1], "fd");
    assert.equal(args[args.indexOf("-c:s") + 1], "webvtt");
    assert(args.includes("-copyts") && args.includes("-start_at_zero"));
    assert(args.includes("-vn") && args.includes("-an") && args.includes("-dn"));
    assert.equal(options?.maxStdoutBytes, config.limits.resourceBytes);
    assert.equal(options?.timeoutMs, 15_000);
    assert.equal(options?.inputFile, "pinned-video.mkv");
    return { executable, args, code: 0, wallMs: 1, stdout: Buffer.from("WEBVTT\n"), stderr: Buffer.alloc(0) };
  });
  for (const index of [-1, .5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(ffmpeg.textSubtitles("pinned-video.mkv", index), /stream index/u);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(ffmpeg.textSubtitles("pinned-video.mkv", 2, controller.signal), /cancelled/u);
  assert.equal(calls, 0);
  assert.equal((await ffmpeg.textSubtitles("pinned-video.mkv", 2)).toString(), "WEBVTT\n");
});
