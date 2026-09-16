import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED = [
  ["resolve"],
  ["singleton"],
  ["timeline"],
  ["inspect"],
  ["frames", "exact"],
  ["frames", "multiple"],
  ["cadence"],
  ["overview"],
  ["cache"],
  ["provenance"],
];

function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function at(value, keys) {
  let current = value;
  for (const key of keys) {
    if (!record(current)) return undefined;
    current = current[key];
  }
  return current;
}

function status(value, keys) {
  return text(at(value, keys)?.status) ?? "MISSING";
}

function provider(value, label) {
  if (!record(value) || text(value.provider) === null) {
    throw new Error(`${label} must contain a non-empty provider name`);
  }
  return value.provider;
}

function manifestTierA(manifest) {
  if (!Array.isArray(manifest)) throw new Error("compatibility fixture manifest must be an array");
  const names = [];
  const seen = new Set();
  manifest.forEach((item, index) => {
    if (!record(item)) throw new Error(`compatibility fixture manifest row ${index + 1} must be an object`);
    if (item.tier !== "A" && item.tier !== "B") {
      throw new Error(`compatibility fixture manifest row ${index + 1} has invalid tier ${JSON.stringify(item.tier)}`);
    }
    if (item.tier !== "A") return;
    const name = provider(item, `compatibility fixture manifest row ${index + 1}`);
    if (seen.has(name)) throw new Error(`compatibility fixture manifest has duplicate Tier A provider ${JSON.stringify(name)}`);
    seen.add(name);
    names.push(name);
  });
  return names;
}

function resultFailures(result) {
  return Array.isArray(result?.failures) ? result.failures.filter(record) : [];
}

function lifecycleReason(result, key) {
  const section = result?.[key];
  if (!record(section) || typeof section.enabled !== "boolean") return `${key}=MISSING`;
  const value = text(section.status) ?? "MISSING";
  if (section.enabled === true && value !== "PASS") return `${key}=${value}`;
  if (section.enabled === false && value !== "NOT_RUN" && value !== "PASS") return `${key}=${value}`;
  return null;
}

function primaryReason(result) {
  if (!Array.isArray(result?.fixtureAttempts) || result.fixtureAttempts.length === 0) return "primary=MISSING";
  const primary = result.fixtureAttempts[0];
  if (!record(primary)) return "primary=MALFORMED";
  if (primary.status === "PASS") return null;
  const error = record(primary.error)
    ? ` ${text(primary.error.code) ?? "error"}: ${text(primary.error.detail) ?? "no detail"}`
    : "";
  return `primary=${text(primary.status) ?? "MISSING"}${error}`;
}

function fullPass(result) {
  if (!record(result)) return false;
  if (result.classification !== "FIRST_CLASS_CANDIDATE") return false;
  if (result.fixtureOutcome !== "PRIMARY_PASSED") return false;
  if (!Array.isArray(result.fixtureAttempts) || result.fixtureAttempts[0]?.status !== "PASS") return false;
  if (REQUIRED.some((keys) => status(result, keys) !== "PASS")) return false;
  return ["restart", "refresh"].every((key) => lifecycleReason(result, key) === null);
}

function resultReason(result) {
  const reasons = [];
  if (result?.classification !== "FIRST_CLASS_CANDIDATE") {
    reasons.push(`classification=${text(result?.classification) ?? "MISSING"}`);
  }
  if (result?.fixtureOutcome !== "PRIMARY_PASSED") {
    reasons.push(`fixtureOutcome=${text(result?.fixtureOutcome) ?? "MISSING"}`);
  }
  for (const keys of REQUIRED) {
    const value = status(result, keys);
    if (value !== "PASS") reasons.push(`${keys.join(".")}=${value}`);
  }
  for (const key of ["restart", "refresh"]) {
    const reason = lifecycleReason(result, key);
    if (reason !== null) reasons.push(reason);
  }
  const primary = primaryReason(result);
  if (primary !== null) reasons.push(primary);
  const causes = resultFailures(result)
    .map((failure) => {
      const cause = text(failure.responsibility) ?? "unknown-cause";
      const kind = text(failure.class) ?? text(failure.code) ?? "failure";
      return `${kind}[${cause}]`;
    });
  if (causes.length > 0) reasons.push(`failures=${[...new Set(causes)].join(",")}`);
  return reasons.length > 0 ? reasons.join("; ") : "not a full Tier A pass";
}

function regressionEvidence(results) {
  return results.flatMap((result) => resultFailures(result)
    .filter((failure) => failure.responsibility === "Urma")
    .map((failure) => `${provider(result, "compatibility result")}: ${text(failure.class) ?? "failure"} — ${text(failure.observedError) ?? "no detail"}`));
}

export function evaluateCompatibility(manifest, report) {
  const expected = manifestTierA(manifest);
  if (!record(report) || !Array.isArray(report.results) || report.results.length === 0) {
    throw new Error("compatibility report must contain a non-empty results array");
  }
  const results = report.results;
  const tierA = results.filter((result) => record(result) && result.tier === "A");
  const seen = new Set();
  const duplicate = [];
  for (const result of tierA) {
    const name = provider(result, "compatibility result");
    if (seen.has(name)) duplicate.push(name);
    seen.add(name);
  }
  const missing = expected.filter((name) => !seen.has(name));
  const unexpected = tierA
    .map((result) => provider(result, "compatibility result"))
    .filter((name) => !expected.includes(name));
  const incomplete = tierA
    .filter((result) => expected.includes(provider(result, "compatibility result")) && !fullPass(result))
    .map((result) => `${provider(result, "compatibility result")}: ${resultReason(result)}`);
  const failures = [
    ...missing.map((name) => `${name}: missing result`),
    ...duplicate.map((name) => `${name}: duplicate result`),
    ...unexpected.map((name) => `${name}: unexpected Tier A result`),
    ...incomplete,
  ];
  return {
    tierA,
    expected,
    failures,
    regressionEvidence: regressionEvidence(tierA),
    passed: failures.length === 0,
  };
}

export function gateText(summary) {
  const lines = [
    `Tier A compatibility qualification: ${summary.passed ? "PASS" : "INCOMPLETE"}`,
    `Urma regression evidence: ${summary.regressionEvidence.length > 0 ? summary.regressionEvidence.join(" | ") : "none demonstrated"}`,
  ];
  if (summary.failures.length > 0) lines.push(`Tier A qualification failures: ${summary.failures.join(" | ")}`);
  return lines.join("\n");
}

async function main() {
  const reportPath = path.resolve(process.argv[2] ?? "compat/results/latest.json");
  const manifestPath = path.resolve(process.argv[3] ?? "compat/fixtures/providers.json");
  const releaseType = process.env.RELEASE_TYPE ?? "rc";
  if (!["test", "rc", "stable"].includes(releaseType)) {
    throw new Error(`compatibility gate received unsupported release type ${JSON.stringify(releaseType)}`);
  }
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const summary = evaluateCompatibility(manifest, report);
  process.stdout.write(`${gateText(summary)}\n`);
  if (!summary.passed && releaseType !== "test") {
    throw new Error(`Tier A compatibility qualification failed for release_type=${releaseType}; inspect ${reportPath}.`);
  }
  if (!summary.passed) {
    process.stdout.write("release_type=test: continuing for investigation; publication is disabled for test runs.\n");
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) await main();
