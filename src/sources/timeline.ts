import { UrmaError } from "../core/errors.js";
import type { FiniteTimeline, TimelineBasis } from "../core/model.js";

export type TimelineValidationBudget = Readonly<{
  maxBytes?: number;
  maxSegments?: number;
}>;

const DEFAULT_BUDGET: Required<TimelineValidationBudget> = {
  maxBytes: 8 * 1024 * 1024,
  maxSegments: 100_000,
};

function positiveDuration(
  durationMs: number,
  basis: TimelineBasis,
  validatedAt = new Date().toISOString(),
): FiniteTimeline {
  if (!Number.isSafeInteger(durationMs) || durationMs < 1) {
    throw new UrmaError(
      "SOURCE_UNAVAILABLE",
      "Validated media did not establish a positive finite duration",
      { detail: { timelineValidation: "failed", basis } },
    );
  }
  return { finite: true, durationMs, basis, validatedAt };
}

function boundedText(value: string, budget: TimelineValidationBudget): string {
  const maxBytes = budget.maxBytes ?? DEFAULT_BUDGET.maxBytes;
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new UrmaError(
      "SOURCE_UNAVAILABLE",
      "Remote manifest exceeded the bounded timeline-validation budget",
      { detail: { timelineValidation: "budget" } },
    );
  }
  return value;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate metadata emitted by yt-dlp after resolving the selected transport
 * locator itself. This is distinct from source-page metadata: the value comes
 * from the selected HLS/DASH transport, and live/dynamic results are rejected.
 */
export function validateFiniteTransportMetadata(
  info: Readonly<Record<string, unknown>>,
  basis: Extract<TimelineBasis, "hls" | "dash">,
): FiniteTimeline {
  const entries = info.entries;
  if (Array.isArray(entries) || (entries !== undefined && entries !== null)) {
    throw new UrmaError(
      "UNSUPPORTED_SOURCE",
      "Selected remote transport resolved to multiple entries instead of one finite media representation",
      { detail: { timelineValidation: "multi-entry", basis } },
    );
  }
  if (
    info._type !== undefined &&
    info._type !== null &&
    info._type !== "video"
  ) {
    throw new UrmaError(
      "UNSUPPORTED_SOURCE",
      "Selected remote transport did not resolve to one video representation",
      { detail: { timelineValidation: "result-class", basis } },
    );
  }
  if (
    info.is_live === true ||
    info.live_status === "is_live" ||
    info.live_status === "is_upcoming" ||
    info.live_status === "post_live"
  ) {
    throw new UrmaError(
      "UNSUPPORTED_SOURCE",
      "Selected remote transport is live or upcoming and cannot define an immutable finite timeline",
      { detail: { timelineValidation: "live", basis } },
    );
  }
  const durationSeconds = Number(info.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new UrmaError(
      "SOURCE_UNAVAILABLE",
      "Selected remote transport did not expose a positive finite duration",
      { detail: { timelineValidation: "missing-duration", basis } },
    );
  }
  return positiveDuration(Math.round(durationSeconds * 1_000), basis);
}

/** Validate a staged progressive/container probe; never accepts a URL. */
export function validateProgressiveProbe(
  probe: Readonly<Record<string, unknown>>,
  basis: TimelineBasis = "progressive",
): FiniteTimeline {
  const format = record(probe.format) ? probe.format : {};
  const streams = Array.isArray(probe.streams)
    ? probe.streams.filter(record)
    : [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const candidates = [format.duration, video?.duration]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  const durationSeconds = candidates[0];
  if (durationSeconds === undefined) {
    throw new UrmaError(
      "SOURCE_UNAVAILABLE",
      "Container validation did not establish a positive finite video duration",
      { detail: { timelineValidation: "failed", basis } },
    );
  }
  return positiveDuration(Math.round(durationSeconds * 1_000), basis);
}

/** Validate one selected finite HLS media playlist, not a master playlist. */
export function validateFiniteHlsManifest(
  manifest: string,
  budget: TimelineValidationBudget = {},
): FiniteTimeline {
  const text = boundedText(manifest, budget);
  const lines = text.split(/\r?\n/u).map((line) => line.trim());
  if (!lines.includes("#EXTM3U")) {
    throw new UrmaError("SOURCE_UNAVAILABLE", "HLS timeline validation received no media playlist header");
  }
  if (lines.some((line) => line.startsWith("#EXT-X-STREAM-INF"))) {
    throw new UrmaError("SOURCE_UNAVAILABLE", "HLS master playlists must be resolved to one media playlist before timeline admission");
  }
  if (!lines.includes("#EXT-X-ENDLIST")) {
    throw new UrmaError("UNSUPPORTED_SOURCE", "HLS playlist is not finite because it has no ENDLIST marker");
  }
  if (lines.some((line) => line.startsWith("#EXT-X-PRELOAD-HINT") || line.startsWith("#EXT-X-PART"))) {
    throw new UrmaError("UNSUPPORTED_SOURCE", "HLS playlist contains live low-latency parts and is not an immutable finite timeline");
  }
  const maxSegments = budget.maxSegments ?? DEFAULT_BUDGET.maxSegments;
  let segmentCount = 0;
  let seconds = 0;
  for (const line of lines) {
    if (!line.startsWith("#EXTINF:")) continue;
    const raw = line.slice("#EXTINF:".length).split(",", 1)[0];
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      throw new UrmaError("SOURCE_UNAVAILABLE", "HLS playlist contains an invalid segment duration");
    }
    segmentCount += 1;
    if (segmentCount > maxSegments) {
      throw new UrmaError("SOURCE_UNAVAILABLE", "HLS playlist exceeded the bounded segment-validation budget");
    }
    seconds += value;
  }
  if (segmentCount === 0 || !Number.isFinite(seconds) || seconds <= 0) {
    throw new UrmaError("SOURCE_UNAVAILABLE", "HLS playlist contains no finite media segments");
  }
  return positiveDuration(Math.round(seconds * 1_000), "hls");
}

function isoDurationMs(value: string): number | null {
  const match = /^P(?:(?<days>\d+(?:\.\d+)?)D)?(?:T(?:(?<hours>\d+(?:\.\d+)?)H)?(?:(?<minutes>\d+(?:\.\d+)?)M)?(?:(?<seconds>\d+(?:\.\d+)?)S)?)?$/u.exec(value);
  if (!match?.groups) return null;
  const days = Number(match.groups.days ?? 0);
  const hours = Number(match.groups.hours ?? 0);
  const minutes = Number(match.groups.minutes ?? 0);
  const seconds = Number(match.groups.seconds ?? 0);
  const total = (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1_000;
  return Number.isSafeInteger(Math.round(total)) && total > 0 ? Math.round(total) : null;
}

/** Validate a static finite DASH MPD. Acquisition targeting remains deferred. */
export function validateStaticDashManifest(
  manifest: string,
  budget: TimelineValidationBudget = {},
): FiniteTimeline {
  const text = boundedText(manifest, budget);
  const root = /<MPD\b([^>]*)>/iu.exec(text)?.[1] ?? null;
  if (!root) throw new UrmaError("SOURCE_UNAVAILABLE", "DASH timeline validation received no MPD root");
  const type = /\btype\s*=\s*["']([^"']+)["']/iu.exec(root)?.[1]?.toLowerCase();
  if (type && type !== "static") {
    throw new UrmaError("UNSUPPORTED_SOURCE", "DASH MPD is dynamic and cannot define an immutable finite timeline");
  }
  if (/\bminimumUpdatePeriod\s*=|\btimeShiftBufferDepth\s*=/iu.test(root)) {
    throw new UrmaError("UNSUPPORTED_SOURCE", "DASH MPD advertises a changing/live timeline");
  }
  const duration = /\bmediaPresentationDuration\s*=\s*["']([^"']+)["']/iu.exec(root)?.[1];
  const durationMs = duration ? isoDurationMs(duration) : null;
  if (durationMs === null) {
    throw new UrmaError("SOURCE_UNAVAILABLE", "Static DASH MPD has no positive finite mediaPresentationDuration");
  }
  return positiveDuration(durationMs, "dash");
}

/** Metadata duration is retained for comparison; validated transport duration wins. */
export function admitValidatedTimeline(
  metadataDurationMs: number | null,
  validated: FiniteTimeline,
): Readonly<{ durationMs: number; metadataDurationMs: number | null; timeline: FiniteTimeline }> {
  if (!validated.finite || validated.durationMs < 1) {
    throw new UrmaError("SOURCE_UNAVAILABLE", "Only a positive finite validated timeline can be admitted");
  }
  return { durationMs: validated.durationMs, metadataDurationMs, timeline: validated };
}

export function assertValidatedTimelinesAgree(
  previous: FiniteTimeline,
  next: FiniteTimeline,
): void {
  if (previous.durationMs !== next.durationMs || previous.basis !== next.basis) {
    throw new UrmaError(
      "SOURCE_UNAVAILABLE",
      "A later validated representation contradicts the immutable snapshot timeline",
      { detail: { timelineValidation: "contradiction" } },
    );
  }
}
