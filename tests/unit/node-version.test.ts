import assert from "node:assert/strict";
import test from "node:test";
import { nodeVersionIsSupported } from "../../src/distribution/platform.js";

test("Node support range accepts the maintained 22, 24, and 26 lines at their boundaries", () => {
  for (const version of [
    "22.16.0",
    "22.16.1",
    "22.99.99",
    "24.0.0",
    "24.99.99",
    "26.0.0",
    "26.99.99",
  ]) {
    assert.equal(nodeVersionIsSupported(version), true, version);
  }
});

test("Node support range rejects below-floor, odd, EOL, and above-current majors", () => {
  for (const version of [
    "20.19.0",
    "21.0.0",
    "22.15.999",
    "23.0.0",
    "25.0.0",
    "27.0.0",
  ]) {
    assert.equal(nodeVersionIsSupported(version), false, version);
  }
});

test("Node support checks reject malformed runtime versions", () => {
  for (const version of [
    "",
    "22",
    "22.16",
    "v22.16.0",
    "22.16.0-rc.1",
    "22.16.0garbage",
    "22.16.0.1",
    "022.16.0",
    "9007199254740992.0.0",
  ]) {
    assert.equal(nodeVersionIsSupported(version), false, JSON.stringify(version));
  }
});

test("Node support checks preserve the comparator-range parameter", () => {
  assert.equal(nodeVersionIsSupported("24.0.0", ">=24 <25"), true);
  assert.equal(
    nodeVersionIsSupported("24.0.0", ">=22.16.0 <23 || >=24.0.0 <25"),
    true,
  );
  assert.equal(nodeVersionIsSupported("24.0.0", ">=25 <26"), false);
  assert.equal(nodeVersionIsSupported("24.0.0", ">=24 <25 ||"), false);
});
