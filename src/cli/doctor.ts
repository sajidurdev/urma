import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { UrmaConfig } from "../config.js";
import { Ffmpeg } from "../subprocess/ffmpeg.js";
import { Ffprobe } from "../subprocess/ffprobe.js";
import { redactText } from "../subprocess/redaction.js";
import { YtDlp } from "../subprocess/ytdlp.js";
import { SCHEMA_VERSION } from "../store/schema.js";
import { SUPPORTED_NODE_RANGE, URMA_VERSION } from "../version.js";

export type DoctorStatus = "ok" | "warning" | "fail";
type DoctorIssue = "missing" | "unsupported" | "failed" | "unusable";
export type DoctorCheck = Readonly<{
  name: string;
  ok: boolean;
  status: DoctorStatus;
  detail: string;
  issue?: DoctorIssue;
}>;
export type DoctorGuidance = Readonly<{
  title: string;
  platform: string;
  command: string;
  docs: string;
}>;
export type DoctorReport = Readonly<{
  ok: boolean;
  checks: readonly DoctorCheck[];
  guidance: readonly DoctorGuidance[];
}>;

function check(
  name: string,
  status: DoctorStatus,
  detail: string,
  issue?: DoctorIssue,
): DoctorCheck {
  return issue === undefined
    ? { name, ok: status !== "fail", status, detail }
    : { name, ok: status !== "fail", status, detail, issue };
}

function success(name: string, detail: string): DoctorCheck {
  return check(name, "ok", detail);
}
function warning(name: string, detail: string): DoctorCheck {
  return check(name, "warning", detail);
}
function failure(
  name: string,
  detail: string,
  issue: DoctorIssue = "failed",
): DoctorCheck {
  return check(name, "fail", detail, issue);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
}
function isMissing(error: unknown): boolean {
  return (
    errorCode(error) === "ENOENT" ||
    errorCode(error) === "REQUIRED_BINARY_MISSING"
  );
}

function nodeVersionIsSupported(version: string): boolean {
  const major = Number(version.split(".", 1)[0]);
  const lower = Number(SUPPORTED_NODE_RANGE.match(/>=\s*(\d+)/u)?.[1] ?? 0);
  const upperMatch = SUPPORTED_NODE_RANGE.match(/<\s*(\d+)/u);
  const upper = upperMatch ? Number(upperMatch[1]) : Number.POSITIVE_INFINITY;
  return Number.isSafeInteger(major) && major >= lower && major < upper;
}

type InstallPlatform =
  | "Windows"
  | "macOS"
  | "Ubuntu/Debian"
  | "Other Linux"
  | "Other OS";

async function installPlatform(): Promise<InstallPlatform> {
  if (process.platform === "win32") return "Windows";
  if (process.platform === "darwin") return "macOS";
  if (process.platform !== "linux") return "Other OS";
  try {
    const release = await readFile("/etc/os-release", "utf8");
    const fields = new Map<string, string>();
    for (const line of release.split(/\r?\n/u)) {
      const separator = line.indexOf("=");
      if (separator < 1) continue;
      fields.set(
        line.slice(0, separator),
        line
          .slice(separator + 1)
          .replace(/^"|"$/gu, "")
          .toLowerCase(),
      );
    }
    const ids = `${fields.get("ID") ?? ""} ${fields.get("ID_LIKE") ?? ""}`;
    if (/\b(?:ubuntu|debian)\b/u.test(ids)) return "Ubuntu/Debian";
  } catch {
    // A missing or unreadable os-release only means the distro is unknown.
  }
  return "Other Linux";
}

function guidance(title: string, platform: InstallPlatform): DoctorGuidance {
  const docs = title === "Node.js 24+"
    ? "https://nodejs.org/en/download/package-manager"
    : title === "FFmpeg"
    ? "https://ffmpeg.org/download.html"
    : "https://github.com/yt-dlp/yt-dlp#installation";
  const setupCommand = title === "Node.js 24+"
    ? "Install native Node.js 24 LTS, then rerun npx -y @urma/mcp@latest setup"
    : "npx -y @urma/mcp@latest setup";
  const commands: Record<InstallPlatform, string> = {
    Windows: setupCommand,
    macOS: setupCommand,
    "Ubuntu/Debian": setupCommand,
    "Other Linux": setupCommand,
    "Other OS": setupCommand,
  };
  return { title, platform, command: commands[platform], docs };
}

async function nearestExistingDirectory(start: string): Promise<string> {
  let current = path.resolve(start);
  for (;;) {
    try {
      if (!(await stat(current)).isDirectory()) {
        throw new Error(`${current} is not a directory`);
      }
      return current;
    } catch (error) {
      if (!isMissing(error)) throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

async function directoryAccess(
  name: string,
  directory: string,
): Promise<DoctorCheck> {
  try {
    const info = await stat(directory);
    if (!info.isDirectory()) {
      return failure(name, `${directory} is not a directory`);
    }
    await access(directory, constants.R_OK | constants.W_OK);
    return success(name, `read/write ${directory}`);
  } catch (error) {
    if (!isMissing(error)) return failure(name, errorMessage(error));
    try {
      const parent = await nearestExistingDirectory(path.dirname(directory));
      await access(parent, constants.R_OK | constants.W_OK);
      return success(
        name,
        `not created; writable parent ${parent} will be used on first run`,
      );
    } catch (parentError) {
      return failure(
        name,
        `cannot use ${directory}: ${errorMessage(parentError)}`,
      );
    }
  }
}

function sqliteChecks(): [DoctorCheck, DoctorCheck] {
  let database: DatabaseSync | undefined;
  let sqliteVersion: string | null = null;
  let sqliteError: unknown;
  let ftsAvailable = false;
  let ftsError: unknown;
  try {
    database = new DatabaseSync(":memory:");
    try {
      const row = database
        .prepare("SELECT sqlite_version() AS version")
        .get() as { version?: unknown };
      if (typeof row.version !== "string" || row.version.length === 0) {
        throw new Error("SQLite returned no version");
      }
      sqliteVersion = row.version;
    } catch (error) {
      sqliteError = error;
    }
    try {
      database.exec("CREATE VIRTUAL TABLE doctor_fts USING fts5(body)");
      ftsAvailable = true;
    } catch (error) {
      ftsError = error;
    }
  } catch (error) {
    sqliteError = error;
    ftsError = error;
  } finally {
    try {
      database?.close();
    } catch {
      /* preserve the diagnostic result */
    }
  }
  const sqlite = sqliteVersion === null
    ? failure(
      "SQLite",
      errorMessage(sqliteError ?? new Error("SQLite is unavailable")),
    )
    : success("SQLite", `SQLite ${sqliteVersion}`);
  const fts = ftsAvailable ? success("FTS5", "available") : failure(
    "FTS5",
    `unavailable: ${
      errorMessage(ftsError ?? new Error("SQLite could not be opened"))
    }`,
  );
  return [sqlite, fts];
}

function displayVersion(name: string, value: string): string {
  if (name === "ffmpeg" || name === "ffprobe") {
    return value.match(/\bversion\s+([^\s]+)/iu)?.[1] ?? value;
  }
  return value;
}

async function versionCheck(
  name: string,
  action: () => Promise<string>,
  validate?: (version: string) => boolean,
): Promise<DoctorCheck> {
  try {
    const version = (await action()).trim();
    if (version.length === 0) {
      return failure(
        name,
        "present but unusable: executable returned no version",
        "unusable",
      );
    }
    if (validate !== undefined && !validate(version)) {
      return failure(
        name,
        `present but unusable: ${displayVersion(name, version)}`,
        "unusable",
      );
    }
    return success(name, displayVersion(name, version));
  } catch (error) {
    if (isMissing(error)) return failure(name, "not found", "missing");
    if (errorCode(error) === "REQUIRED_BINARY_UNSUPPORTED") {
      return failure(
        name,
        `unsupported version or capability: ${redactText(errorMessage(error))}`,
        "unsupported",
      );
    }
    if (errorCode(error) === "INSTALLATION_CORRUPT") {
      return failure(
        name,
        `corrupt installed generation: ${redactText(errorMessage(error))}`,
        "unsupported",
      );
    }
    if (errorCode(error) === "SOURCE_UNAVAILABLE") {
      return failure(
        name,
        `present but unusable: ${redactText(errorMessage(error))}`,
        "unusable",
      );
    }
    return failure(
      name,
      `executable failed: ${redactText(errorMessage(error))}`,
      "failed",
    );
  }
}

async function ytdlpJsCheck(
  config: UrmaConfig,
  ytdlp: DoctorCheck,
): Promise<DoctorCheck> {
  if (!ytdlp.ok) {
    return warning(
      "yt-dlp JS",
      `unknown (yt-dlp ${
        ytdlp.issue === "missing" ? "is not found" : "is not usable"
      })`,
    );
  }
  try {
    const result = await new YtDlp(config).run(["--help"], {
      timeoutMs: 10_000,
    });
    const help = `${result.stdout.toString("utf8")}\n${
      result.stderr.toString("utf8")
    }`;
    if (!/--js-runtimes\s+RUNTIME\[:PATH\]/iu.test(help)) {
      return failure(
        "yt-dlp JS",
        "unsupported version: yt-dlp does not advertise --js-runtimes; install a current yt-dlp",
        "unsupported",
      );
    }
    return success("yt-dlp JS", `Node ${process.versions.node}`);
  } catch (error) {
    if (isMissing(error)) return failure("yt-dlp JS", "not found", "missing");
    if (errorCode(error) === "REQUIRED_BINARY_UNSUPPORTED") {
      return failure(
        "yt-dlp JS",
        `unsupported version or capability: ${redactText(errorMessage(error))}`,
        "unsupported",
      );
    }
    if (errorCode(error) === "SOURCE_UNAVAILABLE") {
      return failure(
        "yt-dlp JS",
        `present but unusable: ${redactText(errorMessage(error))}`,
        "unusable",
      );
    }
    return failure(
      "yt-dlp JS",
      `executable failed: ${redactText(errorMessage(error))}`,
      "failed",
    );
  }
}

async function databaseCheck(config: UrmaConfig): Promise<DoctorCheck> {
  const databasePath = path.join(config.dataDir, "urma.db");
  try {
    const info = await stat(databasePath);
    if (!info.isFile()) {
      return failure("Database", `${databasePath} is not a regular file`);
    }
  } catch (error) {
    if (!isMissing(error)) return failure("Database", errorMessage(error));
    try {
      const parent = await nearestExistingDirectory(config.dataDir);
      await access(parent, constants.R_OK | constants.W_OK);
      return success(
        "Database",
        `not initialized; will be created at ${databasePath} on first run`,
      );
    } catch (parentError) {
      return failure(
        "Database",
        `cannot access ${databasePath}: ${errorMessage(parentError)}`,
      );
    }
  }

  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(databasePath, {
      readOnly: true,
      timeout: 5_000,
    });
    const schema = database
      .prepare("SELECT version FROM schema_meta LIMIT 1")
      .get() as { version?: unknown };
    if (!Number.isSafeInteger(schema.version)) {
      throw new Error("schema_meta has no valid version");
    }
    const integrity = database.prepare("PRAGMA quick_check").get() as {
      quick_check?: unknown;
    };
    if (integrity.quick_check !== "ok") {
      throw new Error(
        `SQLite quick_check returned ${String(integrity.quick_check)}`,
      );
    }
    if (schema.version !== SCHEMA_VERSION) {
      return failure(
        "Database",
        `unsupported pre-launch schema v${
          String(schema.version)
        }; remove ${databasePath} and reacquire evidence`,
        "unsupported",
      );
    }
    return success(
      "Database",
      `read-only current schema v${String(schema.version)}; quick_check ok`,
    );
  } catch (error) {
    return failure(
      "Database",
      `cannot open ${databasePath} read-only: ${errorMessage(error)}`,
    );
  } finally {
    try {
      database?.close();
    } catch {
      /* preserve the diagnostic result */
    }
  }
}

async function localRootsCheck(config: UrmaConfig): Promise<DoctorCheck> {
  if (config.localRoots.length === 0) {
    return success(
      "Local roots",
      "disabled (URMA_LOCAL_ROOTS is unset or empty)",
    );
  }
  try {
    const roots: string[] = [];
    for (const root of config.localRoots) {
      const canonical = await realpath(root);
      if (!(await stat(canonical)).isDirectory()) {
        throw new Error(`${canonical} is not a directory`);
      }
      await access(canonical, constants.R_OK);
      roots.push(canonical);
    }
    return success("Local roots", `configured ${roots.join(path.delimiter)}`);
  } catch (error) {
    return failure("Local roots", errorMessage(error));
  }
}

export async function runDoctor(config: UrmaConfig): Promise<DoctorReport> {
  const platform = await installPlatform();
  const checks: DoctorCheck[] = [
    success("Urma", URMA_VERSION),
    nodeVersionIsSupported(process.versions.node)
      ? success(
        "Node",
        `${process.versions.node} (supported: ${SUPPORTED_NODE_RANGE})`,
      )
      : failure(
        "Node",
        `unsupported version: ${process.versions.node} is outside the supported range ${SUPPORTED_NODE_RANGE}`,
        "unsupported",
      ),
  ];
  checks.push(...sqliteChecks());

  const [ffmpeg, ffprobe, ytdlp] = await Promise.all([
    versionCheck(
      "ffmpeg",
      () => new Ffmpeg(config).version(),
      (version) => /^ffmpeg\s+version\s+\S+/iu.test(version),
    ),
    versionCheck(
      "ffprobe",
      () => new Ffprobe(config).version(),
      (version) => /^ffprobe\s+version\s+\S+/iu.test(version),
    ),
    versionCheck(
      "yt-dlp",
      () => new YtDlp(config).version(),
      (version) => /^\d{4}\.\d{2}\.\d{2}(?:\s|$)/u.test(version),
    ),
  ]);
  const ytdlpJs = await ytdlpJsCheck(config, ytdlp);
  checks.push(ffmpeg, ffprobe, ytdlp, ytdlpJs);
  checks.push(await directoryAccess("Storage", config.dataDir));
  checks.push(await databaseCheck(config));
  checks.push(
    await directoryAccess("Blob/cache", path.join(config.dataDir, "blobs")),
  );
  checks.push(await localRootsCheck(config));
  checks.push(
    success(
      "Frame schedules",
      `page maximum ${config.limits.maxFrameSchedulePageTargets}; schedule maximum ${config.limits.maxFrameScheduleTargets} (URMA_MAX_FRAME_SCHEDULE_PAGE_TARGETS / URMA_MAX_FRAME_SCHEDULE_TARGETS)`,
    ),
  );
  const guidanceChecks = new Set<string>();
  if (
    checks.some(
      (item) =>
        (item.name === "ffmpeg" || item.name === "ffprobe") &&
        (item.issue === "missing" ||
          item.issue === "unsupported" ||
          item.issue === "unusable"),
    )
  ) {
    guidanceChecks.add("FFmpeg");
  }
  if (
    checks.some(
      (item) =>
        item.name === "yt-dlp" &&
        (item.issue === "missing" ||
          item.issue === "unsupported" ||
          item.issue === "unusable"),
    ) ||
    ytdlpJs.issue === "missing" ||
    ytdlpJs.issue === "unsupported" ||
    ytdlpJs.issue === "unusable"
  ) {
    guidanceChecks.add("yt-dlp");
  }
  if (
    checks.some((item) => item.name === "Node" && item.issue === "unsupported")
  ) {
    guidanceChecks.add("Node.js 24+");
  }
  return {
    ok: checks.every((item) => item.ok),
    checks,
    guidance: [...guidanceChecks].map((title) => guidance(title, platform)),
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const width = Math.max(...report.checks.map((item) => item.name.length));
  const lines = ["Urma Doctor", ""];
  for (const item of report.checks) {
    const detailLines = item.detail.split(/\r?\n/u);
    lines.push(
      `${item.status === "ok" ? "✓" : item.status === "warning" ? "?" : "✗"} ${
        item.name.padEnd(width)
      }  ${detailLines[0] ?? ""}`,
    );
    lines.push(
      ...detailLines
        .slice(1)
        .map((line) => (line.length > 0 ? `  ${line}` : "")),
    );
  }
  for (const item of report.guidance) {
    lines.push(
      "",
      `Install ${item.title}:`,
      "",
      `  ${item.platform}:`,
      `    ${item.command}`,
      "",
      `  Official docs: ${item.docs}`,
    );
  }
  lines.push("", report.ok ? "Ready." : "Not ready.");
  return lines.join("\n");
}
