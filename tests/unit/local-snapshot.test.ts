import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../../src/config.js";
import {
  localSnapshotForBundle,
  localSnapshotRevision,
  parseLocalSnapshot,
  pinLocalBundle,
  resolveLocalBundle,
} from "../../src/sources/local.js";
import { BlobStore } from "../../src/store/blob-store.js";

test("local snapshot revisions distinguish same-size replacements and pin sidecar absence", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "urma-local-snapshot-"));
  const root = path.join(directory, "root");
  await mkdir(root);
  const video = path.join(root, "video.mp4");
  await writeFile(video, Buffer.alloc(128, 0x41));
  const blobs = new BlobStore(path.join(directory, "data", "blobs"));
  await blobs.initialize();
  const config = loadConfig({
    URMA_DATA_DIR: path.join(directory, "data"),
    URMA_LOCAL_ROOTS: root,
  });
  t.after(() => rm(directory, { recursive: true, force: true }));

  const firstBundle = await resolveLocalBundle(video, config);
  const firstPinned = await pinLocalBundle(firstBundle, blobs);
  const firstRevision = localSnapshotRevision(firstPinned);
  const firstSnapshot = localSnapshotForBundle(firstPinned);
  const firstBytes = await readFile(firstPinned.video.absolutePath);
  const before = await stat(video);

  await writeFile(video, Buffer.alloc(128, 0x42));
  await utimes(video, before.atime, before.mtime);
  const after = await stat(video);
  assert.equal(after.size, before.size);
  assert.equal(Math.round(after.mtimeMs), Math.round(before.mtimeMs));

  const secondBundle = await resolveLocalBundle(video, config);
  const secondPinned = await pinLocalBundle(secondBundle, blobs);
  assert.notEqual(localSnapshotRevision(secondPinned), firstRevision);
  assert.deepEqual(
    await readFile(firstPinned.video.absolutePath),
    firstBytes,
  );
  assert.notDeepEqual(
    await readFile(secondPinned.video.absolutePath),
    firstBytes,
  );
  assert.equal(parseLocalSnapshot(firstSnapshot)?.caption, null);

  await writeFile(path.join(root, "video.vtt"), "WEBVTT\n");
  const withCaption = await pinLocalBundle(
    await resolveLocalBundle(video, config),
    blobs,
  );
  assert(parseLocalSnapshot(localSnapshotForBundle(withCaption))?.caption);
});
