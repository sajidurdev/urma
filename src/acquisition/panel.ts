import { stat } from "node:fs/promises";
import path from "node:path";
import type { UrmaConfig } from "../config.js";
import { verifyRuntimeTool } from "../distribution/integrity.js";
import { runChecked } from "../subprocess/runner.js";

export const MAX_FRAME_PANEL_CELLS = 12;
const CELL_WIDTH = 320;
const FRAME_HEIGHT = 180;
const CAPTION_HEIGHT = 32;

export type PanelDimensions = Readonly<{
  columns: number;
  rows: number;
  width: number;
  height: number;
  cellWidth: number;
  frameHeight: number;
  captionHeight: number;
}>;

function escapeFilter(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

export function formatTimestampMs(value: number): string {
  const hours = Math.floor(value / 3_600_000);
  const minutes = Math.floor((value % 3_600_000) / 60_000);
  const seconds = Math.floor((value % 60_000) / 1_000);
  const millis = value % 1_000;
  return `${String(hours).padStart(2, "0")}:${
    String(minutes).padStart(2, "0")
  }:${String(seconds).padStart(2, "0")}${
    millis ? `.${String(millis).padStart(3, "0")}` : ""
  }`;
}

async function fontPath(): Promise<string | null> {
  const candidates = [
    process.env.URMA_FONT,
    process.platform === "win32"
      ? path.join(process.env.WINDIR ?? "C:\\Windows", "Fonts", "segoeui.ttf")
      : undefined,
    process.platform === "darwin"
      ? "/System/Library/Fonts/Supplemental/Arial.ttf"
      : undefined,
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  ].filter((item): item is string => Boolean(item));
  for (const candidate of candidates) {
    if ((await stat(candidate).catch(() => null))?.isFile()) {
      return candidate.replace(/\\/g, "/");
    }
  }
  return null;
}

export function framePanelDimensions(count: number): PanelDimensions {
  if (!Number.isInteger(count) || count < 1 || count > MAX_FRAME_PANEL_CELLS) {
    throw new RangeError(
      `Exact-frame panel requires 1-${MAX_FRAME_PANEL_CELLS} cells; received ${
        String(count)
      }`,
    );
  }
  const columns = count <= 3 ? count : count <= 6 ? 3 : 4;
  const rows = Math.ceil(count / columns);
  return {
    columns,
    rows,
    width: columns * CELL_WIDTH,
    height: rows * (FRAME_HEIGHT + CAPTION_HEIGHT),
    cellWidth: CELL_WIDTH,
    frameHeight: FRAME_HEIGHT,
    captionHeight: CAPTION_HEIGHT,
  };
}

export async function createPanel(
  config: UrmaConfig,
  frames: readonly string[],
  timesMs: readonly number[],
  output: string,
  signal?: AbortSignal,
  options: Readonly<{ presentation?: "overview" | "exact-frames" }> = {},
): Promise<PanelDimensions> {
  if (
    frames.length < 1 ||
    frames.length > MAX_FRAME_PANEL_CELLS ||
    frames.length !== timesMs.length
  ) {
    throw new RangeError(
      `Panel requires 1-${MAX_FRAME_PANEL_CELLS} frames with one timestamp per frame`,
    );
  }
  const exact = options.presentation === "exact-frames";
  const dimensions = exact ? framePanelDimensions(frames.length) : {
    columns: 4,
    rows: Math.ceil(frames.length / 4),
    width: 4 * CELL_WIDTH,
    height: Math.ceil(frames.length / 4) * FRAME_HEIGHT,
    cellWidth: CELL_WIDTH,
    frameHeight: FRAME_HEIGHT,
    captionHeight: 0,
  };
  const font = await fontPath();
  const filters: string[] = [];
  const labels: string[] = [];
  for (let index = 0; index < frames.length; index++) {
    const label = `v${index}`;
    labels.push(`[${label}]`);
    const caption = exact
      ? `#${index + 1} ${formatTimestampMs(timesMs[index]!)}`
      : formatTimestampMs(timesMs[index]!);
    const draw = exact
      ? `drawtext=${font ? `fontfile='${escapeFilter(font)}':` : ""}text='${
        escapeFilter(caption)
      }':fontcolor=white:fontsize=20:x=(w-text_w)/2:y=${FRAME_HEIGHT}+(h-${FRAME_HEIGHT}-text_h)/2`
      : `drawtext=${font ? `fontfile='${escapeFilter(font)}':` : ""}text='${
        escapeFilter(caption)
      }':fontcolor=white:fontsize=20:box=1:boxcolor=black@0.72:boxborderw=5:x=7:y=7`;
    const captionPad = exact
      ? `,pad=${CELL_WIDTH}:${FRAME_HEIGHT + CAPTION_HEIGHT}:0:0:black`
      : "";
    filters.push(
      `[${index}:v]setsar=1,scale=${CELL_WIDTH}:${FRAME_HEIGHT}:force_original_aspect_ratio=decrease,pad=${CELL_WIDTH}:${FRAME_HEIGHT}:(ow-iw)/2:(oh-ih)/2:black${captionPad},${draw}[${label}]`,
    );
  }
  const layout = frames
    .map(
      (_, index) =>
        `${(index % dimensions.columns) * CELL_WIDTH}_${
          Math.floor(index / dimensions.columns) *
          (FRAME_HEIGHT + dimensions.captionHeight)
        }`,
    )
    .join("|");
  if (frames.length === 1 && exact) filters.push("[v0]null[out]");
  else if (frames.length === 1) {
    filters.push(
      `[v0]pad=${dimensions.width}:${dimensions.height}:0:0:black[out]`,
    );
  } else {
    filters.push(
      `${
        labels.join("")
      }xstack=inputs=${frames.length}:layout=${layout}:fill=black[out]`,
    );
  }
  await verifyRuntimeTool(config, "ffmpeg");
  await runChecked(
    config.ffmpeg,
    [
      "-v",
      "error",
      ...frames.flatMap((frame) => ["-i", frame]),
      "-filter_complex",
      filters.join(";"),
      "-map",
      "[out]",
      "-frames:v",
      "1",
      "-pix_fmt",
      "yuvj420p",
      "-q:v",
      "2",
      "-y",
      output,
    ],
    {
      timeoutMs: config.limits.mediaTimeoutMs,
      maxStdoutBytes: 512 * 1024,
      maxStderrBytes: config.limits.subprocessStderrBytes,
      signal,
      debug: config.debug,
      label: "ffmpeg",
    },
  );
  return dimensions;
}
