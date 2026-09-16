import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/client/stdio";
import { URMA_VERSION } from "../../src/version.js";
import { runChecked } from "../../src/subprocess/runner.js";

const cliEntrypoint = path.resolve("dist/src/cli/main.js");
const stdioEntrypoint = path.resolve("dist/tests/support/stdio-entry.js");

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function waitForProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100 && processIsAlive(pid); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(
    processIsAlive(pid),
    false,
    `Urma stdio process ${pid} survived MCP client shutdown`,
  );
}

test("stdio server keeps stdout protocol-clean", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "urma-stdio-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [stdioEntrypoint],
    cwd: process.cwd(),
    env: {
      ...getDefaultEnvironment(),
      URMA_DATA_DIR: path.join(directory, "data"),
      URMA_LOCAL_ROOTS: directory,
    },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const client = new Client({ name: "urma-stdio-test", version: "1.0.0" });
  let serverPid: number | null = null;
  t.after(async () => {
    await client.close().catch(() => undefined);
    if (serverPid !== null) await waitForProcessExit(serverPid);
    await rm(directory, { recursive: true, force: true });
  });
  await client.connect(transport);
  serverPid = transport.pid;
  assert.equal(typeof serverPid, "number");
  const serverVersion = client.getServerVersion();
  assert.equal(serverVersion?.name, "urma");
  assert.equal(serverVersion?.version, URMA_VERSION);
  assert.equal(serverVersion?.icons?.length, 1);
  assert.equal(serverVersion?.icons?.[0]?.mimeType, "image/png");
  assert.deepEqual(serverVersion?.icons?.[0]?.sizes, ["256x256"]);
  assert.match(serverVersion?.icons?.[0]?.src ?? "", /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/);
  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name),
    [
      "inspect_video",
      "search_transcript",
      "read_transcript",
      "get_overview",
      "get_frames",
    ],
  );
  assert.equal(stderr.trim(), "");
});

test("raw stdio stdout stays valid MCP JSON-RPC through startup, discovery, request, and shutdown", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "urma-stdio-raw-"));
  const video = path.join(directory, "fixture.mp4");
  await runChecked(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=160x90:d=1:r=1",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-y",
      video,
    ],
    { timeoutMs: 30_000 },
  );
  const stamp = (value: number) =>
    `00:00:${String(Math.floor(value / 1000)).padStart(2, "0")}.${
      String(value % 1000).padStart(3, "0")
    }`;
  const segments = Array.from({ length: 200 }, (_, ordinal) => {
    const start = ordinal * 4;
    return `${stamp(start)} --> ${stamp(start + 2)}\ntransport cue ${ordinal}`;
  });
  await writeFile(
    path.join(directory, "fixture.vtt"),
    `WEBVTT\n\n${segments.join("\n\n")}\n`,
  );
  const dataDir = path.join(directory, "data");
  const debugFile = path.join(directory, "urma-debug.jsonl");
  const child = spawn(process.execPath, [stdioEntrypoint], {
    cwd: process.cwd(),
    env: {
      ...getDefaultEnvironment(),
      URMA_DATA_DIR: dataDir,
      URMA_LOCAL_ROOTS: directory,
      URMA_DEBUG: "1",
      URMA_DEBUG_FILE: debugFile,
    },
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  let outputError: Error | null = null;
  const messages: Record<string, unknown>[] = [];
  const waiters = new Map<
    number,
    {
      resolve: (message: Record<string, unknown>) => void;
      reject: (error: Error) => void;
    }
  >();
  const failOutput = (error: Error) => {
    if (outputError) return;
    outputError = error;
    for (const waiter of waiters.values()) waiter.reject(error);
    waiters.clear();
  };
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).replace(/\r$/u, "");
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        failOutput(
          new Error(`stdout contained non-JSON text: ${line.slice(0, 200)}`, {
            cause: error,
          }),
        );
        return;
      }
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        failOutput(new Error("stdout contained a non-MCP JSON-RPC message"));
        return;
      }
      const message = parsed as Record<string, unknown>;
      if (message.jsonrpc !== "2.0") {
        failOutput(new Error("stdout contained a non-MCP JSON-RPC message"));
        return;
      }
      messages.push(message);
      const id = message.id;
      if (typeof id === "number") {
        const waiter = waiters.get(id);
        if (waiter) {
          waiters.delete(id);
          waiter.resolve(message);
        }
      }
    }
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const waitFor = (id: number): Promise<Record<string, unknown>> => {
    if (outputError) return Promise.reject(outputError);
    const existing = messages.find((message) => message.id === id);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) =>
      waiters.set(id, { resolve, reject })
    );
  };
  const send = async (message: Record<string, unknown>, id: number) => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
    return await waitFor(id);
  };
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await once(child, "close").catch(() => undefined);
    }
    await rm(directory, { recursive: true, force: true });
  });

  const initialized = await send(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "urma-stdout-purity", version: "1.0.0" },
      },
    },
    1,
  );
  assert.equal(initialized.id, 1);
  const serverInfo = initialized.result as {
    serverInfo?: {
      icons?: readonly {
        src?: string;
        mimeType?: string;
        sizes?: readonly string[];
      }[];
    };
  };
  assert.equal(serverInfo.serverInfo?.icons?.length, 1);
  assert.equal(serverInfo.serverInfo?.icons?.[0]?.mimeType, "image/png");
  assert.deepEqual(serverInfo.serverInfo?.icons?.[0]?.sizes, ["256x256"]);
  assert.match(serverInfo.serverInfo?.icons?.[0]?.src ?? "", /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/);
  child.stdin.write(
    `${
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      })
    }\n`,
  );
  const listed = await send(
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    2,
  );
  assert.deepEqual(
    (listed.result as { tools: readonly { name: string }[] }).tools.map(
      (tool) => tool.name,
    ),
    [
      "inspect_video",
      "search_transcript",
      "read_transcript",
      "get_overview",
      "get_frames",
    ],
  );
  const inspected = await send(
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "inspect_video", arguments: { source: video } },
    },
    3,
  );
  assert.equal((inspected.result as { isError?: boolean }).isError, undefined);
  const investigationRef = String(
    (inspected.result as { structuredContent?: Record<string, unknown> })
      .structuredContent?.investigationRef,
  );
  const read = await send(
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "read_transcript",
        arguments: { investigationRef, startMs: 0, endMs: 1000 },
      },
    },
    4,
  );
  assert.equal((read.result as { isError?: boolean }).isError, undefined);
  const readResult = read.result as {
    structuredContent?: Record<string, unknown>;
    content?: readonly { type: string; text?: string }[];
  };
  const readStructured = readResult.structuredContent as {
    segments: readonly unknown[];
    partial: boolean;
    nextCursor: string | null;
  };
  assert.equal(readStructured.segments.length, 200);
  assert.equal(readStructured.partial, false);
  assert.equal(readStructured.nextCursor, null);
  assert.equal(
    readResult.content?.some((item) => item.type === "text"),
    false,
    "successful structured results must not repeat JSON in a text block",
  );
  const panel = await send(
    {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "get_frames",
        arguments: {
          investigationRef,
          presentation: "panel",
          request: { kind: "points", timesMs: [0] },
        },
      },
    },
    5,
  );
  assert.equal((panel.result as { isError?: boolean }).isError, undefined);
  assert.equal(
    (
      (panel.result as { content?: readonly { type: string }[] }).content ?? []
    ).filter((item) => item.type === "image").length,
    1,
  );
  child.stdin.end();
  await once(child, "close");
  assert.equal(outputError, null);
  assert.equal(buffer.trim(), "");
  const debugLines = (await readFile(debugFile, "utf8"))
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean);
  const stderrLines = stderr.trim().split(/\r?\n/u).filter(Boolean);
  assert(debugLines.length > 0, "debug mode should emit durable diagnostics");
  const debugEvents = debugLines.map(
    (line) => JSON.parse(line) as Record<string, unknown>,
  );
  assert.deepEqual(
    stderrLines.map((line) => JSON.parse(line.slice("Urma debug ".length))),
    debugEvents,
    "stderr and JSONL diagnostics should mirror one another",
  );
  const framePresentation = debugEvents.find(
    (event) => event.event === "get-frames-presentation",
  );
  assert(framePresentation);
  assert.equal(framePresentation.presentation, "panel");
  assert.equal(framePresentation.requestedTimestamps, "0");
  assert.equal(framePresentation.exactFramesReturned, 1);
  assert.equal(framePresentation.inlineImageCount, 1);
  assert(Number(framePresentation.inlineImageBytes) > 0);
  assert.equal(framePresentation.cellCount, 1);
  assert.equal(framePresentation.canonicalArtifactCount, 1);
  assert.equal(framePresentation.canvasWidth, 320);
  assert.equal(framePresentation.canvasHeight, 212);
  assert(
    messages.length >= 5,
    "expected initialize, tools/list, and tool-call responses",
  );
});

test("packaged CLI exposes only MCP stdio, doctor, and version", async () => {
  const packageJson = JSON.parse(
    await readFile(path.resolve("package.json"), "utf8"),
  ) as { version: string; bin: Record<string, string> };
  assert.equal(URMA_VERSION, packageJson.version);
  assert.deepEqual(packageJson.bin, { urma: "./dist/src/cli/main.js" });

  for (const flag of ["--version", "-v"]) {
    const result = spawnSync(process.execPath, [cliEntrypoint, flag], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(
      result.status,
      0,
      `${flag} should exit successfully: ${result.stderr}`,
    );
    assert.equal(result.stdout, `${packageJson.version}\n`);
    assert.equal(result.stderr, "");
  }

  for (
    const args of [
      ["inspect"],
      ["search"],
      ["cache", "stats"],
      ["cache", "prune"],
      ["serve"],
      ["debug"],
      ["doctor", "extra"],
      ["--version", "extra"],
      ["-v", "extra"],
      ["Doctor"],
      [" doctor "],
    ]
  ) {
    const result = spawnSync(process.execPath, [cliEntrypoint, ...args], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 2, `${args.join(" ")} should be rejected`);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "Usage: urma [setup [--data-dir PATH] [--client generic --config PATH] | doctor | --version | -v]\n");
  }
});

test("doctor rejects direct uninstalled startup", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "urma-doctor-cli-"));
  const dataDir = path.join(directory, "data");
  try {
    const result = spawnSync(process.execPath, [cliEntrypoint, "doctor"], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        URMA_DATA_DIR: dataDir,
      },
    });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^Urma INSTALLATION_MISSING:/u);
    await assert.rejects(access(dataDir));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
