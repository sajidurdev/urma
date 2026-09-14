import { createHash } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import path from "node:path";
import { UrmaError } from "../core/errors.js";
import type { ArtifactSpec } from "./manifest.js";

export type ArtifactFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type DownloadOptions = Readonly<{
  fetchImpl?: ArtifactFetch;
  maxBytes?: number;
  timeoutMs?: number;
}>;

function artifactError(message: string, cause?: unknown): UrmaError {
  return new UrmaError("ARTIFACT_DOWNLOAD_FAILED", message, { cause });
}

export async function downloadAndVerifyArtifact(
  artifact: ArtifactSpec,
  destination: string,
  options: DownloadOptions = {},
): Promise<void> {
  if (!/^https:\/\//u.test(artifact.url) || /\/latest(?:\/|$)/iu.test(artifact.url)) {
    throw artifactError(`Artifact URL is not an immutable HTTPS release URL: ${artifact.url}`);
  }
  const maxBytes = options.maxBytes ?? Math.max(artifact.archiveBytes, 1) + 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw artifactError("Artifact download byte limit is invalid");
  const contentLengthLimit = artifact.archiveBytes > 0 ? artifact.archiveBytes : undefined;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10 * 60_000);
  timeout.unref();
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let verified = false;
  try {
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    handle = await open(destination, "wx", 0o600);
    const fetchImpl = options.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await fetchImpl(artifact.url, {
        redirect: "follow",
        cache: "no-store",
        signal: controller.signal,
        headers: { "user-agent": "Urma-v1-installer" },
      });
    } catch (error) {
      throw artifactError(`Could not download pinned ${artifact.provider} ${artifact.kind} artifact`, error);
    }
    if (!response.ok || response.body === null) {
      throw artifactError(`Pinned artifact request failed with HTTP ${String(response.status)} for ${artifact.url}`);
    }
    const contentLength = response.headers.get("content-length")?.trim();
    const declared = contentLength === undefined || contentLength === ""
      ? undefined
      : Number(contentLength);
    if (declared !== undefined && Number.isSafeInteger(declared) && declared > maxBytes) throw artifactError("Artifact Content-Length exceeds the installer safety limit");
    if (declared !== undefined && !Number.isSafeInteger(declared)) throw artifactError(`Artifact Content-Length ${JSON.stringify(contentLength)} is invalid`);
    if (contentLengthLimit !== undefined && declared !== undefined && declared !== contentLengthLimit) {
      throw artifactError(`Artifact Content-Length ${String(declared)} does not match the pinned size ${String(contentLengthLimit)}`);
    }
    const digest = createHash("sha256");
    let bytes = 0;
    const reader = response.body.getReader();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const value = Buffer.from(next.value);
      bytes += value.length;
      if (bytes > maxBytes) throw artifactError(`Artifact exceeded the ${String(maxBytes)}-byte safety limit`);
      digest.update(value);
      await handle.write(value);
    }
    await handle.sync();
    if (contentLengthLimit !== undefined && bytes !== contentLengthLimit) throw artifactError(`Artifact size ${String(bytes)} does not match the pinned size ${String(contentLengthLimit)}`);
    const actual = digest.digest("hex");
    if (actual !== artifact.archiveSha256) {
      throw new UrmaError(
        "ARTIFACT_HASH_MISMATCH",
        `Pinned ${artifact.kind} artifact hash mismatch; expected ${artifact.archiveSha256}, received ${actual}`,
        { detail: { url: artifact.url, expectedSha256: artifact.archiveSha256, actualSha256: actual } },
      );
    }
    verified = true;
  } catch (error) {
    if (!verified) controller.abort();
    if (error instanceof UrmaError) throw error;
    throw artifactError(`Could not acquire or verify ${artifact.kind} artifact`, error);
  } finally {
    clearTimeout(timeout);
    try {
      await handle?.close();
    } catch {
      // The original acquisition error is more useful to the caller.
    }
    if (!verified) await rm(destination, { force: true }).catch(() => undefined);
  }
}
