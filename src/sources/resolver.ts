import type { UrmaConfig } from "../config.js";
import { UrmaError } from "../core/errors.js";
import {
  createSnapshotRevision,
  parseSourceRef,
  sha256,
  type RemoteIdentity,
  type SourceRef,
} from "../core/ids.js";
import type {
  StoredSource,
  StoredSourceLocator,
  StoredSourceSnapshot,
  UrmaStore,
} from "../store/store.js";
import { inspectGenericRemote, inspectLocal, inspectYouTube } from "./metadata.js";
import {
  localSnapshotRevision,
  parseLocalSnapshot,
  pinLocalBundle,
  resolveLocalBundle,
  type PinnedLocalBundle,
} from "./local.js";
import type { BlobStore } from "../store/blob-store.js";
import type { ResolvedSource } from "./types.js";
import { parseYouTubeUrl } from "./youtube.js";
import { hydrateCaptionTracks } from "./caption-tracks.js";
import { assertRemoteTargetAllowed } from "../remote/egress.js";
import {
  type RemoteOperationContext,
} from "../remote/worker.js";
import {
  normalizeRemoteResolution,
  type RemoteResolutionResult,
} from "../remote/normalize.js";

export type Freshness = "reuse" | "refresh";

function remoteResolutionResult(value: unknown): value is RemoteResolutionResult {
  if (!record(value)) return false;
  const timeline = value.timeline;
  if (!record(timeline)) return false;
  return typeof value.inputUrl === "string" &&
    typeof value.canonicalUrl === "string" &&
    record(value.metadata) &&
    timeline.finite === true &&
    typeof timeline.durationMs === "number" &&
    Number.isSafeInteger(timeline.durationMs) &&
    timeline.durationMs > 0;
}

export type RemoteResolutionProvider = (
  inputUrl: string,
  signal?: AbortSignal,
) => Promise<RemoteResolutionResult>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeMetadataForSnapshot(source: ResolvedSource): Record<string, unknown> {
  const safe = { ...source.safeMetadata };
  delete safe.canonicalLocator;
  delete safe.captionSidecar;
  return safe;
}

function descriptor(source: ResolvedSource): Record<string, unknown> {
  const captionSidecar = typeof source.safeMetadata.captionSidecar === "string"
    ? source.safeMetadata.captionSidecar
    : null;
  return {
    canonicalKey: source.kind === "remote" ? source.canonicalKey : null,
    identity: source.identity,
    title: source.title,
    metadataDurationMs: source.metadataDurationMs,
    timeline: source.timeline,
    extractor: source.extractor,
    extractorKey: source.extractorKey,
    liveState: source.liveState,
    safeOrigins: source.safeOrigins,
    resolverVersion: source.resolverVersion,
    normalizationVersion: source.normalizationVersion,
    policyVersion: source.policyVersion,
    chapters: source.chapters,
    captionTracks: source.captionTracks,
    formats: source.formats,
    capabilities: source.capabilities,
    safeMetadata: safeMetadataForSnapshot(source),
    remoteAcquisition: source.remoteAcquisition ?? null,
    reopenLocatorDigest: sha256(source.canonicalLocator),
    captionLocatorDigest: captionSidecar === null ? null : sha256(captionSidecar),
  };
}

function snapshotFromResolved(source: ResolvedSource): StoredSourceSnapshot {
  return {
    sourceRef: source.sourceRef,
    revision: source.revision,
    observedAt: source.observedAt,
    durationMs: source.durationMs,
    descriptor: descriptor(source),
  };
}

function sourceIdentity(source: ResolvedSource): StoredSource["identity"] {
  if (source.kind === "remote" && source.identity !== null) return source.identity;
  return {
    basis: "local",
    pathDigest: source.sourceRef.slice("urma:source:local:".length),
  };
}

function locatorsFor(
  source: ResolvedSource,
  additional: readonly string[],
): StoredSourceLocator[] {
  const values = new Map<string, string>();
  values.set(sha256(source.canonicalLocator), source.canonicalLocator);
  for (const locator of additional) values.set(sha256(locator), locator);
  const captionSidecar = source.safeMetadata.captionSidecar;
  if (typeof captionSidecar === "string") values.set(sha256(captionSidecar), captionSidecar);
  return [...values.entries()].map(([locatorDigest, privateReopenLocator]) => ({
    sourceRef: source.sourceRef,
    locatorDigest,
    privateReopenLocator,
    observedAt: source.observedAt,
  }));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function liveState(value: unknown): ResolvedSource["liveState"] {
  return value === "live" || value === "upcoming" || value === "unknown" ? value : "finite";
}

export function materializeResolvedSource(
  store: UrmaStore,
  source: StoredSource,
  snapshot: StoredSourceSnapshot,
): ResolvedSource {
  const metadata = snapshot.descriptor;
  const reopenDigest = typeof metadata.reopenLocatorDigest === "string"
    ? metadata.reopenLocatorDigest
    : null;
  const reopenLocator = reopenDigest === null
    ? null
    : store.getLocator(source.sourceRef, reopenDigest);
  if (!reopenLocator) {
    throw new UrmaError(
      "SOURCE_UNAVAILABLE",
      `Source snapshot ${snapshot.revision} has no private reopen locator; refresh the source from its original input`,
    );
  }
  const captionDigest = typeof metadata.captionLocatorDigest === "string"
    ? metadata.captionLocatorDigest
    : null;
  const captionLocator = captionDigest === null
    ? null
    : store.getLocator(source.sourceRef, captionDigest);
  const safe = record(metadata.safeMetadata) ? { ...metadata.safeMetadata } : {};
  if (source.kind === "local" && !parseLocalSnapshot(safe.localSnapshot)) {
    throw new UrmaError(
      "SOURCE_UNAVAILABLE",
      `Source snapshot ${snapshot.revision} has no valid pinned local content; inspect the original source with refresh`,
      { detail: { reason: "local-snapshot-missing" } },
    );
  }
  if (captionLocator) safe.captionSidecar = captionLocator.privateReopenLocator;
  const timeline = record(metadata.timeline)
    ? metadata.timeline as ResolvedSource["timeline"]
    : {
      finite: true as const,
      durationMs: snapshot.durationMs,
      basis: "container" as const,
      validatedAt: snapshot.observedAt,
    };
  const remoteAcquisition = source.kind === "remote"
    ? "safe-proxy"
    : null;
  return {
    sourceRef: source.sourceRef,
    kind: source.kind,
    canonicalKey: typeof metadata.canonicalKey === "string" ? metadata.canonicalKey : source.sourceRef,
    identity: source.kind === "remote" ? source.identity as RemoteIdentity : null,
    snapshotRef: { sourceRef: source.sourceRef, revision: snapshot.revision },
    canonicalLocator: reopenLocator.privateReopenLocator,
    revision: snapshot.revision,
    observedAt: snapshot.observedAt,
    title: typeof metadata.title === "string" ? metadata.title : "untitled",
    durationMs: snapshot.durationMs,
    metadataDurationMs: typeof metadata.metadataDurationMs === "number" ? metadata.metadataDurationMs : null,
    timeline,
    extractor: typeof metadata.extractor === "string" ? metadata.extractor : null,
    extractorKey: typeof metadata.extractorKey === "string" ? metadata.extractorKey : null,
    liveState: liveState(metadata.liveState),
    safeOrigins: stringArray(metadata.safeOrigins),
    resolverVersion: typeof metadata.resolverVersion === "string" ? metadata.resolverVersion : "unknown",
    normalizationVersion: typeof metadata.normalizationVersion === "string" ? metadata.normalizationVersion : "unknown",
    policyVersion: typeof metadata.policyVersion === "string" ? metadata.policyVersion : "unknown",
    chapters: Array.isArray(metadata.chapters) ? metadata.chapters as ResolvedSource["chapters"] : [],
    captionTracks: hydrateCaptionTracks(source.sourceRef, snapshot.revision, metadata.captionTracks),
    formats: Array.isArray(metadata.formats) ? metadata.formats as ResolvedSource["formats"] : [],
    capabilities: (metadata.capabilities ?? {
      nativeCaptions: false,
      chapters: false,
      nativeStoryboard: false,
      targetedMedia: false,
      audio: false,
    }) as ResolvedSource["capabilities"],
    safeMetadata: safe,
    ...(remoteAcquisition === null ? {} : { remoteAcquisition }),
  };
}

export class SourceResolver {
  constructor(
    readonly config: UrmaConfig,
    readonly store: UrmaStore,
    readonly remoteContext: RemoteOperationContext | null = null,
    readonly remoteResolutionProvider: RemoteResolutionProvider | null = null,
    readonly blobs: BlobStore | null = null,
  ) {}

  async resolve(
    input: string,
    signal?: AbortSignal,
    freshness: Freshness = "reuse",
  ): Promise<{ source: ResolvedSource; cacheHit: boolean }> {
    if (input.startsWith("urma:source:")) {
      let ref: SourceRef;
      try {
        ref = parseSourceRef(input);
      } catch (error) {
        throw new UrmaError(
          "INVALID_SOURCE",
          `Source reference ${JSON.stringify(input)} is malformed; call inspect_video with a supported URL or local path`,
          { cause: error },
        );
      }
      const stored = this.store.getSource(ref);
      if (!stored) throw new UrmaError("INVALID_SOURCE", `Source reference ${input} is unknown in this Urma data directory; inspect the original source first`);
      const latest = this.store.getLatestSnapshot(ref);
      if (!latest) throw new UrmaError("SOURCE_UNAVAILABLE", `Source reference ${input} has no resolution snapshot; refresh the original source`);
      if (freshness === "reuse") return { source: materializeResolvedSource(this.store, stored, latest), cacheHit: true };
      return await this.#refresh(this.#canonicalLocator(stored, latest), stored, signal);
    }

    let youtube: ReturnType<typeof parseYouTubeUrl> | null = null;
    try {
      youtube = parseYouTubeUrl(input);
    } catch (error) {
      const youtubeHost = (() => {
        try {
          const host = new URL(input).hostname.toLowerCase();
          return host === "youtu.be" ||
            host === "youtube.com" ||
            host.endsWith(".youtube.com");
        } catch {
          return false;
        }
      })();
      const windowsPath = /^[A-Za-z]:[\\/]/u.test(input);
      const nonHttpScheme =
        !windowsPath &&
        !/^https?:\/\//i.test(input) &&
        /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(input);
      if (
        youtubeHost ||
        nonHttpScheme ||
        (!/^https?:\/\//i.test(input) &&
          !(/[\\/]/.test(input) || windowsPath))
      ) throw error;
    }
    if (youtube) {
      const existing = this.store.getSource(youtube.sourceRef);
      if (existing && freshness === "reuse") {
        const latest = this.store.getLatestSnapshot(youtube.sourceRef);
        if (latest) {
          const source = materializeResolvedSource(this.store, existing, latest);
          this.#recordLocators(source, [input, youtube.canonicalUrl]);
          return { source, cacheHit: true };
        }
      }
      const source = await inspectYouTube(input, this.config, this.remoteContext, signal);
      this.#save(source, [input, youtube.canonicalUrl]);
      return { source, cacheHit: false };
    }
    if (/^https?:\/\//i.test(input)) {
      assertRemoteTargetAllowed({ url: input, purpose: "input" });
      const locatorMatches = this.store.findSourcesByLocatorDigest(sha256(input));
      if (locatorMatches.length > 1) {
        throw new UrmaError(
          "INVALID_SOURCE",
          "The supplied remote locator is ambiguous across logical sources; use an exact sourceRef or refresh from the original URL",
          { detail: { locatorAmbiguous: true } },
        );
      }
      const aliased = locatorMatches[0];
      if (aliased) {
        const latest = this.store.getLatestSnapshot(aliased.sourceRef);
        if (!latest) {
          throw new UrmaError(
            "SOURCE_UNAVAILABLE",
            "The remote locator has no immutable snapshot; refresh from the original URL",
          );
        }
        if (freshness === "reuse") {
          const source = materializeResolvedSource(this.store, aliased, latest);
          this.#recordLocators(source, [input]);
          return { source, cacheHit: true };
        }
        return await this.#refresh(input, aliased, signal);
      }
      const revision = createSnapshotRevision();
      let source: ResolvedSource;
      let aliases: string[] = [input];
      if (this.remoteResolutionProvider) {
        const result = await this.remoteResolutionProvider(input, signal);
        if (!remoteResolutionResult(result)) {
          throw new UrmaError(
            "SOURCE_UNAVAILABLE",
            "Remote resolver returned no validated resolution snapshot",
          );
        }
        source = normalizeRemoteResolution(result, revision);
        aliases = [input, result.canonicalUrl, ...(result.redirectUrls ?? [])];
      } else {
        source = await inspectGenericRemote(
          input,
          this.config,
          this.remoteContext,
          signal,
          revision,
        );
      }
      this.#save(source, aliases);
      return { source, cacheHit: false };
    }
    const pinned = await this.#pinLocalBundle(input);
    const existing = this.store.getSource(pinned.identity.sourceRef);
    const latest = existing ? this.store.getLatestSnapshot(pinned.identity.sourceRef) : null;
    const revision = localSnapshotRevision(pinned);
    if (existing && latest && latest.revision === revision) {
      return {
        source: materializeResolvedSource(this.store, existing, latest),
        cacheHit: freshness === "reuse",
      };
    }
    const source = await inspectLocal(pinned, this.config, signal);
    this.#save(source, []);
    return { source, cacheHit: false };
  }

  async #pinLocalBundle(input: string): Promise<PinnedLocalBundle> {
    const blobs = this.blobs;
    if (!blobs) {
      throw new UrmaError(
        "SOURCE_UNAVAILABLE",
        "Local source inspection requires a configured blob store to pin the admitted bytes",
        { detail: { reason: "local-snapshot-unavailable" } },
      );
    }
    return await pinLocalBundle(
      await resolveLocalBundle(input, this.config),
      blobs,
    );
  }

  #canonicalLocator(source: StoredSource, snapshot: StoredSourceSnapshot): string {
    const digest = record(snapshot.descriptor) && typeof snapshot.descriptor.reopenLocatorDigest === "string" ? snapshot.descriptor.reopenLocatorDigest : null;
    if (!digest) throw new UrmaError("SOURCE_UNAVAILABLE", `Source ${source.sourceRef} has no canonical locator digest; refresh from the original input`);
    const locator = this.store.getLocator(source.sourceRef, digest);
    if (!locator) throw new UrmaError("SOURCE_UNAVAILABLE", `Source ${source.sourceRef} has no private reopen locator; refresh from the original input`);
    return locator.privateReopenLocator;
  }

  async #refresh(locator: string, stored: StoredSource, signal?: AbortSignal): Promise<{ source: ResolvedSource; cacheHit: boolean }> {
    if (stored.kind === "remote") {
      let source: ResolvedSource;
      if (
        stored.identity.basis === "extractor" &&
        stored.identity.namespace === "youtube"
      ) {
        source = await inspectYouTube(locator, this.config, this.remoteContext, signal);
      } else {
        const revision = createSnapshotRevision();
        if (this.remoteResolutionProvider) {
          const result = await this.remoteResolutionProvider(locator, signal);
          if (!remoteResolutionResult(result)) {
            throw new UrmaError(
              "SOURCE_UNAVAILABLE",
              "Remote resolver returned no validated refresh snapshot",
            );
          }
          source = normalizeRemoteResolution(result, revision);
        } else {
          source = await inspectGenericRemote(
            locator,
            this.config,
            this.remoteContext,
            signal,
            revision,
          );
        }
      }
      if (source.sourceRef !== stored.sourceRef) throw new UrmaError("SOURCE_UNAVAILABLE", "Refresh resolved a different logical remote source; the old snapshot remains unchanged");
      this.#save(source, [locator]);
      return { source, cacheHit: false };
    }
    const pinned = await this.#pinLocalBundle(locator);
    const revision = localSnapshotRevision(pinned);
    const existing = this.store.getSnapshot(stored.sourceRef, revision);
    if (existing) {
      return {
        source: materializeResolvedSource(this.store, stored, existing),
        cacheHit: false,
      };
    }
    const source = await inspectLocal(pinned, this.config, signal);
    if (source.sourceRef !== stored.sourceRef) throw new UrmaError("SOURCE_UNAVAILABLE", "Refresh resolved a different local logical source; the old snapshot remains unchanged");
    this.#save(source, []);
    return { source, cacheHit: false };
  }

  #recordLocators(source: ResolvedSource, aliases: readonly string[]): void {
    this.store.putSourceSnapshot({
      source: { sourceRef: source.sourceRef, kind: source.kind, identity: sourceIdentity(source), latestRevision: source.revision },
      snapshot: snapshotFromResolved(source),
      locators: locatorsFor(source, aliases),
    });
  }

  #save(source: ResolvedSource, aliases: readonly string[]): void {
    if (source.durationMs < 1 || !Number.isSafeInteger(source.durationMs)) throw new UrmaError("METADATA_UNAVAILABLE", "Only a positive finite source timeline can be admitted to an investigation");
    this.store.putSourceSnapshot({
      source: { sourceRef: source.sourceRef, kind: source.kind, identity: sourceIdentity(source), latestRevision: source.revision },
      snapshot: snapshotFromResolved(source),
      locators: locatorsFor(source, aliases),
    });
  }
}
