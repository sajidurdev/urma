import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../../src/config.js";
import { formatDoctorReport, runDoctor } from "../../src/cli/doctor.js";

test("doctor does not create or migrate storage while diagnosing", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "urma-doctor-"));
  const dataDir = path.join(directory, "data");
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const report = await runDoctor(
    loadConfig({
      URMA_DATA_DIR: dataDir,
      URMA_FFMPEG: process.execPath,
      URMA_FFPROBE: process.execPath,
      URMA_YTDLP: process.execPath,
      URMA_LOCAL_ROOTS: "",
    }),
  );

  await assert.rejects(access(dataDir));
  assert.deepEqual(
    report.checks.map((check) => check.name),
    [
      "Urma",
      "Node",
      "SQLite",
      "FTS5",
      "ffmpeg",
      "ffprobe",
      "yt-dlp",
      "yt-dlp JS",
      "Storage",
      "Database",
      "Blob/cache",
      "Local roots",
      "Frame schedules",
    ],
  );
  assert.equal(formatDoctorReport(report).startsWith("Urma Doctor\n\n"), true);
  assert.match(formatDoctorReport(report), /Not ready\.$/u);
});

test("doctor gives concise platform guidance for missing prerequisites", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "urma-doctor-missing-"),
  );
  const missing = (name: string) => path.join(directory, name);
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const report = await runDoctor(
    loadConfig({
      URMA_DATA_DIR: path.join(directory, "data"),
      URMA_FFMPEG: missing("missing-ffmpeg"),
      URMA_FFPROBE: missing("missing-ffprobe"),
      URMA_YTDLP: missing("missing-yt-dlp"),
      URMA_LOCAL_ROOTS: "",
    }),
  );
  const formatted = formatDoctorReport(report);
  assert.equal(report.ok, false);
  assert.match(formatted, /✗ ffmpeg\s+not found/u);
  assert.match(formatted, /✗ ffprobe\s+not found/u);
  assert.match(formatted, /✗ yt-dlp\s+not found/u);
  assert.match(formatted, /Install FFmpeg:/u);
  assert.match(formatted, /Install yt-dlp:/u);
  assert.match(formatted, /Official docs:/u);
  assert.doesNotMatch(formatted, /Deno|EJS/u);
  assert.match(formatted, /Not ready\.$/u);
});

test("doctor distinguishes a present but unusable executable", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "urma-doctor-unusable-"),
  );
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const report = await runDoctor(
    loadConfig({
      URMA_DATA_DIR: path.join(directory, "data"),
      URMA_FFMPEG: process.execPath,
      URMA_FFPROBE: process.execPath,
      URMA_YTDLP: process.execPath,
      URMA_LOCAL_ROOTS: "",
    }),
  );
  for (const name of ["ffmpeg", "ffprobe", "yt-dlp"]) {
    const check = report.checks.find((item) => item.name === name);
    assert(check);
    assert.match(check.detail, /present but unusable/u);
  }
});

test("doctor rejects obsolete pre-launch database schemas instead of calling them usable", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "urma-doctor-schema-"),
  );
  const dataDir = path.join(directory, "data");
  await mkdir(dataDir);
  const database = new DatabaseSync(path.join(dataDir, "urma.db"));
  database.exec(
    "CREATE TABLE schema_meta (version INTEGER NOT NULL); INSERT INTO schema_meta(version) VALUES(2);",
  );
  database.close();
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const report = await runDoctor(
    loadConfig({
      URMA_DATA_DIR: dataDir,
      URMA_FFMPEG: process.execPath,
      URMA_FFPROBE: process.execPath,
      URMA_YTDLP: process.execPath,
      URMA_LOCAL_ROOTS: "",
    }),
  );
  const check = report.checks.find((item) => item.name === "Database");
  assert(check);
  assert.equal(check.status, "fail");
  assert.match(
    check.detail,
    /unsupported pre-launch schema v2.*reacquire evidence/u,
  );
});
