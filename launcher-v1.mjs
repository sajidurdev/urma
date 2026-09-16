import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ACTIVE_SCHEMA = 1;
const STATE_SCHEMA = 5;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const HASH = /^[a-f0-9]{64}$/u;

function fail(message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = "INSTALLATION_CORRUPT";
  throw error;
}

function rootFromEnvironment() {
  const override = process.env.URMA_DATA_DIR?.trim();
  if (override) return safeRoot(override);
  if (process.platform === "win32") {
    return safeRoot(path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "Urma"));
  }
  if (process.platform === "darwin") return safeRoot(path.join(os.homedir(), "Library", "Application Support", "Urma"));
  return safeRoot(path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "urma"));
}

function safeRoot(value) {
  if (!value || value.includes("\0") || /^\\\\/u.test(value) || /^\/\/[^/]/u.test(value)) fail("Urma data directory must be a user-owned local filesystem path; network/UNC paths are unsupported");
  return path.resolve(value);
}

function contained(root, child) {
  const relative = path.relative(path.resolve(root), path.resolve(child));
  return relative !== "" && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

async function realContained(root, child, label) {
  let realRoot;
  let realChild;
  try {
    realRoot = await realpath(root);
    realChild = await realpath(child);
  } catch (error) {
    fail(`${label} could not be resolved inside the selected generation`, error);
  }
  if (!contained(realRoot, realChild)) fail(`${label} resolves outside the selected generation`);
  return realChild;
}

function installPath(root, id) {
  if (typeof id !== "string" || !ID.test(id)) fail(`Invalid Urma installation id ${JSON.stringify(id)}`);
  const result = path.resolve(root, "installs", id);
  if (!contained(root, result)) fail("ACTIVE.json selected an installation outside the Urma data directory");
  return result;
}

function executingTarget() {
  if (process.platform === "win32") {
    if (process.arch === "x64") return "windows-x64";
    if (process.arch === "arm64") return "windows-arm64";
  } else if (process.platform === "darwin") {
    if (process.arch === "x64") return "macos-x64";
    if (process.arch === "arm64") return "macos-arm64";
  } else if (process.platform === "linux") {
    if (process.arch !== "x64" && process.arch !== "arm64") fail(`Unsupported Linux Node architecture ${process.arch}; rerun setup with native Node 24`);
    let glibc;
    try {
      glibc = process.report?.getReport?.().header?.glibcVersionRuntime;
    } catch (error) {
      fail("Could not determine the executing Linux glibc runtime; rerun setup on a supported glibc system", error);
    }
    if (typeof glibc !== "string" || glibc.length === 0) fail("Urma v1 requires a glibc Linux runtime; musl/Alpine is unsupported");
    return process.arch === "x64" ? "linux-x64-glibc" : "linux-arm64-glibc";
  }
  fail(`Unsupported Urma platform ${process.platform}-${process.arch}; rerun setup on a supported native platform`);
}

async function regular(file, label) {
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    fail(`${label} is missing; rerun setup`, error);
  }
  if (!info.isFile() || info.isSymbolicLink()) fail(`${label} is not a regular file`);
}

async function ensureRootDirectory(root, create) {
  if (create) await mkdir(root, { recursive: true, mode: 0o700 });
  let info;
  try {
    info = await lstat(root);
  } catch (error) {
    fail("Urma data directory is missing; run setup", error);
  }
  if (!info.isDirectory() || info.isSymbolicLink()) fail("Urma data directory must be a real local directory");
}

async function readJson(file, label) {
  await regular(file, label);
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    fail(`${label} is malformed; use the ACTIVE.backup.json recovery path or rerun setup`, error);
  }
}

function parseSelection(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema !== ACTIVE_SCHEMA || !Number.isSafeInteger(value.generation) || value.generation < 1 || typeof value.active !== "string" || !ID.test(value.active) || (value.previous !== null && (typeof value.previous !== "string" || !ID.test(value.previous))) || value.active.toLowerCase() === value.previous?.toLowerCase()) {
    fail("ACTIVE.json has an invalid schema or install selection");
  }
  return { schema: ACTIVE_SCHEMA, generation: value.generation, active: value.active, previous: value.previous };
}

function parseRelative(value, label) {
  if (typeof value !== "string" || !value || value.includes("\0") || path.isAbsolute(value) || /^[A-Za-z]:/u.test(value) || value.split(/[\\/]/u).some((part) => !part || part === "..")) fail(`${label} is not a contained relative path`);
  return value;
}

async function hashFile(file) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}

async function hashTree(digest, root, prefix) {
  const walk = async (directory, relative) => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en-US"));
    for (const entry of entries) {
      const childRelative = relative ? path.join(relative, entry.name) : entry.name;
      const child = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) fail(`Rollback found a symlink in the retained runtime payload: ${child}`);
      if (entry.isDirectory()) {
        digest.update(`D\0${prefix}/${childRelative.replaceAll(path.sep, "/")}\0`);
        await walk(child, childRelative);
      } else if (entry.isFile()) {
        digest.update(`F\0${prefix}/${childRelative.replaceAll(path.sep, "/")}\0`);
        digest.update(await readFile(child));
      } else {
        fail(`Rollback found an unsupported retained runtime entry: ${child}`);
      }
    }
  };
  await walk(root, "");
}

async function verifyGenerationContent(chosen) {
  try {
    for (const [kind, item] of Object.entries(chosen.tools)) {
      const actual = await hashFile(item.executable);
      if (actual !== item.hash) fail(`Retained ${kind} executable failed rollback integrity verification; refusing to activate it`);
    }
    const digest = createHash("sha256");
    await hashTree(digest, path.join(chosen.generationDir, "runtime"), "runtime");
    await hashTree(digest, path.join(chosen.generationDir, "assets"), "assets");
    if (digest.digest("hex") !== chosen.receipt.urma.payloadSha256) fail("Retained Urma runtime payload failed rollback integrity verification; refusing to activate it");
  } catch (error) {
    if (error?.code === "INSTALLATION_CORRUPT") throw error;
    fail("Retained Urma generation could not complete rollback integrity verification; refusing to activate it", error);
  }
}

async function validateGeneration(root, id, options = {}) {
  if (!/^24\./u.test(process.versions.node)) fail(`This Node.js runtime is ${process.versions.node}, but Urma setup requires Node 24 LTS; rerun setup with supported Node 24`);
  const generationDir = installPath(root, id);
  let realRoot;
  try {
    realRoot = await realpath(root);
  } catch (error) {
    fail("Urma data directory could not be resolved; run setup", error);
  }
  let info;
  try {
    info = await lstat(generationDir);
  } catch (error) {
    fail(`Selected Urma installation ${id} is missing; rerun setup`, error);
  }
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`Selected Urma installation ${id} is not an immutable directory`);
  const realGenerationDir = await realContained(realRoot, generationDir, "Selected Urma generation");
  const receiptPath = path.join(realGenerationDir, "receipt.json");
  await realContained(realGenerationDir, receiptPath, "Selected installation receipt");
  const receipt = await readJson(receiptPath, "Selected installation receipt");
  const target = executingTarget();
  if (receipt.schema !== 1 || receipt.installId !== id || receipt.target !== target || receipt.manifest?.target !== target || receipt.runtime?.stateSchemaVersion !== STATE_SCHEMA || typeof receipt.node?.execPath !== "string" || !path.isAbsolute(receipt.node.execPath) || !/^24\./u.test(receipt.node.version ?? "") || receipt.node.executionArchitecture !== `${process.platform}-${process.arch}`) fail(`Installation ${id} has incompatible receipt metadata or Node execution architecture; rerun setup`);
  if (!HASH.test(receipt.urma?.payloadSha256 ?? "") || !HASH.test(receipt.manifest?.identity ?? "") || typeof receipt.urma?.version !== "string" || receipt.urma.version.length === 0) fail(`Installation ${id} has invalid provenance hashes`);
  if (!receipt.tools || !receipt.runtime || !Array.isArray(receipt.policy?.flags) || receipt.policy.flags.length === 0 || receipt.qualification?.status !== "passed" || !Array.isArray(receipt.qualification.checks) || receipt.qualification.checks.length === 0 || !Array.isArray(receipt.notices)) fail(`Installation ${id} has incomplete receipt metadata`);
  const expected = {};
  for (const kind of ["ffmpeg", "ffprobe", "ytdlp"]) {
    const item = receipt.tools[kind];
    if (!item || typeof item.provider !== "string" || item.provider.length === 0 || typeof item.version !== "string" || item.version.length === 0 || typeof item.release !== "string" || item.release.length === 0 || typeof item.buildConfiguration !== "string" || item.buildConfiguration.length === 0 || !HASH.test(item.binarySha256 ?? "") || !HASH.test(item.archiveSha256 ?? "")) fail(`Installation ${id} has incomplete ${kind} receipt metadata`);
    const relative = parseRelative(item.relativePath, `${kind} receipt path`);
    const executable = path.resolve(realGenerationDir, relative);
    if (!contained(realGenerationDir, executable)) fail(`Installation ${id} has an escaping ${kind} path`);
    await regular(executable, `Selected ${kind} executable`);
    expected[kind] = { executable: await realContained(realGenerationDir, executable, `Selected ${kind} executable`), hash: item.binarySha256 };
  }
  const runtimeRelative = parseRelative(receipt.runtime.entry, "runtime receipt entry");
  const runtimeEntry = path.resolve(realGenerationDir, runtimeRelative);
  if (!contained(realGenerationDir, runtimeEntry)) fail(`Installation ${id} has an escaping runtime entry`);
  await regular(runtimeEntry, "Selected Urma runtime entry");
  const realRuntimeEntry = await realContained(realGenerationDir, runtimeEntry, "Selected Urma runtime entry");
  if (!options.skipNodePath) {
    const current = path.resolve(process.execPath);
    const recorded = path.resolve(receipt.node.execPath);
    const same = process.platform === "win32" ? current.toLowerCase() === recorded.toLowerCase() : current === recorded;
    if (!same) fail(`The Node executable recorded by setup is ${recorded}, but this session uses ${current}; rerun setup with the supported Node 24 installation`);
  }
  return { generationDir: realGenerationDir, runtimeEntry: realRuntimeEntry, receipt, tools: expected };
}

function ownerAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EINVAL") return false;
    return true;
  }
}

async function acquireLock(root) {
  const state = path.join(root, "state");
  let stateInfo;
  try {
    stateInfo = await lstat(state);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(state, { recursive: false, mode: 0o700 });
    stateInfo = await lstat(state);
  }
  if (!stateInfo.isDirectory() || stateInfo.isSymbolicLink()) fail("Urma installation state directory must be a real local directory");
  const lockPath = path.join(state, "install.lock");
  const owner = { schema: 1, pid: process.pid, createdAt: new Date().toISOString(), token: randomUUID() };
  try {
    const handle = await open(lockPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    return async () => {
      try {
        const current = JSON.parse(await readFile(lockPath, "utf8"));
        if (current.token === owner.token) await rm(lockPath, { force: true });
      } catch {
        // Never remove a lock that cannot be proven to be ours
      }
    };
  } catch (error) {
    if (error?.code !== "EEXIST") fail("Could not acquire the Urma installation lock", error);
    let current;
    try {
      current = JSON.parse(await readFile(lockPath, "utf8"));
    } catch (readError) {
      fail("Urma installation lock is malformed or unreadable; refusing concurrent mutation", readError);
    }
    if (!Number.isSafeInteger(current?.pid) || current.pid < 1 || typeof current.token !== "string") fail("Urma installation lock is malformed; refusing concurrent mutation");
    if (ownerAlive(current.pid)) fail(`Another Urma installation operation is running under pid ${String(current.pid)}; wait for it to finish`);
    const quarantine = `${lockPath}.stale-${randomUUID()}`;
    try {
      await rename(lockPath, quarantine);
      await rm(quarantine, { force: true });
    } catch (reclaimError) {
      fail("A stale Urma installation lock could not be reclaimed safely", reclaimError);
    }
    return await acquireLock(root);
  }
}

async function preserveSelectionAsBackup(active, backup) {
  const activeInfo = await lstat(active);
  if (!activeInfo.isFile() || activeInfo.isSymbolicLink()) fail("ACTIVE.json is not a regular file");
  try {
    const backupInfo = await lstat(backup);
    if (!backupInfo.isFile() || backupInfo.isSymbolicLink()) fail("ACTIVE.backup.json is not a regular file");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const backupNext = `${backup}.next`;
  await rm(backupNext, { force: true });
  const bytes = await readFile(active);
  const handle = await open(backupNext, "wx", 0o600);
  try {
    await handle.write(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(backupNext, backup);
  } catch (error) {
    await rm(backupNext, { force: true });
    throw error;
  }
}

async function commitSelection(root, selection, options = {}) {
  const parsed = parseSelection(selection);
  const active = path.join(root, "ACTIVE.json");
  const backup = path.join(root, "ACTIVE.backup.json");
  const next = path.join(root, "ACTIVE.next");
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
      await preserveSelectionAsBackup(active, backup);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        await rm(next, { force: true });
        fail("Could not preserve ACTIVE.json before rollback", error);
      }
    }
  }
  try {
    await rename(next, active);
  } catch (error) {
    await rm(next, { force: true });
    fail("Could not atomically commit the rollback selection", error);
  }
}

async function checkState(root) {
  const databasePath = path.join(root, "urma.db");
  let databaseInfo;
  try {
    databaseInfo = await lstat(databasePath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    fail("Could not verify persistent state compatibility for rollback", error);
  }
  if (!databaseInfo.isFile() || databaseInfo.isSymbolicLink()) fail("Persistent Urma state is not a regular local database file");
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(databasePath, { readOnly: true, timeout: 5_000 });
    try {
      const row = db.prepare("SELECT version FROM schema_meta LIMIT 1").get();
      if (row?.version !== STATE_SCHEMA) fail(`Persistent state schema v${String(row?.version)} is incompatible with rollback target v${String(STATE_SCHEMA)}`);
    } finally {
      db.close();
    }
  } catch (error) {
    if (error?.code === "INSTALLATION_CORRUPT") throw error;
    fail("Could not verify persistent state compatibility for rollback", error);
  }
}

async function rollback() {
  const root = rootFromEnvironment();
  await ensureRootDirectory(root, true);
  const release = await acquireLock(root);
  try {
    const activeFile = path.join(root, "ACTIVE.json");
    const selection = parseSelection(await readJson(activeFile, "ACTIVE.json"));
    if (selection.previous === null) fail("No retained previous Urma generation is available for rollback");
    const previous = await validateGeneration(root, selection.previous);
    await checkState(root);
    await verifyGenerationContent(previous);
    if (selection.generation === Number.MAX_SAFE_INTEGER) fail("Urma selection generation cannot be incremented safely");
    const next = { schema: ACTIVE_SCHEMA, generation: selection.generation + 1, active: selection.previous, previous: selection.active };
    await commitSelection(root, next);
    process.stdout.write(`Urma rollback complete: active=${next.active}, previous=${next.previous}\n`);
  } finally {
    await release();
  }
}

async function recover() {
  const root = rootFromEnvironment();
  await ensureRootDirectory(root, true);
  const release = await acquireLock(root);
  try {
    const backup = path.join(root, "ACTIVE.backup.json");
    const selection = parseSelection(await readJson(backup, "ACTIVE.backup.json"));
    await validateGeneration(root, selection.active);
    if (selection.previous !== null) await validateGeneration(root, selection.previous);
    await commitSelection(root, selection, { preserveBackup: false });
    process.stdout.write(`Urma ACTIVE recovery complete: active=${selection.active}, previous=${selection.previous}\n`);
  } finally {
    await release();
  }
}

async function start() {
  const root = rootFromEnvironment();
  await ensureRootDirectory(root, false);
  const runtimeRoot = await realpath(root);
  const activeFile = path.join(root, "ACTIVE.json");
  const selection = parseSelection(await readJson(activeFile, "ACTIVE.json"));
  const chosen = await validateGeneration(root, selection.active);
  process.env.URMA_RUNTIME_ROOT_V1 = runtimeRoot;
  process.env.URMA_RUNTIME_GENERATION_V1 = selection.active;
  process.env.URMA_RUNTIME_GENERATION_DIR_V1 = chosen.generationDir;
  process.env.URMA_RUNTIME_DATA_DIR_V1 = runtimeRoot;
  process.env.URMA_RUNTIME_NODE_V1 = chosen.receipt.node.execPath;
  process.env.URMA_RUNTIME_FFMPEG_V1 = chosen.tools.ffmpeg.executable;
  process.env.URMA_RUNTIME_FFPROBE_V1 = chosen.tools.ffprobe.executable;
  process.env.URMA_RUNTIME_YTDLP_V1 = chosen.tools.ytdlp.executable;
  process.env.URMA_RUNTIME_FFMPEG_HASH_V1 = chosen.tools.ffmpeg.hash;
  process.env.URMA_RUNTIME_FFPROBE_HASH_V1 = chosen.tools.ffprobe.hash;
  process.env.URMA_RUNTIME_YTDLP_HASH_V1 = chosen.tools.ytdlp.hash;
  process.argv = [process.execPath, chosen.runtimeEntry, ...process.argv.slice(2)];
  await import(pathToFileURL(chosen.runtimeEntry).href);
}

try {
  if (process.argv[2] === "rollback" && process.argv.length === 3) await rollback();
  else if (process.argv[2] === "recover" && process.argv.length === 3) await recover();
  else if (process.argv[2] === "setup") fail("setup must be run from the npm release: npx -y urma-mcp@latest setup");
  else await start();
} catch (error) {
  process.stderr.write(`Urma startup failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
