import { open, readFile } from "node:fs/promises";
import path from "node:path";
import { SCHEMA_VERSION } from "../store/schema.js";
import type { TargetPlatform } from "./platform.js";
import { validateInstallId } from "./paths.js";

export type ToolReceipt = Readonly<{
  provider: string;
  version: string;
  release: string;
  archiveSha256: string;
  binarySha256: string;
  relativePath: string;
  buildConfiguration: string;
}>;

export type InstallationReceipt = Readonly<{
  schema: 1;
  installId: string;
  target: TargetPlatform;
  createdAt: string;
  urma: Readonly<{
    version: string;
    payloadSha256: string;
  }>;
  manifest: Readonly<{
    identity: string;
    target: TargetPlatform;
  }>;
  node: Readonly<{
    execPath: string;
    version: string;
    executionArchitecture: string;
    sha256?: string;
  }>;
  tools: Readonly<{
    ffmpeg: ToolReceipt;
    ffprobe: ToolReceipt;
    ytdlp: ToolReceipt;
  }>;
  policy: Readonly<{
    invocationProfileVersion: string;
    flags: readonly string[];
  }>;
  runtime: Readonly<{
    entry: string;
    stateSchemaVersion: number;
  }>;
  qualification: Readonly<{
    status: "passed";
    fixtureVersion: string;
    checks: readonly string[];
  }>;
  notices: readonly string[];
}>;

const RELATIVE_FILE = /^(?![\\/])(?!(?:[A-Za-z]:|\\\\))/u;

function fail(message: string): never {
  throw new Error(message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function stringField(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) fail(`${label} must be a non-empty string`);
  return value;
}

function hashField(value: unknown, label: string): string {
  const result = stringField(value, label);
  if (!/^[a-f0-9]{64}$/u.test(result)) fail(`${label} must be a lowercase SHA-256 digest`);
  return result;
}

function relativeField(value: unknown, label: string): string {
  const result = stringField(value, label);
  if (!RELATIVE_FILE.test(result) || result === "." || result.split(/[\\/]/u).some((part) => part === ".." || part === "" || part === ".")) {
    fail(`${label} must be a contained relative path`);
  }
  return result;
}

function tool(value: unknown, label: string): ToolReceipt {
  const item = record(value, label);
  return {
    provider: stringField(item.provider, `${label}.provider`),
    version: stringField(item.version, `${label}.version`),
    release: stringField(item.release, `${label}.release`),
    archiveSha256: hashField(item.archiveSha256, `${label}.archiveSha256`),
    binarySha256: hashField(item.binarySha256, `${label}.binarySha256`),
    relativePath: relativeField(item.relativePath, `${label}.relativePath`),
    buildConfiguration: stringField(item.buildConfiguration, `${label}.buildConfiguration`),
  };
}

export function parseReceipt(value: unknown): InstallationReceipt {
  const item = record(value, "receipt");
  const urma = record(item.urma, "receipt.urma");
  const manifest = record(item.manifest, "receipt.manifest");
  const node = record(item.node, "receipt.node");
  const tools = record(item.tools, "receipt.tools");
  const policy = record(item.policy, "receipt.policy");
  const runtime = record(item.runtime, "receipt.runtime");
  const qualification = record(item.qualification, "receipt.qualification");
  const target = stringField(item.target, "receipt.target") as TargetPlatform;
  if (!new Set(["windows-x64", "windows-arm64", "macos-x64", "macos-arm64", "linux-x64-glibc", "linux-arm64-glibc"]).has(target)) fail("receipt.target is not a supported target");
  if (item.schema !== 1 || manifest.target !== target || qualification.status !== "passed") {
    fail("receipt has an invalid schema, target, or qualification status");
  }
  if (runtime.stateSchemaVersion !== SCHEMA_VERSION) {
    fail(`receipt.runtime.stateSchemaVersion must match current schema v${String(SCHEMA_VERSION)}`);
  }
  if (!Array.isArray(policy.flags) || !policy.flags.every((flag) => typeof flag === "string")) {
    fail("receipt.policy.flags must be a string array");
  }
  if (!Array.isArray(qualification.checks) || qualification.checks.length === 0 || !qualification.checks.every((check) => typeof check === "string")) {
    fail("receipt.qualification.checks must be a string array");
  }
  if (!Array.isArray(item.notices) || !item.notices.every((notice) => typeof notice === "string")) {
    fail("receipt.notices must be a string array");
  }
  return {
    schema: 1,
    installId: validateInstallId(stringField(item.installId, "receipt.installId")),
    target,
    createdAt: stringField(item.createdAt, "receipt.createdAt"),
    urma: {
      version: stringField(urma.version, "receipt.urma.version"),
      payloadSha256: hashField(urma.payloadSha256, "receipt.urma.payloadSha256"),
    },
    manifest: {
      identity: hashField(manifest.identity, "receipt.manifest.identity"),
      target,
    },
    node: {
      execPath: (() => {
        const value = stringField(node.execPath, "receipt.node.execPath");
        if (!path.isAbsolute(value)) fail("receipt.node.execPath must be absolute");
        return value;
      })(),
      version: stringField(node.version, "receipt.node.version"),
      executionArchitecture: stringField(node.executionArchitecture, "receipt.node.executionArchitecture"),
      ...(node.sha256 === undefined ? {} : { sha256: hashField(node.sha256, "receipt.node.sha256") }),
    },
    tools: {
      ffmpeg: tool(tools.ffmpeg, "receipt.tools.ffmpeg"),
      ffprobe: tool(tools.ffprobe, "receipt.tools.ffprobe"),
      ytdlp: tool(tools.ytdlp, "receipt.tools.ytdlp"),
    },
    policy: {
      invocationProfileVersion: stringField(policy.invocationProfileVersion, "receipt.policy.invocationProfileVersion"),
      flags: [...policy.flags] as string[],
    },
    runtime: {
      entry: relativeField(runtime.entry, "receipt.runtime.entry"),
      stateSchemaVersion: runtime.stateSchemaVersion as number,
    },
    qualification: {
      status: "passed",
      fixtureVersion: stringField(qualification.fixtureVersion, "receipt.qualification.fixtureVersion"),
      checks: [...qualification.checks] as string[],
    },
    notices: [...item.notices] as string[],
  };
}

export async function readReceipt(file: string): Promise<InstallationReceipt> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Could not read installation receipt ${file}`, { cause: error });
  }
  try {
    return parseReceipt(parsed);
  } catch (error) {
    throw new Error(`Installation receipt ${file} is invalid`, { cause: error });
  }
}

export async function writeReceipt(file: string, receipt: InstallationReceipt): Promise<void> {
  const parsed = parseReceipt(receipt);
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}
