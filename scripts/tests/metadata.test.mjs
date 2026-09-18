import assert from "node:assert/strict";
import test from "node:test";
import { assertPublishingIdentity, readMetadata, validateMetadata, validateReleaseRequest } from "../validate-metadata.mjs";

test("current metadata agrees, including repository .git normalization", () => {
  const { pkg, server } = readMetadata();
  assert.equal(validateMetadata(pkg, server).package_name, pkg.name);
  assertPublishingIdentity(pkg);
});

test("reject metadata drift and malformed npm/stdio records", () => {
  const mutations = [
    s => { s.name = "io.github.other/urma"; },
    s => { s.version = "999.0.0"; },
    s => { s.packages[0].identifier = "other"; },
    s => { s.packages[0].version = "latest"; },
    s => { s.repository.url = "https://github.com/other/urma"; },
    s => { s.repository.source = "gitlab"; },
    s => { s.packages[0].transport = { type: "streamable-http" }; },
    s => { s.packages = []; },
    s => { s.description = ""; },
    s => { s.$schema = "https://example.com/new-schema"; },
    s => { s.packages[0].runtimeArguments = "invalid"; },
  ];
  for (const mutate of mutations) {
    const { pkg, server } = readMetadata();
    mutate(server);
    assert.throws(() => validateMetadata(pkg, server));
  }
});

test("consistent metadata alone cannot change publishing identity", () => {
  const { pkg, server } = readMetadata();
  pkg.name = server.packages[0].identifier = "unexpected-package";
  validateMetadata(pkg, server);
  assert.throws(() => assertPublishingIdentity(pkg), /publishing identity/u);
});

test("release requests follow the actual default branch and retain dist-tags", () => {
  for (const [releaseType, version, distTag] of [["rc", "1.2.3-rc.2", "rc"], ["stable", "1.2.3", "latest"]]) {
    const request = { releaseType, defaultBranch: "trunk", refType: "branch", refName: "trunk" };
    assert.equal(validateReleaseRequest({ version }, request).dist_tag, distTag);
    for (const change of [{ defaultBranch: "" }, { defaultBranch: undefined }, { refName: "main" }, { refType: "tag" }]) {
      assert.throws(() => validateReleaseRequest({ version }, { ...request, ...change }));
    }
    assert.throws(() => validateReleaseRequest({ version: releaseType === "rc" ? "1.2.3" : "1.2.3-rc.2" }, request));
  }
  assert.equal(validateReleaseRequest({ version: "1.2.3-rc.2" }, { releaseType: "test", defaultBranch: "trunk", refType: "branch", refName: "feature" }).dist_tag, "");
});
