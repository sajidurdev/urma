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

// Pin month-end builds; BtbN retains them for two years.
const BTBN_RELEASE = "autobuild-2026-10-31-12-59";
const BTBN_VERSION = "N-128227-g4811625b5f";
const YTDLP_VERSION = "2026.10.26";
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
      license: "GPL-3.0-or-later",
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
  "ffmpeg-N-128227-g4811625b5f-linux64-lgpl.tar.xz",
  "f7ce163eca978dc3ab761e6c288f5f764ec4326d17c926c8d4f75ed95e77ee4b",
  140425228,
  "",
);
const linuxArm64 = btbN(
  "linux-arm64-glibc",
  "ffmpeg-N-128227-g4811625b5f-linuxarm64-lgpl.tar.xz",
  "3c620620e5836f6e48b37883e2a84ce20286e4f5585574c54ba4bc11edba61af",
  121614672,
  "",
);
const windowsX64 = btbN(
  "windows-x64",
  "ffmpeg-N-128227-g4811625b5f-win64-lgpl.zip",
  "6550f7abc950128fbb0069b4552f2972baccf5fbd819f2fd0abbe4ceb8d48734",
  175264885,
  ".exe",
);
// Requalify ARM64 startup: the September build crashed on the native runner.
const windowsArm64 = btbN(
  "windows-arm64",
  "ffmpeg-N-128227-g4811625b5f-winarm64-lgpl.zip",
  "742afe9b16d5aff391180d2f6be836b32e904f17ee5f304af7733642395582bd",
  123255806,
  ".exe",
);

export const RELEASE_MANIFESTS: Readonly<Record<TargetPlatform, TargetReleaseManifest>> = {
  "windows-x64": release(
    "windows-x64",
    "Windows 10 22H2 or later; release-qualified platform is maintained in CI metadata",
    windowsX64,
    btbNProbe(windowsX64),
    standaloneYtDlp(
      "windows-x64",
      "yt-dlp_win.zip",
      "fd51b212cf8380c7a52ee08c0d6be7f3c59b2f2c832eaf7b45acfae6eab57419",
      23885596,
      "yt-dlp.exe",
    ),
  ),
  "windows-arm64": release(
    "windows-arm64",
    "Windows 10 22H2 or later; release-qualified platform is maintained in CI metadata",
    windowsArm64,
    btbNProbe(windowsArm64),
    standaloneYtDlp(
      "windows-arm64",
      "yt-dlp_win_arm64.zip",
      "5eaa4c61f3c09189f3a551bf1855c13aad61fb865cc33f06012a6c2dbe287a45",
      23179217,
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
      "f34053415136e55073dd64ba5326d161ecc23ce0e98c081d8752867b37809450",
      41236547,
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
      "74708e707e8fa8177c8347e58152337edf320149cd7b225defd453f7cde47822",
      40835009,
      "yt-dlp_linux_aarch64",
    ),
  ),
  "macos-x64": release(
    "macos-x64",
    "release-qualified minimum macOS platform is maintained in CI metadata",
    macArtifact(
      "ffmpeg",
      "Martin Riedl",
      "9.0.2",
      "1789931006_9.0.2",
      "https://ffmpeg.martin-riedl.de/download/macos/amd64/1789931006_9.0.2/ffmpeg.zip",
      "7c6b4125b191cbf773832dc51f424cf2b6bb7da43007d1e066f95909e47cacd4",
      33816391,
      "ffmpeg",
      ["https://ffmpeg.martin-riedl.de/"],
      "Martin Riedl signed Intel build; preserve upstream signature and release configuration",
    ),
    macArtifact(
      "ffprobe",
      "Martin Riedl",
      "9.0.2",
      "1789931006_9.0.2",
      "https://ffmpeg.martin-riedl.de/download/macos/amd64/1789931006_9.0.2/ffprobe.zip",
      "2322438ed2f6319a691291b247d09c69dcaa3a982460d1f269a7e1af335cfdfd",
      33719233,
      "ffprobe",
      ["https://ffmpeg.martin-riedl.de/"],
      "Martin Riedl signed Intel build; preserve upstream signature and release configuration",
    ),
    standaloneYtDlp(
      "macos-x64",
      "yt-dlp_macos.zip",
      "20d98fa608998eff87d1d35a6e9fb65e4b874639a6cc89addc19da3becde3ef1",
      54165284,
      "yt-dlp_macos",
    ),
  ),
  "macos-arm64": release(
    "macos-arm64",
    "release-qualified minimum macOS platform is maintained in CI metadata",
    macArtifact(
      "ffmpeg",
      "Martin Riedl",
      "9.0.2",
      "1789931890_9.0.2",
      "https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip",
      "c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924",
      28395699,
      "ffmpeg",
      ["https://ffmpeg.martin-riedl.de/"],
      "Martin Riedl signed Apple Silicon build; preserve upstream signature and release configuration",
    ),
    macArtifact(
      "ffprobe",
      "Martin Riedl",
      "9.0.2",
      "1789931890_9.0.2",
      "https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffprobe.zip",
      "fcbe839537485eaee7a7a8bc5cbc0f90d53617e80943e8a5b2e31cb851197ea6",
      28317701,
      "ffprobe",
      ["https://ffmpeg.martin-riedl.de/"],
      "Martin Riedl signed Apple Silicon build; preserve upstream signature and release configuration",
    ),
    standaloneYtDlp(
      "macos-arm64",
      "yt-dlp_macos.zip",
      "20d98fa608998eff87d1d35a6e9fb65e4b874639a6cc89addc19da3becde3ef1",
      54165284,
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
