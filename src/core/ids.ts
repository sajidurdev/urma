import { createHash, randomUUID } from "node:crypto";

declare const sourceRefBrand: unique symbol;
declare const investigationRefBrand: unique symbol;
declare const artifactIdBrand: unique symbol;
declare const trackRefBrand: unique symbol;

export type SourceRef = string & { readonly [sourceRefBrand]: true };
export type InvestigationRef = string & {
  readonly [investigationRefBrand]: true;
};
export type ArtifactId = string & { readonly [artifactIdBrand]: true };
export type TrackRef = string & { readonly [trackRefBrand]: true };
export type CandidateKey = string & { readonly __candidateKey: true };

const SOURCE_REF =
  /^urma:source:(remote:v1:[0-9a-f]{64}|local:[0-9a-f]{32})$/;
const INVESTIGATION_REF = /^urma:investigation:([0-9a-f]{32})$/;
const ARTIFACT_ID = /^urma:artifact:sha256:([0-9a-f]{64})$/;
const TRACK_REF = /^urma:track:([0-9a-f]{32})$/;

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${
    Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")
  }}`;
}

export type RemoteIdentity = Readonly<
  | {
    basis: "extractor";
    namespace: string;
    id: string;
  }
  | {
    basis: "locator";
    locatorDigest: string;
  }
>;

function assertRemoteIdentity(identity: RemoteIdentity): void {
  if (identity.basis === "extractor") {
    if (
      !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(identity.namespace) ||
      identity.id.length < 1 ||
      identity.id.length > 512 ||
      /[\u0000-\u001f\u007f]/u.test(identity.id)
    ) {
      throw new TypeError("Extractor remote identity is malformed");
    }
    return;
  }
  if (!/^[0-9a-f]{64}$/.test(identity.locatorDigest)) {
    throw new TypeError(
      "Locator remote identity must contain a lowercase full SHA-256 digest",
    );
  }
}

export function remoteSourceRef(identity: RemoteIdentity): SourceRef {
  assertRemoteIdentity(identity);
  return `urma:source:remote:v1:${
    sha256(stableJson({ version: 1, identity }))
  }` as SourceRef;
}

export function snapshotCandidateKey(
  snapshot: { readonly sourceRef: SourceRef; readonly revision: string },
  description: unknown,
): CandidateKey {
  if (!snapshot.sourceRef || !snapshot.revision) {
    throw new TypeError("Candidate identity requires a source snapshot");
  }
  return `urma:candidate:${sha256(stableJson({ snapshot, description }))}` as CandidateKey;
}

export function createSnapshotRevision(now = Date.now()): string {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new TypeError("Snapshot revision time must be a non-negative safe integer");
  }
  return `v1:${now.toString(36)}:${randomUUID().replaceAll("-", "")}`;
}

/** Normalize a validated YouTube video ID to the generic remote identity shape. */
export function youtubeRemoteIdentity(videoId: string): RemoteIdentity {
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    throw new TypeError(
      `Invalid YouTube video ID ${
        JSON.stringify(videoId)
      }; expected 11 URL-safe characters`,
    );
  }
  return { basis: "extractor", namespace: "youtube", id: videoId };
}

export function localSourceRef(canonicalPath: string): SourceRef {
  if (!canonicalPath) {
    throw new TypeError(
      "Cannot create a local sourceRef from an empty canonical path",
    );
  }
  return `urma:source:local:${sha256(canonicalPath).slice(0, 32)}` as SourceRef;
}

export function captionTrackRef(
  sourceRef: SourceRef,
  sourceRevision: string,
  language: string,
  kind: string,
  providerTrackId: string | null,
): TrackRef {
  if (!sourceRevision || !language || !kind) {
    throw new TypeError("Caption track identity inputs must not be empty");
  }
  const identity = providerTrackId === null
    ? `${sourceRef}|${sourceRevision}|${language}|${kind}`
    : stableJson({
      sourceRef,
      sourceRevision,
      language,
      kind,
      providerTrackId,
    });
  return `urma:track:${sha256(identity).slice(0, 32)}` as TrackRef;
}

export function createInvestigationRef(uuid = randomUUID()): InvestigationRef {
  const compact = uuid.toLowerCase().replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/.test(compact)) {
    throw new TypeError(
      `Invalid investigation UUID ${
        JSON.stringify(uuid)
      }; expected 128-bit hexadecimal UUID data`,
    );
  }
  return `urma:investigation:${compact}` as InvestigationRef;
}

export function artifactIdFromSha256(hash: string): ArtifactId {
  const normalized = hash.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new TypeError(
      `Invalid artifact SHA-256 ${
        JSON.stringify(hash)
      }; expected 64 hexadecimal characters`,
    );
  }
  return `urma:artifact:sha256:${normalized}` as ArtifactId;
}

export function parseSourceRef(value: string): SourceRef {
  if (!SOURCE_REF.test(value)) {
    throw new TypeError(`Invalid sourceRef ${JSON.stringify(value)}`);
  }
  return value as SourceRef;
}

export function parseInvestigationRef(value: string): InvestigationRef {
  if (!INVESTIGATION_REF.test(value)) {
    throw new TypeError(`Invalid investigationRef ${JSON.stringify(value)}`);
  }
  return value as InvestigationRef;
}

export function parseArtifactId(value: string): ArtifactId {
  if (!ARTIFACT_ID.test(value)) {
    throw new TypeError(`Invalid artifactId ${JSON.stringify(value)}`);
  }
  return value as ArtifactId;
}

export function parseTrackRef(value: string): TrackRef {
  if (!TRACK_REF.test(value)) {
    throw new TypeError(`Invalid trackRef ${JSON.stringify(value)}`);
  }
  return value as TrackRef;
}

export function artifactHashFromId(value: ArtifactId): string {
  return value.slice("urma:artifact:sha256:".length);
}

export function investigationArtifactUri(
  investigationRef: InvestigationRef,
  artifactId: ArtifactId,
): string {
  return `urma://investigation/${
    investigationRef.slice("urma:investigation:".length)
  }/artifact/${artifactHashFromId(artifactId)}`;
}
