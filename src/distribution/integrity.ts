import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { UrmaError } from "../core/errors.js";
import type { UrmaConfig } from "../config.js";
import { readReceipt, type ToolReceipt } from "./receipt.js";

export type RuntimeToolKind = "ffmpeg" | "ffprobe" | "ytdlp";

export async function sha256File(file: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk as Buffer);
  return digest.digest("hex");
}

function contained(root: string, file: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative !== "" && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function receiptTool(receipt: Awaited<ReturnType<typeof readReceipt>>, kind: RuntimeToolKind): ToolReceipt {
  return receipt.tools[kind];
}

const successful = new WeakMap<UrmaConfig, Map<RuntimeToolKind, Promise<void>>>();

/**
 * Verify a generation-local tool on first use in this process
 * Keep the result process-local; the receipt is not a fresh measurement
 */
export async function verifyRuntimeTool(
  config: UrmaConfig,
  kind: RuntimeToolKind,
): Promise<void> {
  if (config.runtime === undefined) return;
  let byKind = successful.get(config);
  if (byKind === undefined) {
    byKind = new Map();
    successful.set(config, byKind);
  }
  const pending = byKind.get(kind);
  if (pending !== undefined) {
    await pending;
    return;
  }
  const check = verifyRuntimeToolFresh(config, kind);
  byKind.set(kind, check);
  try {
    await check;
  } catch (error) {
    if (byKind.get(kind) === check) byKind.delete(kind);
    throw error;
  }
}

async function verifyRuntimeToolFresh(config: UrmaConfig, kind: RuntimeToolKind): Promise<void> {
  const runtime = config.runtime;
  if (runtime === undefined) return;
  const executable = kind === "ffmpeg" ? config.ffmpeg : kind === "ffprobe" ? config.ffprobe : config.ytdlp;
  if (!path.isAbsolute(executable) || !contained(runtime.generationDir, executable)) {
    throw new UrmaError(
      "INSTALLATION_CORRUPT",
      `Selected ${kind} executable is not an absolute path inside the active Urma generation`,
      { detail: { executable, generationDir: runtime.generationDir } },
    );
  }
  let info;
  try {
    info = await lstat(executable);
  } catch (error) {
    throw new UrmaError(
      "INSTALLATION_CORRUPT",
      `Selected ${kind} executable is missing from the active Urma generation; rerun setup`,
      { cause: error, detail: { executable } },
    );
  }
  if (!info.isFile()) {
    throw new UrmaError("INSTALLATION_CORRUPT", `Selected ${kind} executable is not a regular file; refusing PATH fallback`, {
      detail: { executable },
    });
  }
  let realGeneration: string;
  let realExecutable: string;
  try {
    realGeneration = await realpath(runtime.generationDir);
    realExecutable = await realpath(executable);
  } catch (error) {
    throw new UrmaError("INSTALLATION_CORRUPT", `Selected ${kind} executable could not be resolved inside the active generation`, { cause: error });
  }
  if (!contained(realGeneration, realExecutable)) {
    throw new UrmaError("INSTALLATION_CORRUPT", `Selected ${kind} executable resolves outside the active Urma generation; refusing PATH fallback`, {
      detail: { executable, generationDir: runtime.generationDir },
    });
  }
  let receipt;
  try {
    const receiptInfo = await lstat(runtime.receiptPath);
    if (!receiptInfo.isFile() || receiptInfo.isSymbolicLink()) throw new Error("receipt is not a regular file");
    const realReceipt = await realpath(runtime.receiptPath);
    if (!contained(realGeneration, realReceipt)) throw new Error("receipt resolves outside the active generation");
    receipt = await readReceipt(runtime.receiptPath);
  } catch (error) {
    throw new UrmaError("INSTALLATION_CORRUPT", "The active Urma installation receipt could not be validated", { cause: error });
  }
  const expected = receiptTool(receipt, kind);
  const expectedPath = path.resolve(runtime.generationDir, expected.relativePath);
  if (!samePath(path.resolve(executable), expectedPath)) {
    throw new UrmaError("INSTALLATION_CORRUPT", `Selected ${kind} path does not match the active receipt`, {
      detail: { executable, expectedPath },
    });
  }
  let expectedRealPath: string;
  try {
    expectedRealPath = await realpath(expectedPath);
  } catch (error) {
    throw new UrmaError("INSTALLATION_CORRUPT", `Selected ${kind} receipt path could not be resolved`, { cause: error });
  }
  if (!samePath(realExecutable, expectedRealPath)) {
    throw new UrmaError("INSTALLATION_CORRUPT", `Selected ${kind} executable does not resolve to the receipt path`, {
      detail: { executable, expectedPath },
    });
  }
  const configuredHash = runtime.toolHashes[kind];
  if (configuredHash !== expected.binarySha256) {
    throw new UrmaError("INSTALLATION_CORRUPT", `Selected ${kind} hash metadata does not match the active receipt`, {
      detail: { kind },
    });
  }
  const actual = await sha256File(executable);
  if (actual !== expected.binarySha256) {
    throw new UrmaError(
      "INSTALLATION_CORRUPT",
      `Selected ${kind} executable failed fresh integrity verification; rerun setup and do not use a system fallback`,
      { detail: { kind, executable, expectedSha256: expected.binarySha256, actualSha256: actual } },
    );
  }
}
