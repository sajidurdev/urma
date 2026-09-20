import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { evaluateCompatibility, gateText, runGate } from "../check-compatibility-gate.mjs";

const manifest = [
  { provider: "Tier A pass", tier: "A", url: "https://example.test/a" },
  { provider: "Tier B fixture", tier: "B", url: "https://example.test/b" },
];

function passResult(provider = "Tier A pass", tier = "A") {
  return {
    provider,
    tier,
    classification: tier === "A" ? "FIRST_CLASS_CANDIDATE" : "BEST_EFFORT_PASS",
    fixtureOutcome: "PRIMARY_PASSED",
    fixtureAttempts: [{ status: "PASS" }],
    resolve: { status: "PASS" },
    singleton: { status: "PASS" },
    timeline: { status: "PASS" },
    inspect: { status: "PASS" },
    frames: { exact: { status: "PASS" }, multiple: { status: "PASS" } },
    cadence: { status: "PASS" },
    overview: { status: "PASS" },
    cache: { status: "PASS" },
    provenance: { status: "PASS" },
    restart: { enabled: true, status: "PASS" },
    refresh: { enabled: true, status: "PASS" },
    failures: [],
  };
}

function failingResult(provider, tier, classification, failure) {
  return {
    ...passResult(provider, tier),
    classification,
    fixtureOutcome: classification === "UNTESTED"
      ? "PROVIDER_UNAVAILABLE_OR_BLOCKED"
      : "UNSUPPORTED_OR_REGRESSION",
    fixtureAttempts: [{ status: "FAIL", error: { code: "SOURCE_UNAVAILABLE", detail: "fixture failed" } }],
    resolve: { status: classification === "UNTESTED" ? "UNTESTED" : "PASS" },
    cadence: { status: classification === "PARTIAL_PASS" ? "FAIL" : "NOT_RUN" },
    failures: [failure],
  };
}

function report(results) {
  return { results };
}

test("all Tier A passes while an external Tier B block leaves correctness green", () => {
  const summary = evaluateCompatibility(manifest, report([
    passResult(),
    failingResult("Tier B fixture", "B", "BLOCKED", {
      class: "PROVIDER_403_OR_RATE_LIMIT",
      responsibility: "upstream",
      blocking: true,
      observedError: "runner IP blocked",
    }),
  ]));

  assert.equal(summary.releaseCorrectness, "PASS");
  assert.equal(summary.tierAQualification, "PASS");
  assert.equal(summary.externalCoverage, "INCOMPLETE");
  assert.deepEqual(summary.regressionEvidence, []);
  assert.equal(summary.passed, true);
});

test("Tier A UNTESTED blocks release correctness", () => {
  const summary = evaluateCompatibility(manifest, report([
    failingResult("Tier A pass", "A", "UNTESTED", {
      class: "FIXTURE_LOGIN_REQUIRED",
      responsibility: "fixture",
      blocking: true,
      observedError: "login required",
    }),
    passResult("Tier B fixture", "B"),
  ]));

  assert.equal(summary.releaseCorrectness, "FAIL");
  assert.equal(summary.tierAQualification, "INCOMPLETE");
  assert.equal(summary.passed, false);
});

test("Tier A PARTIAL_PASS blocks release correctness", () => {
  const summary = evaluateCompatibility(manifest, report([
    failingResult("Tier A pass", "A", "PARTIAL_PASS", {
      class: "FRAME_FAILED",
      responsibility: "Urma",
      blocking: true,
      observedError: "cadence failed",
    }),
    passResult("Tier B fixture", "B"),
  ]));

  assert.equal(summary.releaseCorrectness, "FAIL");
  assert.equal(summary.tierAQualification, "INCOMPLETE");
});

test("Tier A external block still blocks because Tier A is incomplete", () => {
  const summary = evaluateCompatibility(manifest, report([
    failingResult("Tier A pass", "A", "BLOCKED", {
      class: "PROVIDER_403_OR_RATE_LIMIT",
      responsibility: "upstream",
      blocking: true,
      observedError: "provider rejected runner",
    }),
    passResult("Tier B fixture", "B"),
  ]));

  assert.equal(summary.releaseCorrectness, "FAIL");
  assert.equal(summary.tierAQualification, "INCOMPLETE");
});

test("Tier B known transport limitation is visible but non-blocking", () => {
  const summary = evaluateCompatibility(manifest, report([
    passResult(),
    failingResult("Tier B fixture", "B", "PARTIAL_PASS", {
      class: "ACQUISITION_FAILED",
      responsibility: "transport",
      blocking: true,
      observedError: "Bounded section [0,2001) does not cover target 0 ms",
    }),
  ]));

  assert.equal(summary.releaseCorrectness, "PASS");
  assert.equal(summary.externalCoverage, "INCOMPLETE");
  assert.deepEqual(summary.regressionEvidence, []);
});

test("a blocking Urma regression remains publication-blocking even in Tier B", () => {
  const summary = evaluateCompatibility(manifest, report([
    passResult(),
    failingResult("Tier B fixture", "B", "BLOCKED", {
      class: "INTERNAL_BUG",
      responsibility: "Urma",
      blocking: true,
      observedError: "unexpected internal failure",
    }),
  ]));

  assert.equal(summary.releaseCorrectness, "FAIL");
  assert.equal(summary.externalCoverage, "INCOMPLETE");
  assert.equal(summary.regressionEvidence.length, 1);
});

test("gate output keeps correctness, Tier A, coverage, and regression status separate", () => {
  const summary = evaluateCompatibility(manifest, report([
    passResult(),
    failingResult("Tier B fixture", "B", "BLOCKED", {
      class: "PROVIDER_403_OR_RATE_LIMIT",
      responsibility: "upstream",
      blocking: true,
      observedError: "runner IP blocked",
    }),
  ]));
  const output = gateText(summary);

  assert.match(output, /Release correctness: PASS/u);
  assert.match(output, /Tier A first-class qualification: PASS/u);
  assert.match(output, /External live-provider coverage: INCOMPLETE/u);
  assert.match(output, /Urma regression evidence: none/u);
});

test("release_type=test reports a failed correctness gate but exits without publishing", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "urma-compatibility-gate-"));
  try {
    const reportPath = path.join(directory, "report.json");
    const manifestPath = path.join(directory, "manifest.json");
    writeFileSync(reportPath, JSON.stringify(report([
      failingResult("Tier A pass", "A", "UNTESTED", {
        class: "FIXTURE_LOGIN_REQUIRED",
        responsibility: "fixture",
        blocking: true,
        observedError: "login required",
      }),
      passResult("Tier B fixture", "B"),
    ])));
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const result = await runGate({
      reportPath,
      manifestPath,
      releaseType: "test",
    });

    assert.equal(result.shouldFail, false);
    assert.match(result.output, /Release correctness: FAIL/u);
    assert.match(result.output, /release_type=test: diagnostic only; publication is disabled/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
