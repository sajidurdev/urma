import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { UrmaConfig } from "../config.js";
import { verifyRuntimeTool } from "../distribution/integrity.js";
import { runChecked } from "../subprocess/runner.js";
import type { FrameCropGeometry } from "../core/frame-crop.js";

export const MAX_FRAME_PANEL_CELLS = 12;
export const RULER_STYLE_VERSION = "source-rulers-v2";
const CELL_WIDTH = 320;
const FRAME_HEIGHT = 180;
const CAPTION_HEIGHT = 32;
const RULER_MARGIN = 40;

/** Applied before tile letterboxing: axes belong to the fitted source image. */
function rulerFilters(font: string | null, crop?: FrameCropGeometry): string {
  const margin = RULER_MARGIN;
  const filters = [`pad=iw+${2 * margin}:ih+${2 * margin}:${margin}:${margin}:black`,
    `drawbox=x=${margin - 2}:y=${margin - 2}:w=iw-${2 * margin - 4}:h=ih-${2 * margin - 4}:color=0xe2e8f0:t=1`,
    `drawbox=x=${margin - 1}:y=${margin - 1}:w=iw-${2 * margin - 2}:h=ih-${2 * margin - 2}:color=0x0f172a:t=1`];
  for (let percent = 0; percent <= 100; percent += 5) {
    const fraction = percent / 100;
    const x = `${margin}+(iw-${2 * margin})*${fraction}`;
    const y = `${margin}+(ih-${2 * margin})*${fraction}`;
    const length = percent % 25 === 0 ? 6 : percent % 10 === 0 ? 4 : 2;
    filters.push(`drawbox=x='${x}':y=${margin - 2 - length}:w=1:h=${length}:color=white:t=fill`);
    filters.push(`drawbox=x=${margin - 2 - length}:y='${y}':w=${length}:h=1:color=white:t=fill`);
    if (percent % 25 !== 0) continue;
    const sourceX = crop ? (crop.pixels.x + crop.pixels.width * fraction) / crop.sourceWidth * 100 : percent;
    const sourceY = crop ? (crop.pixels.y + crop.pixels.height * fraction) / crop.sourceHeight * 100 : percent;
    const text = (value: number) => `drawtext=${font ? `fontfile='${escapeFilter(font)}':` : "font='sans-serif\\:style=Bold':"}expansion=none:text='${Number(value.toFixed(2))}':fontcolor=white:fontsize=12`;
    const textX = percent === 0 ? `${margin}-text_w-3` : percent === 100
      ? `w-${margin}+3` : `${margin}+(w-${2 * margin})*${fraction}-text_w/2`;
    const textY = percent === 0 ? `${margin}-text_h-5` : percent === 100
      ? `h-${margin}+5` : `${margin}+(h-${2 * margin})*${fraction}-text_h/2`;
    const interior = percent !== 0 && percent !== 100;
    filters.push(`${text(sourceX)}:x='${textX}':y=${margin - 30}${interior ? `:alpha='gte(w,240)'` : ""}`);
    filters.push(`${text(sourceY)}:x=${margin}-text_w-4:y='${textY}'${interior ? `:alpha='gte(h,180)'` : ""}`);
  }
  return filters.join(",");
}

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

async function fontPath(bold = false): Promise<string | null> {
  const candidates = [
    process.env.URMA_FONT,
    process.platform === "win32"
      ? path.join(process.env.WINDIR ?? "C:\\Windows", "Fonts", bold ? "segoeuib.ttf" : "segoeui.ttf")
      : undefined,
    process.platform === "darwin"
      ? `/System/Library/Fonts/Supplemental/${bold ? "Arial Bold" : "Arial"}.ttf`
      : undefined,
    `/usr/share/fonts/truetype/dejavu/DejaVuSans${bold ? "-Bold" : ""}.ttf`,
  ].filter((item): item is string => Boolean(item));
  for (const candidate of candidates) {
    if ((await stat(candidate).catch(() => null))?.isFile()) {
      return candidate.replace(/\\/g, "/");
    }
  }
  return null;
}

export function framePanelDimensions(count: number, rulers = false): PanelDimensions {
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
    width: columns * (CELL_WIDTH + (rulers ? 2 * RULER_MARGIN : 0)),
    height: rows * (FRAME_HEIGHT + CAPTION_HEIGHT + (rulers ? 2 * RULER_MARGIN : 0)),
    cellWidth: CELL_WIDTH + (rulers ? 2 * RULER_MARGIN : 0),
    frameHeight: FRAME_HEIGHT + (rulers ? 2 * RULER_MARGIN : 0),
    captionHeight: CAPTION_HEIGHT,
  };
}

export async function createPanel(
  config: UrmaConfig,
  frames: readonly string[],
  timesMs: readonly number[],
  output: string,
  signal?: AbortSignal,
  options: Readonly<{ presentation?: "overview" | "exact-frames" | "individual"; rulers?: boolean; crops?: readonly (FrameCropGeometry | undefined)[] }> = {},
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
  const individual = options.presentation === "individual";
  if (individual && frames.length !== 1) throw new RangeError("Individual previews require exactly one frame");
  const exact = options.presentation === "exact-frames" || individual;
  const rulers = options.rulers === true;
  const innerWidth = individual ? 1280 : CELL_WIDTH;
  const innerHeight = individual ? 720 : FRAME_HEIGHT;
  const cellWidth = innerWidth + (rulers ? 2 * RULER_MARGIN : 0);
  const frameHeight = innerHeight + (rulers ? 2 * RULER_MARGIN : 0);
  const dimensions = individual ? {
    columns: 1, rows: 1, width: cellWidth, height: frameHeight + CAPTION_HEIGHT,
    cellWidth, frameHeight, captionHeight: CAPTION_HEIGHT,
  } : exact ? framePanelDimensions(frames.length, rulers) : {
    columns: 4,
    rows: Math.ceil(frames.length / 4),
    width: 4 * cellWidth,
    height: Math.ceil(frames.length / 4) * (frameHeight + (rulers ? CAPTION_HEIGHT : 0)),
    cellWidth,
    frameHeight,
    captionHeight: rulers ? CAPTION_HEIGHT : 0,
  };
  const font = await fontPath(rulers);
  const filters: string[] = [];
  const labels: string[] = [];
  for (let index = 0; index < frames.length; index++) {
    const label = `v${index}`;
    labels.push(`[${label}]`);
    const caption = exact
      ? `#${index + 1} ${formatTimestampMs(timesMs[index]!)}`
      : formatTimestampMs(timesMs[index]!);
    const draw = exact || rulers
      ? `drawtext=${font ? `fontfile='${escapeFilter(font)}':` : ""}text='${
        escapeFilter(caption)
      }':fontcolor=white:fontsize=20:x=(w-text_w)/2:y=${frameHeight}+(h-${frameHeight}-text_h)/2`
      : `drawtext=${font ? `fontfile='${escapeFilter(font)}':` : ""}text='${
        escapeFilter(caption)
      }':fontcolor=white:fontsize=20:box=1:boxcolor=black@0.72:boxborderw=5:x=7:y=7`;
    const captionPad = exact || rulers
      ? `,pad=${cellWidth}:${frameHeight + CAPTION_HEIGHT}:0:0:black`
      : "";
    const fit = rulers
      ? `setsar='if(gt(sar,0),sar,1)':max=2147483647,format=yuv444p,scale=w='max(1,round(iw*sar*min(${innerWidth}/(iw*sar),${innerHeight}/ih)))':h='max(1,round(ih*min(${innerWidth}/(iw*sar),${innerHeight}/ih)))',setsar=1,${rulerFilters(font, options.crops?.[index])},pad=${cellWidth}:${frameHeight}:(ow-iw)/2:(oh-ih)/2:black`
      : `setsar=1,scale=${innerWidth}:${innerHeight}:force_original_aspect_ratio=decrease,pad=${cellWidth}:${frameHeight}:(ow-iw)/2:(oh-ih)/2:black`;
    filters.push(`[${index}:v]${fit}${captionPad},${draw}[${label}]`);
  }
  const layout = frames
    .map(
      (_, index) =>
        `${(index % dimensions.columns) * cellWidth}_${
          Math.floor(index / dimensions.columns) *
          (frameHeight + dimensions.captionHeight)
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
  // A 12-tile ruler graph exceeds Windows' command-line length limit.
  const scriptDirectory = rulers ? await mkdtemp(path.join(path.dirname(output), "ruler-filters-")) : null;
  try {
    const script = scriptDirectory ? path.join(scriptDirectory, "graph.txt") : null;
    if (script) await writeFile(script, filters.join(";"), "utf8");
    await runChecked(
      config.ffmpeg,
      [
        "-v",
        "error",
        ...frames.flatMap((frame) => ["-i", frame]),
        ...(script ? ["-filter_complex_script", script] : ["-filter_complex", filters.join(";")]),
        "-map",
        "[out]",
        "-frames:v",
        "1",
        "-pix_fmt",
        rulers ? "yuvj444p" : "yuvj420p",
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
  } finally {
    if (scriptDirectory) await rm(scriptDirectory, { recursive: true, force: true });
  }
  return dimensions;
}
