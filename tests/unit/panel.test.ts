import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createPanel,
  formatTimestampMs,
  framePanelDimensions,
} from "../../src/acquisition/panel.js";
import { loadConfig } from "../../src/config.js";
import { runChecked } from "../../src/subprocess/runner.js";

async function pixel(
  file: string,
  x: number,
  y: number,
): Promise<readonly number[]> {
  const result = await runChecked(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      file,
      "-vf",
      `crop=2:2:${x}:${y},format=rgb24`,
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "pipe:1",
    ],
    { timeoutMs: 30_000, maxStdoutBytes: 16 },
  );
  return [...result.stdout.subarray(0, 3)];
}

function red(value: readonly number[]): boolean {
  return value[0]! > 180 && value[1]! < 80 && value[2]! < 80;
}
function black(value: readonly number[]): boolean {
  return value.every((channel) => channel < 40);
}

test("exact-frame panel geometry is deterministic and bounded", () => {
  assert.equal(formatTimestampMs(0), "00:00:00");
  assert.equal(formatTimestampMs(762_250), "00:12:42.250");
  assert.equal(formatTimestampMs(3_599_000), "00:59:59");
  assert.deepEqual(framePanelDimensions(1), {
    columns: 1,
    rows: 1,
    width: 320,
    height: 212,
    cellWidth: 320,
    frameHeight: 180,
    captionHeight: 32,
  });
  assert.deepEqual(framePanelDimensions(3), {
    columns: 3,
    rows: 1,
    width: 960,
    height: 212,
    cellWidth: 320,
    frameHeight: 180,
    captionHeight: 32,
  });
  assert.deepEqual(framePanelDimensions(4), {
    columns: 3,
    rows: 2,
    width: 960,
    height: 424,
    cellWidth: 320,
    frameHeight: 180,
    captionHeight: 32,
  });
  assert.deepEqual(framePanelDimensions(7), {
    columns: 4,
    rows: 2,
    width: 1_280,
    height: 424,
    cellWidth: 320,
    frameHeight: 180,
    captionHeight: 32,
  });
  assert.deepEqual(framePanelDimensions(12), {
    columns: 4,
    rows: 3,
    width: 1_280,
    height: 636,
    cellWidth: 320,
    frameHeight: 180,
    captionHeight: 32,
  });
  assert.throws(() => framePanelDimensions(0), /1-12/u);
  assert.throws(() => framePanelDimensions(13), /1-12/u);
});

test("exact-frame panels preserve landscape, portrait, and ultrawide aspect ratios without cropping", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "urma-panel-aspect-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const config = loadConfig({
    URMA_DATA_DIR: path.join(directory, "data"),
    URMA_FFMPEG: "ffmpeg",
  });
  const cases = [
    {
      name: "widescreen",
      size: "160x90",
      redPoint: [5, 90] as const,
      blackPoint: null,
    },
    {
      name: "standard",
      size: "120x90",
      redPoint: [45, 90] as const,
      blackPoint: [5, 90] as const,
    },
    {
      name: "portrait",
      size: "90x160",
      redPoint: [120, 90] as const,
      blackPoint: [5, 90] as const,
    },
    {
      name: "ultrawide",
      size: "210x90",
      redPoint: [160, 90] as const,
      blackPoint: [160, 5] as const,
    },
  ];
  for (const [index, item] of cases.entries()) {
    const source = path.join(directory, `${item.name}.jpg`);
    const panel = path.join(directory, `${item.name}-panel.jpg`);
    await runChecked(
      "ffmpeg",
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        `color=c=red:s=${item.size}:d=1:r=1`,
        "-frames:v",
        "1",
        "-q:v",
        "2",
        "-y",
        source,
      ],
      { timeoutMs: 30_000 },
    );
    const dimensions = await createPanel(
      config,
      [source],
      [index * 1_000],
      panel,
      undefined,
      { presentation: "exact-frames" },
    );
    assert.equal(dimensions.width, 320);
    assert.equal(dimensions.height, 212);
    assert(
      red(await pixel(panel, item.redPoint[0], item.redPoint[1])),
      `${item.name} source pixels should remain visible at the fitted-image interior`,
    );
    if (item.blackPoint) {
      assert(
        black(await pixel(panel, item.blackPoint[0], item.blackPoint[1])),
        `${item.name} should be letterboxed rather than stretched or cropped`,
      );
    }
    assert(
      black(await pixel(panel, 5, 185)),
      `${item.name} caption band must sit outside source evidence pixels`,
    );
  }
});
