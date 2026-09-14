import { sha256 } from "../../src/core/ids.js";
import type { SourceKind } from "../../src/core/model.js";
import type { SourceRef } from "../../src/core/ids.js";
import type { UrmaStore } from "../../src/store/store.js";

export type TestSourceInput = Readonly<{
  sourceRef: SourceRef;
  kind: SourceKind;
  canonicalKey: string;
  revision: string;
  title: string;
  durationMs: number;
  metadata: Readonly<Record<string, unknown>>;
}>;

/** Store compact test fixtures through the immutable snapshot API. */
export function putTestSource(
  store: UrmaStore,
  source: TestSourceInput,
  aliases: readonly Readonly<{ alias: string }>[] = [],
): void {
  const isRemote = source.kind === "remote";
  const canonicalLocator = typeof source.metadata.canonicalLocator === "string"
    ? source.metadata.canonicalLocator
    : isRemote
    ? `https://www.youtube.com/watch?v=${source.canonicalKey}`
    : source.canonicalKey;
  const observedAt = new Date(0).toISOString();
  const metadata = { ...source.metadata };
  delete metadata.canonicalLocator;
  const remoteIdentity = isRemote
    ? { basis: "extractor" as const, namespace: "youtube", id: source.canonicalKey }
    : null;
  const identity = remoteIdentity ?? {
    basis: "local" as const,
    pathDigest: source.sourceRef.slice("urma:source:local:".length),
  };
  store.putSourceSnapshot({
    source: {
      sourceRef: source.sourceRef,
      kind: source.kind,
      identity,
      latestRevision: source.revision,
    },
    snapshot: {
      sourceRef: source.sourceRef,
      revision: source.revision,
      observedAt,
      durationMs: source.durationMs,
      descriptor: {
        canonicalKey: isRemote ? source.canonicalKey : null,
        identity: remoteIdentity,
        title: source.title,
        metadataDurationMs: source.durationMs,
        timeline: {
          finite: true,
          durationMs: source.durationMs,
          basis: "container",
          validatedAt: observedAt,
        },
        extractor: isRemote ? "youtube" : null,
        extractorKey: isRemote ? source.canonicalKey : null,
        liveState: "finite",
        safeOrigins: isRemote ? ["https://www.youtube.com"] : [],
        resolverVersion: "fixture",
        normalizationVersion: "remote-normalization-v1",
        policyVersion: "fixture",
        ...metadata,
        reopenLocatorDigest: sha256(canonicalLocator),
        captionLocatorDigest: null,
      },
    },
    locators: [
      {
        sourceRef: source.sourceRef,
        locatorDigest: sha256(canonicalLocator),
        privateReopenLocator: canonicalLocator,
        observedAt,
      },
      ...aliases.map((alias) => ({
        sourceRef: source.sourceRef,
        locatorDigest: sha256(alias.alias),
        privateReopenLocator: alias.alias,
        observedAt,
      })),
    ],
  });
}
