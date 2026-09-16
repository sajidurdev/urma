import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { UrmaError } from "../core/errors.js";
import type { DistributionPaths } from "./paths.js";

type LockOwner = Readonly<{
  schema: 1;
  pid: number;
  createdAt: string;
  token: string;
}>;

export type InstallationLock = Readonly<{
  path: string;
  owner: LockOwner;
  release: () => Promise<void>;
}>;

function isNoSuchProcess(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNoSuchProcess(error)) return false;
    if (error instanceof Error && "code" in error && error.code === "EINVAL") return false;
    // EPERM means the process exists but this user cannot signal it
    if (error instanceof Error && "code" in error && error.code === "EPERM") return true;
    return true;
  }
}

function parseOwner(raw: string): LockOwner | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (
      record.schema !== 1 ||
      !Number.isSafeInteger(record.pid) ||
      (record.pid as number) < 1 ||
      typeof record.createdAt !== "string" ||
      typeof record.token !== "string" ||
      record.token.length < 16
    ) return null;
    return {
      schema: 1,
      pid: record.pid as number,
      createdAt: record.createdAt,
      token: record.token,
    };
  } catch {
    return null;
  }
}

async function existingOwner(lockPath: string): Promise<LockOwner | null> {
  try {
    return parseOwner(await readFile(lockPath, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    return null;
  }
}

export async function acquireInstallationLock(paths: DistributionPaths): Promise<InstallationLock> {
  const lockDirectory = path.dirname(paths.lock);
  let directoryInfo;
  try {
    directoryInfo = await lstat(lockDirectory);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    await mkdir(lockDirectory, { recursive: true, mode: 0o700 });
    directoryInfo = await lstat(lockDirectory);
  }
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new UrmaError(
      "UNSUPPORTED_FILESYSTEM",
      "Urma installation lock directory must be a real local directory; refusing a symlinked state path",
      { detail: { path: lockDirectory } },
    );
  }
  const owner: LockOwner = {
    schema: 1,
    pid: process.pid,
    createdAt: new Date().toISOString(),
    token: randomUUID(),
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(paths.lock, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      let released = false;
      return {
        path: paths.lock,
        owner,
        async release() {
          if (released) return;
          released = true;
          const current = await existingOwner(paths.lock);
          if (current?.token !== owner.token) return;
          await rm(paths.lock, { force: true });
        },
      };
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
        throw new UrmaError("INSTALLATION_LOCKED", "Could not acquire the Urma installation lock", { cause: error });
      }
      const current = await existingOwner(paths.lock);
      if (current === null) {
        throw new UrmaError(
          "INSTALLATION_LOCKED",
          "Urma installation lock exists but is malformed or unreadable; refusing to let another writer run",
          { detail: { lockPath: paths.lock } },
        );
      }
      if (isAlive(current.pid)) {
        throw new UrmaError(
          "INSTALLATION_LOCKED",
          `Another Urma installation operation is running under pid ${String(current.pid)}; wait for it to finish`,
          { detail: { lockPath: paths.lock, pid: current.pid, createdAt: current.createdAt } },
        );
      }
      if (attempt === 1) {
        throw new UrmaError("INSTALLATION_LOCKED", "A stale Urma installation lock could not be reclaimed safely", {
          detail: { lockPath: paths.lock, pid: current.pid },
        });
      }
      // Rename the stale lock first so a concurrent writer's new lock is not removed
      const quarantine = `${paths.lock}.stale-${randomUUID()}`;
      try {
        await rename(paths.lock, quarantine);
        await rm(quarantine, { force: true });
      } catch (reclaimError) {
        throw new UrmaError("INSTALLATION_LOCKED", "A stale Urma installation lock could not be reclaimed safely", {
          cause: reclaimError,
          detail: { lockPath: paths.lock, pid: current.pid },
        });
      }
    }
  }
  throw new UrmaError("INSTALLATION_LOCKED", "Could not acquire the Urma installation lock");
}
