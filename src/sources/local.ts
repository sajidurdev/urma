import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { UrmaConfig } from "../config.js";
import { UrmaError } from "../core/errors.js";
import {
  artifactHashFromId,
  localSourceRef,
  parseArtifactId,
  sha256,
  stableJson,
  type ArtifactId,
  type SourceRef,
} from "../core/ids.js";
import type { BlobStore, BlobWrite } from "../store/blob-store.js";

function isUnc(value: string): boolean {
  return value.startsWith("\\\\") || value.startsWith("//");
}
function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

export type LocalIdentity = Readonly<{
  sourceRef: SourceRef;
  canonicalPath: string;
  revision: string;
  size: number;
  mtimeMs: number;
}>;
export type LocalBundleIdentity =
  & LocalIdentity
  & Readonly<{
    captionSidecar: string | null;
    captionSize: number | null;
    captionMtimeMs: number | null;
  }>;

export type LocalPinnedBlob = Readonly<{
  artifactId: ArtifactId;
  sha256: string;
  byteSize: number;
  blobPath: string;
  extension: string | null;
}>;

export type LocalSnapshot = Readonly<{
  version: "local-snapshot-v1";
  video: LocalPinnedBlob;
  caption: LocalPinnedBlob | null;
}>;

export type PinnedLocalBundle = Readonly<{
  identity: LocalBundleIdentity;
  video: BlobWrite;
  caption: BlobWrite | null;
}>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extensionForCaption(value: string): ".vtt" | ".srt" | null {
  const extension = path.extname(value).toLowerCase();
  return extension === ".vtt" || extension === ".srt" ? extension : null;
}

function localPinnedBlob(
  blob: BlobWrite,
  extension: string | null,
): LocalPinnedBlob {
  return {
    artifactId: blob.artifactId,
    sha256: blob.sha256,
    byteSize: blob.byteSize,
    blobPath: blob.relativePath,
    extension,
  };
}

export function localSnapshotForBundle(
  bundle: PinnedLocalBundle,
): LocalSnapshot {
  return {
    version: "local-snapshot-v1",
    video: localPinnedBlob(bundle.video, null),
    caption: bundle.caption === null
      ? null
      : localPinnedBlob(
        bundle.caption,
        extensionForCaption(bundle.identity.captionSidecar ?? ""),
      ),
  };
}

function parsePinnedBlob(value: unknown): LocalPinnedBlob | null | undefined {
  if (value === null) return null;
  if (!record(value)) return undefined;
  if (
    typeof value.artifactId !== "string" ||
    !/^urma:artifact:sha256:[0-9a-f]{64}$/u.test(value.artifactId) ||
    typeof value.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.sha256) ||
    typeof value.byteSize !== "number" ||
    !Number.isSafeInteger(value.byteSize) ||
    value.byteSize < 1 ||
    typeof value.blobPath !== "string" ||
    value.blobPath.length < 1 ||
    value.blobPath.length > 1024 ||
    value.blobPath.includes("\0") ||
    path.isAbsolute(value.blobPath)
  ) return undefined;
  let artifactId: ArtifactId;
  try {
    artifactId = parseArtifactId(value.artifactId);
  } catch {
    return undefined;
  }
  if (artifactHashFromId(artifactId) !== value.sha256) return undefined;
  const extension = value.extension === null
    ? null
    : typeof value.extension === "string" &&
        (value.extension === ".vtt" || value.extension === ".srt")
    ? value.extension
    : undefined;
  if (extension === undefined) return undefined;
  return {
    artifactId,
    sha256: value.sha256,
    byteSize: value.byteSize,
    blobPath: value.blobPath,
    extension,
  };
}

export function parseLocalSnapshot(value: unknown): LocalSnapshot | null {
  if (!record(value) || value.version !== "local-snapshot-v1") return null;
  const video = parsePinnedBlob(value.video);
  const caption = parsePinnedBlob(value.caption);
  if (video === null || video === undefined || caption === undefined) return null;
  if (video.extension !== null) return null;
  return { version: "local-snapshot-v1", video, caption };
}

/** Capture the admitted local bundle into immutable, content-addressed blobs. */
export async function pinLocalBundle(
  identity: LocalBundleIdentity,
  blobs: Pick<BlobStore, "putFile">,
): Promise<PinnedLocalBundle> {
  const video = await blobs.putFile(identity.canonicalPath);
  const caption = identity.captionSidecar === null
    ? null
    : await blobs.putFile(identity.captionSidecar);
  return { identity, video, caption };
}

/** Resolve a retained local video blob or fail closed if its snapshot is absent. */
export async function verifyPinnedLocalVideo(
  value: unknown,
  blobs: Pick<BlobStore, "verify">,
): Promise<string> {
  const snapshot = parseLocalSnapshot(value);
  if (!snapshot) {
    throw new UrmaError(
      "SOURCE_UNAVAILABLE",
      "The local investigation has no valid pinned video snapshot; inspect the source again",
      { detail: { reason: "local-snapshot-missing" } },
    );
  }
  try {
    return await blobs.verify(snapshot.video.artifactId, snapshot.video.blobPath);
  } catch (error) {
    throw new UrmaError(
      "SOURCE_UNAVAILABLE",
      "The pinned local video snapshot is unavailable; inspect the source again",
      { detail: { reason: "local-snapshot-blob-unavailable" }, cause: error },
    );
  }
}

/** Derive a local revision from admitted bytes and selected sidecar state. */
export function localSnapshotRevision(bundle: PinnedLocalBundle): string {
  const caption = bundle.caption === null
    ? null
    : {
      pathDigest: bundle.identity.captionSidecar === null
        ? null
        : sha256(bundle.identity.captionSidecar),
      sha256: bundle.caption.sha256,
      byteSize: bundle.caption.byteSize,
      extension: extensionForCaption(bundle.identity.captionSidecar ?? ""),
    };
  return `local:v2:${sha256(stableJson({
    version: 2,
    video: { sha256: bundle.video.sha256, byteSize: bundle.video.byteSize },
    caption,
  }))}`;
}

export async function resolveLocalPath(
  input: string,
  config: Pick<UrmaConfig, "localRoots" | "allowUnc">,
): Promise<LocalIdentity> {
  if (config.localRoots.length === 0) {
    throw new UrmaError(
      "LOCAL_SOURCE_DISABLED",
      "Local video sources are disabled; set URMA_LOCAL_ROOTS to one or more allowed directories and restart Urma",
    );
  }
  if (isUnc(input) && !config.allowUnc) {
    throw new UrmaError(
      "LOCAL_PATH_OUTSIDE_ROOT",
      `UNC/network source paths are disabled; use a local path under URMA_LOCAL_ROOTS`,
    );
  }
  const requested = path.resolve(input);
  const canonical = await realpath(requested).catch((error) => {
    throw new UrmaError(
      "LOCAL_FILE_NOT_FOUND",
      "Local source does not exist or cannot be resolved under the configured roots; verify the path and try again",
      { cause: error },
    );
  });
  if (isUnc(canonical) && !config.allowUnc) {
    throw new UrmaError(
      "LOCAL_PATH_OUTSIDE_ROOT",
      "Resolved local source is a UNC/network path, which is disabled by default",
    );
  }
  const roots = await Promise.all(
    config.localRoots.map(async (root) => {
      const value = await realpath(root).catch((error) => {
        throw new UrmaError(
          "LOCAL_PATH_OUTSIDE_ROOT",
          "A configured local root cannot be resolved; fix URMA_LOCAL_ROOTS and restart Urma",
          { cause: error },
        );
      });
      const info = await stat(value);
      if (!info.isDirectory()) {
        throw new UrmaError(
          "LOCAL_PATH_OUTSIDE_ROOT",
          "A configured URMA_LOCAL_ROOTS entry is not a directory; fix the configuration and restart Urma",
        );
      }
      return value;
    }),
  );
  const comparable = process.platform === "win32"
    ? canonical.toLowerCase()
    : canonical;
  if (
    !roots.some((root) =>
      within(
        process.platform === "win32" ? root.toLowerCase() : root,
        comparable,
      )
    )
  ) {
    throw new UrmaError(
      "LOCAL_PATH_OUTSIDE_ROOT",
      "Local source resolves outside every configured URMA_LOCAL_ROOTS directory",
    );
  }
  const info = await stat(canonical);
  if (!info.isFile()) {
    throw new UrmaError(
      "LOCAL_FILE_NOT_FOUND",
      "Local source is not a regular file; choose a video file under a configured root",
    );
  }
  const revision = `local:${
    sha256(`${canonical}|${info.size}|${info.mtimeMs}`)
  }`;
  return {
    sourceRef: localSourceRef(
      process.platform === "win32" ? canonical.toLowerCase() : canonical,
    ),
    canonicalPath: canonical,
    revision,
    size: info.size,
    mtimeMs: info.mtimeMs,
  };
}

export async function resolveLocalBundle(
  input: string,
  config: Pick<UrmaConfig, "localRoots" | "allowUnc">,
): Promise<LocalBundleIdentity> {
  const video = await resolveLocalPath(input, config);
  const parsed = path.parse(video.canonicalPath);
  let caption: LocalIdentity | null = null;
  for (const extension of [".vtt", ".srt"]) {
    const candidate = path.join(parsed.dir, `${parsed.name}${extension}`);
    const exists = await lstat(candidate)
      .then(() => true)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      });
    if (!exists) continue;
    caption = await resolveLocalPath(candidate, config);
    break;
  }
  const revision = `local:${
    sha256(
      `${video.canonicalPath}|${video.size}|${video.mtimeMs}|${
        caption?.canonicalPath ?? "no-caption"
      }|${caption?.size ?? 0}|${caption?.mtimeMs ?? 0}`,
    )
  }`;
  return {
    ...video,
    revision,
    captionSidecar: caption?.canonicalPath ?? null,
    captionSize: caption?.size ?? null,
    captionMtimeMs: caption?.mtimeMs ?? null,
  };
}
