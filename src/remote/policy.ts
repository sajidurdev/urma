import { UrmaError } from "../core/errors.js";
import { videoCodecForFormat } from "./formats.js";

export const REMOTE_POLICY_VERSION = "remote-policy-v1";

const EXCLUDED_DOMAIN_FAMILIES = [
  ".localhost",
  ".local",
  ".internal",
  ".onion",
  ".i2p",
] as const;

const EXCLUDED_EXTRACTOR_FAMILIES = [
  "search",
  "channel",
  "profile",
  "playlist",
  "collection",
  "tab",
] as const;

const PROHIBITED_RESULT_CLASSES = new Set([
  "playlist",
  "multi_video",
  "search",
  "channel",
  "profile",
  "collection",
  "live",
  "upcoming",
  "audio",
]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hostFromOrigin(origin: string): string {
  try {
    return new URL(origin).hostname.toLowerCase().replace(/\.$/u, "");
  } catch {
    return "";
  }
}

function excludedDomain(hostname: string): boolean {
  return EXCLUDED_DOMAIN_FAMILIES.some((suffix) =>
    hostname === suffix.slice(1) || hostname.endsWith(suffix)
  );
}

function excludedExtractor(extractor: string, extractorKey: string): boolean {
  const values = [extractor, extractorKey].map((value) => value.toLowerCase());
  return values.some((value) =>
    EXCLUDED_EXTRACTOR_FAMILIES.some((family) =>
      value === family || value.endsWith(`:${family}`) || value.endsWith(`_${family}`)
    )
  );
}

export type RemotePolicyObservation = Readonly<{
  inputOrigin: string;
  redirectOrigins: readonly string[];
  webpageOrigins: readonly string[];
  deliveryOrigins: readonly string[];
  extractor: string;
  extractorKey: string;
  resultClass: string | null;
  metadata: Readonly<Record<string, unknown>>;
}>;

/** Negative policy only: it does not attempt to enumerate supported providers. */
export function assertRemotePolicy(
  observation: RemotePolicyObservation,
): void {
  const origins = [
    observation.inputOrigin,
    ...observation.redirectOrigins,
    ...observation.webpageOrigins,
    ...observation.deliveryOrigins,
  ];
  for (const origin of origins) {
    const hostname = hostFromOrigin(origin);
    if (!hostname || excludedDomain(hostname)) {
      throw new UrmaError(
        "UNSUPPORTED_SOURCE",
        "Remote source destination is excluded by the versioned source policy",
        { detail: { policyVersion: REMOTE_POLICY_VERSION } },
      );
    }
  }
  if (
    observation.resultClass !== null &&
    PROHIBITED_RESULT_CLASSES.has(observation.resultClass.toLowerCase())
  ) {
    throw new UrmaError(
      "UNSUPPORTED_SOURCE",
      `Remote result class ${JSON.stringify(observation.resultClass)} is excluded by policy`,
      { detail: { policyVersion: REMOTE_POLICY_VERSION } },
    );
  }
  if (
    observation.resultClass !== null &&
    observation.resultClass.toLowerCase() !== "video"
  ) {
    throw new UrmaError(
      "UNSUPPORTED_SOURCE",
      `Remote result class ${JSON.stringify(observation.resultClass)} is not one finite video`,
      { detail: { policyVersion: REMOTE_POLICY_VERSION } },
    );
  }
  const entries = observation.metadata.entries;
  if (Array.isArray(entries) || (entries !== undefined && entries !== null)) {
    throw new UrmaError(
      "UNSUPPORTED_SOURCE",
      "Remote resolver returned multiple entries; playlists, channels, searches, and collections are not supported",
      { detail: { policyVersion: REMOTE_POLICY_VERSION } },
    );
  }
  if (excludedExtractor(observation.extractor, observation.extractorKey)) {
    throw new UrmaError(
      "UNSUPPORTED_SOURCE",
      "Remote extractor family is excluded by the versioned source policy",
      { detail: { policyVersion: REMOTE_POLICY_VERSION } },
    );
  }
  const metadata = observation.metadata;
  const availability = typeof metadata.availability === "string"
    ? metadata.availability.toLowerCase()
    : "";
  if (
    metadata.is_private === true ||
    metadata.requires_login === true ||
    metadata.requires_subscription === true ||
    metadata.has_drm === true ||
    metadata.drm === true ||
    metadata.is_drm === true ||
    ["private", "login_required", "premium", "subscriber_only", "unavailable", "needs_auth"].includes(availability)
  ) {
    throw new UrmaError(
      "UNSUPPORTED_SOURCE",
      "Remote source requires authentication, is private/paywalled, or is DRM-protected",
      { detail: { policyVersion: REMOTE_POLICY_VERSION } },
    );
  }
  if (
    metadata.is_live === true ||
    metadata.live_status === "is_live" ||
    metadata.live_status === "is_upcoming" ||
    metadata.live_status === "post_live"
  ) {
    throw new UrmaError(
      "UNSUPPORTED_SOURCE",
      "Live and upcoming remote sources are excluded from finite investigations",
      { detail: { policyVersion: REMOTE_POLICY_VERSION } },
    );
  }
  const formats = Array.isArray(metadata.formats)
    ? metadata.formats.filter(record)
    : [];
  const hasVideo = formats.some((format) => {
    const codec = videoCodecForFormat(format);
    return codec !== null && codec !== "none";
  });
  if (!hasVideo) {
    throw new UrmaError(
      "UNSUPPORTED_SOURCE",
      "Remote source does not expose a video representation",
      { detail: { policyVersion: REMOTE_POLICY_VERSION } },
    );
  }
}
