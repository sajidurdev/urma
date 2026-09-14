import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { cp, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { UrmaError } from "../core/errors.js";
import { sha256File } from "./integrity.js";

type PackageJson = Readonly<{
  name?: unknown;
  version?: unknown;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  engines?: { node?: string };
}>;

export type CopiedRuntime = Readonly<{
  packageRoot: string;
  entry: string;
  payloadSha256: string;
}>;

async function findPackageRoot(start: string): Promise<string> {
  let current = path.resolve(start);
  for (;;) {
    try {
      const candidate = path.join(current, "package.json");
      await stat(candidate);
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) throw new UrmaError("SETUP_FAILED", "Could not locate the executing Urma package root");
      current = parent;
    }
  }
}

async function readPackageJson(root: string): Promise<PackageJson> {
  const value = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new UrmaError("SETUP_FAILED", `Package metadata at ${root} is invalid`);
  return value as PackageJson;
}

async function resolveDependencyRoot(name: string, fromRoot: string, packageRoot: string): Promise<string> {
  let physicalFrom = fromRoot;
  try {
    physicalFrom = await realpath(fromRoot);
  } catch {
    // The normal package-root candidate is checked below.
  }
  const candidates: string[] = [];
  let current = physicalFrom;
  for (;;) {
    candidates.push(path.join(current, "node_modules", name));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  candidates.push(path.join(packageRoot, "node_modules", name));
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (!info.isDirectory()) continue;
      return await findPackageRoot(candidate);
    } catch {
      // Try the next package resolution location.
    }
  }
  try {
    const require = createRequire(path.join(fromRoot, "package.json"));
    const entry = require.resolve(name);
    return await findPackageRoot(path.dirname(entry));
  } catch (error) {
    throw new UrmaError("SETUP_FAILED", `Runtime dependency ${JSON.stringify(name)} is not installed in the npm package`, { cause: error });
  }
}

async function copyDependencyTree(packageRoot: string, runtimeNodeModules: string): Promise<void> {
  const copied = new Set<string>();
  const visit = async (name: string, fromRoot: string): Promise<void> => {
    if (copied.has(name)) return;
    const source = await resolveDependencyRoot(name, fromRoot, packageRoot);
    const metadata = await readPackageJson(source);
    if (metadata.name !== undefined && metadata.name !== name) throw new UrmaError("SETUP_FAILED", `Resolved dependency ${name} has package name ${String(metadata.name)}`);
    copied.add(name);
    const target = path.join(runtimeNodeModules, name);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await cp(source, target, { recursive: true, dereference: true, errorOnExist: true, force: false });
    const dependencies = {
      ...(metadata.dependencies ?? {}),
      ...(metadata.optionalDependencies ?? {}),
    };
    for (const dependency of Object.keys(dependencies)) await visit(dependency, source);
  };
  const packageJson = await readPackageJson(packageRoot);
  const dependencies = {
    ...(packageJson.dependencies ?? {}),
    ...(packageJson.optionalDependencies ?? {}),
  };
  for (const name of Object.keys(dependencies)) await visit(name, packageRoot);
}

async function updateTree(
  digest: ReturnType<typeof createHash>,
  root: string,
  prefix: string,
): Promise<void> {
  const walk = async (directory: string, relative: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en-US"));
    for (const entry of entries) {
      const childRelative = relative ? path.join(relative, entry.name) : entry.name;
      const child = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new UrmaError("SETUP_FAILED", `Runtime payload contains an unresolved symlink: ${child}`);
      if (entry.isDirectory()) {
        digest.update(`D\0${prefix}/${childRelative.replaceAll(path.sep, "/")}\0`);
        await walk(child, childRelative);
      } else if (entry.isFile()) {
        digest.update(`F\0${prefix}/${childRelative.replaceAll(path.sep, "/")}\0`);
        digest.update(await readFile(child));
      } else {
        throw new UrmaError("SETUP_FAILED", `Runtime payload contains unsupported filesystem entry: ${child}`);
      }
    }
  };
  await walk(root, "");
}

async function hashTree(root: string): Promise<string> {
  const digest = createHash("sha256");
  await updateTree(digest, root, "runtime");
  return digest.digest("hex");
}

async function hashPayload(runtime: string, assets: string): Promise<string> {
  const digest = createHash("sha256");
  await updateTree(digest, runtime, "runtime");
  try {
    await stat(assets);
    await updateTree(digest, assets, "assets");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  return digest.digest("hex");
}

export async function copyNpmRuntime(stageGenerationDir: string): Promise<CopiedRuntime> {
  const packageRoot = await findPackageRoot(fileURLToPath(import.meta.url));
  const sourceDist = path.join(packageRoot, "dist", "src");
  const sourceAssets = path.join(packageRoot, "assets");
  const runtime = path.join(stageGenerationDir, "runtime");
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  await cp(sourceDist, path.join(runtime, "src"), { recursive: true, dereference: true, errorOnExist: true, force: false });
  const packageJson = await readPackageJson(packageRoot);
  const sanitized = {
    name: typeof packageJson.name === "string" ? packageJson.name : "@urma/mcp",
    version: typeof packageJson.version === "string" ? packageJson.version : "0.0.0",
    type: "module",
    engines: packageJson.engines ?? { node: ">=24 <25" },
    dependencies: packageJson.dependencies ?? {},
  };
  delete (sanitized.dependencies as Record<string, string>).urma;
  await writeFile(path.join(runtime, "package.json"), `${JSON.stringify(sanitized, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await copyDependencyTree(packageRoot, path.join(runtime, "node_modules"));
  await cp(sourceAssets, path.join(stageGenerationDir, "assets"), { recursive: true, dereference: true, errorOnExist: true, force: false });
  const payloadSha256 = await hashPayload(runtime, path.join(stageGenerationDir, "assets"));
  return {
    packageRoot,
    entry: path.join(runtime, "src", "cli", "main.js"),
    payloadSha256,
  };
}

export async function hashRuntimePayload(runtime: string): Promise<string> {
  return await hashTree(runtime);
}

export async function hashNodeExecutable(nodeExecutable: string): Promise<string | undefined> {
  try {
    return await sha256File(nodeExecutable);
  } catch {
    return undefined;
  }
}
