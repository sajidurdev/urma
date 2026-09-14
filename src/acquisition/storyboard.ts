import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { UrmaConfig } from "../config.js";
import { UrmaError } from "../core/errors.js";
import { assertInterval, assertMs } from "../core/coverage.js";
import type { InvestigationRef } from "../core/ids.js";
import { deterministicRequestKey } from "../core/request-key.js";
import type { ResolvedSource } from "../sources/types.js";
import { candidateKeyForSourceFormat } from "../sources/candidates.js";
import { Ffmpeg } from "../subprocess/ffmpeg.js";
import { YtDlp } from "../subprocess/ytdlp.js";
import type { RemoteOperationContext } from "../remote/worker.js";
import { collectBinaryVersions } from "../subprocess/versions.js";
import { BlobStore } from "../store/blob-store.js";
import type { StoredArtifact, UrmaStore } from "../store/store.js";
import { URMA_VERSION } from "../version.js";
import {
  assertExpectedRemoteBytes,
  assertRemoteDirectoryWithinBudget,
  withRemoteAcquisitionDirectory,
} from "./remote-budget.js";
import { startAcquisition } from "./records.js";

export type MhtmlImagePart = Readonly<{
  contentType: string;
  durationMs: number;
  bytes: Buffer;
}>;
type StoryboardScope = Readonly<{ startMs: number; endMs: number }>;
type StoryboardLayout = Readonly<{
  width: number;
  height: number;
  fps: number;
  columns: number;
  rows: number;
  intervalMs: number;
}>;
type StoryboardCell = Readonly<{
  partIndex: number;
  cell: number;
  timestampMs: number;
}>;
export type StoryboardSample = Readonly<{
  timestampMs: number;
  fragmentIndex: number;
  cellIndex: number;
}>;

const MAX_STORYBOARD_CELLS = 100_000;

function headerEnd(
  buffer: Buffer,
  start: number,
): { index: number; length: number } | null {
  const crlf = buffer.indexOf(Buffer.from("\r\n\r\n"), start);
  const lf = buffer.indexOf(Buffer.from("\n\n"), start);
  if (crlf < 0 && lf < 0) return null;
  return crlf >= 0 && (lf < 0 || crlf <= lf)
    ? { index: crlf, length: 4 }
    : { index: lf, length: 2 };
}

export function parseMhtmlImages(buffer: Buffer): MhtmlImagePart[] {
  const root = headerEnd(buffer, 0);
  if (!root) {
    throw new UrmaError(
      "MEDIA_INVALID",
      "Storyboard MHTML root headers are incomplete",
    );
  }
  const boundary = buffer
    .subarray(0, root.index)
    .toString("utf8")
    .match(/boundary="?([^";\r\n]+)"?/i)?.[1];
  if (!boundary) {
    throw new UrmaError(
      "MEDIA_INVALID",
      "Storyboard MHTML multipart boundary is missing",
    );
  }
  const marker = Buffer.from(`--${boundary}`);
  const parts: MhtmlImagePart[] = [];
  let cursor = buffer.indexOf(marker, root.index);
  while (cursor >= 0) {
    const start = cursor + marker.length;
    if (buffer.subarray(start, start + 2).toString("ascii") === "--") break;
    const end = headerEnd(buffer, start);
    if (!end) break;
    const headers = buffer.subarray(start, end.index).toString("utf8");
    const length = Number(headers.match(/Content-Length:\s*(\d+)/i)?.[1]);
    const contentType =
      headers.match(/Content-Type:\s*([^;\r\n]+)/i)?.[1]?.trim() ??
        "application/octet-stream";
    const bodyStart = end.index + end.length;
    if (
      !Number.isFinite(length) ||
      length < 0 ||
      bodyStart + length > buffer.length
    ) {
      throw new UrmaError(
        "MEDIA_INVALID",
        "Storyboard MHTML part length is invalid",
      );
    }
    if (contentType.startsWith("image/")) {
      const seconds = Number(
        headers.match(/X\.yt-dlp\.Duration:\s*([0-9.]+)/i)?.[1],
      );
      parts.push({
        contentType,
        durationMs: Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0,
        bytes: buffer.subarray(bodyStart, bodyStart + length),
      });
    }
    cursor = buffer.indexOf(marker, bodyStart + length);
  }
  if (parts.length === 0) {
    throw new UrmaError(
      "MEDIA_INVALID",
      "Storyboard MHTML contains no image parts",
    );
  }
  return parts;
}

function layoutFor(
  format: NonNullable<ResolvedSource["formats"]>[number],
): StoryboardLayout {
  const width = format.width;
  const height = format.height;
  const fps = format.fps;
  const columns = format.columns ?? 10;
  const rows = format.rows ?? 10;
  if (
    width === null ||
    height === null ||
    fps === null ||
    !Number.isSafeInteger(width) ||
    width < 1 ||
    !Number.isSafeInteger(height) ||
    height < 1 ||
    !Number.isFinite(fps) ||
    fps <= 0 ||
    !Number.isSafeInteger(columns) ||
    columns < 1 ||
    !Number.isSafeInteger(rows) ||
    rows < 1 ||
    columns * rows > MAX_STORYBOARD_CELLS
  ) {
    throw new UrmaError(
      "STORYBOARD_UNAVAILABLE",
      "Source advertises storyboard geometry that cannot be sampled safely",
    );
  }
  return {
    width,
    height,
    fps,
    columns,
    rows,
    intervalMs: Math.max(1, Math.round(1000 / fps)),
  };
}

function storyboardCells(
  parts: readonly MhtmlImagePart[],
  layout: StoryboardLayout,
  sourceDurationMs: number,
): StoryboardCell[] {
  const cells: StoryboardCell[] = [];
  let startMs = 0;
  for (const [partIndex, part] of parts.entries()) {
    if (!Number.isSafeInteger(part.durationMs) || part.durationMs < 1) {
      throw new UrmaError(
        "STORYBOARD_UNAVAILABLE",
        "Storyboard sheet has no positive finite duration; the source cannot be mapped safely",
      );
    }
    const partEndMs = startMs + part.durationMs;
    if (!Number.isSafeInteger(partEndMs)) {
      throw new UrmaError(
        "STORYBOARD_UNAVAILABLE",
        "Storyboard sheet durations exceed the safe timestamp range",
      );
    }
    const count = Math.min(
      layout.columns * layout.rows,
      Math.max(1, Math.ceil(part.durationMs / layout.intervalMs)),
    );
    for (let cell = 0; cell < count; cell += 1) {
      const timestampMs = startMs + cell * layout.intervalMs;
      if (timestampMs >= partEndMs || timestampMs >= sourceDurationMs) break;
      cells.push({ partIndex, cell, timestampMs });
    }
    startMs = partEndMs;
  }
  return cells;
}

function lowerBound(
  cells: readonly StoryboardCell[],
  targetMs: number,
): number {
  let low = 0;
  let high = cells.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (cells[middle]!.timestampMs < targetMs) low = middle + 1;
    else high = middle;
  }
  return low;
}

function selectStoryboardCells(
  cells: readonly StoryboardCell[],
  requested: readonly number[],
  scope: StoryboardScope,
): StoryboardCell[] {
  assertInterval(scope.startMs, scope.endMs);
  for (const point of requested) {
    const timestampMs = assertMs(point, "storyboard request point");
    if (timestampMs < scope.startMs || timestampMs >= scope.endMs) {
      throw new RangeError(
        `Storyboard request point ${timestampMs} is outside [${scope.startMs},${scope.endMs})`,
      );
    }
  }
  const available = cells.filter(
    (cell) =>
      cell.timestampMs >= scope.startMs && cell.timestampMs < scope.endMs,
  );
  if (available.length === 0) {
    throw new UrmaError(
      "STORYBOARD_UNAVAILABLE",
      `Storyboard has no representative cell inside [${scope.startMs},${scope.endMs}); use another bounded evidence source`,
    );
  }
  const selected = new Map<string, StoryboardCell>();
  for (const targetMs of [...requested].sort((a, b) => a - b)) {
    const index = lowerBound(available, targetMs);
    let candidate = index > 0 ? available[index - 1] : available[0];
    if (candidate && candidate.timestampMs < scope.startMs) {
      candidate = available[index];
    }
    if (
      candidate &&
      candidate.timestampMs >= scope.startMs &&
      candidate.timestampMs < scope.endMs
    ) {
      selected.set(`${candidate.partIndex}:${candidate.cell}`, candidate);
    }
  }
  return [...selected.values()].sort(
    (a, b) =>
      a.timestampMs - b.timestampMs ||
      a.partIndex - b.partIndex ||
      a.cell - b.cell,
  );
}

export class StoryboardAcquirer {
  constructor(
    readonly config: UrmaConfig,
    readonly store: UrmaStore,
    readonly blobs: BlobStore,
    readonly remoteContext: RemoteOperationContext | null = null,
  ) {}

  async cells(
    source: ResolvedSource,
    investigationRef: InvestigationRef,
    requested: readonly number[],
    working: string,
    signal?: AbortSignal,
    scope: StoryboardScope = { startMs: 0, endMs: source.durationMs },
  ): Promise<{
    paths: string[];
    pointsMs: number[];
    samples: StoryboardSample[];
    artifact: StoredArtifact;
    cacheHit: boolean;
  }> {
    assertInterval(scope.startMs, scope.endMs, source.durationMs);
    const format = [...source.formats]
      .filter((item) => item.ext === "mhtml" || item.protocol === "mhtml")
      .sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0];
    if (!format) {
      throw new UrmaError(
        "STORYBOARD_UNAVAILABLE",
        "Source advertises no usable timestamped native storyboard",
      );
    }
    const layout = layoutFor(format);
    const requestKey = deterministicRequestKey(
      source.revision,
      "storyboard",
      {
        candidateKey: candidateKeyForSourceFormat(source, format),
        formatId: format.id,
      },
      "storyboard-parser",
    );
    let artifact = this.store.getArtifactByRequest(requestKey);
    let bytes: Buffer;
    let cacheHit = false;
    const acquisitionBudget = Math.min(
      this.config.limits.maxNavigationCopyBytes,
      this.config.limits.resourceBytes,
    );
    if (artifact) {
      try {
        bytes = await this.blobs.read(
          artifact.artifactId,
          artifact.blobPath,
          acquisitionBudget,
        );
        cacheHit = true;
      } catch {
        artifact = null;
      }
    }
    if (!artifact) {
      const acquisition = startAcquisition(this.store, {
        sourceRef: source.sourceRef,
        sourceRevision: source.revision,
        investigationRef,
        operation: "acquire-storyboard",
        requestKey,
        method: "yt-dlp-storyboard",
        debug: this.config.debug,
      });
      try {
        const budget = acquisitionBudget;
        assertExpectedRemoteBytes(format.estimatedBytes, budget, "storyboard");
        artifact = await withRemoteAcquisitionDirectory(
          this.config,
          "storyboard",
          budget,
          signal,
          async (temporary, remoteSignal) => {
            const ytdlp = new YtDlp(this.config, undefined, this.remoteContext);
            const exact = await ytdlp.exactFormatSnapshot(
              source,
              format,
              remoteSignal,
            );
            const infoPath = path.join(temporary, "snapshot-info.json");
            await writeFile(infoPath, JSON.stringify(exact.metadata), "utf8");
            await ytdlp.run(
              [
                "--load-info-json",
                infoPath,
                "-f",
                exact.formatId,
                "--paths",
                temporary,
                "-o",
                "storyboard.%(ext)s",
              ],
              {
                signal: remoteSignal,
                timeoutMs: this.config.limits.maxRemoteAcquisitionWallMs,
                remote: true,
              },
            );
            await assertRemoteDirectoryWithinBudget(
              temporary,
              budget,
              "storyboard",
            );
            const names = (await readdir(temporary)).filter((item) =>
              /^[A-Za-z0-9_.-]{1,200}\.mhtml$/u.test(item)
            );
            if (names.length !== 1) {
              throw new UrmaError(
                "STORYBOARD_UNAVAILABLE",
                names.length === 0
                  ? "yt-dlp completed without the requested MHTML storyboard"
                  : "yt-dlp completed with ambiguous MHTML storyboard outputs",
              );
            }
            bytes = await readFile(path.join(temporary, names[0]!));
            const parts = parseMhtmlImages(bytes);
            storyboardCells(parts, layout, source.durationMs);
            const blob = await this.blobs.put(bytes);
            const versions = await collectBinaryVersions(
              this.config,
              ["ytdlp"],
              remoteSignal,
            );
            const stored: StoredArtifact = {
              artifactId: blob.artifactId,
              sourceRef: source.sourceRef,
              sourceRevision: source.revision,
              kind: "storyboard",
              role: "locator",
              mimeType: "multipart/related",
              sha256: blob.sha256,
              byteSize: blob.byteSize,
              blobPath: blob.relativePath,
              startMs: 0,
              endMs: source.durationMs,
              params: {
                candidateKey: candidateKeyForSourceFormat(source, format),
                formatId: format.id,
              },
              producer: {
                version: "storyboard-parser",
                urmaVersion: URMA_VERSION,
                ...versions,
                cellWidth: format.width,
                cellHeight: format.height,
                fps: format.fps,
                columns: format.columns,
                rows: format.rows,
              },
              createdAt: new Date().toISOString(),
            };
            this.store.putArtifact(stored, {
              requestKey,
              operation: "storyboard",
            });
            acquisition.succeed({
              networkBytes: null,
              networkAccountingComplete: false,
              metadata: { artifactId: stored.artifactId, ...versions },
            });
            return stored;
          },
        );
      } catch (error) {
        acquisition.fail(error);
        throw error;
      }
    }
    const parts = parseMhtmlImages(bytes!);
    const selected = selectStoryboardCells(
      storyboardCells(parts, layout, source.durationMs),
      requested,
      scope,
    );
    const emittedSprites = new Map<number, string>();
    const paths: string[] = [];
    const pointsMs: number[] = [];
    const ffmpeg = new Ffmpeg(this.config);
    const samples: StoryboardSample[] = [];
    for (const [index, cell] of selected.entries()) {
      let sprite = emittedSprites.get(cell.partIndex);
      if (!sprite) {
        sprite = path.join(working, `sprite-${cell.partIndex}.img`);
        await writeFile(sprite, parts[cell.partIndex]!.bytes);
        emittedSprites.set(cell.partIndex, sprite);
      }
      const output = path.join(working, `cell-${index}.jpg`);
      await ffmpeg.cropJpeg(
        sprite,
        {
          width: layout.width,
          height: layout.height,
          x: (cell.cell % layout.columns) * layout.width,
          y: Math.floor(cell.cell / layout.columns) * layout.height,
        },
        output,
        signal,
      );
      await ffmpeg.validateJpeg(output);
      paths.push(output);
      pointsMs.push(cell.timestampMs);
      samples.push({
        timestampMs: cell.timestampMs,
        fragmentIndex: cell.partIndex,
        cellIndex: cell.cell,
      });
    }
    return { paths, pointsMs, samples, artifact, cacheHit };
  }
}
