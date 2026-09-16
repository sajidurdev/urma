import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../../src/config.js";
import { extractArchive } from "../../src/distribution/archive.js";
import { commitActive, parseActiveSelection, readActive, readActiveBackup, selectionForUpdate } from "../../src/distribution/active.js";
import { downloadAndVerifyArtifact } from "../../src/distribution/download.js";
import { acquireInstallationLock } from "../../src/distribution/lock.js";
import { RELEASE_MANIFESTS } from "../../src/distribution/manifest.js";
import { chooseDataRoot, distributionPaths } from "../../src/distribution/paths.js";
import { detectTargetPlatform } from "../../src/distribution/platform.js";
import { parseFfmpegBuildConfiguration } from "../../src/distribution/qualification.js";
import { hermeticYtDlpArgs } from "../../src/subprocess/ytdlp.js";
import { UrmaError } from "../../src/core/errors.js";
import type { ProcessResult } from "../../src/subprocess/runner.js";

function crc32(buffer: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

type ZipItem = Readonly<{ name: string; data?: Buffer; method?: "store" | "deflate"; symlink?: boolean }>;

function zip(items: readonly ZipItem[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const item of items) {
    const name = Buffer.from(item.name, "utf8");
    const data = item.data ?? Buffer.alloc(0);
    const method = item.method === "store" ? 0 : 8;
    const compressed = method === 0 ? data : deflateRawSync(data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local, compressed);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(item.symlink ? 0xa0000000 : 0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length + compressed.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(items.length, 8);
  end.writeUInt16LE(items.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

function tar(items: readonly { name: string; data: Buffer }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const item of items) {
    const header = Buffer.alloc(512);
    header.write(item.name, 0, 100, "utf8");
    header.write("0000644\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write(`${item.data.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    header.write("00000000000\0", 136, 12, "ascii");
    header[156] = 0x30;
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    header.fill(0x20, 148, 156);
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    blocks.push(header, item.data);
    const padding = (512 - (item.data.length % 512)) % 512;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

async function tempDirectory(prefix: string): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), prefix));
}

test("target manifest is explicit, pinned, and provider-agnostic across six targets", () => {
  const targets = Object.keys(RELEASE_MANIFESTS);
  assert.deepEqual(targets.sort(), [
    "linux-arm64-glibc",
    "linux-x64-glibc",
    "macos-arm64",
    "macos-x64",
    "windows-arm64",
    "windows-x64",
  ]);
  for (const manifest of Object.values(RELEASE_MANIFESTS)) {
    for (const artifact of [manifest.ffmpeg, manifest.ffprobe, manifest.ytdlp]) {
      assert.match(artifact.url, /^https:\/\//u);
      assert.doesNotMatch(artifact.url, /\/latest(?:\/|$)/iu);
      assert.match(artifact.archiveSha256, /^[a-f0-9]{64}$/u);
      assert.equal(artifact.licensing.nonfree, false);
      assert.equal(artifact.licensing.redistributable, true);
      assert.ok(artifact.archiveBytes > 0);
    }
    assert.equal(manifest.ffmpeg.upstreamVersion, manifest.ffprobe.upstreamVersion);
    assert.equal(manifest.ffmpeg.provider, manifest.ffprobe.provider);
    assert.equal(manifest.ffmpeg.upstreamRelease, manifest.ffprobe.upstreamRelease);
    assert.equal(manifest.ytdlpProfile.version, manifest.ytdlp.upstreamVersion);
    assert.equal(manifest.ytdlpProfile.flags.includes("--no-exec"), true);
    for (const flag of manifest.ytdlpProfile.unsupportedFlags) assert.equal(manifest.ytdlpProfile.flags.includes(flag), false);
  }
  assert.equal(RELEASE_MANIFESTS["windows-arm64"].ytdlp.executable, "yt-dlp_arm64.exe");
  assert.equal(RELEASE_MANIFESTS["linux-x64-glibc"].ytdlp.executable, "yt-dlp_linux");
  assert.equal(RELEASE_MANIFESTS["linux-arm64-glibc"].ytdlp.executable, "yt-dlp_linux_aarch64");
  assert.equal(RELEASE_MANIFESTS["macos-x64"].ytdlp.executable, "yt-dlp_macos");
  assert.equal(RELEASE_MANIFESTS["macos-arm64"].ytdlp.executable, "yt-dlp_macos");
});

test("platform detection qualifies executing architecture and rejects musl-like Linux", () => {
  assert.equal(detectTargetPlatform({ platform: "win32", arch: "x64" }), "windows-x64");
  assert.equal(detectTargetPlatform({ platform: "darwin", arch: "arm64" }), "macos-arm64");
  assert.equal(detectTargetPlatform({ platform: "linux", arch: "arm64", glibcVersion: "2.35" }), "linux-arm64-glibc");
  assert.throws(
    () => detectTargetPlatform({ platform: "linux", arch: "x64", glibcVersion: null }),
    (error: unknown) => error instanceof UrmaError && error.code === "UNSUPPORTED_PLATFORM",
  );
});

test("persistent paths use the explicit override and reject UNC data roots", () => {
  const override = path.join(os.tmpdir(), "urma-space-ユニコード");
  assert.equal(chooseDataRoot({ URMA_DATA_DIR: override }), path.resolve(override));
  assert.throws(() => distributionPaths("\\\\server\\share\\Urma"), (error: unknown) => error instanceof UrmaError && error.code === "UNSUPPORTED_FILESYSTEM");
});

test("persistent runtime configuration never falls back to PATH when launcher metadata is incomplete", () => {
  assert.throws(
    () => loadConfig({ URMA_RUNTIME_ROOT_V1: path.join(os.tmpdir(), "urma") }),
    /requires both the launcher root and selected generation metadata/u,
  );
});

test("ACTIVE selection is strict and commits through a backup plus atomic next file", async (t) => {
  const root = await tempDirectory("urma-active-");
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const paths = distributionPaths(root);
  const first = selectionForUpdate(null, "install-old");
  await commitActive(paths, first);
  assert.deepEqual(await readActive(paths), first);
  const second = selectionForUpdate(first, "install-new");
  await commitActive(paths, second);
  assert.deepEqual(await readActive(paths), second);
  assert.deepEqual(await readActiveBackup(paths), first);
  await assert.rejects(readFile(paths.next), /ENOENT/u);
  await writeFile(paths.active, "{ malformed");
  const repaired = selectionForUpdate(second, "install-repaired");
  await commitActive(paths, repaired, { preserveBackup: false });
  assert.deepEqual(await readActiveBackup(paths), first);
  assert.throws(() => parseActiveSelection({ schema: 1, generation: 1, active: "..", previous: null }), (error: unknown) => error instanceof UrmaError && error.code === "INSTALLATION_CORRUPT");
  assert.throws(() => parseActiveSelection({ schema: 1, generation: 1, active: "a", previous: "A" }), (error: unknown) => error instanceof UrmaError && error.code === "INSTALLATION_CORRUPT");
});

test("installation lock serializes writers and conservatively reclaims a dead owner", async (t) => {
  const root = await tempDirectory("urma-lock-");
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const paths = distributionPaths(root);
  const first = await acquireInstallationLock(paths);
  await assert.rejects(acquireInstallationLock(paths), (error: unknown) => error instanceof UrmaError && error.code === "INSTALLATION_LOCKED");
  await first.release();
  await mkdir(path.dirname(paths.lock), { recursive: true });
  const exited = spawn(process.execPath, ["-e", "process.exit(0)"], { windowsHide: true, stdio: "ignore" });
  const stalePid = exited.pid;
  assert.equal(typeof stalePid, "number");
  await once(exited, "close");
  await writeFile(paths.lock, JSON.stringify({ schema: 1, pid: stalePid, createdAt: new Date().toISOString(), token: "stale-token-123456789" }));
  const reclaimed = await acquireInstallationLock(paths);
  await reclaimed.release();
});

test("installation lock refuses a non-directory state path before writing outside the root", async (t) => {
  const root = await tempDirectory("urma-lock-path-");
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const paths = distributionPaths(root);
  await writeFile(paths.state, "not a directory");
  await assert.rejects(
    acquireInstallationLock(paths),
    (error: unknown) => error instanceof UrmaError && error.code === "UNSUPPORTED_FILESYSTEM",
  );
  await assert.rejects(
    readFile(paths.lock),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR"),
  );
});

test("safe ZIP extraction rejects traversal, duplicates, case collisions, symlinks, and corrupt data", async (t) => {
  const root = await tempDirectory("urma-zip-");
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const goodArchive = path.join(root, "good.zip");
  await writeFile(goodArchive, zip([{ name: "bin/tool", data: Buffer.from("tool"), method: "deflate" }]));
  const goodDestination = path.join(root, "good");
  assert.deepEqual(await extractArchive(goodArchive, "zip", goodDestination), ["bin/tool"]);
  assert.equal(await readFile(path.join(goodDestination, "bin/tool"), "utf8"), "tool");
  const emptyArchive = path.join(root, "empty-deflated.zip");
  await writeFile(emptyArchive, zip([{ name: "_internal/certifi/py.typed", data: Buffer.alloc(0), method: "deflate" }]));
  const emptyDestination = path.join(root, "empty-deflated");
  assert.deepEqual(await extractArchive(emptyArchive, "zip", emptyDestination), ["_internal/certifi/py.typed"]);
  assert.equal((await readFile(path.join(emptyDestination, "_internal/certifi/py.typed"))).length, 0);
  const occupiedDestination = path.join(root, "occupied");
  await mkdir(occupiedDestination, { recursive: true });
  await writeFile(path.join(occupiedDestination, "sentinel"), "keep");
  await assert.rejects(extractArchive(goodArchive, "zip", occupiedDestination), (error: unknown) => error instanceof UrmaError && error.code === "ARCHIVE_INVALID");
  assert.equal(await readFile(path.join(occupiedDestination, "sentinel"), "utf8"), "keep");
  const cases: readonly [string, readonly ZipItem[]][] = [
    ["traversal", [{ name: "../outside", data: Buffer.from("x") }]],
    ["absolute", [{ name: "/outside", data: Buffer.from("x") }]],
    ["drive", [{ name: "C:outside", data: Buffer.from("x") }]],
    ["duplicate", [{ name: "a", data: Buffer.from("x") }, { name: "a", data: Buffer.from("y") }]],
    ["case", [{ name: "A", data: Buffer.from("x") }, { name: "a", data: Buffer.from("y") }]],
    ["reserved", [{ name: "CON.txt", data: Buffer.from("x") }]],
    ["symlink", [{ name: "link", data: Buffer.from("target"), symlink: true }]],
  ];
  for (const [label, item] of cases) {
    const archive = path.join(root, `${label}.zip`);
    const destination = path.join(root, label);
    await writeFile(archive, zip(item));
    await assert.rejects(extractArchive(archive, "zip", destination), (error: unknown) => error instanceof UrmaError && error.code === "ARCHIVE_INVALID");
    await assert.rejects(access(destination));
  }
  const corrupt = path.join(root, "corrupt.zip");
  const corruptBytes = zip([{ name: "file", data: Buffer.from("valid") }]);
  const corruptIndex = corruptBytes.length - 22 - 5;
  corruptBytes[corruptIndex] = (corruptBytes[corruptIndex] ?? 0) ^ 0xff;
  await writeFile(corrupt, corruptBytes);
  await assert.rejects(extractArchive(corrupt, "zip", path.join(root, "corrupt")), (error: unknown) => error instanceof UrmaError && error.code === "ARCHIVE_INVALID");
});

test("safe XZ/TAR extraction uses the portable decoder and preserves bounded files", async (t) => {
  const root = await tempDirectory("urma-xz-");
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const packageName: string = "lzma-wasm";
  const lzma = await import(packageName) as { initWasm: () => Promise<unknown>; compress: (value: Uint8Array, options: { format: "xz" }) => Uint8Array };
  await lzma.initWasm();
  const archive = path.join(root, "fixture.tar.xz");
  await writeFile(archive, lzma.compress(new Uint8Array(tar([{ name: "bin/tool", data: Buffer.from("tool") }])), { format: "xz" }));
  const destination = path.join(root, "extracted");
  assert.deepEqual(await extractArchive(archive, "tar.xz", destination), ["bin/tool"]);
  assert.equal(await readFile(path.join(destination, "bin/tool"), "utf8"), "tool");
});

test("artifact download verifies exact size/hash and removes failed partial files", async (t) => {
  const root = await tempDirectory("urma-download-");
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const payload = Buffer.from("not-a-qualified-archive");
  const base = RELEASE_MANIFESTS[detectTargetPlatform()].ytdlp;
  const artifact = {
    ...base,
    url: "https://fixtures.invalid/pinned/yt-dlp.zip",
    archiveBytes: payload.length,
    archiveSha256: "0".repeat(64),
  };
  const destination = path.join(root, "artifact.zip");
  await assert.rejects(
    downloadAndVerifyArtifact(artifact, destination, {
      fetchImpl: async () => new Response(payload, { status: 200, headers: { "content-length": String(payload.length) } }),
    }),
    (error: unknown) => error instanceof UrmaError && error.code === "ARTIFACT_HASH_MISMATCH",
  );
  await assert.rejects(access(destination));
  const valid = {
    ...artifact,
    archiveSha256: createHash("sha256").update(payload).digest("hex"),
  };
  await downloadAndVerifyArtifact(valid, destination, {
    fetchImpl: async () => new Response(payload, { status: 200, headers: { "content-length": String(payload.length) } }),
  });
  assert.equal(await readFile(destination, "utf8"), payload.toString("utf8"));
  const chunkedDestination = path.join(root, "chunked-artifact.zip");
  await downloadAndVerifyArtifact(valid, chunkedDestination, {
    fetchImpl: async () => new Response(payload, { status: 200 }),
  });
  assert.equal(await readFile(chunkedDestination, "utf8"), payload.toString("utf8"));
});

test("yt-dlp profile binds absolute Node and does not claim unsupported --no-netrc", () => {
  const args = hermeticYtDlpArgs(["--help"], process.execPath, undefined, ["--ffmpeg-location", path.join(os.tmpdir(), "ffmpeg")]);
  assert.ok(args.includes("--ignore-config"));
  assert.ok(args.includes("--no-plugin-dirs"));
  assert.ok(args.includes("--no-remote-components"));
  assert.ok(args.includes(`node:${process.execPath}`));
  assert.ok(args.includes("--ffmpeg-location"));
  assert.equal(args.includes("--no-netrc"), false);
});

test("FFmpeg build configuration is required and rejects nonfree profiles", () => {
  const result = (text: string): ProcessResult => ({
    executable: "ffmpeg",
    args: ["-buildconf"],
    code: 0,
    stdout: Buffer.from(text),
    stderr: Buffer.alloc(0),
    wallMs: 1,
  });
  assert.match(parseFfmpegBuildConfiguration(result("\n  configuration:\n    --enable-gpl\n\nExiting with exit code 0\n"), "ffmpeg"), /--enable-gpl/u);
  assert.throws(() => parseFfmpegBuildConfiguration(result("ffmpeg 9.0.1\n"), "ffmpeg"), /did not expose/u);
  assert.throws(() => parseFfmpegBuildConfiguration(result("configuration:\n  --enable-nonfree\n"), "ffmpeg"), /--enable-nonfree/u);
});
