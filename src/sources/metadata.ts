import path from "node:path";
import { readdir } from "node:fs/promises";
import type { UrmaConfig } from "../config.js";
import { normalizeError, UrmaError } from "../core/errors.js";
import {
  createSnapshotRevision,
  remoteSourceRef,
  sha256,
  snapshotCandidateKey,
  stableJson,
} from "../core/ids.js";
import { Ffprobe } from "../subprocess/ffprobe.js";
import { YtDlp } from "../subprocess/ytdlp.js";
import {
  assertRemoteDirectoryWithinBudget,
  withRemoteAcquisitionDirectory,
} from "../acquisition/remote-budget.js";
import {
  admitValidatedTimeline,
  validateFiniteHlsManifest,
  validateStaticDashManifest,
  validateProgressiveProbe,
} from "./timeline.js";
import {
  localSnapshotForBundle,
  localSnapshotRevision,
  pinLocalBundle,
  resolveLocalBundle,
  type PinnedLocalBundle,
} from "./local.js";
import type { BlobStore } from "../store/blob-store.js";
import type {
  CaptionTrackSummary,
  FormatSummary,
  ResolvedSource,
} from "./types.js";
import { parseYouTubeUrl } from "./youtube.js";
import { makeCaptionTrack } from "./caption-tracks.js";
import type { SourceRef } from "../core/ids.js";
import { safeFormatDescription } from "./candidates.js";
import { assertRemoteTargetAllowed } from "../remote/egress.js";
import { assertRemotePolicy, REMOTE_POLICY_VERSION } from "../remote/policy.js";
import type { RemoteOperationContext } from "../remote/worker.js";
import {
  normalizeRemoteResolution,
  remoteIdentityForResolution,
  type RemoteResolutionResult,
} from "../remote/normalize.js";
import { videoCodecForFormat } from "../remote/formats.js";
import type { RemoteIdentity } from "../core/ids.js";
import {
  parseVideoStreamCoverage,
  serializeVideoPtsCoverage,
} from "../acquisition/video-timing.js";

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

function remoteOrigins(
  info: Record<string, unknown>,
  inputOrigin: string,
  canonicalUrl: string,
): string[] {
  const origins = new Set<string>([inputOrigin]);
  const add = (value: unknown) => {
    const url = text(value);
    if (!url) return;
    origins.add(assertRemoteTargetAllowed({ url, purpose: "manifest" }).origin);
  };
  for (const value of [
    canonicalUrl,
    info.webpage_url,
    info.original_url,
    info.redirected_url,
    info.manifest_url,
  ]) add(value);
  for (const format of Array.isArray(info.formats) ? info.formats.filter(record) : []) {
    add(format.url);
    add(format.manifest_url);
  }
  return [...origins].sort();
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function formats(
  info: Record<string, unknown>,
  sourceRef: SourceRef,
  revision: string,
): FormatSummary[] {
  return (Array.isArray(info.formats) ? info.formats.filter(record) : [])
    .map((format) => {
      const id = String(format.format_id ?? "unknown").slice(0, 128);
      const summary: FormatSummary = {
        id,
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
      const candidateKey = snapshotCandidateKey(
        { sourceRef, revision },
        safeFormatDescription(summary),
      );
      return {
        ...summary,
        candidateKey,
      };
    })
    .filter((format) => /^[A-Za-z0-9_.-]{1,128}$/.test(format.id))
    .slice(0, 2000);
}

function timelineBasisForProtocol(
  protocol: string | null,
): "progressive" | "hls" | "dash" {
  if (protocol?.startsWith("m3u8") === true) return "hls";
  if (protocol === "http_dash_segments") return "dash";
  return "progressive";
}

async function validateHlsTransport(
  ytdlp: YtDlp,
  deliveryUrl: string,
  selected: FormatSummary,
  config: UrmaConfig,
  signal: AbortSignal | undefined,
): Promise<ReturnType<typeof validateFiniteHlsManifest>> {
  const budget = { maxBytes: config.limits.maxNavigationCopyBytes };
  let manifest = await ytdlp.manifestText(deliveryUrl, signal);
  if (/#EXT-X-STREAM-INF:/iu.test(manifest)) {
    const transport = await ytdlp.metadata(deliveryUrl, signal);
    const variants = (Array.isArray(transport.formats)
      ? transport.formats.filter(record)
      : [])
      .filter((format) => {
        const protocol = text(format.protocol);
        const url = text(format.url) ?? text(format.manifest_url);
        return url !== null && protocol?.startsWith("m3u8") === true &&
          videoCodecForFormat(format) !== null &&
          videoCodecForFormat(format) !== "none";
      })
      .sort(
        (a, b) =>
          Number(String(a.format_id ?? "") !== (selected.formatId ?? selected.id)) -
            Number(String(b.format_id ?? "") !== (selected.formatId ?? selected.id)) ||
          Math.abs((number(a.height) ?? Number.MAX_SAFE_INTEGER) - (selected.height ?? Number.MAX_SAFE_INTEGER)) -
            Math.abs((number(b.height) ?? Number.MAX_SAFE_INTEGER) - (selected.height ?? Number.MAX_SAFE_INTEGER)) ||
          String(a.format_id ?? "").localeCompare(String(b.format_id ?? "")),
      );
    const variant = variants[0];
    const variantUrl = variant
      ? text(variant.url) ?? text(variant.manifest_url)
      : null;
    if (!variantUrl) {
      throw new UrmaError(
        "SOURCE_UNAVAILABLE",
        "HLS master playlist did not expose one safe media-playlist variant",
        { detail: { timelineValidation: "hls-variant" } },
      );
    }
    assertRemoteTargetAllowed({ url: variantUrl, purpose: "manifest" });
    manifest = await ytdlp.manifestText(variantUrl, signal);
  }
  return validateFiniteHlsManifest(manifest, budget);
}

export async function validateRemoteTransport(
  config: UrmaConfig,
  canonicalUrl: string,
  sourceRef: SourceRef,
  revision: string,
  candidates: readonly FormatSummary[],
  metadataDurationMs: number | null,
  remoteContext: RemoteOperationContext | null | undefined,
  signal?: AbortSignal,
  pinnedIdentity?: RemoteIdentity,
) {
  const selected = [...candidates]
    .filter((format) =>
      format.videoCodec !== null &&
      format.videoCodec !== "none" &&
      format.ext !== "mhtml" &&
      format.protocol !== "mhtml"
    )
    .filter((format) =>
      format.estimatedBytes === null ||
      format.estimatedBytes <= config.limits.maxNavigationCopyBytes
    )
    .sort(
      (a, b) =>
        (Number(!(
          a.protocol?.startsWith("m3u8") === true ||
          a.protocol === "http_dash_segments"
        )) - Number(!(
          b.protocol?.startsWith("m3u8") === true ||
          b.protocol === "http_dash_segments"
        ))) ||
        (a.height ?? Number.MAX_SAFE_INTEGER) -
          (b.height ?? Number.MAX_SAFE_INTEGER) ||
        (a.estimatedBytes ?? Number.MAX_SAFE_INTEGER) -
          (b.estimatedBytes ?? Number.MAX_SAFE_INTEGER) ||
        a.id.localeCompare(b.id),
    )[0];
  if (!selected) {
    throw new UrmaError(
      "SOURCE_UNAVAILABLE",
      "No usable video representation was available to validate the finite timeline",
      { detail: { timelineValidation: "no-candidate" } },
    );
  }
  const ytdlp = new YtDlp(config, undefined, remoteContext ?? null);
  const leaseSource = {
    sourceRef,
    revision,
    canonicalLocator: canonicalUrl,
    identity: pinnedIdentity ?? null,
  };
  const transportBasis = timelineBasisForProtocol(selected.protocol);
  if (transportBasis === "hls" || transportBasis === "dash") {
    return await withRemoteAcquisitionDirectory(
      config,
      "timeline-manifest",
      config.limits.maxNavigationCopyBytes,
        signal,
        async (_temporary, remoteSignal) => {
          const lease = await ytdlp.lease(leaseSource, selected, remoteSignal);
        const validated = transportBasis === "hls"
          ? await validateHlsTransport(
            ytdlp,
            lease.deliveryUrl,
            selected,
            config,
            remoteSignal,
          )
          : validateStaticDashManifest(
            await ytdlp.manifestText(lease.deliveryUrl, remoteSignal),
            { maxBytes: config.limits.maxNavigationCopyBytes },
          );
        return admitValidatedTimeline(metadataDurationMs, validated);
      },
    );
  }
  return await withRemoteAcquisitionDirectory(
    config,
    "timeline",
    config.limits.maxNavigationCopyBytes,
    signal,
    async (temporary, remoteSignal) => {
      const lease = await ytdlp.lease(leaseSource, selected, remoteSignal);
      await ytdlp.run(
        [
          "--paths",
          temporary,
          "-o",
          "timeline.%(ext)s",
          lease.deliveryUrl,
        ],
        {
          signal: remoteSignal,
          timeoutMs: config.limits.maxRemoteAcquisitionWallMs,
          cwd: temporary,
        },
      );
      await assertRemoteDirectoryWithinBudget(
        temporary,
        config.limits.maxNavigationCopyBytes,
        "timeline validation",
      );
      const outputs = (await readdir(temporary)).filter((name) =>
        /^timeline\.(?:mp4|m4v|webm|mkv|mov|ts|m2ts|avi)$/u.test(name)
      );
      if (outputs.length !== 1) {
        throw new UrmaError(
          "SOURCE_UNAVAILABLE",
          "Timeline validation did not produce exactly one typed media output",
          { detail: { timelineValidation: "ambiguous-output" } },
        );
      }
      const probe = await new Ffprobe(config, remoteContext ?? null).inspect(
        path.join(temporary, outputs[0]!),
        remoteSignal,
      );
      const validated = validateProgressiveProbe(probe, transportBasis);
      return admitValidatedTimeline(metadataDurationMs, validated);
    },
  );
}
function captions(
  info: Record<string, unknown>,
  sourceRef: SourceRef,
  revision: string,
): CaptionTrackSummary[] {
  const output: CaptionTrackSummary[] = [];
  for (
    const [key, kind] of [
      ["subtitles", "manual"],
      ["automatic_captions", "automatic"],
    ] as const
  ) {
    const groups = info[key];
    if (!record(groups)) continue;
    for (const [language, raw] of Object.entries(groups)) {
      if (!/^[A-Za-z0-9._-]{1,100}$/.test(language)) continue;
      const variants = Array.isArray(raw) ? raw.filter(record) : [];
      const native = variants.filter((variant) => {
        const url = text(variant.url);
        return url === null || !/[?&]tlang=/.test(url);
      });
      for (const [variantIndex, variant] of native.entries()) {
        const extension = (text(variant.ext) ?? "").toLowerCase();
        const format = extension === "json"
          ? "json3"
          : extension === "json3" || extension === "vtt" || extension === "srt"
          ? extension
          : null;
        if (!format) continue;
        const providerVariantId = `youtube:${kind}:${language}:${format}:${
          variantIndex
        }:${sha256(stableJson({
          name: text(variant.name),
          ext: extension,
          protocol: text(variant.protocol),
        })).slice(0, 16)}`;
        output.push(
          makeCaptionTrack(sourceRef, revision, {
            language,
            kind,
            displayName: text(variant.name)?.slice(0, 200) ?? null,
            formats: [format],
            providerTrackId: providerVariantId,
            variants: [{
              variantId: providerVariantId,
              format,
              providerVariantId,
            }],
          }),
        );
      }
    }
  }
  return output
    .sort(
      (a, b) =>
        compareText(a.language, b.language) || compareText(a.kind, b.kind),
    )
    .slice(0, 200);
}

export async function inspectYouTube(
  input: string,
  config: UrmaConfig,
  remoteContext: RemoteOperationContext | null | undefined,
  signal?: AbortSignal,
  snapshotRevision = createSnapshotRevision(),
): Promise<ResolvedSource> {
  const identity = parseYouTubeUrl(input);
  const info = await new YtDlp(config, undefined, remoteContext ?? null).metadata(identity.canonicalUrl, signal);
  const actual = text(info.id);
  if (actual !== identity.videoId) {
    throw new UrmaError(
      "METADATA_UNAVAILABLE",
      `yt-dlp resolved video ID ${
        JSON.stringify(actual)
      } instead of requested ${identity.videoId}; retry with a canonical single-video URL`,
    );
  }
  const extractor = text(info.extractor) ?? text(info.ie_key) ?? "youtube";
  const extractorKey = text(info.extractor_key) ?? text(info.ie_key) ?? "youtube";
  const safeOrigins = remoteOrigins(
    info,
    identity.origin,
    identity.canonicalUrl,
  );
  assertRemotePolicy({
    inputOrigin: identity.origin,
    redirectOrigins: safeOrigins,
    webpageOrigins: safeOrigins,
    deliveryOrigins: safeOrigins,
    extractor,
    extractorKey,
    resultClass: typeof info._type === "string" ? info._type : null,
    metadata: info,
  });
  const revision = snapshotRevision;
  const allFormats = formats(info, identity.sourceRef, revision);
  const metadataDurationMs = number(info.duration) === null
    ? null
    : milliseconds(info.duration);
  const admittedTimeline = await validateRemoteTransport(
    config,
    identity.canonicalUrl,
    identity.sourceRef,
    revision,
    allFormats,
    metadataDurationMs,
    remoteContext,
    signal,
    identity.remoteIdentity,
  );
  const storyboard = allFormats.some(
    (format) => format.ext === "mhtml" || format.protocol === "mhtml",
  );
  const media = allFormats.filter(
    (format) => format.ext !== "mhtml" && format.protocol !== "mhtml",
  );
  const tracks = captions(info, identity.sourceRef, revision);
  const declaredLanguage =
    (text(info.language) ?? text(info.original_language))?.slice(0, 100) ??
      null;
  const originalLanguage = declaredLanguage &&
      tracks.some(
        (track) =>
          track.language.toLowerCase() === declaredLanguage.toLowerCase(),
      )
    ? declaredLanguage
    : null;
  const allChapters = (
    Array.isArray(info.chapters) ? info.chapters.filter(record) : []
  )
    .map((chapter) => ({
      startMs: milliseconds(chapter.start_time),
      endMs: milliseconds(chapter.end_time),
      title: (text(chapter.title) ?? "untitled chapter").slice(0, 1000),
    }))
    .filter((chapter) => chapter.endMs > chapter.startMs);
  const chapters = allChapters.slice(0, 500);
  const rawTitle = text(info.title) ?? identity.videoId;
  const title = rawTitle.slice(0, 1000);
  return {
    sourceRef: identity.sourceRef,
    kind: "remote",
    identity: identity.remoteIdentity,
    snapshotRef: { sourceRef: identity.sourceRef, revision },
    canonicalKey: identity.videoId,
    canonicalLocator: identity.canonicalUrl,
    revision,
    observedAt: new Date().toISOString(),
    title,
    durationMs: admittedTimeline.durationMs,
    metadataDurationMs: admittedTimeline.metadataDurationMs,
    timeline: admittedTimeline.timeline,
    extractor,
    extractorKey,
    liveState: "finite",
    safeOrigins,
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
      targetedMedia: media.some((format) =>
        ["m3u8", "m3u8_native", "https", "http", "http_dash_segments"].includes(
          format.protocol ?? "",
        )
      ),
      audio: media.some(
        (format) => format.audioCodec !== null && format.audioCodec !== "none",
      ),
      progressive: media.some((format) => format.protocol === "https" || format.protocol === "http"),
      hls: media.some((format) => format.protocol?.startsWith("m3u8") === true),
      dash: media.some((format) => format.protocol === "http_dash_segments"),
      mhtml: storyboard,
    },
    safeMetadata: {
      channel: text(info.channel)?.slice(0, 1000) ?? null,
      uploaderId: text(info.uploader_id)?.slice(0, 1000) ?? null,
      availability: text(info.availability)?.slice(0, 100) ?? null,
      originalLanguage,
      titlePartial: title.length < rawTitle.length,
      chapterCount: allChapters.length,
      chaptersPartial: chapters.length < allChapters.length,
      metadataDurationDisagrees: metadataDurationMs !== null &&
        metadataDurationMs !== admittedTimeline.durationMs,
    },
    remoteAcquisition: "safe-proxy",
  };
}

function firstSafeCanonicalUrl(
  input: string,
  info: Record<string, unknown>,
): string {
  for (const candidate of [info.webpage_url, info.original_url, input]) {
    const value = text(candidate);
    if (!value) continue;
    try {
      return assertRemoteTargetAllowed({ url: value, purpose: "input" }).toString();
    } catch {
      /* Another observed URL may be the safe logical locator. */
    }
  }
  throw new UrmaError(
    "SOURCE_UNAVAILABLE",
    "yt-dlp returned no safe canonical HTTP(S) locator for the remote source",
  );
}

function observedRemoteUrls(info: Record<string, unknown>): string[] {
  const urls: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === "string" && value.length > 0) urls.push(value);
  };
  for (const value of [
    info.redirected_url,
    info.webpage_url,
    info.original_url,
    info.manifest_url,
  ]) add(value);
  for (const format of Array.isArray(info.formats) ? info.formats.filter(record) : []) {
    add(format.url);
    add(format.manifest_url);
  }
  for (const key of ["subtitles", "automatic_captions"] as const) {
    const groups = info[key];
    if (!record(groups)) continue;
    for (const variants of Object.values(groups)) {
      if (!Array.isArray(variants)) continue;
      for (const variant of variants.filter(record)) add(variant.url);
    }
  }
  return urls;
}

export async function inspectGenericRemote(
  input: string,
  config: UrmaConfig,
  remoteContext: RemoteOperationContext | null | undefined,
  signal?: AbortSignal,
  snapshotRevision = createSnapshotRevision(),
): Promise<ResolvedSource> {
  const inputUrl = assertRemoteTargetAllowed({ url: input, purpose: "input" }).toString();
  const info = await new YtDlp(config, undefined, remoteContext ?? null).metadata(inputUrl, signal);
  const canonicalUrl = firstSafeCanonicalUrl(inputUrl, info);
  const identity = remoteIdentityForResolution(info, canonicalUrl);
  const sourceRef = remoteSourceRef(identity);
  const allFormats = formats(info, sourceRef, snapshotRevision);
  const metadataDurationMs = number(info.duration) === null ? null : milliseconds(info.duration);
  const admittedTimeline = await validateRemoteTransport(
    config,
    canonicalUrl,
    sourceRef,
    snapshotRevision,
    allFormats,
    metadataDurationMs,
    remoteContext,
    signal,
    identity,
  );
  const resolution: RemoteResolutionResult = {
    inputUrl,
    canonicalUrl,
    metadata: info,
    timeline: admittedTimeline.timeline,
    redirectUrls: observedRemoteUrls(info),
    webpageUrls: observedRemoteUrls(info),
    deliveryUrls: observedRemoteUrls(info),
  };
  return normalizeRemoteResolution(resolution, snapshotRevision);
}

export async function inspectLocal(
  input: string | PinnedLocalBundle,
  config: UrmaConfig,
  signal?: AbortSignal,
  blobs?: Pick<BlobStore, "putFile">,
): Promise<ResolvedSource> {
  const pinned = typeof input === "string"
    ? await (async () => {
      if (!blobs) {
        throw new UrmaError(
          "SOURCE_UNAVAILABLE",
          "Local source inspection requires a configured blob store to pin the admitted bytes",
        );
      }
      return await pinLocalBundle(await resolveLocalBundle(input, config), blobs);
    })()
    : input;
  const identity = pinned.identity;
  const revision = localSnapshotRevision(pinned);
  let probe: Record<string, unknown>;
  try {
    probe = await new Ffprobe(config).inspect(pinned.video.absolutePath, signal);
  } catch (error) {
    const normalized = normalizeError(error);
    if (
      normalized.code === "CANCELLED" ||
      normalized.code === "REQUIRED_BINARY_MISSING" ||
      normalized.code === "REQUIRED_BINARY_UNSUPPORTED"
    ) {
      throw normalized;
    }
    throw new UrmaError(
      "MEDIA_INVALID",
      "Local source metadata could not be read as a supported video; verify the file and configured ffprobe",
      { cause: error },
    );
  }
  const format = record(probe.format) ? probe.format : {};
  const streams = Array.isArray(probe.streams)
    ? probe.streams.filter(record)
    : [];
  const videoStream = streams.find((stream) => stream.codec_type === "video");
  const videoTiming = videoStream === undefined
    ? null
    : parseVideoStreamCoverage(videoStream);
  const validatedTimeline = (() => {
    try {
      return validateProgressiveProbe(probe, "container");
    } catch (error) {
      throw new UrmaError(
        "MEDIA_INVALID",
        "Local source has no finite positive duration; verify it is a readable video",
        { cause: error },
      );
    }
  })();
  const durationMs = validatedTimeline.durationMs;
  const summaries: FormatSummary[] = streams.map((stream, index) => {
    const id = String(stream.index ?? index);
    const summary: FormatSummary = {
      id,
      formatId: id,
      ext: text(format.format_name),
      protocol: "local-file",
      width: number(stream.width),
      height: number(stream.height),
      fps: null,
      videoCodec: stream.codec_type === "video" ? text(stream.codec_name) : "none",
      audioCodec: stream.codec_type === "audio" ? text(stream.codec_name) : "none",
      estimatedBytes: null,
      rows: null,
      columns: null,
    };
    const candidateKey = snapshotCandidateKey(
      { sourceRef: identity.sourceRef, revision },
      safeFormatDescription(summary),
    );
    return {
      ...summary,
      candidateKey,
    };
  });
  const captionSidecar = identity.captionSidecar;
  const captionTracks: CaptionTrackSummary[] = captionSidecar
    ? [
      makeCaptionTrack(identity.sourceRef, revision, {
        language: "und",
        kind: "sidecar",
        displayName: path.basename(captionSidecar),
        formats: [path.extname(captionSidecar).slice(1)],
        providerTrackId: null,
      }),
    ]
    : [];
  const rawTitle = path.basename(identity.canonicalPath);
  return {
    sourceRef: identity.sourceRef,
    kind: "local",
    identity: null,
    snapshotRef: { sourceRef: identity.sourceRef, revision },
    canonicalKey: identity.canonicalPath,
    canonicalLocator: identity.canonicalPath,
    revision,
    observedAt: new Date().toISOString(),
    title: rawTitle.slice(0, 1000),
    durationMs,
    metadataDurationMs: durationMs,
    timeline: validatedTimeline,
    extractor: null,
    extractorKey: null,
    liveState: "finite",
    safeOrigins: [],
    resolverVersion: "ffprobe",
    normalizationVersion: "remote-normalization-v1",
    policyVersion: "local-policy-v1",
    chapters: [],
    captionTracks,
    formats: summaries,
    capabilities: {
      nativeCaptions: captionTracks.length > 0,
      chapters: false,
      nativeStoryboard: false,
      targetedMedia: true,
      audio: summaries.some(
        (stream) => stream.audioCodec !== null && stream.audioCodec !== "none",
      ),
      progressive: true,
      hls: false,
      dash: false,
      mhtml: false,
    },
    safeMetadata: {
      size: identity.size,
      mtimeMs: identity.mtimeMs,
      captionSidecar,
      captionSize: identity.captionSize,
      captionMtimeMs: identity.captionMtimeMs,
      localSnapshot: localSnapshotForBundle(pinned),
      videoTiming: videoTiming === null
        ? null
        : serializeVideoPtsCoverage(videoTiming),
      titlePartial: rawTitle.length > 1000,
      chapterCount: 0,
      chaptersPartial: false,
    },
  };
}
