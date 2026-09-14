import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { UrmaConfig } from "../config.js";
import { UrmaError } from "../core/errors.js";
import { deterministicRequestKey } from "../core/request-key.js";
import { parseTrackRef } from "../core/ids.js";
import type { InvestigationRef, TrackRef } from "../core/ids.js";
import type { TranscriptKind } from "../core/model.js";
import { BlobStore } from "../store/blob-store.js";
import type {
  StoredArtifact,
  StoredSegment,
  StoredTrack,
  UrmaStore,
} from "../store/store.js";
import { YtDlp } from "../subprocess/ytdlp.js";
import { ensureRemoteProxy, type RemoteOperationContext } from "../remote/worker.js";
import { collectBinaryVersions } from "../subprocess/versions.js";
import { URMA_VERSION } from "../version.js";
import type { CaptionTrackSummary, ResolvedSource } from "../sources/types.js";
import { parseLocalSnapshot } from "../sources/local.js";
import { startAcquisition } from "./records.js";
import {
  assertRemoteDirectoryWithinBudget,
  withRemoteAcquisitionDirectory,
} from "./remote-budget.js";

function cleanText(value: string): string {
  return value
    .replace(/<\/?(?:c(?:\.[^>]*)?|v(?:\s[^>]*)?|i|b|u|ruby|rt)>/gi, "")
    .replace(/<\d{1,2}:\d{2}(?::\d{2})?\.\d{3}>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, " ")
    .trim();
}
function timeMs(value: string): number {
  const pieces = value.split(":").map(Number);
  return Math.round(
    pieces.reduce((total, piece) => total * 60 + piece, 0) * 1000,
  );
}

export function parseJson3Captions(
  value: string,
  trackId: string,
): Omit<StoredSegment, "id">[] {
  const document = JSON.parse(value) as {
    events?: Array<Record<string, unknown>>;
  };
  const output: Omit<StoredSegment, "id">[] = [];
  for (const event of document.events ?? []) {
    const startMs = Number(event.tStartMs);
    const durationMs = Number(event.dDurationMs ?? 0);
    const chunks = Array.isArray(event.segs)
      ? (event.segs as Array<Record<string, unknown>>)
      : [];
    const text = cleanText(
      chunks
        .map((chunk) => (typeof chunk.utf8 === "string" ? chunk.utf8 : ""))
        .join(""),
    );
    if (!Number.isFinite(startMs) || !text) continue;
    output.push({
      trackId,
      startMs: Math.max(0, Math.round(startMs)),
      endMs: Math.max(
        Math.round(startMs),
        Math.round(startMs + (Number.isFinite(durationMs) ? durationMs : 0)),
      ),
      text,
      ordinal: output.length,
    });
  }
  return output;
}
export function parseVttCaptions(
  value: string,
  trackId: string,
): Omit<StoredSegment, "id">[] {
  const blocks = value
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/);
  const output: Omit<StoredSegment, "id">[] = [];
  const timing =
    /(?<start>(?:\d{1,2}:)?\d{2}:\d{2}\.\d{3})\s+-->\s+(?<end>(?:\d{1,2}:)?\d{2}:\d{2}\.\d{3})/;
  for (const block of blocks) {
    const lines = block.split("\n");
    const index = lines.findIndex((line) => timing.test(line));
    const match = index < 0 ? null : lines[index]!.match(timing);
    const text = cleanText(lines.slice(index + 1).join("\n"));
    if (!match?.groups || !text) continue;
    output.push({
      trackId,
      startMs: timeMs(match.groups.start!),
      endMs: timeMs(match.groups.end!),
      text,
      ordinal: output.length,
    });
  }
  return output;
}
export function parseSrtCaptions(
  value: string,
  trackId: string,
): Omit<StoredSegment, "id">[] {
  return parseVttCaptions(
    value.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2"),
    trackId,
  );
}

export function chooseTrack(
  tracks: readonly CaptionTrackSummary[],
  preferredLanguage: string | null = null,
): CaptionTrackSummary | null {
  return (
    [...tracks].sort((a, b) => {
      const preferred = preferredLanguage?.toLowerCase() ?? null;
      const language = (track: CaptionTrackSummary) => {
        const value = track.language.toLowerCase();
        if (preferred && value === preferred) return 0;
        if (preferred && value.split("-")[0] === preferred.split("-")[0]) {
          return 1;
        }
        if (value === "en") return 2;
        if (value.startsWith("en-")) return 3;
        return 4;
      };
      const kind = (track: CaptionTrackSummary) =>
        track.kind === "manual"
          ? 0
          : track.kind === "sidecar"
          ? 1
          : track.kind === "automatic"
          ? 2
          : 3;
      const lexical = a.language < b.language
        ? -1
        : a.language > b.language
        ? 1
        : a.trackRef < b.trackRef
        ? -1
        : a.trackRef > b.trackRef
        ? 1
        : 0;
      return kind(a) - kind(b) || language(a) - language(b) || lexical;
    })[0] ?? null
  );
}
export function selectTrack(
  source: ResolvedSource,
  requested: string | undefined,
): CaptionTrackSummary {
  if (requested !== undefined) {
    let ref: TrackRef;
    try {
      ref = parseTrackRef(requested);
    } catch (error) {
      throw new UrmaError(
        "INVALID_SOURCE",
        "Caption trackRef is malformed or does not belong to this source revision",
        { cause: error },
      );
    }
    const selected = source.captionTracks.find(
      (track) => track.trackRef === ref,
    );
    if (!selected) {
      throw new UrmaError(
        "INVALID_SOURCE",
        "Caption trackRef is unavailable for this source revision; use a trackRef returned by inspect_video",
      );
    }
    return selected;
  }
  const preferred = typeof source.safeMetadata.originalLanguage === "string"
    ? source.safeMetadata.originalLanguage
    : null;
  const selected = chooseTrack(source.captionTracks, preferred);
  if (!selected) {
    throw new UrmaError(
      "CAPTIONS_UNAVAILABLE",
      "This source has no supported native or allowed local sidecar caption track; Urma v0.1 does not perform speech-to-text",
    );
  }
  return selected;
}
export function transcriptTrackId(trackRef: TrackRef): string {
  return `track:${trackRef.slice("urma:track:".length)}`;
}

export class TranscriptAcquirer {
  constructor(
    readonly config: UrmaConfig,
    readonly store: UrmaStore,
    readonly blobs: BlobStore,
    readonly remoteContext: RemoteOperationContext | null = null,
  ) {}
  async ensure(
    source: ResolvedSource,
    investigationRef: InvestigationRef,
    requestedTrackRef?: string,
    signal?: AbortSignal,
  ): Promise<{
    track: StoredTrack;
    segments: StoredSegment[];
    artifact: StoredArtifact;
    cacheHit: boolean;
  }> {
    const selected = selectTrack(source, requestedTrackRef);
    const trackId = transcriptTrackId(selected.trackRef);
    const cached = this.store
      .listTranscriptTracks(source.sourceRef, source.revision)
      .find((track) => track.id === trackId);
    if (cached) {
      const artifacts = this.store.listArtifacts(
        source.sourceRef,
        source.revision,
      );
      const artifact = artifacts.find(
        (item) => item.kind === "caption" && item.params.trackId === cached.id,
      );
      if (artifact) {
        try {
          await this.blobs.verify(artifact.artifactId, artifact.blobPath);
          const acquisition = startAcquisition(this.store, {
            sourceRef: source.sourceRef,
            sourceRevision: source.revision,
            investigationRef,
            operation: "transcript-cache",
            requestKey: `cache:${cached.id}`,
            method: "cache",
            debug: this.config.debug,
          });
          acquisition.succeed({
            networkBytes: 0,
            networkAccountingComplete: true,
            metadata: {
              artifactId: artifact.artifactId,
              trackRef: selected.trackRef,
              providerTrackId: selected.providerTrackId,
              cacheHit: true,
            },
          });
          return {
            track: cached,
            segments: this.store.listTranscriptSegments(cached.id),
            artifact,
            cacheHit: true,
          };
        } catch {
          /* reacquire corrupt or missing caption bytes */
        }
      }
    }
    if (selected.kind === "unknown") {
      throw new UrmaError(
        "CAPTIONS_UNAVAILABLE",
        "The selected caption track has an unknown origin and cannot be acquired safely; choose a manual, automatic, or sidecar track",
      );
    }
    if (selected.kind !== "sidecar") {
      await ensureRemoteProxy(this.remoteContext);
    }
    const requestKey = deterministicRequestKey(
      source.revision,
      "transcript",
      {
        trackRef: selected.trackRef,
        language: selected.language,
        kind: selected.kind,
      },
      "transcript-parser",
    );
    const acquisition = startAcquisition(this.store, {
      sourceRef: source.sourceRef,
      sourceRevision: source.revision,
      investigationRef,
      operation: "acquire-transcript",
      requestKey,
      method: selected.kind === "sidecar" ? "local-file" : "yt-dlp-caption",
      debug: this.config.debug,
    });
    try {
      let body: string;
      let extension: string;
      let bytes: Buffer;
      if (selected.kind === "sidecar") {
        const snapshot = source.kind === "local"
          ? parseLocalSnapshot(source.safeMetadata.localSnapshot)
          : null;
        if (!snapshot?.caption) {
          throw new UrmaError(
            "CAPTIONS_UNAVAILABLE",
            "Local source advertised captions but its pinned sidecar content is unavailable; inspect the source again",
          );
        }
        bytes = await this.blobs.read(
          snapshot.caption.artifactId,
          snapshot.caption.blobPath,
          this.config.limits.resourceBytes,
        );
        body = bytes.toString("utf8");
        extension = snapshot.caption.extension ??
          `.${selected.formats[0] ?? "vtt"}`.toLowerCase();
      } else {
        const downloaded = await withRemoteAcquisitionDirectory(
          this.config,
          "caption",
          this.config.limits.resourceBytes,
          signal,
          async (temporary, remoteSignal) => {
            const flag = selected.kind === "manual"
              ? "--write-subs"
              : "--write-auto-subs";
            await new YtDlp(this.config, undefined, this.remoteContext).run(
              [
                "--skip-download",
                flag,
                "--sub-langs",
                selected.language,
                "--sub-format",
                selected.formats.length > 0
                  ? `${selected.formats.join("/")}/best`
                  : "json3/vtt/srt/best",
                "--paths",
                temporary,
                "-o",
                "caption.%(ext)s",
                source.canonicalLocator,
              ],
              {
                signal: remoteSignal,
                timeoutMs: this.config.limits.maxRemoteAcquisitionWallMs,
                remote: true,
              },
            );
            await assertRemoteDirectoryWithinBudget(
              temporary,
              this.config.limits.resourceBytes,
              "caption",
            );
            const names = (await readdir(temporary)).filter((item) =>
              /^caption(?:\.[A-Za-z0-9._-]{1,128})?\.(?:json3|vtt|srt)$/u.test(item)
            );
            const preferredNames = selected.formats
              .map((format) => `.${format.toLowerCase()}`)
              .flatMap((suffix) => names.filter((item) => item.toLowerCase().endsWith(suffix)));
            const fallbackNames = names.filter((item) =>
              item.toLowerCase().endsWith(".json3") ||
              item.toLowerCase().endsWith(".vtt") ||
              item.toLowerCase().endsWith(".srt")
            );
            const candidates = preferredNames.length > 0 ? preferredNames : fallbackNames;
            if (candidates.length !== 1) {
              throw new UrmaError(
                "CAPTIONS_UNAVAILABLE",
                candidates.length === 0
                  ? "yt-dlp completed without a JSON3, VTT, or SRT caption artifact; update yt-dlp or choose another captioned source"
                  : "yt-dlp completed with ambiguous caption artifacts for the selected track",
              );
            }
            return {
              bytes: await readFile(path.join(temporary, candidates[0]!)),
              extension: path.extname(candidates[0]!).toLowerCase(),
            };
          },
        );
        bytes = downloaded.bytes;
        body = bytes.toString("utf8");
        extension = downloaded.extension;
      }
      const parsed = extension === ".json3"
        ? parseJson3Captions(body, trackId)
        : extension === ".srt"
        ? parseSrtCaptions(body, trackId)
        : parseVttCaptions(body, trackId);
      if (parsed.length === 0) {
        throw new UrmaError(
          "CAPTIONS_UNAVAILABLE",
          "Caption artifact parsed successfully but contained no textual timestamped segments",
        );
      }
      if (parsed.some((segment) => segment.text.length > 16_000)) {
        throw new UrmaError(
          "OUTPUT_LIMIT_EXCEEDED",
          "Caption artifact contains an individual cue above the 16,000-character safety ceiling; split or repair the caption track before importing it",
        );
      }
      const blob = await this.blobs.put(bytes, () => {
        if (parsed.length === 0) throw new Error("empty captions");
      });
      const acquiredAt = new Date().toISOString();
      const versions = await collectBinaryVersions(
        this.config,
        selected.kind === "sidecar" ? [] : ["ytdlp"],
        signal,
      );
      const track: StoredTrack = {
        id: trackId,
        sourceRef: source.sourceRef,
        sourceRevision: source.revision,
        language: selected.language,
        kind: selected.kind as TranscriptKind,
        providerTrackId: selected.providerTrackId,
        acquiredAt,
        metadata: {
          parser: "transcript-parser",
          segmentCount: parsed.length,
          trackRef: selected.trackRef,
          displayName: selected.displayName,
        },
      };
      this.store.putTranscript(track, parsed);
      const artifact: StoredArtifact = {
        artifactId: blob.artifactId,
        sourceRef: source.sourceRef,
        sourceRevision: source.revision,
        kind: "caption",
        role: "evidence",
        mimeType: extension === ".json3"
          ? "application/json"
          : extension === ".srt"
          ? "application/x-subrip"
          : "text/vtt",
        sha256: blob.sha256,
        byteSize: blob.byteSize,
        blobPath: blob.relativePath,
        startMs: 0,
        endMs: parsed.at(-1)!.endMs,
        params: {
          trackId,
          trackRef: selected.trackRef,
          language: selected.language,
          kind: selected.kind,
          providerTrackId: selected.providerTrackId,
        },
        producer: {
          version: "transcript-parser",
          urmaVersion: URMA_VERSION,
          ...versions,
        },
        createdAt: acquiredAt,
      };
      this.store.putArtifact(artifact, { requestKey, operation: "transcript" });
      acquisition.succeed({
        networkBytes: selected.kind === "sidecar" ? 0 : null,
        networkAccountingComplete: selected.kind === "sidecar",
        metadata: {
          artifactId: artifact.artifactId,
          trackRef: selected.trackRef,
          providerTrackId: selected.providerTrackId,
          segments: parsed.length,
          ...versions,
        },
      });
      return {
        track,
        segments: this.store.listTranscriptSegments(track.id),
        artifact,
        cacheHit: false,
      };
    } catch (error) {
      acquisition.fail(error);
      throw error;
    }
  }
}
