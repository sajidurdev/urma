import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import {
  artifactHashFromId,
  type ArtifactId,
  artifactIdFromSha256,
  sha256,
} from "../core/ids.js";
import { UrmaError } from "../core/errors.js";

export type BlobWrite = Readonly<{
  artifactId: ArtifactId;
  sha256: string;
  byteSize: number;
  relativePath: string;
  absolutePath: string;
}>;

export class BlobStore {
  readonly #root: string;
  readonly #temp: string;

  constructor(root: string) {
    this.#root = path.resolve(root);
    this.#temp = path.join(this.#root, ".tmp");
  }
  async initialize(): Promise<void> {
    await mkdir(this.#temp, { recursive: true });
  }
  pathForHash(hash: string): string {
    return path.join(this.#root, hash.slice(0, 2), hash.slice(2, 4), hash);
  }
  relativePathForHash(hash: string): string {
    return path.join(hash.slice(0, 2), hash.slice(2, 4), hash);
  }

  async put(
    bytes: Uint8Array,
    validate: (temporaryPath: string) => Promise<void> | void = () => {},
  ): Promise<BlobWrite> {
    await this.initialize();
    const temporary = path.join(this.#temp, `${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, bytes, { flag: "wx" });
      await validate(temporary);
      const hash = sha256(bytes);
      return await this.#promote(temporary, hash, bytes.byteLength);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      if (error instanceof UrmaError) throw error;
      throw new UrmaError(
        "CACHE_WRITE_FAILED",
        "Validated artifact could not be committed to the Urma blob cache; check data-directory permissions and free space",
        { cause: error },
      );
    }
  }

  async putFile(
    sourcePath: string,
    validate: (temporaryPath: string) => Promise<void> | void = () => {},
  ): Promise<BlobWrite> {
    await this.initialize();
    const temporary = path.join(this.#temp, `${randomUUID()}.tmp`);
    try {
      await pipeline(
        createReadStream(sourcePath),
        createWriteStream(temporary, { flags: "wx" }),
      );
      await validate(temporary);
      const hash = await this.#hashFile(temporary);
      const info = await stat(temporary);
      return await this.#promote(temporary, hash, info.size);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      if (error instanceof UrmaError) throw error;
      throw new UrmaError(
        "CACHE_WRITE_FAILED",
        "Validated file artifact could not be committed to the Urma blob cache; check data-directory permissions and free space",
        { cause: error },
      );
    }
  }

  async #hashFile(file: string): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) {
      hash.update(chunk as Buffer);
    }
    return hash.digest("hex");
  }
  async #promote(
    temporary: string,
    hash: string,
    byteSize: number,
  ): Promise<BlobWrite> {
    const finalPath = this.pathForHash(hash);
    await mkdir(path.dirname(finalPath), { recursive: true });
    try {
      await rename(temporary, finalPath);
    } catch (error) {
      const existing = await stat(finalPath).catch(() => null);
      if (!existing?.isFile()) throw error;
      if ((await this.#hashFile(finalPath)) === hash) {
        await rm(temporary, { force: true });
      } else await this.#replaceCorrupt(temporary, finalPath, hash, error);
    }
    return {
      artifactId: artifactIdFromSha256(hash),
      sha256: hash,
      byteSize,
      relativePath: this.relativePathForHash(hash),
      absolutePath: finalPath,
    };
  }

  async #replaceCorrupt(
    temporary: string,
    finalPath: string,
    hash: string,
    cause: unknown,
  ): Promise<void> {
    const quarantine = `${finalPath}.corrupt-${randomUUID()}`;
    try {
      await rename(finalPath, quarantine);
      try {
        await rename(temporary, finalPath);
      } catch (error) {
        const winner = await stat(finalPath).catch(() => null);
        if (!winner?.isFile() || (await this.#hashFile(finalPath)) !== hash) {
          throw error;
        }
        await rm(temporary, { force: true });
      }
    } catch (error) {
      const winner = await stat(finalPath).catch(() => null);
      if (winner?.isFile() && (await this.#hashFile(finalPath)) === hash) {
        await rm(temporary, { force: true });
      } else {
        throw new UrmaError(
          "CACHE_WRITE_FAILED",
          `Corrupt blob at content hash ${hash} could not be atomically replaced; check data-directory permissions and retry`,
          { cause: error ?? cause },
        );
      }
    } finally {
      await rm(quarantine, { force: true }).catch(() => undefined);
    }
  }

  async verify(artifactId: ArtifactId, relativePath: string): Promise<string> {
    const hash = artifactHashFromId(artifactId);
    const expected = this.pathForHash(hash);
    const resolved = path.resolve(this.#root, relativePath);
    if (resolved !== expected) {
      throw new UrmaError(
        "MEDIA_INVALID",
        `Artifact ${artifactId} has an invalid blob location; reacquire the artifact`,
      );
    }
    const info = await stat(resolved).catch(() => null);
    if (
      !info?.isFile() ||
      info.size < 1 ||
      (await this.#hashFile(resolved)) !== hash
    ) {
      throw new UrmaError(
        "MEDIA_INVALID",
        `Artifact ${artifactId} is missing or failed SHA-256 validation; reacquire it`,
      );
    }
    return resolved;
  }

  async read(
    artifactId: ArtifactId,
    relativePath: string,
    maxBytes: number,
  ): Promise<Buffer> {
    const hash = artifactHashFromId(artifactId);
    const expected = this.pathForHash(hash);
    const resolved = path.resolve(this.#root, relativePath);
    if (resolved !== expected) {
      throw new UrmaError(
        "MEDIA_INVALID",
        `Artifact ${artifactId} has an invalid blob location; reacquire the artifact`,
      );
    }
    const info = await stat(resolved).catch(() => null);
    if (!info?.isFile() || info.size < 1 || info.size > maxBytes) {
      throw new UrmaError(
        "MEDIA_INVALID",
        `Artifact ${artifactId} is missing, empty, or exceeds the ${maxBytes}-byte resource limit; reacquire it`,
      );
    }
    const bytes = await readFile(resolved);
    if (createHash("sha256").update(bytes).digest("hex") !== hash) {
      throw new UrmaError(
        "MEDIA_INVALID",
        `Artifact ${artifactId} failed SHA-256 validation; reacquire it`,
      );
    }
    return bytes;
  }

  async cleanTemps(): Promise<number> {
    await this.initialize();
    const { readdir } = await import("node:fs/promises");
    const names = await readdir(this.#temp);
    await Promise.all(
      names.map((name) =>
        rm(path.join(this.#temp, name), { force: true, recursive: false })
      ),
    );
    return names.length;
  }
}
