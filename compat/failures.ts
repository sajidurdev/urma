import { isIP } from "node:net";

export type FailureClass =
  | "PASS"
  | "FIXTURE_GONE"
  | "FIXTURE_NOT_SINGLE_VIDEO"
  | "FIXTURE_LOGIN_REQUIRED"
  | "FIXTURE_GEO_BLOCKED"
  | "FIXTURE_PROCESSING"
  | "PROVIDER_403_OR_RATE_LIMIT"
  | "PROVIDER_NETWORK_TIMEOUT"
  | "PROVIDER_EXTRACTION_FAILED"
  | "RESOLVER_FAILED"
  | "POLICY_REJECTED"
  | "COLLECTION_REJECTED"
  | "LIVE_REJECTED"
  | "DRM_REJECTED"
  | "NO_VIDEO_STREAM"
  | "FINITE_TIMELINE_FAILED"
  | "TRANSPORT_UNSUPPORTED"
  | "ACQUISITION_FAILED"
  | "SAFE_PROXY_INCOMPATIBLE"
  | "FRAME_FAILED"
  | "OVERVIEW_FAILED"
  | "CAPTION_UNAVAILABLE"
  | "CAPTION_ACQUISITION_FAILED"
  | "TRANSCRIPT_FAILED"
  | "CACHE_FAILED"
  | "PROVENANCE_FAILED"
  | "INTERNAL_BUG"
  | "UNTESTED";

export type ErrorInfo = Readonly<{
  code: string;
  retryable: boolean;
  detail: string;
}>;

export function isFixtureFailure(failure: FailureClass): boolean {
  return [
    "FIXTURE_GONE",
    "FIXTURE_NOT_SINGLE_VIDEO",
    "FIXTURE_LOGIN_REQUIRED",
    "FIXTURE_GEO_BLOCKED",
    "FIXTURE_PROCESSING",
    "UNTESTED",
  ].includes(failure);
}

function isProviderMetadataTimeout(error: ErrorInfo): boolean {
  if (error.code !== "SOURCE_UNAVAILABLE" || !error.retryable) return false;
  const match = /failed with exit code 1:\s+ERROR:\s+\[[^\]\r\n]+\]\s+[^\r\n]*Unable to download (?:JSON metadata|webpage):\s+HTTPSConnectionPool\(host=['"]([a-z0-9.-]+)['"], port=443\): Read timed out\b/iu.exec(error.detail);
  const host = match?.[1]?.toLowerCase();
  return host !== undefined && host.includes(".") && isIP(host) === 0 &&
    !/(?:^|\.)(?:localhost|local|internal|invalid|test)\.?$/u.test(host);
}

export function classifyFailure(stage: string, error: ErrorInfo): FailureClass {
  const text = `${error.code} ${error.detail}`.toLowerCase();
  if (/fixture|video.*not found|not found|removed|deleted|gone|404/.test(text)) {
    return "FIXTURE_GONE";
  }
  if (/login|logged.?in|sign in|authentication|requires? auth|requires? account|private|age.?restrict/.test(text)) {
    return "FIXTURE_LOGIN_REQUIRED";
  }
  if (/geo|country|region|location|not available in your/.test(text)) {
    return "FIXTURE_GEO_BLOCKED";
  }
  if (/403|forbidden|429|rate.?limit|too many requests|http error 4\d\d|status(?: code)? 4\d\d|ip address is blocked|blocked from accessing/.test(text)) {
    return "PROVIDER_403_OR_RATE_LIMIT";
  }
  if (/video is processing|still processing|processing(?: the)? video/.test(text)) {
    return "FIXTURE_PROCESSING";
  }
  if (/drm|encrypted|widevine|fairplay|playready/.test(text)) {
    return "DRM_REJECTED";
  }
  if (/live|upcoming|post.?live/.test(text)) return "LIVE_REJECTED";
  if (/playlist|collection|multi.?video|channel|profile|search|multiple entries|one finite video/.test(text)) {
    return "FIXTURE_NOT_SINGLE_VIDEO";
  }
  if (/safe proxy|safe-proxy|proxy destination|proxy.*incompat|loopback/.test(text)) {
    return "SAFE_PROXY_INCOMPATIBLE";
  }
  if (["resolve", "inspect", "frame", "multiple-frames", "cadence", "overview", "caption-read"].includes(stage) &&
    isProviderMetadataTimeout(error)) return "PROVIDER_NETWORK_TIMEOUT";
  if (/policy|excluded/.test(text)) return "POLICY_REJECTED";
  if (/does not expose a video|no video|video representation/.test(text)) {
    return "NO_VIDEO_STREAM";
  }
  if (/timeline|duration|finite|manifest|ffprobe|pts|timestamp/.test(text)) {
    return stage === "resolve" || stage === "inspect"
      ? "FINITE_TIMELINE_FAILED"
      : "TRANSPORT_UNSUPPORTED";
  }
  if (stage === "overview") return "OVERVIEW_FAILED";
  if (stage === "caption-discovery") return "CAPTION_UNAVAILABLE";
  if (stage === "caption-read") return "CAPTION_ACQUISITION_FAILED";
  if (stage === "transcript") return "TRANSCRIPT_FAILED";
  if (stage === "cache") return "CACHE_FAILED";
  if (stage === "provenance") return "PROVENANCE_FAILED";
  if (/acqui|download|media budget|media/.test(text)) return "ACQUISITION_FAILED";
  if (stage === "cadence" || stage === "multiple-frames") return "FRAME_FAILED";
  if (stage === "frame") return "FRAME_FAILED";
  if (/extractor|no video formats|unable to extract|unsupported site|site is not supported/.test(text)) {
    return "PROVIDER_EXTRACTION_FAILED";
  }
  if (stage === "resolve" || stage === "inspect") return "RESOLVER_FAILED";
  return "INTERNAL_BUG";
}

export type FailureResponsibility = "Urma" | "upstream" | "fixture";

export function responsibility(failure: FailureClass): FailureResponsibility {
  if ([
    "FIXTURE_GONE",
    "FIXTURE_NOT_SINGLE_VIDEO",
    "FIXTURE_LOGIN_REQUIRED",
    "FIXTURE_GEO_BLOCKED",
    "FIXTURE_PROCESSING",
  ].includes(failure)) return "fixture";
  if (
    failure === "PROVIDER_403_OR_RATE_LIMIT" ||
    failure === "PROVIDER_NETWORK_TIMEOUT" ||
    failure === "PROVIDER_EXTRACTION_FAILED" ||
    failure === "DRM_REJECTED" ||
    failure === "LIVE_REJECTED" ||
    failure === "NO_VIDEO_STREAM" ||
    failure === "RESOLVER_FAILED"
  ) return "upstream";
  return "Urma";
}

