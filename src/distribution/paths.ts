import { access, lstat, mkdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { UrmaError } from "../core/errors.js";

export const INSTALL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export type DistributionPaths = Readonly<{
  root: string;
  launcher: string;
  active: string;
  backup: string;
  next: string;
  installs: string;
  staging: string;
  state: string;
  cache: string;
  lock: string;
}>;

function isUncPath(value: string): boolean {
  return /^\\\\/u.test(value) || /^\/\/[^/]/u.test(value);
}

export function defaultDataRoot(environment: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === "win32") {
    return path.resolve(
      environment.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
      "Urma",
    );
  }
  if (process.platform === "darwin") {
    return path.resolve(os.homedir(), "Library", "Application Support", "Urma");
  }
  return path.resolve(
    environment.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"),
    "urma",
  );
}

export function chooseDataRoot(environment: NodeJS.ProcessEnv = process.env): string {
  const override = environment.URMA_DATA_DIR?.trim();
  if (override) return path.resolve(override);
  return defaultDataRoot(environment);
}

export function assertSafeLocalPath(value: string, label: string): string {
  if (!value || value.includes("\0") || isUncPath(value)) {
    throw new UrmaError(
      "UNSUPPORTED_FILESYSTEM",
      `${label} must be a user-owned local filesystem path; network/UNC paths are outside Urma v1 support`,
      { detail: { path: value, label } },
    );
  }
  const resolved = path.resolve(value);
  if (isUncPath(resolved)) {
    throw new UrmaError(
      "UNSUPPORTED_FILESYSTEM",
      `${label} resolves to a network/UNC path, which is outside Urma v1 support`,
      { detail: { path: resolved, label } },
    );
  }
  return resolved;
}

export function distributionPaths(rootInput: string): DistributionPaths {
  const root = assertSafeLocalPath(rootInput, "Urma data directory");
  return {
    root,
    launcher: path.join(root, "launcher-v1.mjs"),
    active: path.join(root, "ACTIVE.json"),
    backup: path.join(root, "ACTIVE.backup.json"),
    next: path.join(root, "ACTIVE.next"),
    installs: path.join(root, "installs"),
    staging: path.join(root, "staging"),
    state: path.join(root, "state"),
    cache: path.join(root, "cache"),
    lock: path.join(root, "state", "install.lock"),
  };
}

export function validateInstallId(installId: string): string {
  if (!INSTALL_ID_PATTERN.test(installId) || installId === "." || installId === "..") {
    throw new UrmaError(
      "INSTALLATION_CORRUPT",
      `Invalid Urma installation id ${JSON.stringify(installId)}`,
      { detail: { installId } },
    );
  }
  return installId;
}

function assertContained(parent: string, child: string, label: string): string {
  const parentResolved = path.resolve(parent);
  const childResolved = path.resolve(child);
  const relative = path.relative(parentResolved, childResolved);
  if (
    relative === "" ||
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  ) {
    throw new UrmaError(
      "INSTALLATION_CORRUPT",
      `${label} escapes the Urma data directory`,
      { detail: { parent: parentResolved, child: childResolved } },
    );
  }
  return childResolved;
}

export function installationPath(paths: DistributionPaths, installId: string): string {
  const safeId = validateInstallId(installId);
  return assertContained(paths.installs, path.join(paths.installs, safeId), "Installation path");
}

export function stagingPath(paths: DistributionPaths, installId: string): string {
  const safeId = validateInstallId(installId);
  return assertContained(paths.staging, path.join(paths.staging, safeId), "Staging path");
}

export function runtimeEntryPath(generationDir: string): string {
  return assertContained(
    generationDir,
    path.join(generationDir, "runtime", "src", "cli", "main.js"),
    "Runtime entry",
  );
}

export function runtimeLauncherPath(root: string): string {
  return path.join(assertSafeLocalPath(root, "Urma data directory"), "launcher-v1.mjs");
}

export function toolPath(
  generationDir: string,
  kind: "ffmpeg" | "ffprobe" | "ytdlp",
  executableName: string,
): string {
  const directory = kind === "ytdlp"
    ? path.join(generationDir, "tools", "yt-dlp")
    : path.join(generationDir, "tools", "ffmpeg");
  return assertContained(generationDir, path.join(directory, executableName), `${kind} path`);
}

export async function ensureDistributionLayout(paths: DistributionPaths): Promise<void> {
  const ensureDirectory = async (directory: string, label: string) => {
    let info;
    try {
      info = await lstat(directory);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      await mkdir(directory, { recursive: false, mode: 0o700 });
      info = await lstat(directory);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new UrmaError(
        "UNSUPPORTED_FILESYSTEM",
        `${label} must be a real directory; symlinked distribution paths are unsupported`,
        { detail: { path: directory } },
      );
    }
  };
  await ensureDirectory(paths.root, "Urma data directory");
  for (const directory of [paths.installs, paths.staging, paths.state, paths.cache]) {
    await ensureDirectory(directory, "Urma distribution directory");
  }
}

async function nearestExistingDirectory(start: string): Promise<string> {
  let current = path.resolve(start);
  for (;;) {
    try {
      const info = await lstat(current);
      if (!info.isDirectory()) {
        throw new UrmaError(
          "UNSUPPORTED_FILESYSTEM",
          `Urma data path parent ${current} is not a directory`,
        );
      }
      return current;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

/**
 * This is deliberately conservative. Existing paths must be directories and
 * owned by the executing user where the platform exposes ownership. New roots
 * are checked through their nearest existing parent before setup creates them.
 */
export async function assertUserOwnedDataRoot(rootInput: string): Promise<string> {
  const root = assertSafeLocalPath(rootInput, "Urma data directory");
  const existing = await nearestExistingDirectory(root);
  const info = await stat(existing);
  if (process.platform !== "win32" && typeof process.getuid === "function") {
    const uid = process.getuid();
    if (info.uid !== uid) {
      throw new UrmaError(
        "UNSUPPORTED_FILESYSTEM",
        `Urma data directory parent ${existing} is owned by uid ${String(info.uid)}, not the current user`,
        { detail: { path: existing, ownerUid: info.uid, currentUid: uid } },
      );
    }
  }
  await access(existing, constants.R_OK | constants.W_OK | constants.X_OK);
  return root;
}

export async function assertRegularFile(file: string, label: string): Promise<void> {
  const info = await lstat(file);
  if (!info.isFile()) {
    throw new UrmaError("INSTALLATION_CORRUPT", `${label} is not a regular file`, {
      detail: { path: file },
    });
  }
}
