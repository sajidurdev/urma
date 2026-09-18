import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, mkdtempSync, readFileSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { getReleaseManifest, validateReleaseManifest } from "../src/distribution/manifest.ts";

if (process.platform !== "linux" || process.arch !== "x64" || !process.env.RUNNER_TEMP || !process.env.GITHUB_PATH) {
  throw new Error("prepare-ci-tools requires an Ubuntu x64 Actions runner with RUNNER_TEMP and GITHUB_PATH");
}
const manifest = getReleaseManifest("linux-x64-glibc");
validateReleaseManifest(manifest);
const artifact = manifest.ytdlp;
if (artifact.archiveFormat !== "zip") throw new Error("CI yt-dlp preparation requires the manifest's standalone ZIP distribution");
const directory = mkdtempSync(path.join(process.env.RUNNER_TEMP, "urma-ci-ytdlp-"));
const archive = path.join(directory, path.basename(new URL(artifact.url).pathname));
execFileSync("curl", ["--fail", "--location", "--retry", "3", "--output", archive, artifact.url], { stdio: "inherit" });
if (statSync(archive).size !== artifact.archiveBytes || createHash("sha256").update(readFileSync(archive)).digest("hex") !== artifact.archiveSha256) {
  throw new Error("Downloaded yt-dlp archive does not match the canonical manifest size/SHA-256");
}
execFileSync("unzip", ["-q", archive, "-d", directory], { stdio: "inherit" });
for (const file of artifact.expectedFiles) {
  if (!statSync(path.join(directory, file)).isFile()) throw new Error(`yt-dlp archive is missing ${file}`);
}
const executable = path.join(directory, "yt-dlp");
renameSync(path.join(directory, artifact.executable), executable);
chmodSync(executable, 0o755);
const version = execFileSync(executable, ["--version"], { encoding: "utf8" }).trim();
if (version !== artifact.upstreamVersion) throw new Error(`yt-dlp version ${version} does not match manifest ${artifact.upstreamVersion}`);
appendFileSync(process.env.GITHUB_PATH, `${directory}\n`);
console.log(`Prepared manifest-verified yt-dlp ${version}`);
