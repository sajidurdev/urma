import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { UrmaConfig } from "../config.js";
import { UrmaError } from "../core/errors.js";

const POLL_MS = 50;

async function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    timer.unref();
    function done() {
      signal.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

async function remoteDirectoryUsage(
  directory: string,
  stopAfter = Number.MAX_SAFE_INTEGER,
): Promise<{ totalBytes: number; largestFileBytes: number }> {
  const names = await readdir(directory, { recursive: true });
  let totalBytes = 0;
  let largestFileBytes = 0;
  for (const name of names) {
    const info = await stat(path.join(directory, name)).catch(() => null);
    if (info?.isFile()) {
      totalBytes += info.size;
      largestFileBytes = Math.max(largestFileBytes, info.size);
      if (totalBytes > stopAfter) return { totalBytes, largestFileBytes };
    }
  }
  return { totalBytes, largestFileBytes };
}
export function assertExpectedRemoteBytes(
  expectedBytes: number | null,
  budgetBytes: number,
  label: string,
): void {
  if (expectedBytes !== null && expectedBytes > budgetBytes) {
    throw new UrmaError(
      "MEDIA_BUDGET_EXCEEDED",
      `${label} expected size ${expectedBytes} bytes exceeds its ${budgetBytes}-byte hard acquisition budget`,
    );
  }
}

export async function assertRemoteDirectoryWithinBudget(
  directory: string,
  budgetBytes: number,
  label: string,
  fileBudgetBytes: number = budgetBytes,
): Promise<number> {
  const usage = await remoteDirectoryUsage(directory, budgetBytes);
  if (usage.totalBytes > budgetBytes) {
    throw new UrmaError(
      "MEDIA_BUDGET_EXCEEDED",
      `${label} exceeded its ${budgetBytes}-byte hard acquisition budget`,
    );
  }
  if (usage.largestFileBytes > fileBudgetBytes) {
    throw new UrmaError(
      "MEDIA_BUDGET_EXCEEDED",
      `${label} emitted one file larger than its ${fileBudgetBytes}-byte per-artifact hard acquisition budget`,
    );
  }
  return usage.totalBytes;
}

export async function withRemoteAcquisitionDirectory<T>(
  config: UrmaConfig,
  prefix: string,
  budgetBytes: number,
  signal: AbortSignal | undefined,
  operation: (directory: string, signal: AbortSignal) => Promise<T>,
  fileBudgetBytes: number = budgetBytes,
): Promise<T> {
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(prefix)) {
    throw new RangeError("Remote acquisition temporary prefix is invalid");
  }
  if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 1) {
    throw new RangeError(
      "Remote acquisition byte budget must be a positive safe integer",
    );
  }
  if (
    !Number.isSafeInteger(fileBudgetBytes) ||
    fileBudgetBytes < 1 ||
    fileBudgetBytes > budgetBytes
  ) {
    throw new RangeError(
      "Remote acquisition per-file byte budget must be a positive safe integer no larger than the directory budget",
    );
  }
  if (signal?.aborted) {
    throw new UrmaError(
      "CANCELLED",
      "Remote acquisition was cancelled before it began",
    );
  }
  const root = path.join(config.dataDir, "tmp");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, `${prefix}-`));
  const controller = new AbortController();
  const monitorController = new AbortController();
  let exceeded: "total" | "file" | null = null;
  let active = true;
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const monitor = (async () => {
    while (active && !monitorController.signal.aborted) {
      await pause(POLL_MS, monitorController.signal);
      if (!active || monitorController.signal.aborted) break;
      const usage = await remoteDirectoryUsage(directory, budgetBytes).catch(
        () => ({ totalBytes: 0, largestFileBytes: 0 }),
      );
      if (
        usage.totalBytes > budgetBytes ||
        usage.largestFileBytes > fileBudgetBytes
      ) {
        exceeded = usage.totalBytes > budgetBytes ? "total" : "file";
        controller.abort();
        break;
      }
    }
  })();
  try {
    let result: T | undefined;
    let failure: unknown;
    try {
      result = await operation(directory, controller.signal);
    } catch (error) {
      failure = error;
    }
    active = false;
    monitorController.abort();
    await monitor;
    const finalUsage = await remoteDirectoryUsage(directory, budgetBytes).catch(
      () => ({ totalBytes: 0, largestFileBytes: 0 }),
    );
    if (
      finalUsage.totalBytes > budgetBytes ||
      finalUsage.largestFileBytes > fileBudgetBytes
    ) {
      exceeded = finalUsage.totalBytes > budgetBytes ? "total" : "file";
    }
    if (exceeded) {
      throw new UrmaError(
        "MEDIA_BUDGET_EXCEEDED",
        exceeded === "total"
          ? `Remote acquisition exceeded its ${budgetBytes}-byte hard acquisition budget; the process tree was terminated and temporary output was discarded`
          : `Remote acquisition emitted one file larger than its ${fileBudgetBytes}-byte per-artifact hard acquisition budget; the process tree was terminated and temporary output was discarded`,
      );
    }
    if (failure !== undefined) throw failure;
    return result as T;
  } finally {
    active = false;
    monitorController.abort();
    signal?.removeEventListener("abort", onAbort);
    await monitor.catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}
