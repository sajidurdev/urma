import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const schema = "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json";
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const repositoryUrl = value => {
  assert.equal(typeof value, "string", "repository URL must be a string");
  const url = new URL(value);
  assert.equal(url.protocol, "https:", "repository URL must use HTTPS");
  assert(!url.username && !url.password && !url.search && !url.hash, "repository URL must not contain credentials, query, or fragment");
  return url.href.replace(/\/$/u, "").replace(/\.git$/u, "");
};

export function readMetadata() {
  return {
    pkg: JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")),
    server: JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf8")),
  };
}

// Validate Urma's current npm/stdio fields from the linked official schema.
// New registry types or launch metadata require an explicit validator update.
export function validateMetadata(pkg, server) {
  assert.equal(server.$schema, schema, "server.json schema changed; review the validator against the new schema");
  assert.equal(typeof pkg.name, "string", "package.json.name must be a string");
  assert(/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/u.test(pkg.name), "package.json.name must be an npm package name");
  assert.equal(typeof pkg.version, "string", "package.json.version must be a string");
  assert(semver.test(pkg.version), "package.json.version must be an exact semantic version");
  assert.equal(typeof pkg.mcpName, "string", "package.json.mcpName is required");
  assert(pkg.mcpName.length <= 200 && /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/u.test(pkg.mcpName), "package.json.mcpName must match the registry name format");
  assert.equal(server.name, pkg.mcpName, "server.json.name must match package.json.mcpName");
  assert.equal(server.version, pkg.version, "server.json.version must match package.json.version");
  assert(typeof server.description === "string" && server.description.length >= 1 && server.description.length <= 100, "server.json.description must contain 1–100 characters");
  assert.equal(pkg.repository?.type, "git", "package.json.repository.type must be git");
  assert.equal(server.repository?.source, "github", "server.json.repository.source must be github");
  const repository = repositoryUrl(pkg.repository.url);
  assert.equal(new URL(repository).hostname, "github.com", "Urma repository must be hosted on GitHub");
  assert.equal(repositoryUrl(server.repository.url), repository, "server.json repository must match package.json.repository");
  assert(Array.isArray(server.packages) && server.packages.length === 1, "server.json must describe one npm package");
  const entry = server.packages[0];
  assert.equal(entry.registryType, "npm", "server.json package must use the npm registry");
  assert.equal(entry.identifier, pkg.name, "server.json package identifier must match package.json.name");
  assert.equal(entry.version, pkg.version, "server.json package version must match package.json.version");
  assert.deepEqual(entry.transport, { type: "stdio" }, "server.json package transport must be stdio");
  assert.deepEqual(Object.keys(entry).sort(), ["identifier", "registryType", "transport", "version"], "Review validation before adding package launch fields");
  assert.equal(server.remotes, undefined, "Urma does not declare a remote transport");
  return { package_name: pkg.name, version: pkg.version, repository, mcp_name: pkg.mcpName };
}

// These are intentional publishing identity assertions, not operational defaults.
export function assertPublishingIdentity(pkg) {
  assert.equal(pkg.name, "urma-mcp", "Unexpected npm publishing identity");
  assert.equal(repositoryUrl(pkg.repository?.url), "https://github.com/sajidurdev/urma", "Unexpected publishing repository");
  assert.equal(pkg.mcpName, "io.github.sajidurdev/urma", "Unexpected MCP publishing identity");
}

export function validateReleaseRequest(pkg, { releaseType, defaultBranch, refType, refName }) {
  assert(["test", "rc", "stable"].includes(releaseType), "Unknown release type");
  assert(typeof defaultBranch === "string" && defaultBranch.trim().length > 0, "GitHub repository default_branch metadata is missing");
  if (releaseType !== "test") {
    assert(refType === "branch" && refName === defaultBranch, `RC/stable releases require the default branch ${defaultBranch}; received ${refType}:${refName}`);
  }
  const versionPattern = releaseType === "rc" ? /^\d+\.\d+\.\d+-rc\.(0|[1-9]\d*)$/u : /^\d+\.\d+\.\d+$/u;
  assert(semver.test(pkg.version) && (releaseType === "test" || versionPattern.test(pkg.version)), `Version ${pkg.version} is not valid for ${releaseType}`);
  return { release_type: releaseType, version: pkg.version, dist_tag: releaseType === "test" ? "" : releaseType === "rc" ? "rc" : "latest", release_tag: `v${pkg.version}` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { pkg, server } = readMetadata();
  validateMetadata(pkg, server);
  assertPublishingIdentity(pkg);
  console.log("Package and MCP metadata are consistent.");
}
