import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { UrmaError } from "../core/errors.js";

export type HostRegistrationResult = Readonly<{
  requested: boolean;
  status: "success" | "failure" | "not-requested";
  detail: string;
}>;

async function readObject(file: string): Promise<Record<string, unknown>> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("configuration path is not a regular file");
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("configuration root is not an object");
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
}

async function atomicWriteJson(file: string, value: Record<string, unknown>): Promise<void> {
  const parent = path.dirname(file);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const next = `${file}.next`;
  await rm(next, { force: true });
  const handle = await open(next, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(next, file);
}

export async function registerGenericMcpHost(
  configFile: string,
  nodeExecutable: string,
  launcherPath: string,
  dataRoot: string,
): Promise<HostRegistrationResult> {
  if (!path.isAbsolute(configFile) || !path.isAbsolute(nodeExecutable) || !path.isAbsolute(launcherPath) || !path.isAbsolute(dataRoot)) {
    throw new UrmaError("HOST_REGISTRATION_FAILED", "Generic MCP registration requires absolute config, Node, launcher, and data-root paths");
  }
  try {
    const config = await readObject(configFile);
    const existing = config.mcpServers;
    if (existing !== undefined && (typeof existing !== "object" || existing === null || Array.isArray(existing))) {
      throw new Error("mcpServers is not a JSON object");
    }
    const mcpServers = { ...(existing as Record<string, unknown> | undefined) };
    mcpServers.urma = {
      command: nodeExecutable,
      args: [launcherPath],
      env: { URMA_DATA_DIR: dataRoot },
    };
    config.mcpServers = mcpServers;
    await atomicWriteJson(configFile, config);
    return { requested: true, status: "success", detail: `registered Urma in ${configFile}` };
  } catch (error) {
    if (error instanceof UrmaError) throw error;
    throw new UrmaError("HOST_REGISTRATION_FAILED", `Could not register Urma in ${configFile}; runtime installation remains healthy`, { cause: error });
  }
}

export function notRequestedHostRegistration(): HostRegistrationResult {
  return { requested: false, status: "not-requested", detail: "no MCP host registration requested" };
}
