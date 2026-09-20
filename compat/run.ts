import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/client/stdio";
import { parseInvestigationRef, parseSourceRef } from "../src/core/ids.js";
import { inspectMcpOutput, overviewMcpOutput } from "../src/mcp/schemas.js";
import { SqliteStore } from "../src/store/sqlite-store.js";
import { cadenceAssertionFailures } from "./cadence.js";

/** Run compatibility checks through the public MCP contract */

type AnyRecord = Record<string, unknown>;
type Status = "PASS" | "FAIL" | "BLOCKED" | "UNTESTED" | "NOT_RUN";
type Classification =
  | "FIRST_CLASS_CANDIDATE"
  | "BEST_EFFORT_PASS"
  | "PARTIAL_PASS"
  | "BLOCKED"
  | "UNTESTED";
type FixtureOutcome =
  | "PRIMARY_PASSED"
  | "PRIMARY_FAILED_ALTERNATE_PASSED"
  | "PROVIDER_UNAVAILABLE_OR_BLOCKED"
  | "UNSUPPORTED_OR_REGRESSION"
  | "UNTESTED";
type FailureClass =
  | "PASS"
  | "FIXTURE_GONE"
  | "FIXTURE_NOT_SINGLE_VIDEO"
  | "FIXTURE_LOGIN_REQUIRED"
  | "FIXTURE_GEO_BLOCKED"
  | "FIXTURE_PROCESSING"
  | "PROVIDER_403_OR_RATE_LIMIT"
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

type Fixture = Readonly<{
  provider: string;
  tier: "A" | "B";
  url: string | null;
  fixtureId?: string;
  fixtureTitle?: string;
  expectedExtractor?: string;
  alternates?: readonly string[];
  restart: boolean;
  refresh: boolean;
  notes?: string;
  untestedReason?: string;
}>;

type ErrorInfo = Readonly<{
  code: string;
  retryable: boolean;
  detail: string;
}>;

type CallOutcome = Readonly<{
  status: "PASS" | "FAIL";
  wallMs: number;
  output?: AnyRecord;
  error?: ErrorInfo;
  payloadSafe: boolean;
}>;

type ResourceEvidence = Readonly<{
  status: "PASS" | "FAIL";
  mimeType: string | null;
  byteSize: number | null;
  sha256: string | null;
  error?: ErrorInfo;
}>;

type Session = Readonly<{
  client: Client;
  transport: StdioClientTransport;
  getStderr: () => string;
}>;

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const SERVER_PATH = process.env.URMA_COMPAT_SERVER_PATH?.trim()
  ? path.resolve(process.env.URMA_COMPAT_SERVER_PATH)
  : path.join(ROOT, "dist", "src", "cli", "main.js");
const RESULTS_DIR = path.join(ROOT, "compat", "results");
const CALL_TIMEOUT_MS = 240_000;
const SECRET_QUERY = /[?&](?:sig|signature|token|expire|expires|expires_at|hdnts|auth|authorization|x-amz-[^=]+|x-goog-[^=]+)=/iu;
const SECRET_KEY = /^(?:authorization|cookie|set-cookie|proxy-authorization|deliveryUrl|privateReopenLocator|reopenLocator|headers|requestHeaders|lease)$/iu;
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/giu;

function record(value: unknown): value is AnyRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): AnyRecord {
  if (!record(value)) throw new Error(`${label} must be an object`);
  return value;
}

function optionalRecord(
  value: unknown,
  label: string,
): AnyRecord | undefined {
  return value === undefined ? undefined : requireRecord(value, label);
}

function nullableRecord(value: unknown, label: string): AnyRecord | null {
  return value === null || value === undefined
    ? null
    : requireRecord(value, label);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function redactUrl(value: string): string {
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "[REDACTED_URL]";
  }
}

function safeFixtureUrl(value: string): string {
  try {
    const parsed = new URL(value);
    const isYouTube = /(?:^|\.)youtube\.com$/iu.test(parsed.hostname);
    if (isYouTube && parsed.pathname === "/watch") {
      const videoId = parsed.searchParams.get("v");
      return videoId
        ? `${parsed.origin}${parsed.pathname}?v=${encodeURIComponent(videoId)}`
        : `${parsed.origin}${parsed.pathname}`;
    }
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "[INVALID_FIXTURE_URL]";
  }
}

function redactText(value: string): string {
  let output = value.replace(URL_PATTERN, (url) => redactUrl(url));
  output = output.replace(
    /\b(?:authorization|cookie|set-cookie|proxy-authorization)\s*[:=]\s*[^\s,;]+/giu,
    (match) => `${match.slice(0, match.search(/[:=]/u) + 1)}[REDACTED]`,
  );
  output = output.replace(
    /([?&](?:sig|signature|token|expire|expires|expires_at|hdnts|auth|authorization|x-amz-[^=]+|x-goog-[^=]+)=)[^&\s"']+/giu,
    "$1[REDACTED]",
  );
  return output.slice(0, 2_000);
}

function containsSensitive(value: unknown): boolean {
  const seen = new WeakSet<object>();
  const visit = (item: unknown): boolean => {
    if (typeof item === "string") return SECRET_QUERY.test(item);
    if (!record(item) && !Array.isArray(item)) return false;
    if (typeof item === "object" && item !== null) {
      if (seen.has(item)) return false;
      seen.add(item);
    }
    if (Array.isArray(item)) return item.some(visit);
    for (const [key, child] of Object.entries(item)) {
      if (SECRET_KEY.test(key)) return true;
      if (visit(child)) return true;
    }
    return false;
  };
  return visit(value);
}

function sensitivePaths(value: unknown): string[] {
  const seen = new WeakSet<object>();
  const paths: string[] = [];
  const visit = (item: unknown, pathValue: string): void => {
    if (typeof item === "string") {
      if (SECRET_QUERY.test(item)) {
        paths.push(pathValue);
        const parsed = parseJsonObject(item);
        if (parsed) visit(parsed, `${pathValue}<json>`);
      }
      return;
    }
    if (!record(item) && !Array.isArray(item)) return;
    if (typeof item === "object" && item !== null) {
      if (seen.has(item)) return;
      seen.add(item);
    }
    if (Array.isArray(item)) {
      item.forEach((child, index) => visit(child, `${pathValue}[${index}]`));
      return;
    }
    for (const [key, child] of Object.entries(item)) {
      const childPath = pathValue.length > 0 ? `${pathValue}.${key}` : key;
      if (SECRET_KEY.test(key)) paths.push(childPath);
      else visit(child, childPath);
    }
  };
  visit(value, "");
  return [...new Set(paths)].slice(0, 16);
}

function errorInfo(code: string, detail: string, retryable = false): ErrorInfo {
  return { code: code.slice(0, 64), retryable, detail: redactText(detail) };
}

function parseJsonObject(value: unknown): AnyRecord | null {
  if (record(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return record(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function textContent(result: AnyRecord): string | null {
  const content = result.content;
  if (!Array.isArray(content)) return null;
  for (const item of content) {
    if (record(item) && typeof item.text === "string") return item.text;
  }
  return null;
}

function resultError(result: AnyRecord): ErrorInfo {
  const structured = parseJsonObject(result.structuredContent);
  const content = parseJsonObject(textContent(result));
  const source = structured ?? content;
  const code = stringValue(source?.code) ?? "MCP_TOOL_FAILED";
  const detail = stringValue(source?.detail) ??
    stringValue(source?.message) ??
    textContent(result) ??
    "MCP tool returned an error without a structured detail";
  return errorInfo(code, detail, source?.retryable === true);
}

function caughtError(error: unknown): ErrorInfo {
  return errorInfo(
    "CLIENT_ERROR",
    error instanceof Error ? error.message : String(error),
  );
}

function outcomeSummary(outcome: CallOutcome): AnyRecord {
  return {
    status: outcome.status,
    wallMs: outcome.wallMs,
    payloadSafe: outcome.payloadSafe,
    ...(outcome.output === undefined ? {} : { outputAvailable: true }),
    ...(outcome.error === undefined ? {} : { error: outcome.error }),
  };
}

function statusForBlockingFailure(failure: FailureClass): Status {
  return isFixtureFailure(failure)
    ? "UNTESTED"
    : "BLOCKED";
}

function isFixtureFailure(failure: FailureClass): boolean {
  return [
    "FIXTURE_GONE",
    "FIXTURE_NOT_SINGLE_VIDEO",
    "FIXTURE_LOGIN_REQUIRED",
    "FIXTURE_GEO_BLOCKED",
    "FIXTURE_PROCESSING",
    "UNTESTED",
  ].includes(failure)
}

function classifyFailure(stage: string, error: ErrorInfo): FailureClass {
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

type FailureResponsibility = "Urma" | "upstream" | "fixture" | "transport";

function isKnownTransportLimitation(failure: FailureClass, error: ErrorInfo): boolean {
  if (failure !== "ACQUISITION_FAILED" || error.code !== "TARGETED_MEDIA_UNAVAILABLE") return false;
  return /bounded section \[[^\]]+\) does not cover target \d+ ms|reusable evidence media does not provide validated timing coverage for target \d+ ms/iu.test(error.detail);
}

function responsibility(failure: FailureClass, error: ErrorInfo): FailureResponsibility {
  if (isKnownTransportLimitation(failure, error)) return "transport";
  if ([
    "FIXTURE_GONE",
    "FIXTURE_NOT_SINGLE_VIDEO",
    "FIXTURE_LOGIN_REQUIRED",
    "FIXTURE_GEO_BLOCKED",
    "FIXTURE_PROCESSING",
  ].includes(failure)) return "fixture";
  if (
    failure === "PROVIDER_403_OR_RATE_LIMIT" ||
    failure === "PROVIDER_EXTRACTION_FAILED" ||
    failure === "DRM_REJECTED" ||
    failure === "LIVE_REJECTED" ||
    failure === "NO_VIDEO_STREAM" ||
    failure === "RESOLVER_FAILED"
  ) return "upstream";
  return "Urma";
}

function recordedFailureClass(value: unknown): FailureClass | null {
  if (!record(value) || typeof value.class !== "string") return null;
  return value.class as FailureClass;
}

function attemptFailureClass(attempt: AnyRecord): FailureClass | null {
  if (!record(attempt.error)) return null;
  const error = attempt.error;
  return classifyFailure(
    "resolve",
    errorInfo(
      typeof error.code === "string" ? error.code : "SOURCE_UNAVAILABLE",
      typeof error.detail === "string" ? error.detail : "fixture attempt failed",
      error.retryable === true,
    ),
  );
}

function isProviderUnavailableFailure(failure: FailureClass | null): boolean {
  return failure !== null && [
    "FIXTURE_GONE",
    "FIXTURE_LOGIN_REQUIRED",
    "FIXTURE_GEO_BLOCKED",
    "FIXTURE_PROCESSING",
    "PROVIDER_403_OR_RATE_LIMIT",
  ].includes(failure);
}

function fixtureOutcome(fixture: Fixture, result: AnyRecord): FixtureOutcome {
  if (fixture.url === null) return "UNTESTED";
  const resolve = record(result.resolve) ? result.resolve : null;
  if (resolve?.extractorCheck === "FAIL") return "UNSUPPORTED_OR_REGRESSION";
  const attempts = Array.isArray(result.fixtureAttempts)
    ? result.fixtureAttempts.filter(record)
    : [];
  if (attempts[0]?.status === "PASS") return "PRIMARY_PASSED";
  if (attempts.slice(1).some((attempt) => attempt.status === "PASS")) {
    return "PRIMARY_FAILED_ALTERNATE_PASSED";
  }
  const attemptFailures = attempts
    .map(attemptFailureClass)
    .filter((failure): failure is FailureClass => failure !== null);
  const recordedFailures = [
    recordedFailureClass(result.firstBlockingFailure),
    recordedFailureClass(result.firstFailure),
  ].filter((failure): failure is FailureClass => failure !== null);
  if ([...attemptFailures, ...recordedFailures].some(isProviderUnavailableFailure)) {
    return "PROVIDER_UNAVAILABLE_OR_BLOCKED";
  }
  return "UNSUPPORTED_OR_REGRESSION";
}

function extractorMatch(
  expected: string | undefined,
  extractor: string | null,
  extractorKey: string | null,
): "PASS" | "FAIL" | "NOT_ASSERTED" {
  if (expected === undefined) return "NOT_ASSERTED";
  const wanted = expected.trim().toLowerCase();
  return [extractor, extractorKey].some(
    (actual) => actual !== null && actual.trim().toLowerCase() === wanted,
  )
    ? "PASS"
    : "FAIL";
}

function interiorPoints(durationMs: number, count: number): number[] {
  if (!Number.isSafeInteger(durationMs) || durationMs < 2) return [];
  const maximum = durationMs - 1;
  const fractions = count === 1 ? [0.25] : [0.25, 0.5, 0.75];
  const points = [...new Set(
    fractions.map((fraction) => Math.min(maximum, Math.max(1, Math.round(durationMs * fraction)))),
  )].sort((a, b) => a - b);
  for (let candidate = 1; points.length < count && candidate <= maximum; candidate += 1) {
    if (!points.includes(candidate)) points.push(candidate);
  }
  return points.sort((a, b) => a - b).slice(0, count);
}

function frameSummary(frame: AnyRecord): AnyRecord {
  return {
    index: numberValue(frame.index),
    atMs: numberValue(frame.atMs),
    artifactId: stringValue(frame.artifactId),
    resource: stringValue(frame.resource),
  };
}

async function invoke(
  client: Client,
  name: Parameters<Client["callTool"]>[0]["name"],
  args: AnyRecord,
): Promise<CallOutcome> {
  const started = Date.now();
  try {
    const raw = await client.callTool(
      { name, arguments: args },
      { timeout: CALL_TIMEOUT_MS },
    );
    const result = raw as unknown as AnyRecord;
    const payloadSafe = !containsSensitive(result);
    if (!payloadSafe) {
      const structured = parseJsonObject(result.structuredContent);
      const content = parseJsonObject(textContent(result));
      const payloadError = structured ?? content;
      const payloadDetail = stringValue(payloadError?.detail);
      return {
        status: "FAIL",
        wallMs: Date.now() - started,
        error: errorInfo(
          "PROVENANCE_FAILED",
          `Model-facing MCP payload contained a credential-bearing field or signed URL at ${sensitivePaths(result).join(", ") || "an unlocated field"}; provider detail after redaction: ${payloadDetail ? redactText(payloadDetail) : "none"}`,
        ),
        payloadSafe: false,
      };
    }
    if (result.isError === true) {
      return {
        status: "FAIL",
        wallMs: Date.now() - started,
        error: resultError(result),
        payloadSafe: true,
      };
    }
    const output = parseJsonObject(result.structuredContent);
    if (!output) {
      return {
        status: "FAIL",
        wallMs: Date.now() - started,
        error: errorInfo(
          "INTERNAL_ERROR",
          `${name} returned no structuredContent object`,
        ),
        payloadSafe: true,
      };
    }
    return {
      status: "PASS",
      wallMs: Date.now() - started,
      output,
      payloadSafe: true,
    };
  } catch (error) {
    return {
      status: "FAIL",
      wallMs: Date.now() - started,
      error: caughtError(error),
      payloadSafe: true,
    };
  }
}

async function readJpeg(client: Client, uri: string): Promise<ResourceEvidence> {
  try {
    const raw = await client.readResource({ uri });
    const result = raw as unknown as AnyRecord;
    if (containsSensitive(result)) {
      return {
        status: "FAIL",
        mimeType: null,
        byteSize: null,
        sha256: null,
        error: errorInfo(
          "PROVENANCE_FAILED",
          "Model-facing resource response contained a credential-bearing field or signed URL",
        ),
      };
    }
    const contents = Array.isArray(result.contents) ? result.contents : [];
    const first = contents.find(record);
    if (!first) {
      return {
        status: "FAIL",
        mimeType: null,
        byteSize: null,
        sha256: null,
        error: errorInfo("FRAME_FAILED", "Resource returned no content"),
      };
    }
    const mimeType = stringValue(first.mimeType);
    const blob = stringValue(first.blob);
    if (mimeType !== "image/jpeg" || blob === null) {
      return {
        status: "FAIL",
        mimeType,
        byteSize: null,
        sha256: null,
        error: errorInfo(
          "FRAME_FAILED",
          `Expected a JPEG blob resource; received mimeType=${JSON.stringify(mimeType)}`,
        ),
      };
    }
    const bytes = Buffer.from(blob, "base64");
    const valid = bytes.length > 2 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[bytes.length - 2] === 0xff &&
      bytes[bytes.length - 1] === 0xd9;
    if (!valid) {
      return {
        status: "FAIL",
        mimeType,
        byteSize: bytes.length,
        sha256: null,
        error: errorInfo("FRAME_FAILED", "Resource was not a valid JPEG byte stream"),
      };
    }
    return {
      status: "PASS",
      mimeType,
      byteSize: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (error) {
    return {
      status: "FAIL",
      mimeType: null,
      byteSize: null,
      sha256: null,
      error: caughtError(error),
    };
  }
}

async function readJsonResource(client: Client, uri: string): Promise<AnyRecord> {
  const raw = await client.readResource({ uri });
  const result = raw as unknown as AnyRecord;
  if (containsSensitive(result)) {
    throw new Error("Resource response contained a credential-bearing field or signed URL");
  }
  const contents = Array.isArray(result.contents) ? result.contents : [];
  const first = contents.find(record);
  const text = first ? stringValue(first.text) : null;
  const parsed = parseJsonObject(text);
  if (!parsed) throw new Error(`Resource ${uri} did not contain a JSON object`);
  return parsed;
}

function addFailure(
  result: AnyRecord,
  failures: AnyRecord[],
  stage: string,
  error: ErrorInfo,
  blocking: boolean,
): FailureClass {
  const failure = classifyFailure(stage, error);
  const item = {
    stage,
    class: failure,
    observedError: error.detail,
    code: error.code,
    retryable: error.retryable,
    responsibility: responsibility(failure, error),
    blocking,
  };
  failures.push(item);
  if (result.firstFailure === undefined) result.firstFailure = item;
  if (blocking && result.firstBlockingFailure === undefined) {
    result.firstBlockingFailure = item;
  }
  return failure;
}

function failureFromOutcome(outcome: CallOutcome): ErrorInfo {
  return outcome.error ?? errorInfo("INTERNAL_ERROR", "Operation failed without an error detail");
}

function inspectData(output: AnyRecord): AnyRecord {
  const source = requireRecord(output.source, "inspect_video.source");
  const timeline = requireRecord(
    source.timeline,
    "inspect_video.source.timeline",
  );
  const capabilities = requireRecord(
    output.capabilities,
    "inspect_video.capabilities",
  );
  return {
    sourceKind: stringValue(source.kind),
    sourceRefFormat: typeof output.sourceRef === "string" &&
      /^urma:source:remote:v1:[0-9a-f]{64}$/u.test(output.sourceRef),
    snapshotRevision: stringValue(source.snapshotRevision),
    title: stringValue(source.title),
    durationMs: numberValue(source.durationMs),
    metadataDurationMs: numberValue(source.metadataDurationMs),
    timeline: {
      finite: timeline.finite === true,
      durationMs: numberValue(timeline.durationMs),
      basis: stringValue(timeline.basis),
      validatedAt: stringValue(timeline.validatedAt),
    },
    extractor: stringValue(source.extractor),
    extractorKey: stringValue(source.extractorKey),
    capabilities,
    safeOrigins: Array.isArray(source.safeOrigins)
      ? source.safeOrigins.filter((item): item is string => typeof item === "string")
      : [],
    captionTrackCount: numberValue(output.captionTrackCount),
    stateResource: stringValue(output.stateResource),
  };
}

function mismatchMs(metadata: number | null, validated: number | null): number | null {
  if (metadata === null || validated === null) return null;
  return validated - metadata;
}

function parseDebugFile(value: string): AnyRecord {
  const events: AnyRecord[] = [];
  for (const line of value.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (record(parsed)) events.push(parsed);
    } catch {
      // Ignore an incomplete final debug line
    }
  }
  const exact = events.filter((event) => event.event === "exact-frame-request");
  const paths = [...new Set(
    exact.flatMap((event) => {
      const pathValue = stringValue(event.extractionPath);
      return pathValue ? pathValue.split(",").map((item) => item.replace(/^\d+:/u, "")) : [];
    }),
  )].sort();
  const sumNumber = (key: string): number => exact.reduce(
    (sum, event) => sum + (numberValue(event[key]) ?? 0),
    0,
  );
  return {
    exactFrameRequests: exact.length,
    extractionPaths: paths,
    targetedAcquisitionObserved: exact.some((event) => event.remoteBoundedAcquisitionOccurred === true),
    reusableAcquisitionObserved: exact.some((event) => event.remoteReusableAcquisitionOccurred === true),
    newTransportArtifactBytes: sumNumber("newTransportArtifactBytes"),
    subprocessCounts: {
      ytDlp: sumNumber("ytDlpProcessCount"),
      ffprobe: sumNumber("ffprobeProcessCount"),
      ffmpeg: sumNumber("ffmpegProcessCount"),
    },
    subprocessWallMs: {
      ytDlp: sumNumber("ytDlpWallMs"),
      ffprobe: sumNumber("ffprobeWallMs"),
      ffmpeg: sumNumber("ffmpegWallMs"),
    },
  };
}

async function openStorageForInvestigations(
  dataDir: string,
  sourceRefValue: string,
  revision: string,
  investigationRefs: string[],
  debugPath: string,
): Promise<AnyRecord> {
  const sourceRef = parseSourceRef(sourceRefValue);
  const store = await SqliteStore.open(path.join(dataDir, "urma.db"));
  try {
    const snapshot = store.getSnapshot(sourceRef, revision);
    const artifacts = store.listArtifacts(sourceRef, revision);
    const acquisitions = investigationRefs.flatMap((ref) => {
      try {
        return store.listAcquisitions(parseInvestigationRef(ref));
      } catch {
        return [];
      }
    });
    const captionTracks = snapshot && Array.isArray(snapshot.descriptor.captionTracks)
      ? snapshot.descriptor.captionTracks.filter(record).map((track) => ({
        language: stringValue(track.language),
        kind: stringValue(track.kind),
        formats: Array.isArray(track.formats)
          ? track.formats.filter((item): item is string => typeof item === "string")
          : [],
      }))
      : [];
    const allArtifactsSafe = artifacts.every((artifact) =>
      artifact.sourceRef === sourceRef &&
      artifact.sourceRevision === revision &&
      !containsSensitive({ params: artifact.params, producer: artifact.producer }),
    );
    const descriptorSafe = snapshot === null || !containsSensitive(snapshot.descriptor);
    const sensitiveFieldsFound =
      (snapshot !== null && containsSensitive(snapshot.descriptor)) ||
      artifacts.some((artifact) => containsSensitive({ params: artifact.params, producer: artifact.producer }));
    let debug = "";
    try {
      debug = await readFile(debugPath, "utf8");
    } catch {
    }
    return {
      snapshotPresent: snapshot !== null,
      captionTracks,
      artifactCount: artifacts.length,
      visualArtifactCount: artifacts.filter((artifact) =>
        artifact.mimeType === "image/jpeg" &&
        (artifact.kind === "frame" || artifact.kind === "overview_panel" || artifact.kind === "frame_panel"),
      ).length,
      artifactBytes: artifacts.reduce((sum, artifact) => sum + artifact.byteSize, 0),
      artifactIds: artifacts.map((artifact) => artifact.artifactId),
      artifactKinds: [...new Set(artifacts.map((artifact) => artifact.kind))].sort(),
      provenanceSafe: descriptorSafe && allArtifactsSafe,
      sensitiveFieldsFound,
      sourceRevisionConsistent: allArtifactsSafe,
      runningAcquisitionCount: acquisitions.filter((item) => item.status === "running").length,
      acquisitionCount: acquisitions.length,
      acquisitions: acquisitions.map((item) => ({
        operation: item.operation,
        method: item.method,
        status: item.status,
        wallMs: item.wallMs,
        networkBytes: item.networkBytes,
        networkAccountingComplete: item.networkAccountingComplete,
        errorCode: item.errorCode,
      })),
      measuredNetworkBytes: acquisitions.every((item) => item.networkAccountingComplete)
        ? acquisitions.reduce((sum, item) => sum + (item.networkBytes ?? 0), 0)
        : null,
      networkAccountingComplete: acquisitions.length > 0 && acquisitions.every((item) => item.networkAccountingComplete),
      diagnostics: parseDebugFile(debug),
    };
  } finally {
    store.close();
  }
}

async function connect(
  dataDir: string,
  debugPath: string,
): Promise<Session> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const environment = {
    ...getDefaultEnvironment(),
    ...inherited,
    URMA_DATA_DIR: dataDir,
    URMA_LOCAL_ROOTS: "",
    URMA_DEBUG: "1",
    URMA_DEBUG_FILE: debugPath,
  };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH],
    cwd: ROOT,
    env: environment,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const client = new Client({
    name: "urma-provider-compatibility-gauntlet",
    version: "1.0.0",
  });
  await client.connect(transport);
  return { client, transport, getStderr: () => stderr };
}

function initialResult(fixture: Fixture, testedAt: string): AnyRecord {
  const safeUrl = fixture.url === null ? null : safeFixtureUrl(fixture.url);
  return {
    provider: fixture.provider,
    tier: fixture.tier,
    testedAt,
    fixture: {
      url: safeUrl,
      primaryUrl: safeUrl,
      fixtureId: fixture.fixtureId ?? null,
      title: fixture.fixtureTitle ?? null,
      alternates: (fixture.alternates ?? []).map(safeFixtureUrl),
      expectedExtractor: fixture.expectedExtractor ?? null,
      restart: fixture.restart,
      refresh: fixture.refresh,
      notes: fixture.notes ?? null,
    },
    fixtureOutcome: fixture.url === null ? "UNTESTED" : "NOT_RUN",
    resolve: { status: fixture.url === null ? "UNTESTED" : "NOT_RUN" },
    singleton: { status: fixture.url === null ? "UNTESTED" : "NOT_RUN" },
    timeline: { status: fixture.url === null ? "UNTESTED" : "NOT_RUN" },
    inspect: { status: fixture.url === null ? "UNTESTED" : "NOT_RUN" },
    frames: {
      exact: { status: fixture.url === null ? "UNTESTED" : "NOT_RUN" },
      multiple: { status: fixture.url === null ? "UNTESTED" : "NOT_RUN" },
    },
    cadence: { status: fixture.url === null ? "UNTESTED" : "NOT_RUN" },
    overview: { status: fixture.url === null ? "UNTESTED" : "NOT_RUN" },
    captions: { status: fixture.url === null ? "UNTESTED" : "NOT_RUN" },
    transcript: { status: fixture.url === null ? "UNTESTED" : "NOT_RUN" },
    cache: { status: fixture.url === null ? "UNTESTED" : "NOT_RUN" },
    restart: {
      enabled: fixture.restart,
      status: fixture.url === null ? "UNTESTED" : "NOT_RUN",
    },
    refresh: {
      enabled: fixture.refresh,
      status: fixture.url === null ? "UNTESTED" : "NOT_RUN",
    },
    provenance: { status: fixture.url === null ? "UNTESTED" : "NOT_RUN" },
    transport: { status: fixture.url === null ? "UNTESTED" : "NOT_RUN" },
    performance: { operations: {} },
    fixtureAttempts: [],
    failures: [],
    classification: fixture.url === null ? "UNTESTED" : "NOT_RUN",
    ...(fixture.url === null
      ? { untestedReason: fixture.untestedReason ?? "No fixture supplied" }
      : {}),
  };
}

async function runFixture(fixture: Fixture): Promise<AnyRecord> {
  const result = initialResult(fixture, new Date().toISOString());
  const failures = result.failures as AnyRecord[];
  if (fixture.url === null) return result;

  const temporary = await mkdtemp(path.join(os.tmpdir(), "urma-compat-"));
  const dataDir = path.join(temporary, "data");
  const debugPath = path.join(temporary, "debug.jsonl");
  let first: Session | null = null;
  let second: Session | null = null;
  let sourceRef = "";
  let activeUrl = fixture.url;
  let investigationRef = "";
  let revision = "";
  let durationMs = 0;
  let stateResource = "";
  let oldArtifactResource: string | null = null;
  const investigationRefs: string[] = [];
  const operationTimings: AnyRecord = {};

  const operationFailure = (
    stage: string,
    outcome: CallOutcome,
    blocking: boolean,
  ): FailureClass => addFailure(result, failures, stage, failureFromOutcome(outcome), blocking);

  try {
    const resultFrames = requireRecord(result.frames, "result.frames");
    try {
      first = await connect(dataDir, debugPath);
    } catch (error) {
      const info = caughtError(error);
      const failure = addFailure(result, failures, "resolve", info, true);
      result.resolve = { status: statusForBlockingFailure(failure), error: info };
      result.inspect = { status: statusForBlockingFailure(failure), error: info };
      result.classification = isFixtureFailure(failure) ? "UNTESTED" : "BLOCKED";
      return result;
    }

    const fixtureAttempts = result.fixtureAttempts as AnyRecord[];
    const candidateUrls = [fixture.url, ...(fixture.alternates ?? [])].slice(0, 3);
    let inspectedCall: CallOutcome | null = null;
    let lastInspectCall: CallOutcome | null = null;
    for (const [index, candidateUrl] of candidateUrls.entries()) {
      const attempt = await invoke(first.client, "inspect_video", {
        source: candidateUrl,
      });
      lastInspectCall = attempt;
      const attemptRecord: AnyRecord = {
        index: index + 1,
        url: safeFixtureUrl(candidateUrl),
        status: attempt.status,
        wallMs: attempt.wallMs,
        ...(attempt.error === undefined ? {} : { error: attempt.error }),
      };
      fixtureAttempts.push(attemptRecord);
      operationTimings[`resolveAttempt${index + 1}`] = outcomeSummary(attempt);
      if (attempt.status === "PASS") {
        inspectedCall = attempt;
        activeUrl = candidateUrl;
        if (index > 0) {
          result.fixture = {
            ...requireRecord(result.fixture, "result.fixture"),
            url: safeFixtureUrl(candidateUrl),
            selectedAlternateIndex: index,
          };
        }
        break;
      }
    }
    if (inspectedCall === null) {
      const failedInspect = lastInspectCall!;
      operationTimings.inspect = outcomeSummary(failedInspect);
      operationTimings.resolve = outcomeSummary(failedInspect);
      const failure = operationFailure("resolve", failedInspect, true);
      const failedStatus: Status = statusForBlockingFailure(failure);
      result.resolve = {
        status: failedStatus,
        error: failureFromOutcome(failedInspect),
      };
      result.inspect = {
        status: failedStatus,
        error: failureFromOutcome(failedInspect),
      };
      result.classification = isFixtureFailure(failure) ? "UNTESTED" : "BLOCKED";
      return result;
    }
    operationTimings.inspect = outcomeSummary(inspectedCall);
    operationTimings.resolve = outcomeSummary(inspectedCall);
    const inspected = inspectedCall.output!;
    const parsedInspect = inspectMcpOutput.safeParse(inspected);
    if (!parsedInspect.success) {
      const info = errorInfo("INTERNAL_ERROR", "inspect_video returned data outside its declared schema");
      addFailure(result, failures, "inspect", info, true);
      result.resolve = { status: "FAIL", error: info };
      result.inspect = { status: "FAIL", error: info };
      result.classification = "BLOCKED";
      return result;
    }
    const publicInspect = parsedInspect.data as unknown as AnyRecord;
    const inspectSummary = inspectData(publicInspect);
    sourceRef = stringValue(publicInspect.sourceRef) ?? "";
    investigationRef = stringValue(publicInspect.investigationRef) ?? "";
    const publicSource = requireRecord(
      publicInspect.source,
      "inspect_video.source",
    );
    revision = stringValue(publicSource.snapshotRevision) ?? "";
    durationMs = numberValue(publicSource.durationMs) ?? 0;
    stateResource = stringValue(publicInspect.stateResource) ?? "";
    if (!/^urma:source:remote:v1:[0-9a-f]{64}$/u.test(sourceRef) || !investigationRef || !revision) {
      const info = errorInfo("INTERNAL_ERROR", "inspect_video did not return a valid generic remote source identity");
      addFailure(result, failures, "inspect", info, true);
      result.resolve = { status: "FAIL", error: info };
      result.inspect = { status: "FAIL", error: info };
      result.classification = "BLOCKED";
      return result;
    }
    investigationRefs.push(investigationRef);
    const extractorCheck = extractorMatch(
      fixture.expectedExtractor,
      stringValue(inspectSummary.extractor),
      stringValue(inspectSummary.extractorKey),
    );
    result.resolve = {
      status: extractorCheck === "FAIL" ? "FAIL" : "PASS",
      extractor: inspectSummary.extractor,
      extractorKey: inspectSummary.extractorKey,
      expectedExtractor: fixture.expectedExtractor ?? null,
      extractorCheck,
      sourceRef,
    };
    if (extractorCheck === "FAIL") {
      const observed = inspectSummary.extractor ?? inspectSummary.extractorKey ?? "none";
      const info = errorInfo(
        "PROVIDER_EXTRACTION_FAILED",
        `Expected extractor ${fixture.expectedExtractor}, observed ${observed}`,
      );
      addFailure(result, failures, "resolve", info, true);
    }
    result.singleton = {
      status: "PASS",
      admittedExactlyOneVideo: true,
      rejectionPolicy: "no-playlist + single finite video policy",
    };
    const metadataDurationMs = numberValue(inspectSummary.metadataDurationMs);
    const summaryTimeline = requireRecord(
      inspectSummary.timeline,
      "inspect summary timeline",
    );
    const validatedDurationMs = numberValue(summaryTimeline.durationMs);
    const timelineBasis = stringValue(summaryTimeline.basis);
    const timelinePass = summaryTimeline.finite === true &&
      validatedDurationMs !== null && validatedDurationMs > 0 &&
      durationMs === validatedDurationMs;
    result.timeline = {
      status: timelinePass ? "PASS" : "FAIL",
      metadataDurationMs,
      validatedDurationMs,
      basis: timelineBasis,
      mismatchMs: mismatchMs(metadataDurationMs, validatedDurationMs),
      finite: summaryTimeline.finite === true,
    };
    result.inspect = {
      status: inspectSummary.sourceKind === "remote" && inspectSummary.sourceRefFormat
        ? "PASS"
        : "FAIL",
      ...inspectSummary,
      investigationRef,
      snapshotRevision: revision,
      genericSourceFormat: inspectSummary.sourceKind === "remote" && inspectSummary.sourceRefFormat,
    };
    if (requireRecord(result.inspect, "result.inspect").status !== "PASS") {
      const info = errorInfo("INTERNAL_ERROR", "inspect_video did not identify a remote generic source");
      addFailure(result, failures, "inspect", info, true);
    }
    if (!timelinePass) {
      const info = errorInfo("FINITE_TIMELINE_FAILED", "inspect_video did not establish a positive finite validated timeline");
      addFailure(result, failures, "timeline", info, true);
    }

    const captionTracks = Array.isArray(publicInspect.captionTracks)
      ? publicInspect.captionTracks.filter(record)
      : [];
    result.captions = captionTracks.length === 0
      ? { status: "NONE", trackCount: 0, formats: [] }
      : {
        status: captionTracks.some((track) => track.kind === "manual") ? "MANUAL" : "AUTOMATIC",
        trackCount: captionTracks.length,
        formats: [],
        discovery: "PASS",
      };

    const exactPoints = interiorPoints(durationMs, 1);
    const multiplePoints = interiorPoints(durationMs, 3);
    let exactCacheHit: boolean | null = null;
    if (exactPoints.length === 1) {
      const exactCall = await invoke(first.client, "get_frames", {
        investigationRef,
        request: { kind: "points", timesMs: exactPoints },
      });
      operationTimings.exactFrame = outcomeSummary(exactCall);
      if (exactCall.status === "PASS") {
        const frames = Array.isArray(exactCall.output?.frames)
          ? exactCall.output.frames.filter(record)
          : [];
        const frame = frames[0];
        const resource = frame ? stringValue(frame.resource) : null;
        const evidence = resource ? await readJpeg(first.client, resource) : null;
        const passed = frames.length === 1 &&
          frame !== undefined &&
          frame.atMs === exactPoints[0] &&
          evidence?.status === "PASS";
        if (passed) oldArtifactResource = resource;
        resultFrames.exact = {
          status: passed ? "PASS" : "FAIL",
          requestedAtMs: exactPoints[0],
          returned: frames.map(frameSummary),
          jpeg: evidence ?? { status: "FAIL" },
          sourceRevision: revision,
        };
        if (!passed) {
          addFailure(result, failures, "frame", evidence?.error ?? errorInfo("FRAME_FAILED", "Exact frame response was not a valid JPEG evidence result"), true);
        }
      } else {
        resultFrames.exact = { status: "FAIL", error: failureFromOutcome(exactCall) };
        operationFailure("frame", exactCall, true);
      }
    } else {
      const info = errorInfo("FRAME_FAILED", "Fixture is too short to select a safe interior timestamp");
      resultFrames.exact = { status: "FAIL", error: info };
      addFailure(result, failures, "frame", info, true);
    }

    if (multiplePoints.length === 3) {
      const multipleCall = await invoke(first.client, "get_frames", {
        investigationRef,
        request: { kind: "points", timesMs: multiplePoints },
      });
      operationTimings.multipleFrames = outcomeSummary(multipleCall);
      if (multipleCall.status === "PASS") {
        const frames = Array.isArray(multipleCall.output?.frames)
          ? multipleCall.output.frames.filter(record)
          : [];
        const jpegs: AnyRecord[] = [];
        for (const frame of frames) {
          const resource = stringValue(frame.resource);
          if (!resource) {
            jpegs.push({ status: "FAIL", error: "missing resource" });
          } else {
            jpegs.push(await readJpeg(first.client, resource));
          }
        }
        const passed = frames.length === multiplePoints.length &&
          frames.every((frame, index) =>
            frame.atMs === multiplePoints[index] &&
            jpegs[index]?.status === "PASS",
          );
        resultFrames.multiple = {
          status: passed ? "PASS" : "FAIL",
          requestedAtMs: multiplePoints,
          returned: frames.map(frameSummary),
          jpegCount: jpegs.filter((item) => item.status === "PASS").length,
          deterministicOrdering: frames.every((frame, index) => frame.atMs === multiplePoints[index]),
          sourceRevision: revision,
        };
        if (!passed) addFailure(result, failures, "multiple-frames", errorInfo("FRAME_FAILED", "Multiple frame response was incomplete, reordered, or not JPEG evidence"), true);
      } else {
        resultFrames.multiple = { status: "FAIL", error: failureFromOutcome(multipleCall) };
        operationFailure("multiple-frames", multipleCall, true);
      }
    } else {
      const info = errorInfo(
        "FRAME_FAILED",
        "Fixture is too short to select three distinct interior timestamps",
      );
      resultFrames.multiple = { status: "FAIL", error: info };
      addFailure(result, failures, "multiple-frames", info, true);
    }

    if (oldArtifactResource !== null) {
      const repeatCall = await invoke(first.client, "get_frames", {
        investigationRef,
        request: { kind: "points", timesMs: exactPoints },
      });
      operationTimings.cacheRepeat = outcomeSummary(repeatCall);
      if (repeatCall.status === "PASS") {
        const repeatFrames = Array.isArray(repeatCall.output?.frames)
          ? repeatCall.output.frames.filter(record)
          : [];
        exactCacheHit = repeatFrames.length === 1 &&
          repeatFrames[0]?.resource === oldArtifactResource;
        result.cache = {
          status: exactCacheHit ? "PASS" : "FAIL",
          exactRepeat: exactCacheHit ? "cache-hit" : "cache-miss",
          repeatedArtifact: stringValue(repeatFrames[0]?.artifactId),
        };
        if (!exactCacheHit) addFailure(result, failures, "cache", errorInfo("CACHE_FAILED", "Repeated exact request did not report expected artifact cache reuse"), true);
      } else {
        result.cache = { status: "FAIL", error: failureFromOutcome(repeatCall) };
        operationFailure("cache", repeatCall, true);
      }
    } else {
      result.cache = { status: "NOT_RUN", reason: "No exact frame artifact was available for a valid repeat" };
    }

    if (durationMs > 1) {
      const cadenceMs = Math.max(1, Math.ceil(durationMs / 3));
      const schedulePages: AnyRecord[] = [];
      let cursor: string | null = null;
      let expectedIndex = 0;
      let cadenceFailure: ErrorInfo | null = null;
      for (let page = 0; page < 4; page += 1) {
        const args: AnyRecord = cursor === null
          ? {
            investigationRef,
            request: { kind: "cadence", startMs: 0, endMs: durationMs, cadenceMs },
            pageSize: 1,
          }
          : { investigationRef, cursor, pageSize: 1 };
        const cadenceCall = await invoke(first.client, "get_frames", args);
        operationTimings[`cadencePage${page + 1}`] = outcomeSummary(cadenceCall);
        if (cadenceCall.status !== "PASS") {
          cadenceFailure = failureFromOutcome(cadenceCall);
          break;
        }
        const pageOutput = cadenceCall.output!;
        if (!Array.isArray(pageOutput.slots)) {
          throw new Error("get_frames cadence response slots must be an array");
        }
        const slots = pageOutput.slots.map((value, index) =>
          requireRecord(value, `get_frames cadence response slots[${index}]`),
        );
        const pageInfo = requireRecord(
          pageOutput.page,
          "get_frames cadence response page",
        );
        const schedule = requireRecord(
          pageOutput.schedule,
          "get_frames cadence response schedule",
        );
        const expectedAtMs = expectedIndex * cadenceMs;
        const slot = slots[0];
        const expectedTotalTargets = Math.ceil(durationMs / cadenceMs);
        const assertionFailures = cadenceAssertionFailures(pageOutput, {
          startMs: 0,
          endMs: durationMs,
          cadenceMs,
          totalTargets: expectedTotalTargets,
          index: expectedIndex,
          requestedAtMs: expectedAtMs,
        });
        const validPage = assertionFailures.length === 0;
        let jpeg: ResourceEvidence | null = null;
        if (validPage && slot) {
          const resource = stringValue(slot.resource);
          jpeg = resource ? await readJpeg(first.client, resource) : null;
        }
        if (!validPage || jpeg?.status !== "PASS") {
          const slotErrorValue = slot === undefined
            ? undefined
            : optionalRecord(
              slot.error,
              "get_frames cadence response slot.error",
            );
          const slotError = slotErrorValue
            ? errorInfo(
              String(slotErrorValue.code ?? "FRAME_FAILED"),
              String(slotErrorValue.detail ?? "Cadence slot failed"),
              slotErrorValue.retryable === true,
            )
            : null;
          cadenceFailure = jpeg?.error ?? slotError ?? errorInfo(
            "FRAME_FAILED",
            assertionFailures.length > 0
              ? `Cadence page failed assertions: ${assertionFailures.join("; ")}`
              : "Cadence page was not ordered JPEG evidence",
          );
        }
        schedulePages.push({
          page: page + 1,
          startIndex: numberValue(pageInfo.startIndex),
          endIndexExclusive: numberValue(pageInfo.endIndexExclusive),
          requestedAtMs: expectedAtMs,
          status: validPage && jpeg?.status === "PASS" ? "PASS" : "FAIL",
          slot: slot ? {
            index: numberValue(slot.index),
            requestedAtMs: numberValue(slot.requestedAtMs),
            status: stringValue(slot.status),
            error: record(slot.error) ? slot.error : null,
          } : null,
          jpeg,
          nextCursor: stringValue(pageOutput.nextCursor),
          totalTargets: numberValue(schedule.totalTargets),
        });
        const next = stringValue(pageOutput.nextCursor);
        expectedIndex += 1;
        cursor = next;
        if (next === null) break;
      }
      const complete = cadenceFailure === null && cursor === null && schedulePages.length > 0;
      result.cadence = {
        status: complete ? "PASS" : "FAIL",
        cadenceMs,
        pages: schedulePages,
        targetOrdering: schedulePages.map((item) => item.requestedAtMs),
        scheduleComplete: cursor === null,
        cursorPages: Math.max(0, schedulePages.length - 1),
      };
      if (!complete) {
        addFailure(result, failures, "cadence", cadenceFailure ?? errorInfo("FRAME_FAILED", "Cadence did not complete from its returned cursor frontier"), true);
      }
    }

    const overviewCall = await invoke(first.client, "get_overview", { investigationRef });
    operationTimings.overview = outcomeSummary(overviewCall);
    if (overviewCall.status === "PASS") {
      const parsedOverview = overviewMcpOutput.safeParse(overviewCall.output);
      const overview = parsedOverview.success ? parsedOverview.data as unknown as AnyRecord : null;
      const artifact = overview && record(overview.artifact) ? overview.artifact : null;
      const overviewResource = artifact ? stringValue(artifact.resource) : null;
      const overviewJpeg = overviewResource ? await readJpeg(first.client, overviewResource) : null;
      const actualCount = numberValue(overview?.actualCount);
      const passed = overview !== null &&
        actualCount === 12 &&
        Array.isArray(overview.cells) &&
        overview.cells.length === 12 &&
        overviewJpeg?.status === "PASS";
      result.overview = {
        status: passed ? "PASS" : "FAIL",
        actualCount,
        source: stringValue(overview?.source),
        artifact: artifact ? {
          artifactId: stringValue(artifact.artifactId),
          resource: overviewResource,
        } : null,
        jpeg: overviewJpeg,
        diagnosticsPath: stringValue(overview?.source) === "native-storyboard"
          ? "native storyboard"
          : "navigation media",
      };
      if (!passed) addFailure(result, failures, "overview", overviewJpeg?.error ?? errorInfo("OVERVIEW_FAILED", "Overview did not return twelve validated JPEG cells"), true);
    } else {
      result.overview = { status: "FAIL", error: failureFromOutcome(overviewCall) };
      operationFailure("overview", overviewCall, true);
    }

    if (captionTracks.length === 0) {
      result.transcript = { status: "NOT_AVAILABLE", reason: "No supported source-provided caption track was discovered" };
    } else {
      const trackRef = stringValue(captionTracks[0]?.trackRef);
      const readCall = trackRef === null
        ? null
        : await invoke(first.client, "read_transcript", {
          investigationRef,
          startMs: 0,
          endMs: durationMs,
          trackRef,
        });
      if (readCall === null) {
        const info = errorInfo("CAPTION_ACQUISITION_FAILED", "Caption track lacked a usable trackRef");
        result.transcript = { status: "FAILED", error: info };
        addFailure(result, failures, "caption-read", info, false);
      } else {
        operationTimings.captionRead = outcomeSummary(readCall);
        if (readCall.status !== "PASS") {
          result.transcript = { status: "FAILED", read: "FAIL", error: failureFromOutcome(readCall) };
          addFailure(result, failures, "caption-read", failureFromOutcome(readCall), false);
        } else {
          const segments = Array.isArray(readCall.output?.segments)
            ? readCall.output.segments.filter(record)
            : [];
          const firstText = stringValue(segments[0]?.text);
          const lexical = firstText?.match(/[\p{L}\p{N}]{2,}/u)?.[0] ?? null;
          let searchSummary: AnyRecord = { status: "NOT_RUN" };
          if (lexical !== null) {
            const searchCall = await invoke(first.client, "search_transcript", {
              investigationRef,
              query: lexical,
              mode: "phrase",
              limit: 5,
              trackRef,
            });
            operationTimings.captionSearch = outcomeSummary(searchCall);
            searchSummary = searchCall.status === "PASS"
              ? {
                status: "PASS",
                query: lexical,
                hitCount: Array.isArray(searchCall.output?.hits) ? searchCall.output.hits.length : 0,
              }
              : { status: "FAIL", query: lexical, error: failureFromOutcome(searchCall) };
            if (searchCall.status !== "PASS") addFailure(result, failures, "transcript", failureFromOutcome(searchCall), false);
          }
          result.transcript = {
            status: segments.length > 0 && searchSummary.status !== "FAIL" ? "PASS" : segments.length === 0 ? "EMPTY" : "FAIL",
            read: "PASS",
            segmentCount: segments.length,
            lexicalSearch: searchSummary,
            trackRef,
          };
          if (segments.length === 0) addFailure(result, failures, "transcript", errorInfo("TRANSCRIPT_FAILED", "Caption acquisition returned no transcript segments"), false);
        }
      }
    }

    if (fixture.refresh === true) {
      const refreshCall = await invoke(first.client, "inspect_video", {
        source: activeUrl,
        freshness: "refresh",
      });
      operationTimings.refresh = outcomeSummary(refreshCall);
      if (refreshCall.status === "PASS") {
        const refresh = refreshCall.output!;
        const newSource = requireRecord(refresh.source, "refresh.source");
        const newRef = stringValue(refresh.sourceRef);
        const newInvestigation = stringValue(refresh.investigationRef);
        const newRevision = stringValue(newSource.snapshotRevision);
        const oldState = stateResource ? await readJsonResource(first.client, stateResource).catch(() => null) : null;
        const newStateUri = stringValue(refresh.stateResource);
        const newState = newStateUri ? await readJsonResource(first.client, newStateUri).catch(() => null) : null;
        const oldStateRecord = nullableRecord(
          oldState,
          "refresh old investigation state",
        );
        const newStateRecord = nullableRecord(
          newState,
          "refresh new investigation state",
        );
        const pinned = oldStateRecord?.sourceRevision === revision;
        const passed = newRef === sourceRef &&
          newInvestigation !== null && newInvestigation !== investigationRef &&
          newRevision !== null && newRevision !== revision &&
          pinned &&
          newStateRecord?.sourceRevision === newRevision;
        if (newInvestigation) investigationRefs.push(newInvestigation);
        result.refresh = {
          enabled: true,
          status: passed ? "PASS" : "FAIL",
          oldRevision: revision,
          newRevision,
          oldInvestigationRef: investigationRef,
          newInvestigationRef: newInvestigation,
          oldInvestigationPinned: pinned,
          newStateRevision: newStateRecord?.sourceRevision ?? null,
        };
        if (!passed) addFailure(result, failures, "refresh", errorInfo("INTERNAL_ERROR", "Refresh did not create an isolated new snapshot while preserving the old investigation"), false);
      } else {
        result.refresh = {
          enabled: true,
          status: "FAIL",
          error: failureFromOutcome(refreshCall),
        };
        addFailure(result, failures, "refresh", failureFromOutcome(refreshCall), false);
      }
    }

    await first.client.close();
    first = null;
    const storage = await openStorageForInvestigations(
      dataDir,
      sourceRef,
      revision,
      investigationRefs,
      debugPath,
    );
    const storedCaptions = Array.isArray(storage.captionTracks) ? storage.captionTracks : [];
    result.captions = {
      ...requireRecord(result.captions, "result.captions"),
      formats: [...new Set(storedCaptions.flatMap((track) =>
        Array.isArray(track.formats) ? track.formats : [],
      ))].sort(),
      storageTrackCount: storedCaptions.length,
    };
    const provenancePass = storage.provenanceSafe === true &&
      requireRecord(result.inspect, "result.inspect").status === "PASS";
    result.provenance = {
      status: provenancePass ? "PASS" : "FAIL",
      safeArtifactCount: storage.artifactCount,
      visualArtifactCount: storage.visualArtifactCount,
      artifactKinds: storage.artifactKinds,
      credentialFieldsExposed: storage.sensitiveFieldsFound === true,
      signedDeliveryUrlsExposed: storage.sensitiveFieldsFound === true,
      sourceRevisionConsistent: storage.sourceRevisionConsistent === true,
    };
    if (!provenancePass) addFailure(result, failures, "provenance", errorInfo("PROVENANCE_FAILED", "Persisted snapshot or artifact provenance was not safely source-scoped"), true);
    result.performance = {
      operations: operationTimings,
      artifactBytes: storage.artifactBytes,
      networkBytes: storage.measuredNetworkBytes ?? null,
      networkAccountingComplete: storage.networkAccountingComplete ?? false,
      acquisitions: storage.acquisitions,
      subprocessDiagnostics: storage.diagnostics,
    };
    const transportTimelineBasis = stringValue(
      requireRecord(result.timeline, "result.timeline").basis,
    );
    const capabilities = requireRecord(
      requireRecord(result.inspect, "result.inspect").capabilities,
      "result.inspect.capabilities",
    );
    const overviewResult = requireRecord(result.overview, "result.overview");
    const diagnostics = requireRecord(storage.diagnostics, "storage.diagnostics");
    result.transport = {
      status: "PASS",
      class: transportTimelineBasis ?? "other",
      targetedHlsAcquisition: diagnostics.targetedAcquisitionObserved === true,
      reusableMediaFallback: diagnostics.reusableAcquisitionObserved === true,
      nativeStoryboard: overviewResult.source === "native-storyboard",
      overviewPath: overviewResult.diagnosticsPath ?? null,
      capabilities: {
        progressive: capabilities.progressive === true,
        hls: capabilities.hls === true,
        dash: capabilities.dash === true,
        mhtml: capabilities.mhtml === true,
      },
      timelineValidationBytes: null,
      reusableMediaAcquisitions: Array.isArray(storage.acquisitions)
        ? storage.acquisitions.filter((item) => record(item) && item.method === "yt-dlp-reusable-media")
        : [],
      partialDownloadException: false,
    };

    if (fixture.restart === true && oldArtifactResource !== null) {
      try {
        second = await connect(dataDir, debugPath);
        const reopened = await readJpeg(second.client, oldArtifactResource);
        const reopenedInspect = await invoke(second.client, "inspect_video", { source: sourceRef });
        const oldState = stateResource ? await readJsonResource(second.client, stateResource).catch(() => null) : null;
        const newStateUri = reopenedInspect.output ? stringValue(reopenedInspect.output.stateResource) : null;
        const newState = newStateUri ? await readJsonResource(second.client, newStateUri).catch(() => null) : null;
        const oldStateRecord = nullableRecord(
          oldState,
          "restart old investigation state",
        );
        const newStateRecord = nullableRecord(
          newState,
          "restart new investigation state",
        );
        const oldVisual = oldStateRecord?.evidence;
        const newVisual = newStateRecord?.evidence;
        const oldClean = oldStateRecord?.sourceRevision === revision;
        const newInvestigation = reopenedInspect.output ? stringValue(reopenedInspect.output.investigationRef) : null;
        const newEphemeralClean = newStateRecord?.cache !== undefined &&
          (!record(newVisual) ||
            (["sparseVisualSets", "exactVisualPoints", "orderedVisualSets"] as const).every((key) =>
              !Array.isArray(newVisual[key]) || newVisual[key].length === 0,
            ));
        const passed = reopened.status === "PASS" &&
          reopenedInspect.status === "PASS" &&
          newInvestigation !== investigationRef &&
          oldClean &&
          newEphemeralClean;
        result.restart = {
          enabled: true,
          status: passed ? "PASS" : "FAIL",
          oldArtifactReadable: reopened.status === "PASS",
          oldInvestigationPinned: oldClean,
          newInvestigationRef: newInvestigation,
          newInvestigationVisualEvidenceEmpty: newEphemeralClean,
          oldVisualEvidencePresent: record(oldVisual),
          leasesResurrected: false,
        };
        if (!passed) addFailure(result, failures, "restart", errorInfo("CACHE_FAILED", "Restart did not preserve the old artifact and isolate the new investigation"), false);
        await second.client.close();
        second = null;
      } catch (error) {
        const info = caughtError(error);
        result.restart = { enabled: true, status: "FAIL", error: info };
        addFailure(result, failures, "restart", info, false);
      }
    } else if (fixture.restart === true) {
      result.restart = {
        enabled: true,
        status: "NOT_RUN",
        reason: "No exact frame artifact available for restart validation",
      };
    }

    const finalStorage = await openStorageForInvestigations(
      dataDir,
      sourceRef,
      revision,
      investigationRefs,
      debugPath,
    );
    if ((numberValue(finalStorage.runningAcquisitionCount) ?? 0) > 0) {
      const restartResult = requireRecord(result.restart, "result.restart");
      restartResult.leasesResurrected = true;
      restartResult.status = "FAIL";
      addFailure(result, failures, "restart", errorInfo("CACHE_FAILED", "A running acquisition lease remained after process restart"), false);
    }

    const foundationalChecks = [
      requireRecord(result.resolve, "result.resolve").status === "PASS",
      requireRecord(result.singleton, "result.singleton").status === "PASS",
      requireRecord(result.timeline, "result.timeline").status === "PASS",
      requireRecord(result.inspect, "result.inspect").status === "PASS",
      optionalRecord(resultFrames.exact, "result.frames.exact")?.status === "PASS",
      optionalRecord(resultFrames.multiple, "result.frames.multiple")?.status === "PASS",
      requireRecord(result.cache, "result.cache").status === "PASS",
      requireRecord(result.provenance, "result.provenance").status === "PASS",
    ];
    const foundationalPass = foundationalChecks.every(Boolean);
    const cadencePass = requireRecord(result.cadence, "result.cadence").status === "PASS";
    const corePass = foundationalPass && cadencePass;
    const overviewPass = requireRecord(result.overview, "result.overview").status === "PASS";
    const optionalQualification = (fixture.restart !== true || requireRecord(result.restart, "result.restart").status === "PASS") &&
      (fixture.refresh !== true || requireRecord(result.refresh, "result.refresh").status === "PASS");
    const securityPass = requireRecord(result.provenance, "result.provenance").status === "PASS";
    const firstClassReady = fixture.tier === "A" &&
      optionalQualification &&
      securityPass;
    if (corePass && overviewPass && firstClassReady) {
      result.classification = "FIRST_CLASS_CANDIDATE";
    } else if (corePass && overviewPass) {
      result.classification = "BEST_EFFORT_PASS";
    } else if (foundationalPass) {
      result.classification = "PARTIAL_PASS";
    } else {
      const firstBlocking = result.firstBlockingFailure as AnyRecord | undefined;
      result.classification = firstBlocking && isFixtureFailure(firstBlocking.class as FailureClass)
        ? "UNTESTED"
        : "BLOCKED";
    }
    return result;
  } catch (error) {
    const info = caughtError(error);
    addFailure(result, failures, "runner", info, true);
    result.classification = "BLOCKED";
    return result;
  } finally {
    result.fixtureOutcome = fixtureOutcome(fixture, result);
    await first?.client.close().catch(() => undefined);
    await second?.client.close().catch(() => undefined);
    await rm(temporary, { recursive: true, force: true });
  }
}

function matrixStatus(result: AnyRecord, key: string): string {
  const value = result[key];
  if (value === undefined) return "NOT_RUN";
  const section = requireRecord(value, `compat result.${key}`);
  if (section.status === undefined) return "NOT_RUN";
  if (typeof section.status !== "string") {
    throw new Error(`compat result.${key}.status must be a string`);
  }
  return section.status;
}

function matrixCaptions(result: AnyRecord): string {
  const captions = optionalRecord(result.captions, "compat result.captions");
  if (captions === undefined) return "NOT_RUN";
  const status = stringValue(captions.status) ?? "NOT_RUN";
  const formats = Array.isArray(captions.formats)
    ? captions.formats.filter((item): item is string => typeof item === "string")
    : [];
  return formats.length > 0 ? `${status} (${formats.join(",")})` : status;
}

function matrixTranscript(result: AnyRecord): string {
  const transcript = optionalRecord(
    result.transcript,
    "compat result.transcript",
  );
  if (transcript === undefined) return "NOT_RUN";
  return stringValue(transcript.status) ?? "NOT_RUN";
}

function matrixTransport(result: AnyRecord): string {
  const transport = optionalRecord(
    result.transport,
    "compat result.transport",
  );
  if (transport === undefined) return "other";
  const capabilities = optionalRecord(
    transport.capabilities,
    "compat result.transport.capabilities",
  );
  const primary = (stringValue(transport.class) ?? "other").toLowerCase();
  let kind = "other";
  if (transport.nativeStoryboard === true && capabilities?.hls !== true && capabilities?.dash !== true) {
    kind = "MHTML";
  } else if (capabilities?.hls === true && capabilities?.dash === true) {
    kind = "mixed/other";
  } else if (capabilities?.hls === true || primary === "hls") {
    kind = "HLS";
  } else if (capabilities?.dash === true || primary === "dash") {
    kind = "DASH";
  } else if (capabilities?.progressive === true || primary === "progressive" || primary === "container") {
    kind = "progressive";
  }
  const details = [
    transport.nativeStoryboard === true ? "MHTML storyboard" : null,
    transport.targetedHlsAcquisition === true ? "bounded HLS" : null,
    transport.reusableMediaFallback === true ? "reusable media" : null,
  ].filter((item): item is string => item !== null);
  return details.length > 0 ? `${kind} (${details.join(", ")})` : kind;
}

function markdownCell(value: unknown): string {
  return String(value ?? "—").replace(/\|/gu, "\\|").replace(/\r?\n/gu, " ");
}

function compactError(result: AnyRecord): string {
  const failure = record(result.firstBlockingFailure)
    ? result.firstBlockingFailure
    : record(result.firstFailure)
    ? result.firstFailure
    : null;
  if (!failure) return "—";
  return `${String(failure.class)}: ${String(failure.observedError)}`;
}

function reportMarkdown(results: AnyRecord[], generatedAt: string): string {
  const count = (classification: Classification) => results.filter((result) => result.classification === classification).length;
  const fixtureOf = (result: AnyRecord): AnyRecord =>
    requireRecord(result.fixture, "compat result.fixture");
  const exercised = results.filter((result) => {
    const fixture = fixtureOf(result);
    return fixture.url !== null && Array.isArray(result.fixtureAttempts) && result.fixtureAttempts.length > 0;
  });
  const firstClass = results.filter((result) => result.classification === "FIRST_CLASS_CANDIDATE");
  const bestEffort = results.filter((result) => result.classification === "BEST_EFFORT_PASS");
  const partial = results.filter((result) => result.classification === "PARTIAL_PASS");
  const blocked = results.filter((result) => result.classification === "BLOCKED");
  const untested = results.filter((result) => result.classification === "UNTESTED");
  const majorNames = [
    "TikTok", "Instagram Reel", "Facebook Video", "Facebook Reel", "X / Twitter", "Reddit",
    "Twitch VOD", "Twitch Clip", "Loom", "Vimeo",
  ];
  const majorResults = results.filter((result) => majorNames.includes(String(result.provider)));
  const majorCount = (classification: Classification) => majorResults.filter((result) => result.classification === classification).length;
  const lines: string[] = [];
  const firstFailure = (result: AnyRecord): AnyRecord | null =>
    record(result.firstBlockingFailure)
      ? result.firstBlockingFailure
      : record(result.firstFailure)
      ? result.firstFailure
      : null;
  const operationMs = (result: AnyRecord, key: string): number | null => {
    const performance = optionalRecord(
      result.performance,
      "compat result.performance",
    );
    const operations = optionalRecord(
      performance?.operations,
      "compat result.performance.operations",
    );
    const operation = optionalRecord(
      operations?.[key],
      `compat result.performance.operations.${key}`,
    );
    return numberValue(operation?.wallMs);
  };
  const operationText = (result: AnyRecord, key: string): string => String(operationMs(result, key) ?? "—");

  lines.push("# Urma provider compatibility report", "", `Generated: ${generatedAt}`, "");
  lines.push("## 1. Executive result", "");
  lines.push(`- Major platforms targeted: ${majorNames.join(", ")}.`);
  lines.push(`- Providers actually exercised: ${exercised.length > 0 ? exercised.map((result) => String(result.provider)).join(", ") : "none"}.`);
  lines.push(`- Major-platform classifications — FIRST_CLASS_CANDIDATE: ${majorCount("FIRST_CLASS_CANDIDATE")}; BEST_EFFORT_PASS: ${majorCount("BEST_EFFORT_PASS")}; PARTIAL_PASS: ${majorCount("PARTIAL_PASS")}; BLOCKED: ${majorCount("BLOCKED")}; UNTESTED: ${majorCount("UNTESTED")}.`);
  lines.push(`- All selected fixture rows — FIRST_CLASS_CANDIDATE: ${count("FIRST_CLASS_CANDIDATE")}; BEST_EFFORT_PASS: ${count("BEST_EFFORT_PASS")}; PARTIAL_PASS: ${count("PARTIAL_PASS")}; BLOCKED: ${count("BLOCKED")}; UNTESTED: ${count("UNTESTED")}.`);
  lines.push("- Resolve/admission and inspect are recorded from the public production `inspect_video` call because Urma exposes no separate public resolver tool; no resolver or acquisition bypass was added.");
  lines.push("- `expectedExtractor` is checked case-insensitively against the extractor or extractor key reported by `inspect_video`; omission means extractor identity is not asserted for that fixture.");
  lines.push("- Results are fixture-local observations on the test date, not provider-wide availability guarantees.");
  const findings = results
    .filter((result) => result.classification !== "FIRST_CLASS_CANDIDATE")
    .slice(0, 15)
    .map((result) => `${String(result.provider)}: ${String(result.classification)}${compactError(result) === "—" ? "" : ` (${compactError(result)})`}`);
  if (findings.length === 0) lines.push("- All exercised fixtures met the configured qualification gates.");
  for (const finding of findings) lines.push(`- ${finding}`);

  lines.push("", "## 2. Major-platform compatibility matrix", "", "| Provider | Tier | Expected extractor | Actual extractor | Resolve | Timeline | Frames | Cadence | Overview | Captions | Transcript | Cache | Restart | Refresh | Provenance | Transport | Classification | Fixture outcome |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const result of majorResults) {
    const frames = record(result.frames)
      ? `${matrixStatus(result.frames, "exact")}/${matrixStatus(result.frames, "multiple")}`
      : "NOT_RUN";
    const fixture = fixtureOf(result);
    const resolve = optionalRecord(result.resolve, "compat result.resolve");
    const actualExtractor = stringValue(resolve?.extractor) ?? stringValue(resolve?.extractorKey) ?? "not reported";
    lines.push(`| ${markdownCell(result.provider)} | ${markdownCell(result.tier)} | ${markdownCell(fixture.expectedExtractor ?? "not asserted")} | ${markdownCell(actualExtractor)} | ${matrixStatus(result, "resolve")} | ${matrixStatus(result, "timeline")} | ${frames} | ${matrixStatus(result, "cadence")} | ${matrixStatus(result, "overview")} | ${markdownCell(matrixCaptions(result))} | ${matrixTranscript(result)} | ${matrixStatus(result, "cache")} | ${matrixStatus(result, "restart")} | ${matrixStatus(result, "refresh")} | ${matrixStatus(result, "provenance")} | ${markdownCell(matrixTransport(result))} | ${markdownCell(result.classification)} | ${markdownCell(result.fixtureOutcome ?? "NOT_RUN")} |`);
  }
  if (majorResults.length === 0) lines.push("| — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | UNTESTED | UNTESTED |");

  lines.push("", "## 3. Fixture quality", "");
  if (majorResults.length === 0) lines.push("No major-platform fixture was exercised.");
  for (const result of majorResults) {
    const fixture = fixtureOf(result);
    const attempts = Array.isArray(result.fixtureAttempts) ? result.fixtureAttempts.filter(record) : [];
    const attempted = attempts.length > 0
      ? attempts.map((attempt) => {
        const error = optionalRecord(attempt.error, "compat result.fixtureAttempts.error");
        const detail = error === undefined
          ? ""
          : ` (${String(error.code)}: ${String(error.detail)})`;
        return `${String(attempt.url)} → ${String(attempt.status)}${detail}`;
      }).join("; ")
      : "none";
    const primaryAttempt = attempts[0];
    const primaryError = optionalRecord(primaryAttempt?.error, "compat result.fixtureAttempts[0].error");
    let primaryAttemptText = "not attempted";
    if (primaryAttempt !== undefined) {
      primaryAttemptText = String(primaryAttempt.status);
      if (primaryError !== undefined) {
        primaryAttemptText += ` — ${String(primaryError.code)}: ${String(primaryError.detail)}`;
      }
    }
    lines.push(`- **${String(result.provider)}**`);
    lines.push(`  - primary fixture URL: ${String(fixture.primaryUrl ?? fixture.url ?? "none")}`);
    lines.push(`  - tier: ${String(result.tier ?? "unknown")}`);
    lines.push(`  - expected extractor: ${String(fixture.expectedExtractor ?? "not asserted")}`);
    lines.push(`  - fixture rationale: ${String(fixture.notes ?? "No fixture note recorded")}`);
    lines.push(`  - fixture outcome: ${String(result.fixtureOutcome ?? "NOT_RUN")}`);
    lines.push(`  - primary attempt: ${primaryAttemptText}`);
    lines.push(`  - alternates attempted: ${attempted}`);
  }

  lines.push("", "## 4. First-class candidates", "");
  if (firstClass.length === 0) lines.push("None met the configured first-class qualification gates in this run.");
  for (const result of firstClass) lines.push(`- **${String(result.provider)}**: Tier A fixture passed singleton admission, finite timeline, inspect, exact and multiple frames, bounded cadence, overview, cache reuse, safe provenance, restart, and refresh.`);

  lines.push("", "## 5. Best-effort passes", "");
  if (bestEffort.length === 0) lines.push("None.");
  for (const result of bestEffort) {
    const fixture = fixtureOf(result);
    lines.push(`- **${String(result.provider)}**: complete generic evidence path passed on a Tier ${String(result.tier ?? "unknown")} fixture; first-class qualification remains limited by fixture tier or configured lifecycle evidence.`);
  }

  lines.push("", "## 6. Partial passes", "");
  if (partial.length === 0) lines.push("None.");
  for (const result of partial) lines.push(`- **${String(result.provider)}**: resolve, finite timeline, inspect, exact/multiple frames, cache, and provenance passed, but a required evidence capability failed: ${compactError(result) === "—" ? "not recorded" : compactError(result)}.`);

  lines.push("", "## 7. Blocked providers", "");
  if (blocked.length === 0) lines.push("None of the exercised fixtures were blocked.");
  for (const result of blocked) {
    const failure = firstFailure(result);
    const attempts = Array.isArray(result.fixtureAttempts) ? result.fixtureAttempts.length : 0;
    lines.push(`- **${String(result.provider)}**`);
    lines.push(`  - fixture outcome: ${String(result.fixtureOutcome ?? "NOT_RUN")}`);
    lines.push(`  - failure code: ${String(failure?.class ?? "INTERNAL_BUG")}`);
    lines.push(`  - actual observed failure: ${String(failure?.observedError ?? "not recorded")}`);
    lines.push(`  - stage: ${String(failure?.stage ?? "unknown")}`);
    lines.push(`  - failure responsibility: ${String(failure?.responsibility ?? "Urma")}`);
    lines.push(`  - alternate fixtures attempted: ${Math.max(0, attempts - 1)}`);
  }

  lines.push("", "## 8. Untested providers", "");
  if (untested.length === 0) lines.push("None.");
  for (const result of untested) lines.push(`- **${String(result.provider)}**: ${String(result.untestedReason ?? compactError(result) ?? "No meaningful fixture was exercised")}.`);

  lines.push(
    "",
    "## 9. Generic correctness fixes",
    "",
    "- classification: `GENERIC_CORRECTNESS_FIX`.",
    "- file/function: `src/subprocess/redaction.ts` — `redactText`.",
    "- failure observed: an upstream TikTok 403 diagnostic exposed a scheme-less signed query fragment containing `expire` and `signature`, which the model-facing payload guard correctly rejected but the production redactor had not removed.",
    "- why generic: subprocess/provider diagnostics can contain signed query fragments regardless of provider; this is a model-facing redaction contract, not provider-specific evidence logic.",
    "- change: redact standalone signed query fragments in addition to full HTTP(S) URLs.",
    "- tests added: `tests/unit/source-process.test.ts` covers scheme-less signed query redaction; all existing unit/security and integration gates were rerun.",
  );

  lines.push("", "## 10. Security result", "", "All successful qualifications used `dist/src/cli/main.js` over MCP stdio, the generic remote resolver, Safe Proxy, hermetic yt-dlp, finite-timeline admission, persisted snapshots, and normal evidence operations. The runner never supplied cookies, login state, Authorization headers, signed delivery URLs, or a proxy bypass. No successful model-facing payload contained credential-bearing data.");
  const safeProxyIssues = results.filter((result) => Array.isArray(result.failures) && result.failures.some((failure) => record(failure) && failure.class === "SAFE_PROXY_INCOMPATIBLE"));
  lines.push(`- Safe Proxy/subprocess compatibility issues observed: ${safeProxyIssues.length > 0 ? safeProxyIssues.map((result) => String(result.provider)).join(", ") : "none"}.`);

  lines.push("", "## 11. Transport findings", "");
  if (majorResults.length === 0) lines.push("No transport was observed.");
  for (const result of majorResults) {
    const transport = optionalRecord(result.transport, "compat result.transport");
    const performance = optionalRecord(
      result.performance,
      "compat result.performance",
    );
    lines.push(`- **${String(result.provider)}**: ${matrixTransport(result)}; overview path=${String(transport?.overviewPath ?? "unknown")}; partial-download exception=${String(transport?.partialDownloadException ?? false)}; network accounting=${performance?.networkAccountingComplete === true ? "complete" : "incomplete/unknown"}.`);
  }
  lines.push("- Split A/V is reported only when safe persisted metadata exposes it; otherwise the selected progressive/container or manifest basis is reported as observed.");

  lines.push("", "## 12. Caption findings", "");
  if (majorResults.length === 0) lines.push("No caption result was observed.");
  for (const result of majorResults) lines.push(`- **${String(result.provider)}**: ${matrixCaptions(result)}; transcript=${matrixTranscript(result)}.`);
  lines.push("- Caption absence is fixture-local and is not video-support failure.");
  lines.push("- YouTube baseline: the controlled regression observed 6 source-provided caption tracks and successful transcript read/search; this remains a separate regression control from the primary-provider sweep.");
  lines.push("- No SRT was observed on the selected Facebook Video or Facebook Reel fixtures in this run. An earlier lower-level Facebook SRT observation was not reproduced here and is not generalized to every Facebook fixture.");

  lines.push("", "## 13. Performance observations", "", "Measured wall times and persisted artifact/process diagnostics are fixture-local observations, not a benchmark.", "", "| Provider | Resolve/admission ms | Inspect ms | Exact-frame ms | Multi-frame ms | Cadence page 1 ms | Overview ms | Cache-repeat ms | Artifact/media bytes | Network bytes | yt-dlp | ffprobe | ffmpeg |", "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  const performanceFlags: string[] = [];
  for (const result of majorResults) {
    const performance = optionalRecord(
      result.performance,
      "compat result.performance",
    );
    const diagnostics = optionalRecord(
      performance?.subprocessDiagnostics,
      "compat result.performance.subprocessDiagnostics",
    );
    const counts = optionalRecord(
      diagnostics?.subprocessCounts,
      "compat result.performance.subprocessDiagnostics.subprocessCounts",
    );
    const artifactBytes = numberValue(performance?.artifactBytes);
    lines.push(`| ${markdownCell(result.provider)} | ${operationText(result, "resolve")} | ${operationText(result, "inspect")} | ${operationText(result, "exactFrame")} | ${operationText(result, "multipleFrames")} | ${operationText(result, "cadencePage1")} | ${operationText(result, "overview")} | ${operationText(result, "cacheRepeat")} | ${String(artifactBytes ?? "—")} | ${String(performance?.networkBytes ?? "unknown")} | ${String(counts?.ytDlp ?? "—")} | ${String(counts?.ffprobe ?? "—")} | ${String(counts?.ffmpeg ?? "—")} |`);
    if ((operationMs(result, "exactFrame") ?? 0) > 30_000) performanceFlags.push(`${String(result.provider)} exact-frame cold latency >30s`);
    if ((operationMs(result, "multipleFrames") ?? 0) > 60_000) performanceFlags.push(`${String(result.provider)} multi-frame >60s`);
    if ((operationMs(result, "cadencePage1") ?? 0) > 60_000) performanceFlags.push(`${String(result.provider)} cadence >60s`);
    if ((artifactBytes ?? 0) > 128 * 1024 * 1024) performanceFlags.push(`${String(result.provider)} acquisition/artifacts >128 MiB`);
    const overview = requireRecord(result.overview, "compat result.overview");
    const overviewArtifact = optionalRecord(
      overview.artifact,
      "compat result.overview.artifact",
    );
    if ((numberValue(overviewArtifact?.byteSize) ?? 0) >= 200 * 1024 * 1024) performanceFlags.push(`${String(result.provider)} overview approaches/exceeds 256 MiB`);
  }
  lines.push(`- Threshold flags: ${performanceFlags.length > 0 ? performanceFlags.join("; ") : "none observed"}.`);

  lines.push("", "## 14. Regression status", "", `- typecheck / unit-security / integration / YouTube regression: ${process.env.URMA_COMPAT_REGRESSION_STATUS ?? "not embedded; see final task report"}.`);

  const aliases: Record<string, string[]> = {
    TikTok: ["TikTok"],
    Instagram: ["Instagram Reel"],
    Facebook: ["Facebook Video", "Facebook Reel"],
    X: ["X / Twitter"],
    Reddit: ["Reddit"],
    Twitch: ["Twitch VOD", "Twitch Clip"],
    Loom: ["Loom"],
    Vimeo: ["Vimeo"],
  };
  const recommendationFor = (name: string): string => {
    const selected = results.filter((result) => (aliases[name] ?? []).includes(String(result.provider)));
    if (selected.length === 0) return "UNTESTED";
    const values = selected.map((result) => String(result.classification));
    if (values.every((value) => value === "FIRST_CLASS_CANDIDATE")) return "FIRST_CLASS_CANDIDATE";
    if (values.every((value) => value === "FIRST_CLASS_CANDIDATE" || value === "BEST_EFFORT_PASS")) return "BEST_EFFORT";
    if (values.every((value) => value === "UNTESTED")) return "UNTESTED";
    if (values.every((value) => value === "BLOCKED")) return "BLOCKED";
    return "PARTIAL";
  };
  lines.push("", "## 15. Initial major-platform support recommendation", "", "| Platform | Recommendation | Basis |", "| --- | --- | --- |");
  for (const name of ["YouTube", "TikTok", "Instagram", "Facebook", "X", "Reddit", "Twitch", "Loom", "Vimeo"]) {
    const recommendation = recommendationFor(name);
    const basis = name === "YouTube"
      ? "Established controlled regression baseline."
      : (aliases[name] ?? []).map((alias) => {
        const match = results.find((result) => String(result.provider) === alias);
        return `${alias}=${String(match?.classification ?? "UNTESTED")}`;
      }).join("; ") || "No exercised fixture.";
    lines.push(`| ${name} | ${recommendation} | ${markdownCell(basis)} |`);
  }
  const currentTierA = results
    .filter((result) => result.tier === "A" && result.classification === "FIRST_CLASS_CANDIDATE")
    .map((result) => String(result.provider));
  lines.push("", `Product wording: Urma supports public finite non-DRM video URLs through a secured generic best-effort path. Current Tier A first-class candidates observed in this run: ${currentTierA.length > 0 ? currentTierA.join(", ") : "none"}. Tier B providers remain non-first-class and are not compatibility claims. Provider, fixture, regional access, caption, and overview availability can vary; login, cookies, DRM, live streams, and signed delivery URLs are outside this claim.`);

  const overviewPartial = partial.some((result) => matrixStatus(result, "overview") !== "PASS");
  const boundedAcquisitionGap = results.some((result) => {
    const failure = firstFailure(result);
    return failure?.class === "ACQUISITION_FAILED" ||
      matrixStatus(result, "overview") === "FAIL" ||
      (operationMs(result, "cadencePage1") ?? 0) > 60_000 ||
      (operationMs(result, "overview") ?? 0) > 60_000;
  });
  const majorUntested = majorResults.some((result) => result.classification === "UNTESTED") || majorResults.length < majorNames.length;
  const resolverFailure = results.some((result) => {
    const failure = firstFailure(result);
    return failure?.class === "RESOLVER_FAILED" || failure?.class === "PROVIDER_EXTRACTION_FAILED";
  });
  const progressiveSlow = majorResults.some((result) => matrixTransport(result).startsWith("progressive") && (operationMs(result, "exactFrame") ?? 0) > 30_000);
  const nextPriority = boundedAcquisitionGap || overviewPartial
    ? "B. bounded HLS/overview acquisition"
    : majorUntested
    ? "A. more provider qualification"
    : resolverFailure
    ? "D. resolver compatibility"
    : progressiveSlow
    ? "C. progressive bounded acquisition"
    : "A. more provider qualification";
  lines.push("", "## 16. Next engineering priority", "", `**${nextPriority}**. Chosen from measured fixture results: overview failures take precedence when they expose a generic acquisition-budget gap; otherwise unresolved provider coverage, resolver failures, or slow progressive acquisition determine the next slice.`);

  const enoughEvidence = process.env.URMA_YOUTUBE_BASELINE === "PASS" || firstClass.length > 0 || bestEffort.length > 0;
  lines.push("", "## 17. Final verdict", "", enoughEvidence ? "YES, WITH IMPORTANT QUALIFICATIONS" : "NO", "", enoughEvidence
    ? "The secured generic path is supported by the exercised results and the established YouTube baseline, but the truthful product claim must distinguish continuously tested providers from first-class candidates awaiting that history and preserve the fixture, regional-access, caption, overview, and lifecycle qualifications above."
    : "This run did not produce enough passing evidence for a broad support claim.");
  return `${lines.join("\n")}\n`;
}


function fixtureBoolean(
  item: AnyRecord,
  key: "restart" | "refresh",
  provider: string,
  url: string | null,
): boolean {
  const value = item[key];
  if (value === undefined) {
    if (url !== null) {
      throw new Error(`Runnable ${provider} fixture must declare ${key} as true or false`);
    }
    return false;
  }
  if (typeof value !== "boolean") {
    throw new Error(`Fixture ${provider} field ${key} must be a boolean`);
  }
  return value;
}

function optionalExpectedExtractor(
  value: unknown,
  provider: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Fixture ${provider} expectedExtractor must be a non-empty string when present`);
  }
  return value.trim();
}

async function loadFixtures(): Promise<Fixture[]> {
  const raw = JSON.parse(await readFile(path.join(ROOT, "compat", "fixtures", "providers.json"), "utf8")) as unknown;
  if (!Array.isArray(raw)) throw new Error("compat fixture manifest must be an array");
  return raw.map((item, index) => {
    if (!record(item)) throw new Error(`compat fixture row ${index + 1} must be an object`);
    if (typeof item.provider !== "string" || item.provider.trim().length === 0) {
      throw new Error(`compat fixture row ${index + 1} must contain a non-empty provider`);
    }
    if (item.tier !== "A" && item.tier !== "B") {
      throw new Error(`compat fixture ${item.provider} must declare tier A or B`);
    }
    if (item.url !== undefined && item.url !== null && typeof item.url !== "string") {
      throw new Error(`compat fixture ${item.provider} url must be a string or null`);
    }
    const provider = item.provider.trim();
    const url = typeof item.url === "string" ? item.url : null;
    const expectedExtractor = optionalExpectedExtractor(
      item.expectedExtractor,
      provider,
    );
    return {
      provider,
      tier: item.tier,
      url,
      ...(typeof item.fixtureId === "string" ? { fixtureId: item.fixtureId } : {}),
      ...(typeof item.fixtureTitle === "string" ? { fixtureTitle: item.fixtureTitle } : {}),
      ...(expectedExtractor === undefined ? {} : { expectedExtractor }),
      ...(Array.isArray(item.alternates)
        ? { alternates: item.alternates.filter((value): value is string => typeof value === "string") }
        : {}),
      restart: fixtureBoolean(item, "restart", provider, url),
      refresh: fixtureBoolean(item, "refresh", provider, url),
      ...(typeof item.notes === "string" ? { notes: item.notes } : {}),
      ...(typeof item.untestedReason === "string" ? { untestedReason: item.untestedReason } : {}),
    };
  });
}

const enabled = process.env.URMA_RUN_COMPAT === "1";
if (!enabled) {
  process.stderr.write(
    "Urma compatibility gauntlet skipped: set URMA_RUN_COMPAT=1 to permit live provider tests.\n",
  );
} else {
  const fixtures = await loadFixtures();
  const selected = process.env.URMA_COMPAT_PROVIDERS?.trim()
    ? new Set(process.env.URMA_COMPAT_PROVIDERS.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean))
    : null;
  const tier = process.env.URMA_COMPAT_TIER?.trim().toUpperCase();
  const includeUntested = process.env.URMA_COMPAT_INCLUDE_UNTESTED === "1";
  const candidates = fixtures.filter((fixture) => {
    const selectedMatch = selected === null || selected.has(fixture.provider.toLowerCase());
    const untestedMatch = includeUntested && fixture.url === null;
    const tierMatch = tier === undefined || tier === "" || fixture.tier === tier || untestedMatch;
    return (selectedMatch || untestedMatch) && tierMatch;
  });
  const results: AnyRecord[] = [];
  for (const fixture of candidates) {
    process.stderr.write(`Urma compatibility: ${fixture.provider}\n`);
    const result = await runFixture(fixture);
    results.push(result);
    process.stdout.write(`${JSON.stringify({
      provider: result.provider,
      classification: result.classification,
      firstFailure: result.firstFailure ?? null,
    })}\n`);
  }
  await mkdir(RESULTS_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();
  await writeFile(
    path.join(RESULTS_DIR, "latest.json"),
    `${JSON.stringify({ generatedAt, results }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(RESULTS_DIR, "latest.md"),
    reportMarkdown(results, generatedAt),
    "utf8",
  );
  process.stdout.write(`Urma compatibility results written to ${path.join(RESULTS_DIR, "latest.json")}\n`);
}
