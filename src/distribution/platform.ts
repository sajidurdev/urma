import os from "node:os";
import process from "node:process";
import { UrmaError } from "../core/errors.js";

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
  range = ">=24 <25",
): boolean {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/u.exec(version.trim());
  if (!match) return false;
  const major = Number(match[1]);
  const lower = Number(/>=\s*(\d+)/u.exec(range)?.[1] ?? 0);
  const upper = Number(/<\s*(\d+)/u.exec(range)?.[1] ?? Number.MAX_SAFE_INTEGER);
  return Number.isSafeInteger(major) && major >= lower && major < upper;
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
