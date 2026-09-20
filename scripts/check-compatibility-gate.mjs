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

function manifestEntries(manifest) {
  if (!Array.isArray(manifest)) throw new Error("compatibility fixture manifest must be an array");
  const entries = [];
  const seen = new Set();
  manifest.forEach((item, index) => {
    if (!record(item)) throw new Error(`compatibility fixture manifest row ${index + 1} must be an object`);
    if (item.tier !== "A" && item.tier !== "B") {
      throw new Error(`compatibility fixture manifest row ${index + 1} has invalid tier ${JSON.stringify(item.tier)}`);
    }
    const name = provider(item, `compatibility fixture manifest row ${index + 1}`);
    if (seen.has(name)) throw new Error(`compatibility fixture manifest has duplicate provider ${JSON.stringify(name)}`);
    seen.add(name);
    entries.push({ name, tier: item.tier });
  });
  return entries;
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

function isBlocking(failure) {
  return failure.blocking !== false;
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
  return reasons.length > 0 ? reasons.join("; ") : "not a full compatibility pass";
}

function regressionEvidence(results) {
  return results.flatMap((result) => resultFailures(result)
    .filter((failure) => failure.responsibility === "Urma" && isBlocking(failure))
    .map((failure) => `${provider(result, "compatibility result")}: ${text(failure.class) ?? "failure"} — ${text(failure.observedError) ?? "no detail"}`));
}

function liveProviderCoverage(entries, results) {
  const byProvider = new Map();
  for (const result of results) {
    if (!record(result)) continue;
    const name = provider(result, "compatibility result");
    const matches = byProvider.get(name) ?? [];
    matches.push(result);
    byProvider.set(name, matches);
  }
  const issues = [];
  for (const entry of entries.filter((item) => item.tier === "B")) {
    const matches = byProvider.get(entry.name) ?? [];
    if (matches.length === 0) {
      issues.push(`${entry.name}: missing result`);
      continue;
    }
    if (matches.length > 1) {
      issues.push(`${entry.name}: duplicate result`);
      continue;
    }
    const result = matches[0];
    if (result.classification !== "BEST_EFFORT_PASS" && result.classification !== "FIRST_CLASS_CANDIDATE") {
      issues.push(`${entry.name}: ${resultReason(result)}`);
    }
  }
  return {
    status: issues.length === 0 ? "COMPLETE" : "INCOMPLETE",
    issues,
  };
}

export function evaluateCompatibility(manifest, report) {
  const entries = manifestEntries(manifest);
  const expected = entries.filter((entry) => entry.tier === "A").map((entry) => entry.name);
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
  const tierAFailures = [
    ...missing.map((name) => `${name}: missing result`),
    ...duplicate.map((name) => `${name}: duplicate result`),
    ...unexpected.map((name) => `${name}: unexpected Tier A result`),
    ...incomplete,
  ];
  const regression = regressionEvidence(results);
  const coverage = liveProviderCoverage(entries, results);
  const releaseCorrectness = tierAFailures.length === 0 && regression.length === 0 ? "PASS" : "FAIL";
  return {
    entries,
    tierA,
    expected,
    failures: tierAFailures,
    tierAFailures,
    regressionEvidence: regression,
    tierAQualification: tierAFailures.length === 0 ? "PASS" : "INCOMPLETE",
    externalCoverage: coverage.status,
    externalCoverageIssues: coverage.issues,
    releaseCorrectness,
    passed: releaseCorrectness === "PASS",
  };
}

export function gateText(summary) {
  const lines = [
    `Release correctness: ${summary.releaseCorrectness}`,
    `Tier A first-class qualification: ${summary.tierAQualification}`,
    `External live-provider coverage: ${summary.externalCoverage}`,
    `Urma regression evidence: ${summary.regressionEvidence.length > 0 ? summary.regressionEvidence.join(" | ") : "none"}`,
  ];
  if (summary.tierAFailures.length > 0) lines.push(`Tier A qualification failures: ${summary.tierAFailures.join(" | ")}`);
  if (summary.externalCoverageIssues.length > 0) lines.push(`Live-provider coverage details: ${summary.externalCoverageIssues.join(" | ")}`);
  return lines.join("\n");
}

export async function runGate(options = {}) {
  const reportPath = path.resolve(options.reportPath ?? "compat/results/latest.json");
  const manifestPath = path.resolve(options.manifestPath ?? "compat/fixtures/providers.json");
  const releaseType = options.releaseType ?? process.env.RELEASE_TYPE ?? "rc";
  if (!["test", "rc", "stable"].includes(releaseType)) {
    throw new Error(`compatibility gate received unsupported release type ${JSON.stringify(releaseType)}`);
  }
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const summary = evaluateCompatibility(manifest, report);
  const lines = [gateText(summary)];
  if (releaseType === "test") {
    lines.push("release_type=test: diagnostic only; publication is disabled for test runs.");
  }
  return {
    summary,
    output: `${lines.join("\n")}\n`,
    shouldFail: summary.releaseCorrectness !== "PASS" && releaseType !== "test",
    reportPath,
  };
}

async function main() {
  const result = await runGate({
    reportPath: process.argv[2],
    manifestPath: process.argv[3],
  });
  process.stdout.write(result.output);
  if (result.shouldFail) {
    throw new Error(`Release correctness compatibility gate failed for release_type=${process.env.RELEASE_TYPE ?? "rc"}; inspect ${result.reportPath}.`);
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) await main();
