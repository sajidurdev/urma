import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { UrmaError } from "../core/errors.js";
import { distributionPaths, validateInstallId, type DistributionPaths } from "./paths.js";

export type ActiveSelection = Readonly<{
  schema: 1;
  generation: number;
  active: string;
  previous: string | null;
}>;

function invalid(message: string, detail: Readonly<Record<string, unknown>> = {}): never {
  throw new UrmaError("INSTALLATION_CORRUPT", message, { detail });
}

export function parseActiveSelection(value: unknown): ActiveSelection {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid("ACTIVE.json must contain one JSON object");
  }
  const record = value as Record<string, unknown>;
  if (
    record.schema !== 1 ||
    !Number.isSafeInteger(record.generation) ||
    (record.generation as number) < 1 ||
    typeof record.active !== "string" ||
    (record.previous !== null && typeof record.previous !== "string")
  ) {
    return invalid("ACTIVE.json has an invalid schema, generation, or selection");
  }
  const active = validateInstallId(record.active);
  const previous = record.previous === null
    ? null
    : validateInstallId(record.previous);
  if (previous !== null && previous.toLowerCase() === active.toLowerCase()) return invalid("ACTIVE.json cannot select the same active and previous generation");
  return { schema: 1, generation: record.generation as number, active, previous };
}

async function readSelectionFile(file: string): Promise<ActiveSelection> {
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) invalid(`${path.basename(file)} is not a regular file`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch (error) {
    throw new UrmaError(
      "INSTALLATION_CORRUPT",
      `${path.basename(file)} is not valid JSON`,
      { cause: error, detail: { path: file } },
    );
  }
  return parseActiveSelection(parsed);
}

export async function readActive(
  paths: DistributionPaths,
  options: { allowMissing?: boolean } = {},
): Promise<ActiveSelection | null> {
  try {
    return await readSelectionFile(paths.active);
  } catch (error) {
    if (
      options.allowMissing !== false &&
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) return null;
    throw error;
  }
}

export async function readActiveBackup(paths: DistributionPaths): Promise<ActiveSelection | null> {
  try {
    return await readSelectionFile(paths.backup);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function nextSelectionFile(paths: DistributionPaths): string {
  return path.resolve(paths.next);
}

async function preserveActiveAsBackup(paths: DistributionPaths): Promise<void> {
  const activeInfo = await lstat(paths.active);
  if (!activeInfo.isFile() || activeInfo.isSymbolicLink()) invalid("ACTIVE.json is not a regular file");
  try {
    const backupInfo = await lstat(paths.backup);
    if (!backupInfo.isFile() || backupInfo.isSymbolicLink()) invalid("ACTIVE.backup.json is not a regular file");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const backupNext = `${paths.backup}.next`;
  await rm(backupNext, { force: true });
  const bytes = await readFile(paths.active);
  const handle = await open(backupNext, "wx", 0o600);
  try {
    await handle.write(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(backupNext, paths.backup);
  } catch (error) {
    await rm(backupNext, { force: true });
    throw error;
  }
}

/** Commit only the selector; never overwrite generation directories */
export async function commitActive(
  paths: DistributionPaths,
  selection: ActiveSelection,
  options: Readonly<{ preserveBackup?: boolean }> = {},
): Promise<void> {
  const parsed = parseActiveSelection(selection);
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  const next = nextSelectionFile(paths);
  await rm(next, { force: true });
  const handle = await open(next, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  if (options.preserveBackup !== false) {
    try {
      await preserveActiveAsBackup(paths);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        await rm(next, { force: true });
        throw new UrmaError("SETUP_FAILED", "Could not preserve the previous ACTIVE.json selection", {
          cause: error,
        });
      }
    }
  }
  try {
    await rename(next, paths.active);
  } catch (error) {
    await rm(next, { force: true });
    throw new UrmaError(
      "SETUP_FAILED",
      "Could not atomically commit ACTIVE.json; the previous selection remains authoritative",
      { cause: error },
    );
  }
}

export function nextGenerationNumber(active: ActiveSelection | null): number {
  const next = (active?.generation ?? 0) + 1;
  if (!Number.isSafeInteger(next)) throw new UrmaError("SETUP_FAILED", "Urma generation number overflowed safely representable integers");
  return next;
}

export function selectionForUpdate(
  active: ActiveSelection | null,
  installId: string,
): ActiveSelection {
  const safeId = validateInstallId(installId);
  return {
    schema: 1,
    generation: nextGenerationNumber(active),
    active: safeId,
    previous: active?.active ?? null,
  };
}

export function selectionForRollback(
  active: ActiveSelection,
): ActiveSelection {
  if (active.previous === null) {
    throw new UrmaError("INSTALLATION_STATE_INCOMPATIBLE", "No retained previous Urma generation is available for rollback");
  }
  return {
    schema: 1,
    generation: nextGenerationNumber(active),
    active: active.previous,
    previous: active.active,
  };
}

export function pathsForRoot(root: string): DistributionPaths {
  return distributionPaths(root);
}
