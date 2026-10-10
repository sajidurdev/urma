import os from "node:os";
import process from "node:process";
import { UrmaError } from "../core/errors.js";
import { SUPPORTED_NODE_RANGE } from "../version.js";

export type TargetPlatform =
  | "windows-x64"
  | "windows-arm64"
  | "macos-x64"
  | "macos-arm64"
  | "linux-x64-glibc"
  | "linux-arm64-glibc";

export type PlatformProbe = Readonly<{
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  glibcVersion?: string | null;
}>;

export function currentGlibcVersion(): string | null {
  try {
    const report = process.report?.getReport() as {
      header?: { glibcVersionRuntime?: unknown };
    };
    const value = report.header?.glibcVersionRuntime;
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function detectTargetPlatform(
  probe: PlatformProbe = {
    platform: process.platform,
    arch: process.arch,
    glibcVersion: currentGlibcVersion(),
  },
): TargetPlatform {
  if (probe.platform === "win32" && probe.arch === "x64") {
    return "windows-x64";
  }
  if (probe.platform === "win32" && probe.arch === "arm64") {
    return "windows-arm64";
  }
  if (probe.platform === "darwin" && probe.arch === "x64") {
    return "macos-x64";
  }
  if (probe.platform === "darwin" && probe.arch === "arm64") {
    return "macos-arm64";
  }
  if (probe.platform === "linux" && probe.arch === "x64") {
    if (!probe.glibcVersion) {
      throw new UrmaError(
        "UNSUPPORTED_PLATFORM",
        "Urma v1 requires a glibc Linux runtime; this Node process did not report glibc",
      );
    }
    return "linux-x64-glibc";
  }
  if (probe.platform === "linux" && probe.arch === "arm64") {
    if (!probe.glibcVersion) {
      throw new UrmaError(
        "UNSUPPORTED_PLATFORM",
        "Urma v1 requires a glibc Linux runtime; this Node process did not report glibc",
      );
    }
    return "linux-arm64-glibc";
  }
  throw new UrmaError(
    "UNSUPPORTED_PLATFORM",
    `Urma v1 does not support executing Node platform ${probe.platform}/${probe.arch}; supported targets are Windows x64/ARM64, macOS x64/ARM64, and Linux x64/ARM64 glibc`,
    { detail: { platform: probe.platform, arch: probe.arch } },
  );
}

export function nodeVersionIsSupported(
  version: string,
  range = SUPPORTED_NODE_RANGE,
): boolean {
  const parsedVersion = parseVersionTuple(version, false);
  if (!parsedVersion || typeof range !== "string" || range.trim() === "") {
    return false;
  }

  let supported = false;
  for (const alternative of range.split(/\s*\|\|\s*/u)) {
    const match = /^>=\s*(\S+)\s+<\s*(\S+)$/u.exec(alternative.trim());
    if (!match) return false;
    const lower = parseVersionTuple(match[1], true);
    const upper = parseVersionTuple(match[2], true);
    if (!lower || !upper || compareVersions(lower, upper) >= 0) return false;
    if (
      compareVersions(parsedVersion, lower) >= 0 &&
      compareVersions(parsedVersion, upper) < 0
    ) {
      supported = true;
    }
  }
  return supported;
}

type VersionTuple = readonly [number, number, number];

function parseVersionTuple(
  value: unknown,
  allowPartial: boolean,
): VersionTuple | null {
  if (typeof value !== "string") return null;
  const components = value.split(".");
  if (
    components.length < 1 ||
    components.length > 3 ||
    (!allowPartial && components.length !== 3) ||
    components.some((component) => !/^(?:0|[1-9][0-9]*)$/u.test(component))
  ) {
    return null;
  }
  const parsed = components.map(Number);
  if (parsed.some((component) => !Number.isSafeInteger(component))) return null;
  return [parsed[0] ?? 0, parsed[1] ?? 0, parsed[2] ?? 0];
}

function compareVersions(left: VersionTuple, right: VersionTuple): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

export function executionArchitecture(): string {
  return `${process.platform}-${process.arch}`;
}

export function hostPlatformLabel(target: TargetPlatform): string {
  return target.startsWith("windows")
    ? "Windows"
    : target.startsWith("macos")
    ? "macOS"
    : "Linux glibc";
}

export function isWindows(target: TargetPlatform): boolean {
  return target.startsWith("windows");
}

export function isMacOS(target: TargetPlatform): boolean {
  return target.startsWith("macos");
}

export function isLinux(target: TargetPlatform): boolean {
  return target.startsWith("linux");
}

export function nativeNodeArchitecture(): string {
  return `${os.platform()}-${os.arch()}`;
}
