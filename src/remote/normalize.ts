import {
  remoteSourceRef,
  sha256,
  snapshotCandidateKey,
  stableJson,
  type RemoteIdentity,
} from "../core/ids.js";
import { UrmaError } from "../core/errors.js";
import type { FiniteTimeline } from "../core/model.js";
import { assertRemoteTargetAllowed } from "./egress.js";
import { videoCodecForFormat } from "./formats.js";
import { assertRemotePolicy, REMOTE_POLICY_VERSION } from "./policy.js";
import { makeCaptionTrack } from "../sources/caption-tracks.js";
import type {
  CaptionTrackSummary,
  FormatSummary,
  ResolvedSource,
} from "../sources/types.js";
import type { SourceRef } from "../core/ids.js";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function milliseconds(value: unknown): number {
  return Math.max(0, Math.round((number(value) ?? 0) * 1000));
}
function originOf(value: unknown): string | null {
  const url = text(value);
  if (!url) return null;
  const parsed = assertRemoteTargetAllowed({ url, purpose: "manifest" });
  return parsed.origin;
}
function originsFrom(info: Record<string, unknown>, inputUrl: string, canonicalUrl: string): string[] {
  const output = new Set<string>();
  for (const candidate of [
    inputUrl,
    canonicalUrl,
    info.webpage_url,
    info.original_url,
    info.redirected_url,
    info.manifest_url,
  ]) {
    const origin = originOf(candidate);
    if (origin) output.add(origin);
  }
  for (const format of Array.isArray(info.formats) ? info.formats.filter(record) : []) {
    const origin = originOf(format.url) ?? originOf(format.manifest_url);
    if (origin) output.add(origin);
  }
  for (const key of ["subtitles", "automatic_captions"] as const) {
    const groups = info[key];
    if (!record(groups)) continue;
    for (const variants of Object.values(groups)) {
      if (!Array.isArray(variants)) continue;
      for (const variant of variants.filter(record)) {
        const origin = originOf(variant.url);
        if (origin) output.add(origin);
      }
    }
  }
  return [...output].sort();
}
function formatSummary(
  format: Record<string, unknown>,
  snapshot: { sourceRef: SourceRef; revision: string },
): FormatSummary | null {
  const id = text(format.format_id)?.slice(0, 128) ?? null;
  if (!id || !/^[A-Za-z0-9_.-]{1,128}$/u.test(id)) return null;
  const description = {
    formatId: id,
    ext: text(format.ext)?.slice(0, 32) ?? null,
    protocol: text(format.protocol)?.slice(0, 64) ?? null,
    width: number(format.width),
    height: number(format.height),
    fps: number(format.fps),
    videoCodec: videoCodecForFormat(format)?.slice(0, 128) ?? null,
    audioCodec: text(format.acodec)?.slice(0, 128) ?? null,
    estimatedBytes: number(format.filesize) ?? number(format.filesize_approx),
    rows: number(format.rows),
    columns: number(format.columns),
  };
  return {
    id,
    candidateKey: snapshotCandidateKey(snapshot, description),
    ...description,
  };
}
function captions(
  info: Record<string, unknown>,
  sourceRef: SourceRef,
  revision: string,
  extractor: string,
): CaptionTrackSummary[] {
  const output: CaptionTrackSummary[] = [];
  for (const [key, kind] of [["subtitles", "manual"], ["automatic_captions", "automatic"]] as const) {
    const groups = info[key];
    if (!record(groups)) continue;
    for (const [language, raw] of Object.entries(groups)) {
      if (!/^[A-Za-z0-9._-]{1,100}$/u.test(language)) continue;
      const variants = Array.isArray(raw) ? raw.filter(record) : [];
      for (const [index, variant] of variants.entries()) {
        const extension = (text(variant.ext) ?? "").toLowerCase();
        const format = extension === "json"
          ? "json3"
          : extension === "json3" || extension === "vtt" || extension === "srt"
          ? extension
          : null;
        if (!format) continue;
        const providerVariantId = `${extractor}:${kind}:${language}:${index}:${sha256(stableJson({
          name: text(variant.name),
          ext: extension,
          protocol: text(variant.protocol),
        })).slice(0, 16)}`;
        output.push(makeCaptionTrack(sourceRef, revision, {
          language,
          kind,
          displayName: text(variant.name)?.slice(0, 200) ?? null,
          formats: [format],
          providerTrackId: providerVariantId,
          variants: [{ variantId: providerVariantId, format, providerVariantId }],
        }));
      }
    }
  }
  return output.sort((a, b) => a.language.localeCompare(b.language) || a.kind.localeCompare(b.kind));
}

export function remoteIdentityForResolution(
  info: Readonly<Record<string, unknown>>,
  canonicalUrl: string,
): RemoteIdentity {
  const declaredExtractorKey = text(info.extractor_key) ?? text(info.ie_key);
  const id = text(info.id);
  if (
    id &&
    declaredExtractorKey !== null &&
    /^[a-z0-9][a-z0-9._-]{0,63}$/u.test(declaredExtractorKey.toLowerCase())
  ) {
    return {
      basis: "extractor",
      namespace: declaredExtractorKey.toLowerCase(),
      id,
    };
  }
  return {
    basis: "locator",
    locatorDigest: sha256(new URL(canonicalUrl).toString()),
  };
}

export type RemoteResolutionResult = Readonly<{
  inputUrl: string;
  canonicalUrl: string;
  metadata: Readonly<Record<string, unknown>>;
  timeline: FiniteTimeline;
  redirectUrls?: readonly string[];
  webpageUrls?: readonly string[];
  deliveryUrls?: readonly string[];
}>;

export function normalizeRemoteResolution(
  resolution: RemoteResolutionResult,
  revision: string,
): ResolvedSource {
  const info = resolution.metadata;
  const declaredExtractor = text(info.extractor) ?? text(info.ie_key);
  const declaredExtractorKey = text(info.extractor_key) ?? declaredExtractor;
  const extractor = declaredExtractor ?? "generic";
  const extractorKey = declaredExtractorKey ?? "generic";
  const id = text(info.id);
  if (
    !resolution.timeline.finite ||
    !Number.isSafeInteger(resolution.timeline.durationMs) ||
    resolution.timeline.durationMs < 1 ||
    !["progressive", "hls", "dash", "container"].includes(resolution.timeline.basis) ||
    typeof resolution.timeline.validatedAt !== "string" ||
    resolution.timeline.validatedAt.length === 0
  ) {
    throw new UrmaError(
      "SOURCE_UNAVAILABLE",
      "Remote resolver did not establish a valid positive finite timeline",
      { detail: { timelineValidation: "invalid-resolution-result" } },
    );
  }
  assertRemoteTargetAllowed({ url: resolution.canonicalUrl, purpose: "input" });
  const origins = originsFrom(info, resolution.inputUrl, resolution.canonicalUrl);
  for (const url of [
    ...(resolution.redirectUrls ?? []),
    ...(resolution.webpageUrls ?? []),
    ...(resolution.deliveryUrls ?? []),
  ]) {
    const origin = originOf(url);
    if (origin) origins.push(origin);
  }
  const uniqueOrigins = [...new Set(origins)].sort();
  const inputOrigin = originOf(resolution.inputUrl);
  if (!inputOrigin) throw new Error("Remote resolver input has no safe origin");
  assertRemotePolicy({
    inputOrigin,
    redirectOrigins: uniqueOrigins,
    webpageOrigins: uniqueOrigins,
    deliveryOrigins: uniqueOrigins,
    extractor,
    extractorKey,
    resultClass: text(info._type),
    metadata: info,
  });
  const identity = remoteIdentityForResolution(info, resolution.canonicalUrl);
  const sourceRef = remoteSourceRef(identity);
  const snapshot = { sourceRef, revision };
  const allFormats = (Array.isArray(info.formats) ? info.formats.filter(record) : [])
    .map((format) => formatSummary(format, snapshot))
    .filter((format): format is FormatSummary => format !== null)
    .slice(0, 2000);
  const tracks = captions(info, sourceRef, revision, extractorKey.toLowerCase());
  const chapters = (Array.isArray(info.chapters) ? info.chapters.filter(record) : [])
    .map((chapter) => ({
      startMs: milliseconds(chapter.start_time),
      endMs: milliseconds(chapter.end_time),
      title: (text(chapter.title) ?? "untitled chapter").slice(0, 1000),
    }))
    .filter((chapter) => chapter.endMs > chapter.startMs)
    .slice(0, 500);
  const title = (text(info.title) ?? id ?? resolution.canonicalUrl).slice(0, 1000);
  const media = allFormats.filter((format) => format.ext !== "mhtml" && format.protocol !== "mhtml");
  const storyboard = allFormats.some((format) => format.ext === "mhtml" || format.protocol === "mhtml");
  const metadataDurationMs = number(info.duration) === null ? null : milliseconds(info.duration);
  return {
    sourceRef,
    kind: "remote",
    identity,
    snapshotRef: snapshot,
    canonicalKey: id ?? resolution.canonicalUrl,
    canonicalLocator: resolution.canonicalUrl,
    revision,
    observedAt: new Date().toISOString(),
    title,
    durationMs: resolution.timeline.durationMs,
    metadataDurationMs,
    timeline: resolution.timeline,
    extractor,
    extractorKey,
    liveState: "finite",
    safeOrigins: uniqueOrigins,
    resolverVersion: "yt-dlp",
    normalizationVersion: "remote-normalization-v1",
    policyVersion: REMOTE_POLICY_VERSION,
    chapters,
    captionTracks: tracks,
    formats: allFormats,
    capabilities: {
      nativeCaptions: tracks.length > 0,
      chapters: chapters.length > 0,
      nativeStoryboard: storyboard,
      targetedMedia: media.some((format) => ["m3u8", "m3u8_native", "http", "https", "http_dash_segments"].includes(format.protocol ?? "")),
      audio: media.some((format) => format.audioCodec !== null && format.audioCodec !== "none"),
      progressive: media.some((format) => format.protocol === "https" || format.protocol === "http"),
      hls: media.some((format) => format.protocol?.startsWith("m3u8") === true),
      dash: media.some((format) => format.protocol === "http_dash_segments"),
      mhtml: storyboard,
    },
    safeMetadata: {
      channel: text(info.channel)?.slice(0, 1000) ?? null,
      uploaderId: text(info.uploader_id)?.slice(0, 1000) ?? null,
      availability: text(info.availability)?.slice(0, 100) ?? null,
      titlePartial: title.length < (text(info.title) ?? id ?? resolution.canonicalUrl).length,
      chapterCount: Array.isArray(info.chapters) ? info.chapters.length : 0,
      chaptersPartial: Array.isArray(info.chapters) && info.chapters.length > chapters.length,
    },
    remoteAcquisition: "safe-proxy",
  };
}
