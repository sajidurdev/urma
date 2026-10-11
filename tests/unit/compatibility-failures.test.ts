import assert from "node:assert/strict";
import test from "node:test";
import { classifyFailure, responsibility } from "../../compat/failures.js";

const providerTimeout = "[local-path-redacted] failed with exit code 1: ERROR: [dailymotion] x8yfogk: Unable to download JSON metadata: HTTPSConnectionPool(host='graphql.api.dailymotion.com', port=443): Read timed out. (read timeout=10.0) (caused by TransportError(\"HTTPSConnectionPool(host='graphql.api.dailymotion.com', port=443): Read timed out. (read timeout=10.0)\"))";

test("provider metadata read timeouts retain upstream attribution across evidence operations", () => {
  for (const stage of ["resolve", "inspect", "frame", "multiple-frames", "cadence", "overview", "caption-read"]) {
    const failure = classifyFailure(stage, { code: "SOURCE_UNAVAILABLE", retryable: true, detail: providerTimeout });
    assert.equal(failure, "PROVIDER_NETWORK_TIMEOUT", stage);
    assert.equal(responsibility(failure), "upstream", stage);
  }
});

test("operation limits and proxy failures cannot be exempted as provider timeouts", () => {
  const cases = [
    { code: "MEDIA_ACQUISITION_TIMEOUT", detail: "yt-dlp exceeded its 180000 ms timeout and its process tree was terminated" },
    { code: "MEDIA_BUDGET_EXCEEDED", detail: "Remote media budget exceeded" },
    { code: "SOURCE_UNAVAILABLE", detail: "Safe Proxy upstream connection timed out" },
    { code: "SOURCE_UNAVAILABLE", detail: "Bounded section [0,2001) does not cover target 0 ms" },
    { code: "SOURCE_UNAVAILABLE", detail: "Unable to download JSON metadata: Read timed out" },
    { code: "SOURCE_UNAVAILABLE", detail: providerTimeout.replaceAll("graphql.api.dailymotion.com", "127.0.0.1") },
    { code: "SOURCE_UNAVAILABLE", detail: providerTimeout.replaceAll("graphql.api.dailymotion.com", "proxy.localhost") },
    { code: "INTERNAL_ERROR", detail: providerTimeout },
  ];
  for (const error of cases) {
    const failure = classifyFailure("cadence", { ...error, retryable: true });
    assert.equal(responsibility(failure), "Urma", error.detail);
  }
  for (const stage of ["cache", "provenance", "runner"]) {
    assert.equal(responsibility(classifyFailure(stage, {
      code: "SOURCE_UNAVAILABLE", retryable: true, detail: providerTimeout,
    })), "Urma", stage);
  }
  assert.equal(responsibility(classifyFailure("cadence", {
    code: "SOURCE_UNAVAILABLE", retryable: false, detail: providerTimeout,
  })), "Urma");
});

test("provider access restrictions keep their existing attribution", () => {
  assert.equal(classifyFailure("resolve", {
    code: "SOURCE_UNAVAILABLE", retryable: true, detail: "HTTP Error 429: Too Many Requests",
  }), "PROVIDER_403_OR_RATE_LIMIT");
  assert.equal(classifyFailure("resolve", {
    code: "SOURCE_UNAVAILABLE", retryable: true, detail: "Sign in to confirm you are not a bot",
  }), "FIXTURE_LOGIN_REQUIRED");
});
