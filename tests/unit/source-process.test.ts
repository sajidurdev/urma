import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  remoteSourceRef,
  type SourceRef,
} from "../../src/core/ids.js";
import { loadConfig } from "../../src/config.js";
import { UrmaError } from "../../src/core/errors.js";
import {
  resolveLocalBundle,
  resolveLocalPath,
} from "../../src/sources/local.js";
import { parseYouTubeUrl } from "../../src/sources/youtube.js";
import { redactModelText, redactText } from "../../src/subprocess/redaction.js";
import { Ffmpeg } from "../../src/subprocess/ffmpeg.js";
import { Ffprobe } from "../../src/subprocess/ffprobe.js";
import { remoteMediaInputArgs } from "../../src/subprocess/remote-media.js";
import {
  allowlistedEnvironment,
  runChecked,
  runProcess,
} from "../../src/subprocess/runner.js";
import { hermeticYtDlpArgs, YtDlp } from "../../src/subprocess/ytdlp.js";

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "urma-source-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const testRemoteContext = {
  safeProxy: {
    start: async () => "http://127.0.0.1:41234",
  },
} as const;

test("supported YouTube URL forms canonicalize to the provider video ID", () => {
  const urls = [
    "https://www.youtube.com/watch?v=yP0axVHdP-U&t=2",
    "https://youtu.be/yP0axVHdP-U",
    "https://youtube.com/shorts/yP0axVHdP-U",
    "https://m.youtube.com/live/yP0axVHdP-U",
  ];
  assert.equal(
    new Set(urls.map((url) => parseYouTubeUrl(url).sourceRef)).size,
    1,
  );
});
test("malformed and non-YouTube remote sources retain explicit failure codes before downloader use", () => {
  assert.throws(
    () => parseYouTubeUrl("https://example.com/watch?v=yP0axVHdP-U"),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "UNSUPPORTED_SOURCE",
  );
  assert.throws(
    () => parseYouTubeUrl("https://youtube.com/playlist?list=abc"),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "INVALID_SOURCE",
  );
});
test("non-HTTP URL schemes cannot fall through to local-path resolution", () => {
  assert.throws(
    () => parseYouTubeUrl("ftp://example.test/video.mp4"),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "UNSUPPORTED_SOURCE",
  );
});

test("local roots reject outside files and symlink escapes while revision follows metadata", async (t) => {
  const directory = await fixture(t);
  const root = path.join(directory, "root");
  const outside = path.join(directory, "outside");
  await mkdir(root);
  await mkdir(outside);
  const inside = path.join(root, "video.mp4");
  const escaped = path.join(outside, "secret.mp4");
  await writeFile(inside, "one");
  await writeFile(escaped, "secret");
  const config = { localRoots: [root], allowUnc: false };
  const first = await resolveLocalPath(inside, config);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await writeFile(inside, "two-two");
  const second = await resolveLocalPath(inside, config);
  assert.notEqual(first.revision, second.revision);
  await assert.rejects(
    resolveLocalPath(escaped, config),
    /outside every configured/,
  );
  const link = path.join(root, "escape.mp4");
  try {
    await symlink(escaped, link, "file");
    await assert.rejects(
      resolveLocalPath(link, config),
      /outside every configured/,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
  }
});
test("local source identity is path-sensitive while its public handle remains opaque", async (t) => {
  const directory = await fixture(t);
  const firstPath = path.join(directory, "first.mp4");
  const secondPath = path.join(directory, "second.mp4");
  await writeFile(firstPath, "same bytes");
  await writeFile(secondPath, "same bytes");
  const first = await resolveLocalPath(firstPath, {
    localRoots: [directory],
    allowUnc: false,
  });
  const second = await resolveLocalPath(secondPath, {
    localRoots: [directory],
    allowUnc: false,
  });
  assert.notEqual(first.sourceRef, second.sourceRef);
  assert.match(first.sourceRef, /^urma:source:local:[0-9a-f]{32}$/);
  assert.equal(first.sourceRef.includes("first"), false);
  assert.equal(first.sourceRef.includes(directory), false);
});
test("local files are disabled when no roots are configured", async (t) => {
  const directory = await fixture(t);
  const file = path.join(directory, "video.mp4");
  await writeFile(file, "x");
  await assert.rejects(
    resolveLocalPath(file, { localRoots: [], allowUnc: false }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "LOCAL_SOURCE_DISABLED",
  );
});
test("local sidecar changes revision and sidecar symlink escapes are rejected", async (t) => {
  const directory = await fixture(t);
  const root = path.join(directory, "root");
  const outside = path.join(directory, "outside");
  await mkdir(root);
  await mkdir(outside);
  const video = path.join(root, "video.mp4");
  const sidecar = path.join(root, "video.vtt");
  await writeFile(video, "video");
  await writeFile(sidecar, "one");
  const first = await resolveLocalBundle(video, {
    localRoots: [root],
    allowUnc: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  await writeFile(sidecar, "two-two");
  const second = await resolveLocalBundle(video, {
    localRoots: [root],
    allowUnc: false,
  });
  assert.notEqual(first.revision, second.revision);
  const escapedVideo = path.join(root, "escaped.mp4");
  const outsideCaption = path.join(outside, "escaped.vtt");
  await writeFile(escapedVideo, "video");
  await writeFile(outsideCaption, "caption");
  try {
    await symlink(outsideCaption, path.join(root, "escaped.vtt"), "file");
    await assert.rejects(
      resolveLocalBundle(escapedVideo, { localRoots: [root], allowUnc: false }),
      /outside every configured/,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
  }
});

test("subprocess arguments are passed literally without a shell", async () => {
  const marker = "hello; echo INJECTED";
  const result = await runChecked(process.execPath, [
    "-e",
    "process.stdout.write(process.argv[1])",
    marker,
  ]);
  assert.equal(result.stdout.toString(), marker);
});
test("subprocess environments exclude credentials, proxy bypasses, and runtime hooks", () => {
  const environment = allowlistedEnvironment({
    PATH: "path",
    HTTP_PROXY: "http://proxy.invalid",
    HTTPS_PROXY: "https://proxy.invalid",
    ALL_PROXY: "socks5://proxy.invalid",
    NO_PROXY: "*",
    NODE_OPTIONS: "--require evil",
    BROWSER_PROFILE: "secret",
  });
  assert.equal(environment.PATH, "path");
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "NODE_OPTIONS", "BROWSER_PROFILE"]) {
    assert.equal(environment[key], undefined, key);
  }
});
test("yt-dlp caller options cannot override the hermetic boundary", () => {
  assert.throws(
    () => hermeticYtDlpArgs(["--proxy", "http://proxy.invalid"]),
    /controlled by Urma/u,
  );
  assert.throws(
    () => hermeticYtDlpArgs(["--cookies-from-browser", "chrome"]),
    /controlled by Urma/u,
  );
  assert.throws(
    () => hermeticYtDlpArgs(["--postprocessor-args", "FFmpeg_i:-http_proxy http://evil.invalid"]),
    /controlled by Urma/u,
  );
  assert.throws(
    () => hermeticYtDlpArgs(["--dump-pages"]),
    /controlled by Urma/u,
  );
  assert.throws(
    () => hermeticYtDlpArgs(["--netrc-cmd", "whoami"]),
    /controlled by Urma/u,
  );
  assert.throws(
    () => hermeticYtDlpArgs(["--exec-before-download", "whoami"]),
    /controlled by Urma/u,
  );
});

test("yt-dlp manifest validation selects only typed internal page output", async () => {
  const manifest = "#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nsegment.ts\n#EXT-X-ENDLIST\n";
  let captured: readonly string[] = [];
  const ytdlp = new YtDlp(
    loadConfig(),
    async (executable, args) => {
      captured = [...args];
      return {
        executable,
        args,
        code: 0,
        stdout: Buffer.from(`log line\n${Buffer.from(manifest).toString("base64")}\n`),
        stderr: Buffer.alloc(0),
        wallMs: 1,
      };
    },
    testRemoteContext,
  );
  assert.equal(
    await ytdlp.manifestText("https://cdn.example.test/manifest.m3u8"),
    manifest,
  );
  assert.equal(captured.includes("--dump-pages"), true);
  assert.equal(captured.includes("--proxy"), true);
  assert.equal(captured.includes("--write-pages"), false);
});

test("HLS acquisition leases keep the selected media-playlist URL instead of the master manifest", async () => {
  const identity = { basis: "extractor" as const, namespace: "fixture", id: "hls-video" };
  const sourceRef = remoteSourceRef(identity);
  const format = {
    id: "hls-270",
    formatId: "hls-270",
    ext: "mp4",
    protocol: "m3u8_native",
    width: 480,
    height: 270,
    fps: 30,
    videoCodec: "avc1.4D401E",
    audioCodec: "mp4a.40.2",
    estimatedBytes: null,
    rows: null,
    columns: null,
  } as const;
  const rawMetadata = {
    _type: "video",
    extractor_key: "fixture",
    id: "hls-video",
    formats: [{
      format_id: format.id,
      ext: format.ext,
      protocol: format.protocol,
      width: format.width,
      height: format.height,
      fps: format.fps,
      vcodec: format.videoCodec,
      acodec: format.audioCodec,
      url: "https://cdn.example.test/variant.m3u8",
      manifest_url: "https://cdn.example.test/master.m3u8",
    }],
  };
  const ytdlp = new YtDlp(
    loadConfig(),
    async (executable, args) => ({
      executable,
      args,
      code: 0,
      stdout: Buffer.from(JSON.stringify(rawMetadata)),
      stderr: Buffer.alloc(0),
      wallMs: 1,
    }),
    testRemoteContext,
  );
  const lease = await ytdlp.lease(
    {
      sourceRef,
      revision: "revision-a",
      canonicalLocator: "https://example.test/video",
      identity,
    },
    format,
  );
  assert.equal(lease.deliveryUrl, "https://cdn.example.test/variant.m3u8");
});

test("yt-dlp lease reacquisition permits delivery URL rotation for the pinned remote identity", async () => {
  const identity = { basis: "extractor" as const, namespace: "fixture", id: "video-a" };
  const sourceRef = remoteSourceRef(identity);
  const format = {
    id: "video",
    formatId: "video",
    ext: "mp4",
    protocol: "https",
    width: 320,
    height: 180,
    fps: 30,
    videoCodec: "h264",
    audioCodec: "aac",
    estimatedBytes: null,
    rows: null,
    columns: null,
  } as const;
  const ytdlp = new YtDlp(
    loadConfig(),
    async (executable, args) => ({
      executable,
      args,
      code: 0,
      stdout: Buffer.from(JSON.stringify({
        _type: "video",
        extractor_key: "fixture",
        id: "video-a",
        formats: [{
          format_id: "video",
          ext: "mp4",
          protocol: "https",
          width: 320,
          height: 180,
          fps: 30,
          vcodec: "h264",
          acodec: "aac",
          url: "https://cdn.example.test/rotated-delivery.mp4?token=new",
        }],
      })),
      stderr: Buffer.alloc(0),
      wallMs: 1,
    }),
    testRemoteContext,
  );
  const lease = await ytdlp.lease(
    {
      sourceRef,
      revision: "revision-a",
      canonicalLocator: "https://example.test/video",
      identity,
    },
    format,
  );
  assert.equal(
    lease.deliveryUrl,
    "https://cdn.example.test/rotated-delivery.mp4?token=new",
  );
});

test("yt-dlp lease reacquisition rejects a different remote identity before media work", async () => {
  const identity = { basis: "extractor" as const, namespace: "fixture", id: "video-a" };
  const sourceRef = remoteSourceRef(identity);
  const format = {
    id: "video",
    formatId: "video",
    ext: "mp4",
    protocol: "https",
    width: 320,
    height: 180,
    fps: 30,
    videoCodec: "h264",
    audioCodec: "aac",
    estimatedBytes: null,
    rows: null,
    columns: null,
  } as const;
  let metadataCalls = 0;
  const ytdlp = new YtDlp(
    loadConfig(),
    async (executable, args) => {
      metadataCalls += 1;
      return {
        executable,
        args,
        code: 0,
        stdout: Buffer.from(JSON.stringify({
          _type: "video",
          extractor_key: "fixture",
          id: "video-b",
          formats: [{
            format_id: "video",
            ext: "mp4",
            protocol: "https",
            width: 320,
            height: 180,
            fps: 30,
            vcodec: "h264",
            acodec: "aac",
            url: "https://cdn.example.test/other-object.mp4?token=new",
          }],
        })),
        stderr: Buffer.alloc(0),
        wallMs: 1,
      };
    },
    testRemoteContext,
  );
  await assert.rejects(
    ytdlp.lease(
      {
        sourceRef,
        revision: "revision-a",
        canonicalLocator: "https://example.test/video",
        identity,
      },
      format,
    ),
    (error: unknown) => {
      assert(error instanceof Error);
      assert.equal("code" in error ? error.code : undefined, "SOURCE_UNAVAILABLE");
      assert.equal(
        "detail" in error && typeof error.detail === "object" && error.detail !== null
          ? (error.detail as Record<string, unknown>).refreshRequired
          : undefined,
        true,
      );
      return true;
    },
  );
  assert.equal(metadataCalls, 1);
});

test("yt-dlp candidate snapshots reject non-HTTP(S) delivery locators", async () => {
  const config = loadConfig();
  const ytdlp = new YtDlp(
    config,
    async () => ({
      executable: "yt-dlp",
      args: [],
      code: 0,
      stdout: Buffer.from(JSON.stringify({
        _type: "video",
        extractor_key: "fixture",
        id: "storyboard-video",
        formats: [{
          format_id: "storyboard",
          ext: "mhtml",
          protocol: "mhtml",
          url: "file:///private/secret.mhtml",
        }],
      })),
      stderr: Buffer.alloc(0),
      wallMs: 1,
    }),
    testRemoteContext,
  );
  await assert.rejects(
    ytdlp.exactFormatSnapshot(
      {
        sourceRef: remoteSourceRef({
          basis: "extractor",
          namespace: "fixture",
          id: "storyboard-video",
        }),
        revision: "revision-a",
        canonicalLocator: "https://example.test/video",
        identity: {
          basis: "extractor",
          namespace: "fixture",
          id: "storyboard-video",
        },
      },
      {
        id: "storyboard",
        formatId: "storyboard",
        ext: "mhtml",
        protocol: "mhtml",
        width: null,
        height: null,
        fps: null,
        videoCodec: null,
        audioCodec: null,
        estimatedBytes: null,
        rows: null,
        columns: null,
      },
    ),
    /HTTP or HTTPS/u,
  );
});

test("yt-dlp metadata admission rejects multi-entry result classes explicitly", async () => {
  const config = loadConfig({ URMA_YTDLP: "yt-dlp" });
  const ytdlp = new YtDlp(config, async (executable, args) => ({
    executable,
    args,
    code: 0,
    stdout: Buffer.from(JSON.stringify({ _type: "playlist", entries: [] })),
    stderr: Buffer.alloc(0),
    wallMs: 1,
  }), testRemoteContext);
  await assert.rejects(
    ytdlp.metadata("https://example.test/collection"),
    /multi-entry|only one finite video/u,
  );
});

test("yt-dlp retries a generic Cloudflare challenge once with impersonation", async () => {
  const calls: string[][] = [];
  let attempt = 0;
  const ytdlp = new YtDlp(
    loadConfig({ URMA_YTDLP: "yt-dlp" }),
    async (executable, args) => {
      calls.push([...args]);
      attempt += 1;
      if (attempt === 1) {
        throw new UrmaError(
          "SOURCE_UNAVAILABLE",
          'yt-dlp failed: ERROR: [generic] Got HTTP Error 403 caused by Cloudflare anti-bot challenge; try again with --extractor-args "generic:impersonate"',
          { retryable: true },
        );
      }
      return {
        executable,
        args,
        code: 0,
        stdout: Buffer.from(JSON.stringify({ _type: "video", id: "generic-video" })),
        stderr: Buffer.alloc(0),
        wallMs: 1,
      };
    },
    testRemoteContext,
  );

  const info = await ytdlp.metadata("https://example.test/video");
  assert.equal(info.id, "generic-video");
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.includes("--extractor-args"), false);
  const extractorArgsIndex = calls[1]?.indexOf("--extractor-args") ?? -1;
  assert.equal(calls[1]?.[extractorArgsIndex + 1], "generic:impersonate");
  for (const flag of [
    "--ignore-config",
    "--no-config-locations",
    "--no-plugin-dirs",
    "--no-cookies",
    "--no-cookies-from-browser",
    "--no-exec",
    "--no-cache-dir",
    "--no-remote-components",
    "--no-js-runtimes",
    "--proxy",
  ]) {
    assert.equal(calls[1]?.includes(flag), true, flag);
  }
  const proxyIndex = calls[1]?.indexOf("--proxy") ?? -1;
  assert.equal(calls[1]?.[proxyIndex + 1], "http://127.0.0.1:41234");
  for (const flag of [
    "--cookies",
    "--cookies-from-browser",
    "--netrc",
    "--netrc-location",
    "--netrc-cmd",
    "--plugin-dirs",
    "--remote-components",
    "--exec",
    "--config-locations",
  ]) {
    assert.equal(calls[1]?.includes(flag), false, flag);
  }
  assert.equal(
    (calls[1]?.filter((argument) => argument.includes("http://127.0.0.1:41234")).length ?? 0) >= 4,
    true,
  );
});

test("yt-dlp does not retry a Cloudflare-looking 403 without the impersonation hint", async () => {
  let calls = 0;
  const challengeWithoutHint =
    "yt-dlp failed: ERROR: [generic] Got HTTP Error 403 caused by Cloudflare anti-bot challenge;";
  const ytdlp = new YtDlp(
    loadConfig({ URMA_YTDLP: "yt-dlp" }),
    async () => {
      calls += 1;
      throw new UrmaError("SOURCE_UNAVAILABLE", challengeWithoutHint, {
        retryable: true,
      });
    },
    testRemoteContext,
  );

  await assert.rejects(
    ytdlp.metadata("https://example.test/video"),
    (error: unknown) =>
      error instanceof UrmaError &&
      error.code === "SOURCE_UNAVAILABLE" &&
      error.message === challengeWithoutHint,
  );

  assert.equal(calls, 1);
});

test("yt-dlp does not retry unrelated generic 403 or login failures", async () => {
  const failures = [
    "yt-dlp failed: ERROR: [generic] Got HTTP Error 403: Forbidden",
    "yt-dlp failed: ERROR: [generic] Sign in to confirm access to this video",
  ];

  for (const failure of failures) {
    let calls = 0;
    const ytdlp = new YtDlp(
      loadConfig({ URMA_YTDLP: "yt-dlp" }),
      async () => {
        calls += 1;
        throw new UrmaError("SOURCE_UNAVAILABLE", failure, {
          retryable: true,
        });
      },
      testRemoteContext,
    );

    await assert.rejects(
      ytdlp.metadata("https://example.test/video"),
      (error: unknown) =>
        error instanceof UrmaError &&
        error.code === "SOURCE_UNAVAILABLE" &&
        error.message === failure,
    );

    assert.equal(calls, 1, failure);
  }
});

test("yt-dlp does not impersonate normal generic requests or provider-specific failures", async () => {
  const normalCalls: string[][] = [];
  const normal = new YtDlp(
    loadConfig({ URMA_YTDLP: "yt-dlp" }),
    async (executable, args) => {
      normalCalls.push([...args]);
      return {
        executable,
        args,
        code: 0,
        stdout: Buffer.from(JSON.stringify({ _type: "video", id: "normal-video" })),
        stderr: Buffer.alloc(0),
        wallMs: 1,
      };
    },
    testRemoteContext,
  );
  await normal.metadata("https://example.test/video");
  assert.equal(normalCalls.length, 1);
  assert.equal(normalCalls[0]?.includes("--extractor-args"), false);

  const providerCalls: string[][] = [];
  const provider = new YtDlp(
    loadConfig({ URMA_YTDLP: "yt-dlp" }),
    async (executable, args) => {
      providerCalls.push([...args]);
      throw new UrmaError(
        "SOURCE_UNAVAILABLE",
        "yt-dlp failed: ERROR: [youtube] HTTP Error 403: Forbidden",
        { retryable: true },
      );
    },
    testRemoteContext,
  );
  await assert.rejects(
    provider.metadata("https://www.youtube.com/watch?v=video-id"),
    /youtube.*403/u,
  );
  assert.equal(providerCalls.length, 1);
  assert.equal(providerCalls[0]?.includes("--extractor-args"), false);
});

test("yt-dlp retries at most once and preserves source-unavailable when impersonation is unavailable", async () => {
  const calls: string[][] = [];
  let attempt = 0;
  const ytdlp = new YtDlp(
    loadConfig({ URMA_YTDLP: "yt-dlp" }),
    async (executable, args) => {
      calls.push([...args]);
      attempt += 1;
      if (attempt === 1) {
        throw new UrmaError(
          "SOURCE_UNAVAILABLE",
          "yt-dlp failed: ERROR: [generic] Got HTTP Error 403 caused by Cloudflare anti-bot challenge; try again with --extractor-args \"generic:impersonate\"",
          { retryable: true },
        );
      }
      throw new UrmaError(
        "SOURCE_UNAVAILABLE",
        "yt-dlp failed: generic impersonation backend is unavailable",
        { retryable: true },
      );
    },
    testRemoteContext,
  );

  await assert.rejects(
    ytdlp.metadata("https://example.test/video"),
    (error: unknown) =>
      error instanceof UrmaError &&
      error.code === "SOURCE_UNAVAILABLE" &&
      /impersonation backend is unavailable/u.test(error.message),
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.[calls[1]?.indexOf("--extractor-args") + 1], "generic:impersonate");
});
test("missing subprocess dependencies retain an explicit machine-readable failure", async (t) => {
  const directory = await fixture(t);
  await assert.rejects(
    runProcess(path.join(directory, "missing-tool"), []),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "REQUIRED_BINARY_MISSING",
  );
});
test("subprocess timeout and cancellation terminate work visibly", async () => {
  await assert.rejects(
    runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      timeoutMs: 50,
    }),
    /timeout/,
  );
  const controller = new AbortController();
  const pending = runProcess(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    { timeoutMs: 5000, signal: controller.signal },
  );
  controller.abort();
  await assert.rejects(pending, /cancelled/);
});
test("timeout and cancellation terminate descendant process trees", async (t) => {
  const directory = await fixture(t);
  const childPids: number[] = [];
  t.after(() => {
    for (const pid of childPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  });
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const waitForPid = async (marker: string) => {
    for (let attempt = 0; attempt < 50; attempt++) {
      const value = await readFile(marker, "utf8").catch(() => "");
      const pid = Number(value);
      if (Number.isInteger(pid) && pid > 0) return pid;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`descendant PID marker was not written: ${marker}`);
  };
  const waitForExit = async (pid: number) => {
    for (let attempt = 0; attempt < 100 && alive(pid); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(
      alive(pid),
      false,
      `descendant process ${pid} survived tree termination`,
    );
  };
  const parentCode =
    "const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(process.argv[1],String(child.pid));setInterval(()=>{},1000);";
  const timeoutMarker = path.join(directory, "timeout.pid");
  const timed = runProcess(
    process.execPath,
    ["-e", parentCode, timeoutMarker],
    { timeoutMs: 300 },
  );
  const timeoutPid = await waitForPid(timeoutMarker);
  childPids.push(timeoutPid);
  await assert.rejects(timed, /timeout/);
  await waitForExit(timeoutPid);
  const cancelMarker = path.join(directory, "cancel.pid");
  const controller = new AbortController();
  const cancelled = runProcess(
    process.execPath,
    ["-e", parentCode, cancelMarker],
    { timeoutMs: 5000, signal: controller.signal },
  );
  const cancelPid = await waitForPid(cancelMarker);
  childPids.push(cancelPid);
  controller.abort();
  await assert.rejects(cancelled, /cancelled/);
  await waitForExit(cancelPid);
});
test("subprocess stderr is bounded and signed URLs are redacted", async () => {
  await assert.rejects(
    runProcess(
      process.execPath,
      ["-e", "process.stderr.write('x'.repeat(5000))"],
      { maxStderrBytes: 1000 },
    ),
    /safety limit/,
  );
  const output = redactText(
    "failed https://cdn.example/video?expire=1&sig=secret and https://youtube.com/watch?v=abc&token=secret",
  );
  assert(!output.includes("secret"));
  assert(!output.includes("expire"));
  const schemeLess = redactText(
    "yt-dlp failed: ?a=public&expire=1&signature=secret&tk=chain",
  );
  assert(!schemeLess.includes("secret"));
  assert(!schemeLess.includes("expire"));
  assert(schemeLess.includes("[query-redacted]"));
  const model = redactModelText(
    "ffmpeg failed for C:\\private\\root\\video.mp4 and /srv/private/video.mp4",
  );
  assert(!model.includes("private"));
  assert(model.includes("[local-path-redacted]"));
});
test("configuration uses the platform path-list delimiter without a Deno setting", () => {
  const config = loadConfig({
    URMA_LOCAL_ROOTS: ["a", "b"].join(path.delimiter),
    URMA_DATA_DIR: "data",
    URMA_DENO: "ignored",
  });
  assert.equal(config.localRoots.length, 2);
  assert.equal("deno" in config, false);
});
test("media executables resolve to explicit overrides or PATH names without PATH mutation", () => {
  const before = process.env.PATH;
  const defaults = loadConfig({});
  assert.deepEqual(
    [defaults.ffmpeg, defaults.ffprobe, defaults.ytdlp],
    ["ffmpeg", "ffprobe", "yt-dlp"],
  );
  const overrides = loadConfig({
    URMA_FFMPEG: "C:\\tools\\ffmpeg.exe",
    URMA_FFPROBE: "C:\\tools\\ffprobe.exe",
    URMA_YTDLP: "C:\\tools\\yt-dlp.exe",
  });
  assert.equal(overrides.ffmpeg, "C:\\tools\\ffmpeg.exe");
  assert.equal(overrides.ffprobe, "C:\\tools\\ffprobe.exe");
  assert.equal(overrides.ytdlp, "C:\\tools\\yt-dlp.exe");
  assert.equal(process.env.PATH, before);
});
test("remote acquisition budgets are explicit and independently configurable", () => {
  const config = loadConfig({
    URMA_DATA_DIR: "data",
    URMA_MAX_TARGETED_MEDIA_BYTES: "1048576",
    URMA_MAX_NAVIGATION_COPY_BYTES: "2097152",
    URMA_MAX_REUSABLE_EVIDENCE_MEDIA_BYTES: "3145728",
    URMA_MAX_REMOTE_ACQUISITION_WALL_MS: "4321",
  });
  const limits = config.limits as unknown as Record<string, number>;
  assert.equal(limits.maxTargetedMediaBytes, 1_048_576);
  assert.equal(limits.maxNavigationCopyBytes, 2_097_152);
  assert.equal(limits.maxReusableEvidenceMediaBytes, 3_145_728);
  assert.equal(limits.maxRemoteAcquisitionWallMs, 4321);
});
test("remote acquisition budgets reject zero and malformed configuration", () => {
  assert.throws(
    () => loadConfig({ URMA_MAX_TARGETED_MEDIA_BYTES: "0" }),
    /received "0"/,
  );
  assert.throws(
    () => loadConfig({ URMA_MAX_REMOTE_ACQUISITION_WALL_MS: "soon" }),
    /received "soon"/,
  );
});
test("yt-dlp acquisition uses the configured hard remote wall clock", async () => {
  const config = loadConfig({
    URMA_YTDLP: "yt-dlp",
    URMA_MAX_REMOTE_ACQUISITION_WALL_MS: "50",
  });
  const ytdlp = new YtDlp(
    config,
    async (_executable, _args, options) =>
      await runChecked(
        process.execPath,
        ["-e", "setInterval(()=>{},1000)"],
        options,
      ),
    testRemoteContext,
  );
  await assert.rejects(
    ytdlp.run([
      "--skip-download",
      "https://www.youtube.com/watch?v=yP0axVHdP-U",
    ]),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "MEDIA_ACQUISITION_TIMEOUT",
  );
});
test("local-source failures do not disclose the configured root", async (t) => {
  const directory = await fixture(t);
  const root = path.join(directory, "root");
  await mkdir(root);
  const missing = path.join(root, "missing.mp4");
  await assert.rejects(
    resolveLocalPath(missing, { localRoots: [root], allowUnc: false }),
    (error: unknown) => {
      assert(error instanceof Error);
      const normalized = error.message.replaceAll("\\\\", "\\").toLowerCase();
      assert.equal(normalized.includes(root.toLowerCase()), false);
      return true;
    },
  );
});

test("yt-dlp acquisition binds the active Node executable with the supported runtime flag", async () => {
  const calls: { executable: string; args: readonly string[] }[] = [];
  const config = loadConfig({ URMA_YTDLP: "yt-dlp" });
  const ytdlp = new YtDlp(config, async (executable, args) => {
    calls.push({ executable, args: [...args] });
    return {
      executable,
      args: [...args],
      code: 0,
      stdout: Buffer.from("ok"),
      stderr: Buffer.alloc(0),
      wallMs: 1,
    };
  }, testRemoteContext);
  await ytdlp.run([
    "--skip-download",
    "https://www.youtube.com/watch?v=yP0axVHdP-U",
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.executable, "yt-dlp");
  assert.equal(calls[0]?.args.includes("--ignore-config"), true);
  assert.equal(calls[0]?.args.includes("--no-config-locations"), true);
  assert.equal(calls[0]?.args.includes("--no-plugin-dirs"), true);
  assert.equal(calls[0]?.args.includes("--no-cookies"), true);
  assert.equal(calls[0]?.args.includes("--no-exec"), true);
  assert.equal(calls[0]?.args.includes("--no-remote-components"), true);
  assert.equal(calls[0]?.args.includes("--no-playlist"), true);
  assert.equal(calls[0]?.args.includes("--default-search"), true);
  assert.equal(calls[0]?.args.includes("--no-wait-for-video"), true);
  assert.equal(calls[0]?.args.includes("--no-mark-watched"), true);
  assert.equal(calls[0]?.args.includes("--no-update"), true);
  assert.equal(calls[0]?.args.includes("--socket-timeout"), true);
  assert.equal(calls[0]?.args.includes("--retries"), true);
  assert.equal(calls[0]?.args.includes("--fragment-retries"), true);
  assert.equal(calls[0]?.args.includes("--extractor-retries"), true);
  assert.equal(calls[0]?.args.includes("--concurrent-fragments"), true);
  const runtimeIndex = calls[0]?.args.indexOf("--js-runtimes") ?? -1;
  assert.equal(calls[0]?.args[runtimeIndex + 1], `node:${process.execPath}`);
  assert.equal(calls[0]?.args.includes("--js-engine"), false);
});

test("yt-dlp cannot opt an HTTP(S) operation out of the Safe Proxy", async () => {
  const ytdlp = new YtDlp(
    loadConfig(),
    async () => ({
      executable: "yt-dlp",
      args: [],
      code: 0,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      wallMs: 1,
    }),
    testRemoteContext,
  );
  await assert.rejects(
    ytdlp.run(["https://cdn.example.test/video.mp4"], { remote: false }),
    /cannot disable the Safe Proxy/u,
  );
});

test("remote yt-dlp and media profiles install only Urma's Safe Proxy", async (t) => {
  const proxyUrl = "http://127.0.0.1:41234";
  const args = hermeticYtDlpArgs(
    ["--skip-download", "https://cdn.example.test/video.mp4"],
    process.execPath,
    proxyUrl,
  );
  const proxyIndex = args.indexOf("--proxy");
  assert.equal(args[proxyIndex + 1], proxyUrl);
  assert.equal(args.some((value) => value.includes("-http_proxy http://127.0.0.1:41234")), true);
  assert.equal(args.some((value) => value.includes("-protocol_whitelist http,https,tcp,tls,httpproxy")), true);
  assert.equal(args.includes("--downloader-args"), true);
  assert.equal(args.includes("--postprocessor-args"), true);

  const directory = await fixture(t);
  const output = path.join(directory, "frame.jpg");
  const calls: readonly string[][] = [];
  const captured: string[][] = [];
  const runner = async (executable: string, command: readonly string[]) => {
    captured.push([executable, ...command]);
    const outputIndex = command.indexOf("-y");
    if (outputIndex >= 0 && typeof command[outputIndex + 1] === "string") {
      await writeFile(command[outputIndex + 1]!, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    }
    return {
      executable,
      args: command,
      code: 0,
      stdout: Buffer.from(JSON.stringify({ streams: [], format: {} })),
      stderr: Buffer.alloc(0),
      wallMs: 1,
    };
  };
  await new Ffmpeg(loadConfig(), testRemoteContext, runner).extractJpeg(
    "https://cdn.example.test/video.mp4",
    1_000,
    output,
  );
  await new Ffprobe(loadConfig(), testRemoteContext, runner).inspect(
    "https://cdn.example.test/video.mp4",
  );
  assert.equal(calls.length, 0);
  assert.equal(captured.length, 2);
  for (const command of captured) {
    assert.equal(command.includes("-http_proxy"), true);
    assert.equal(command.includes(proxyUrl), true);
    assert.equal(command.includes("-protocol_whitelist"), true);
    assert.equal(command.includes("http,https,tcp,tls,httpproxy"), true);
    assert.equal(command.includes("file"), false);
  }
  assert.deepEqual(await remoteMediaInputArgs("/tmp/local.mp4", testRemoteContext), []);
  await assert.rejects(
    remoteMediaInputArgs("file:///tmp/local.mp4", testRemoteContext),
    /HTTP\(S\)|unsupported/u,
  );
});
