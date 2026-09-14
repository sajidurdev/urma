import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type PackageMetadata = Readonly<{
  version: string;
  engines?: Readonly<{ node?: string }>;
}>;

function isPackageMetadata(value: unknown): value is PackageMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as { version?: unknown; engines?: unknown };
  if (
    typeof candidate.version !== "string" || candidate.version.trim() === ""
  ) {
    return false;
  }
  if (candidate.engines === undefined) return true;
  if (
    typeof candidate.engines !== "object" ||
    candidate.engines === null ||
    Array.isArray(candidate.engines)
  ) {
    return false;
  }
  const engines = candidate.engines as { node?: unknown };
  return engines.node === undefined || typeof engines.node === "string";
}

function loadPackageMetadata(): PackageMetadata {
  const candidates = [
    fileURLToPath(new URL("../package.json", import.meta.url)),
    fileURLToPath(new URL("../../package.json", import.meta.url)),
  ];
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(candidate, "utf8"));
      if (isPackageMetadata(parsed)) return parsed;
      lastError = new Error(
        `Package metadata at ${candidate} has no usable version`,
      );
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `Could not load Urma package metadata from its runtime directory`,
    { cause: lastError },
  );
}

export const PACKAGE_METADATA = loadPackageMetadata();
export const URMA_VERSION = PACKAGE_METADATA.version;
export const SUPPORTED_NODE_RANGE = PACKAGE_METADATA.engines?.node ??
  "not declared";
