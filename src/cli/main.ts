#!/usr/bin/env node
import { loadConfig } from "../config.js";
import { normalizeError, UrmaError } from "../core/errors.js";
import { setup } from "../distribution/installer.js";
import { startStdioServer } from "../mcp/stdio.js";
import { URMA_VERSION } from "../version.js";
import { formatDoctorReport, runDoctor } from "./doctor.js";

async function main() {
  const args = process.argv.slice(2);
  const hasPersistentRuntime = Boolean(
    process.env.URMA_RUNTIME_ROOT_V1?.trim() &&
      process.env.URMA_RUNTIME_GENERATION_V1?.trim(),
  );
  if (args.length === 0) {
    if (!hasPersistentRuntime) {
      throw new UrmaError(
        "INSTALLATION_MISSING",
        "No persisted Urma generation is selected; run npx -y urma-mcp@latest setup, then configure your MCP host with the absolute Node executable and launcher-v1.mjs",
      );
    }
    await startStdioServer();
    return;
  }
  if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
    process.stdout.write(`${URMA_VERSION}\n`);
    return;
  }
  if (args[0] === "setup") {
    let dataRoot: string | undefined;
    let client: "generic" | undefined;
    let clientConfig: string | undefined;
    for (let index = 1; index < args.length; index += 1) {
      const argument = args[index];
      if (argument === "--data-dir" && args[index + 1] !== undefined) {
        dataRoot = args[index + 1];
        index += 1;
      } else if (argument === "--client" && args[index + 1] === "generic") {
        client = "generic";
        index += 1;
      } else if (argument === "--config" && args[index + 1] !== undefined) {
        clientConfig = args[index + 1];
        index += 1;
      } else {
        throw new UrmaError("INVALID_SOURCE", `Unknown setup option ${JSON.stringify(argument)}`);
      }
    }
    if (clientConfig !== undefined && client === undefined) {
      throw new UrmaError("INVALID_SOURCE", "--config requires --client generic");
    }
    const result = await setup({
      ...(dataRoot === undefined ? {} : { dataRoot }),
      ...(client === undefined ? {} : { client }),
      ...(clientConfig === undefined ? {} : { clientConfig }),
    });
    process.stdout.write(
      `runtime installation: ${result.runtimeInstallation} (${result.target}, ${result.installId})\n` +
      `launcher: ${result.launcherPath}\n` +
      `node executable: ${result.nodeExecutable}\n` +
      `host registration: ${result.hostRegistration.status} — ${result.hostRegistration.detail}\n`,
    );
    return;
  }
  if (args.length === 1 && args[0] === "doctor") {
    if (!hasPersistentRuntime) {
      throw new UrmaError(
        "INSTALLATION_MISSING",
        "No persisted Urma generation is selected; run setup before doctor",
      );
    }
    const report = await runDoctor(loadConfig());
    process.stderr.write(`${formatDoctorReport(report)}\n`);
    process.exitCode = report.ok ? 0 : 1;
    return;
  }
  process.stderr.write("Usage: urma [setup [--data-dir PATH] [--client generic --config PATH] | doctor | --version | -v]\n");
  process.exitCode = 2;
}
try {
  await main();
} catch (error) {
  const normalized = normalizeError(error);
  process.stderr.write(`Urma ${normalized.code}: ${normalized.message}\n`);
  process.exitCode = 1;
}
