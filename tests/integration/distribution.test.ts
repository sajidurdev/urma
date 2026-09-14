import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { deflateRawSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readActive } from "../../src/distribution/active.js";
import { setup } from "../../src/distribution/installer.js";
import { RELEASE_MANIFESTS, type ArtifactSpec, type TargetReleaseManifest } from "../../src/distribution/manifest.js";
import { detectTargetPlatform } from "../../src/distribution/platform.js";
import { distributionPaths } from "../../src/distribution/paths.js";
import type { QualificationContext } from "../../src/distribution/qualification.js";

function crc32(buffer: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries: readonly { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const compressed = deflateRawSync(entry.data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(entry.data), 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local, compressed);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(entry.data), 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length + compressed.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

function fakeArtifact(artifact: ArtifactSpec, archive: Buffer): ArtifactSpec {
  const sha256 = createHash("sha256").update(archive).digest("hex");
  return {
    ...artifact,
    url: `https://fixtures.invalid/${artifact.kind}/${artifact.upstreamRelease}/${sha256}.zip`,
    archiveFormat: "zip",
    archiveBytes: archive.length,
    archiveSha256: sha256,
  };
}

function makeFixtureManifest(): Readonly<{ manifest: TargetReleaseManifest; archives: ReadonlyMap<string, Buffer> }> {
  const target = detectTargetPlatform();
  const original = RELEASE_MANIFESTS[target];
  const originals = [original.ffmpeg, original.ffprobe, original.ytdlp];
  const initial = new Map<string, Buffer>();
  for (const artifact of originals) {
    const key = `${artifact.url}\0${artifact.archiveSha256}`;
    if (initial.has(key)) continue;
    const names = originals.filter((item) => `${item.url}\0${item.archiveSha256}` === key).flatMap((item) => item.expectedFiles);
    initial.set(key, zip([...new Set(names)].map((name) => ({ name, data: Buffer.from(`${artifact.kind}:${name}`) }))));
  }
  const replacement = originals.map((artifact) => fakeArtifact(artifact, initial.get(`${artifact.url}\0${artifact.archiveSha256}`)!));
  const manifest: TargetReleaseManifest = { ...original, ffmpeg: replacement[0]!, ffprobe: { ...replacement[1]!, kind: "ffprobe" }, ytdlp: replacement[2]! };
  const archives = new Map<string, Buffer>();
  for (let index = 0; index < originals.length; index += 1) {
    const artifact = replacement[index]!;
    archives.set(artifact.url, initial.get(`${originals[index]!.url}\0${originals[index]!.archiveSha256}`)!);
  }
  return { manifest, archives };
}

async function runLauncher(
  root: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const launcher = path.join(root, "launcher-v1.mjs");
  const child = spawn(process.execPath, [launcher, ...args], {
    cwd: root,
    env: { ...process.env, ...environment, URMA_DATA_DIR: root },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  await once(child, "close");
  return { status: child.exitCode, stdout, stderr };
}

function setupOptions(
  root: string,
  fixture: ReturnType<typeof makeFixtureManifest>,
  overrides: Partial<Parameters<typeof setup>[0]> = {},
): Parameters<typeof setup>[0] {
  return {
    dataRoot: root,
    manifest: fixture.manifest,
    minimumFreeBytes: 1,
    downloadArtifact: async (artifact, destination) => {
      await writeFile(destination, fixture.archives.get(artifact.url)!);
    },
    qualifyNative: async (_context: QualificationContext) => ({ fixtureVersion: "fake", checks: ["fake-native"] }),
    probeVersions: async () => ({ ffmpegVersion: "ffmpeg fake", ffprobeVersion: "ffprobe fake", ytdlpVersion: "2026.08.19" }),
    mcpSmoke: async () => ["fake-mcp"],
    ...overrides,
  };
}

test("setup publishes an immutable generation, starts through the persistent launcher, and rolls back locally", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "urma setup spaces-"));
  const root = path.join(parent, "Daten ユニコード", "Urma");
  const fixture = makeFixtureManifest();
  t.after(async () => await rm(parent, { recursive: true, force: true }));
  const first = await setup(setupOptions(root, fixture));
  const paths = distributionPaths(root);
  const activeFirst = await readActive(paths, { allowMissing: false });
  assert(activeFirst);
  assert.equal(first.runtimeInstallation, "healthy");
  assert.equal(first.hostRegistration.status, "not-requested");
  assert.equal((await runLauncher(root, ["--version"], { PATH: "" })).stdout, "0.1.0\n");
  const firstGeneration = path.join(root, "installs", activeFirst.active);
  assert.match(await readFile(path.join(firstGeneration, "receipt.json"), "utf8"), /fake-mcp/u);
  assert.match(await readFile(path.join(firstGeneration, "licenses", "THIRD-PARTY-NOTICES.txt"), "utf8"), /third-party distribution notices/iu);

  const second = await setup(setupOptions(root, fixture));
  const activeSecond = await readActive(paths, { allowMissing: false });
  assert(activeSecond);
  assert.notEqual(activeSecond.active, activeFirst.active);
  assert.equal(activeSecond.previous, activeFirst.active);
  assert.equal(second.generation, activeFirst.generation + 1);
  const secondReceipt = JSON.parse(await readFile(path.join(root, "installs", activeSecond.active, "receipt.json"), "utf8")) as { tools: { ffmpeg: { relativePath: string } } };
  const secondFfmpeg = path.join(root, "installs", activeSecond.active, ...secondReceipt.tools.ffmpeg.relativePath.split("/"));
  const secondFfmpegBytes = await readFile(secondFfmpeg);
  await writeFile(secondFfmpeg, Buffer.concat([secondFfmpegBytes, Buffer.from("tampered-active-generation")]));
  const rollback = await runLauncher(root, ["rollback"]);
  assert.equal(rollback.status, 0, rollback.stderr);
  const afterRollback = await readActive(paths, { allowMissing: false });
  assert(afterRollback);
  assert.equal(afterRollback.active, activeFirst.active);
  assert.equal(afterRollback.previous, activeSecond.active);
  const refusedRollback = await runLauncher(root, ["rollback"]);
  assert.notEqual(refusedRollback.status, 0);
  assert.match(refusedRollback.stderr, /rollback integrity verification/u);
  assert.deepEqual(await readActive(paths, { allowMissing: false }), afterRollback);
});

test("failed setup and host registration failure do not invalidate the selected healthy generation", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "urma setup failure-"));
  const root = path.join(parent, "root");
  const fixture = makeFixtureManifest();
  t.after(async () => await rm(parent, { recursive: true, force: true }));
  await setup(setupOptions(root, fixture));
  const paths = distributionPaths(root);
  const before = await readActive(paths, { allowMissing: false });
  assert(before);
  await assert.rejects(
    setup(setupOptions(root, fixture, { qualifyNative: async () => { throw new Error("injected qualification interruption"); } })),
    /injected qualification interruption/u,
  );
  assert.deepEqual(await readActive(paths, { allowMissing: false }), before);
  await assert.rejects(
    setup(setupOptions(root, fixture, {
      downloadArtifact: async (_artifact, destination) => {
        await writeFile(destination, "partial artifact");
        throw new Error("injected full-write failure");
      },
    })),
    /injected full-write failure/u,
  );
  assert.deepEqual(await readActive(paths, { allowMissing: false }), before);
  await assert.rejects(
    setup(setupOptions(root, fixture, {
      onPhase: async (phase) => {
        if (phase === "published") throw new Error("injected publish interruption");
      },
    })),
    /injected publish interruption/u,
  );
  assert.deepEqual(await readActive(paths, { allowMissing: false }), before);
  const result = await setup(setupOptions(root, fixture, {
    client: "generic",
    clientConfig: root,
  }));
  assert.equal(result.runtimeInstallation, "healthy");
  assert.equal(result.hostRegistration.status, "failure");
  const after = await readActive(paths, { allowMissing: false });
  assert(after);
  assert.notEqual(after.active, before.active);
});

test("ACTIVE recovery, missing generations, and tool corruption fail closed", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "urma recovery integrity-"));
  const root = path.join(parent, "root");
  const fixture = makeFixtureManifest();
  t.after(async () => await rm(parent, { recursive: true, force: true }));
  await setup(setupOptions(root, fixture));
  await setup(setupOptions(root, fixture));
  const paths = distributionPaths(root);
  const selected = await readActive(paths, { allowMissing: false });
  assert(selected);
  const backup = JSON.parse(await readFile(paths.backup, "utf8")) as { active: string };
  await writeFile(paths.active, "{ malformed");
  const recovered = await runLauncher(root, ["recover"]);
  assert.equal(recovered.status, 0, recovered.stderr);
  const afterRecovery = await readActive(paths, { allowMissing: false });
  assert(afterRecovery);
  assert.equal(afterRecovery.active, backup.active);

  const receipt = JSON.parse(await readFile(path.join(root, "installs", afterRecovery.active, "receipt.json"), "utf8")) as { tools: { ffmpeg: { relativePath: string } } };
  const ffmpeg = path.join(root, "installs", afterRecovery.active, ...receipt.tools.ffmpeg.relativePath.split("/"));
  const original = await readFile(ffmpeg);
  try {
    await writeFile(ffmpeg, Buffer.concat([original, Buffer.from("corruption")]));
    const doctor = await runLauncher(root, ["doctor"]);
    assert.notEqual(doctor.status, 0);
    assert.match(`${doctor.stdout}\n${doctor.stderr}`, /fresh integrity verification/iu);
  } finally {
    await writeFile(ffmpeg, original);
  }

  await rm(path.join(root, "installs", afterRecovery.active), { recursive: true, force: true });
  const missing = await runLauncher(root, ["--version"]);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /is missing|rerun setup/iu);
});

test("generic host registration preserves unrelated configuration and uses absolute launcher paths", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "urma host registration-"));
  const root = path.join(parent, "root");
  const configFile = path.join(parent, "client.json");
  const fixture = makeFixtureManifest();
  t.after(async () => await rm(parent, { recursive: true, force: true }));
  await writeFile(configFile, JSON.stringify({ unrelated: { keep: true }, mcpServers: { other: { command: "other" } } }));
  const result = await setup(setupOptions(root, fixture, { client: "generic", clientConfig: configFile }));
  assert.equal(result.hostRegistration.status, "success");
  const config = JSON.parse(await readFile(configFile, "utf8")) as { unrelated: { keep: boolean }; mcpServers: { urma: { command: string; args: string[]; env: { URMA_DATA_DIR: string } } } };
  assert.equal(config.unrelated.keep, true);
  assert.equal(config.mcpServers.urma.command, process.execPath);
  assert.equal(config.mcpServers.urma.args[0], path.join(root, "launcher-v1.mjs"));
  assert.equal(config.mcpServers.urma.env.URMA_DATA_DIR, root);
});

test("concurrent setup attempts serialize on one installation lock", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "urma concurrent setup-"));
  const root = path.join(parent, "root");
  const fixture = makeFixtureManifest();
  t.after(async () => await rm(parent, { recursive: true, force: true }));
  let reached = false;
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const firstReached = new Promise<void>((resolve) => {
    const poll = () => {
      if (reached) resolve();
      else setTimeout(poll, 1);
    };
    poll();
  });
  const first = setup(setupOptions(root, fixture, {
    onPhase: async (phase) => {
      if (phase === "runtime-copied") {
        reached = true;
        await held;
      }
    },
  }));
  await firstReached;
  await assert.rejects(
    setup(setupOptions(root, fixture)),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "INSTALLATION_LOCKED",
  );
  release?.();
  await first;
});

test("rollback refuses incompatible persistent state without changing ACTIVE", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "urma rollback state-"));
  const root = path.join(parent, "root");
  const fixture = makeFixtureManifest();
  t.after(async () => await rm(parent, { recursive: true, force: true }));
  await setup(setupOptions(root, fixture));
  await setup(setupOptions(root, fixture));
  const paths = distributionPaths(root);
  const before = await readActive(paths, { allowMissing: false });
  assert(before);
  const db = new DatabaseSync(path.join(root, "urma.db"));
  db.exec("CREATE TABLE schema_meta (version INTEGER NOT NULL); INSERT INTO schema_meta(version) VALUES(3);");
  db.close();
  const result = await runLauncher(root, ["rollback"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /incompatible/u);
  assert.deepEqual(await readActive(paths, { allowMissing: false }), before);
});
