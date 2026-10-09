import { createHash } from "node:crypto";
import type { TargetPlatform } from "./platform.js";

export type ArchiveFormat = "zip" | "tar.xz";
export type ArtifactKind = "ffmpeg" | "ffprobe" | "ytdlp";

export type LicensingMetadata = Readonly<{
  license: string;
  redistributable: boolean;
  nonfree: boolean;
  buildConfiguration: string;
  noticeUrls: readonly string[];
}>;

export type ArtifactSpec = Readonly<{
  kind: ArtifactKind;
  provider: string;
  upstreamVersion: string;
  upstreamRelease: string;
  url: string;
  archiveFormat: ArchiveFormat;
  archiveBytes: number;
  archiveSha256: string;
  expectedFiles: readonly string[];
  executable: string;
  binarySha256?: string;
  licensing: LicensingMetadata;
}>;

export type YtDlpInvocationProfile = Readonly<{
  version: string;
  flags: readonly string[];
  unsupportedFlags: readonly string[];
}>;

export type TargetReleaseManifest = Readonly<{
  schema: 1;
  target: TargetPlatform;
  minimumPlatform: string;
  capabilityProfile: string;
  ffmpeg: ArtifactSpec;
  ffprobe: ArtifactSpec;
  ytdlp: ArtifactSpec;
  ytdlpProfile: YtDlpInvocationProfile;
  licensing: Readonly<{ notices: readonly string[] }>;
}>;

// Pin the latest verified build of a month; BtbN retains month-end builds for two years.
const BTBN_RELEASE = "autobuild-2026-09-30-13-08";
const BTBN_VERSION = "N-127032-g6ae491a26c";
const YTDLP_VERSION = "2026.08.19";
const YTDLP_NOTICE = `https://github.com/yt-dlp/yt-dlp/blob/${YTDLP_VERSION}/LICENSE`;
const YTDLP_THIRD_PARTY_NOTICE = `https://github.com/yt-dlp/yt-dlp/blob/${YTDLP_VERSION}/THIRD_PARTY_LICENSES.txt`;

function btbN(
  target: TargetPlatform,
  file: string,
  sha256: string,
  bytes: number,
  executableSuffix: string,
  release = BTBN_RELEASE,
  version = BTBN_VERSION,
): ArtifactSpec {
  const url = `https://github.com/BtbN/FFmpeg-Builds/releases/download/${release}/${file}`;
  return {
    kind: "ffmpeg",
    provider: "BtbN FFmpeg-Builds",
    upstreamVersion: version,
    upstreamRelease: release,
    url,
    archiveFormat: file.endsWith(".tar.xz") ? "tar.xz" : "zip",
    archiveBytes: bytes,
    archiveSha256: sha256,
    expectedFiles: [
      `${file.replace(/\.(?:tar\.xz|zip)$/u, "")}/bin/ffmpeg${executableSuffix}`,
      `${file.replace(/\.(?:tar\.xz|zip)$/u, "")}/bin/ffprobe${executableSuffix}`,
    ],
    executable: `${file.replace(/\.(?:tar\.xz|zip)$/u, "")}/bin/ffmpeg${executableSuffix}`,
    licensing: {
      license: "LGPL-2.1-or-later",
      redistributable: true,
      nonfree: false,
      buildConfiguration: "BtbN static LGPL build; nonfree components disabled by release profile",
      noticeUrls: [`https://github.com/BtbN/FFmpeg-Builds/releases/tag/${release}`],
    },
  };
}

function btbNProbe(ffmpeg: ArtifactSpec): ArtifactSpec {
  return { ...ffmpeg, kind: "ffprobe", executable: ffmpeg.executable.replace("/ffmpeg", "/ffprobe") };
}

function standaloneYtDlp(
  target: TargetPlatform,
  file: string,
  sha256: string,
  bytes: number,
  executable: string,
): ArtifactSpec {
  return {
    kind: "ytdlp",
    provider: "yt-dlp official standalone distribution",
    upstreamVersion: YTDLP_VERSION,
    upstreamRelease: YTDLP_VERSION,
    url: `https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/${file}`,
    archiveFormat: "zip",
    archiveBytes: bytes,
    archiveSha256: sha256,
    expectedFiles: [executable],
    executable,
    licensing: {
      license: "GPL-3.0-or-later combined standalone work; yt-dlp core is Unlicense",
      redistributable: true,
      nonfree: false,
      buildConfiguration: "Official unpacked PyInstaller standalone distribution; preserve the complete extracted distribution and bundled third-party notices",
      noticeUrls: [YTDLP_NOTICE, YTDLP_THIRD_PARTY_NOTICE, `https://github.com/yt-dlp/yt-dlp/tree/${YTDLP_VERSION}/third_party`],
    },
  };
}

function macArtifact(
  kind: "ffmpeg" | "ffprobe",
  provider: string,
  version: string,
  release: string,
  url: string,
  sha256: string,
  bytes: number,
  executable: string,
  noticeUrls: readonly string[],
  buildConfiguration: string,
): ArtifactSpec {
  return {
    kind,
    provider,
    upstreamVersion: version,
    upstreamRelease: release,
    url,
    archiveFormat: "zip",
    archiveBytes: bytes,
    archiveSha256: sha256,
    expectedFiles: [executable],
    executable,
    licensing: {
      license: "GPL-2.0-or-later",
      redistributable: true,
      nonfree: false,
      buildConfiguration,
      noticeUrls,
    },
  };
}

function profile(): YtDlpInvocationProfile {
  return {
    version: YTDLP_VERSION,
    flags: [
      "--ignore-config",
      "--no-config-locations",
      "--no-plugin-dirs",
      "--no-update",
      "--no-js-runtimes",
      "--js-runtimes",
      "--no-remote-components",
      "--no-exec",
      "--ffmpeg-location",
      "--no-cache-dir",
      "--no-cookies",
      "--no-cookies-from-browser",
    ],
    // yt-dlp has no --no-netrc flag; --ignore-config blocks ambient netrc settings
    unsupportedFlags: ["--no-netrc"],
  };
}

function release(
  target: TargetPlatform,
  minimumPlatform: string,
  ffmpeg: ArtifactSpec,
  ffprobe: ArtifactSpec,
  ytdlp: ArtifactSpec,
): TargetReleaseManifest {
  return {
    schema: 1,
    target,
    minimumPlatform,
    capabilityProfile: "video-evidence-v1",
    ffmpeg,
    ffprobe,
    ytdlp,
    ytdlpProfile: profile(),
    licensing: {
      notices: [
        "https://ffmpeg.org/legal.html",
        YTDLP_NOTICE,
      ],
    },
  };
}

const linuxX64 = btbN(
  "linux-x64-glibc",
  "ffmpeg-N-127032-g6ae491a26c-linux64-lgpl.tar.xz",
  "82ccd41f4c04ac6f1633920c83eb4c73c6c9dc954d64da10a2410c1277b83647",
  140614116,
  "",
);
const linuxArm64 = btbN(
  "linux-arm64-glibc",
  "ffmpeg-N-127032-g6ae491a26c-linuxarm64-lgpl.tar.xz",
  "1f3190187f4027e2335c2542f6c3a73cf51e81820b200f3c75cfdca0d7a0b624",
  119163928,
  "",
);
const windowsX64 = btbN(
  "windows-x64",
  "ffmpeg-N-127032-g6ae491a26c-win64-lgpl.zip",
  "c73ad424c5f9d94dd48815b4d3531e57130cb9f5c3dc8f21f4aa4e1fdb0658e3",
  176142306,
  ".exe",
);
// The September winarm64 build crashes at startup (-version) on the native ARM64 runner.
const windowsArm64 = btbN(
  "windows-arm64",
  "ffmpeg-N-126342-gf88b741dbf-winarm64-lgpl.zip",
  "050be15329851af86bba7f06c08dc6bdeaf9819e2269d945a9f33d61ab0149ad",
  98448796,
  ".exe",
  "autobuild-2026-08-31-13-27",
  "N-126342-gf88b741dbf",
);

export const RELEASE_MANIFESTS: Readonly<Record<TargetPlatform, TargetReleaseManifest>> = {
  "windows-x64": release(
    "windows-x64",
    "release-qualified minimum Windows platform is maintained in CI metadata",
    windowsX64,
    btbNProbe(windowsX64),
    standaloneYtDlp(
      "windows-x64",
      "yt-dlp_win.zip",
      "30b4c14aafab6082becff7881e41b76df46dc43ea7633479410a91e29da492bf",
      18087041,
      "yt-dlp.exe",
    ),
  ),
  "windows-arm64": release(
    "windows-arm64",
    "release-qualified minimum Windows platform is maintained in CI metadata",
    windowsArm64,
    btbNProbe(windowsArm64),
    standaloneYtDlp(
      "windows-arm64",
      "yt-dlp_win_arm64.zip",
      "2ad49db7429a6204721f711a44199a8c9fa8d5df2183dd7fedc4ef6c9e2e50d3",
      21463236,
      "yt-dlp_arm64.exe",
    ),
  ),
  "linux-x64-glibc": release(
    "linux-x64-glibc",
    "release-qualified glibc/kernel floor is maintained in CI metadata",
    linuxX64,
    btbNProbe(linuxX64),
    standaloneYtDlp(
      "linux-x64-glibc",
      "yt-dlp_linux.zip",
      "32e72032766bef9199d99d15beb69fd52e46df8f8b06f0d8745db59e04d339e9",
      40516244,
      "yt-dlp_linux",
    ),
  ),
  "linux-arm64-glibc": release(
    "linux-arm64-glibc",
    "release-qualified glibc/kernel floor is maintained in CI metadata",
    linuxArm64,
    btbNProbe(linuxArm64),
    standaloneYtDlp(
      "linux-arm64-glibc",
      "yt-dlp_linux_aarch64.zip",
      "4e27ad43f3a34bacffd078694eb3edbb4e3b378e7da44edab2be02e98555516e",
      40213537,
      "yt-dlp_linux_aarch64",
    ),
  ),
  "macos-x64": release(
    "macos-x64",
    "release-qualified minimum macOS platform is maintained in CI metadata",
    macArtifact(
      "ffmpeg",
      "Evermeet",
      "9.0.1",
      "9.0.1",
      "https://evermeet.cx/ffmpeg/ffmpeg-9.0.1.zip",
      "8a8c9e549983409fe6604b9aa665648b7a5def9407fe814c39c8b2ea7f64a48f",
      26172529,
      "ffmpeg",
      ["https://evermeet.cx/ffmpeg/"],
      "Evermeet versioned macOS Intel build; nonfree components disabled by Urma release qualification",
    ),
    macArtifact(
      "ffprobe",
      "Evermeet",
      "9.0.1",
      "9.0.1",
      "https://evermeet.cx/ffmpeg/ffprobe-9.0.1.zip",
      "d13f35db03456b7f65b7edb6437c86e23810fbfe91795e571f5b77211343b4f1",
      26075757,
      "ffprobe",
      ["https://evermeet.cx/ffmpeg/"],
      "Evermeet versioned macOS Intel build; nonfree components disabled by Urma release qualification",
    ),
    standaloneYtDlp(
      "macos-x64",
      "yt-dlp_macos.zip",
      "07e54b0865303c864006925913bce2604f8ee8cc6f18699bac9c309f9328a6d8",
      53923637,
      "yt-dlp_macos",
    ),
  ),
  "macos-arm64": release(
    "macos-arm64",
    "release-qualified minimum macOS platform is maintained in CI metadata",
    macArtifact(
      "ffmpeg",
      "Martin Riedl",
      "9.0.1",
      "1787073674_9.0.1",
      "https://ffmpeg.martin-riedl.de/download/macos/arm64/1787073674_9.0.1/ffmpeg.zip",
      "8287a1b2229e05eb41859f073e18e6c52c60a778f2f5e6881070fe51b79407fe",
      28447413,
      "ffmpeg",
      ["https://ffmpeg.martin-riedl.de/"],
      "Martin Riedl signed Apple Silicon build; preserve upstream signature and release configuration",
    ),
    macArtifact(
      "ffprobe",
      "Martin Riedl",
      "9.0.1",
      "1787073674_9.0.1",
      "https://ffmpeg.martin-riedl.de/download/macos/arm64/1787073674_9.0.1/ffprobe.zip",
      "102a26b8940a053298d9929bfaae71e4b6ef65ba5f19a99a88c433108560741a",
      28370930,
      "ffprobe",
      ["https://ffmpeg.martin-riedl.de/"],
      "Martin Riedl signed Apple Silicon build; preserve upstream signature and release configuration",
    ),
    standaloneYtDlp(
      "macos-arm64",
      "yt-dlp_macos.zip",
      "07e54b0865303c864006925913bce2604f8ee8cc6f18699bac9c309f9328a6d8",
      53923637,
      "yt-dlp_macos",
    ),
  ),
};

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

export function manifestIdentity(manifest: TargetReleaseManifest): string {
  return createHash("sha256").update(stableJson(manifest)).digest("hex");
}

export function getReleaseManifest(target: TargetPlatform): TargetReleaseManifest {
  return RELEASE_MANIFESTS[target];
}

export function validateReleaseManifest(manifest: TargetReleaseManifest): void {
  const targets = new Set<TargetPlatform>([
    "windows-x64",
    "windows-arm64",
    "macos-x64",
    "macos-arm64",
    "linux-x64-glibc",
    "linux-arm64-glibc",
  ]);
  if (
    manifest.schema !== 1 ||
    !targets.has(manifest.target) ||
    manifest.minimumPlatform.length === 0 ||
    manifest.capabilityProfile.length === 0
  ) {
    throw new Error("Invalid target release manifest metadata");
  }
  const expectedKinds: readonly ArtifactKind[] = ["ffmpeg", "ffprobe", "ytdlp"];
  const artifacts = [manifest.ffmpeg, manifest.ffprobe, manifest.ytdlp];
  for (let index = 0; index < artifacts.length; index += 1) {
    const artifact = artifacts[index]!;
    if (
      artifact.kind !== expectedKinds[index] ||
      artifact.provider.length === 0 ||
      artifact.upstreamVersion.length === 0 ||
      artifact.upstreamRelease.length === 0 ||
      !/^https:\/\//u.test(artifact.url) ||
      /\/latest(?:\/|$)/iu.test(artifact.url) ||
      !/^[a-f0-9]{64}$/u.test(artifact.archiveSha256) ||
      !Number.isSafeInteger(artifact.archiveBytes) ||
      (artifact.archiveBytes !== 0 && artifact.archiveBytes < 1) ||
      !artifact.licensing.redistributable ||
      artifact.licensing.nonfree ||
      artifact.expectedFiles.length === 0 ||
      !artifact.expectedFiles.includes(artifact.executable) ||
      artifact.expectedFiles.some((file) =>
        file.length === 0 ||
        file.includes("\\") ||
        file.startsWith("/") ||
        /^[A-Za-z]:/u.test(file) ||
        file.split("/").some((part) => part === "" || part === "." || part === "..")
      ) ||
      !/^[^/\\]+(?:\/[^/\\]+)*$/u.test(artifact.executable) ||
      artifact.licensing.noticeUrls.some((url) => !/^https:\/\//u.test(url))
    ) {
      throw new Error(`Invalid release artifact metadata for ${artifact.kind}`);
    }
  }
  if (manifest.ffmpeg.upstreamVersion !== manifest.ffprobe.upstreamVersion) {
    throw new Error("ffmpeg and ffprobe must use one qualified build version");
  }
  if (
    manifest.ffmpeg.provider !== manifest.ffprobe.provider ||
    manifest.ffmpeg.upstreamRelease !== manifest.ffprobe.upstreamRelease ||
    manifest.ffmpeg.licensing.license !== manifest.ffprobe.licensing.license ||
    manifest.ffmpeg.licensing.nonfree !== manifest.ffprobe.licensing.nonfree
  ) {
    throw new Error("ffmpeg and ffprobe must come from one qualified provider/build pair");
  }
  if (manifest.ytdlpProfile.version !== manifest.ytdlp.upstreamVersion) {
    throw new Error("yt-dlp invocation profile must match the pinned distribution");
  }
  if (
    manifest.ytdlpProfile.flags.some((flag) => typeof flag !== "string" || !flag.startsWith("--")) ||
    manifest.ytdlpProfile.unsupportedFlags.some((flag) => typeof flag !== "string" || !flag.startsWith("--")) ||
    manifest.licensing.notices.some((url) => !/^https:\/\//u.test(url))
  ) {
    throw new Error("Invalid yt-dlp or licensing metadata in target release manifest");
  }
  if (manifest.ytdlpProfile.unsupportedFlags.some((flag) => manifest.ytdlpProfile.flags.includes(flag))) {
    throw new Error("yt-dlp invocation profile contains a flag explicitly marked unsupported");
  }
}

for (const manifest of Object.values(RELEASE_MANIFESTS)) validateReleaseManifest(manifest);
