# Contributing

Bug fixes, documentation corrections, tests, and improvements within Urma's
[supported scope](../README.md#supported-sources-and-limitations) are welcome.
For vulnerabilities, use the [private reporting process](SECURITY.md#report-a-vulnerability).

## Development setup

Use Node.js 24 from [`.node-version`](../.node-version) and the exact pnpm version
in [`package.json`](../package.json). Install `ffmpeg`, `ffprobe`, and `yt-dlp`
on `PATH`; the FFmpeg build must include `libx264`. Packaged Urma installations
manage their own native tools and do not add them to your development shell.
Tests use isolated temporary data and local media; HTTP fixtures need loopback access.

From the repository root, install dependencies and run the checks:

```sh
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` type-checks and runs the unit and integration suites. To run one
suite, use `pnpm test:unit` or `pnpm test:integration`; each builds first.
For package metadata, CI, or release changes, also run:

```sh
node scripts/validate-metadata.mjs
node --test scripts/tests/*.test.mjs
```

For documentation changes, validate links and anchors, parse JSON examples,
and check tool arguments against [`src/mcp/schemas.ts`](../src/mcp/schemas.ts),
public fields against [`src/mcp/projection.ts`](../src/mcp/projection.ts), and
settings against [`src/config.ts`](../src/config.ts). Keep the README for user
setup, [TOOLS](../docs/TOOLS.md) for contracts, and [SECURITY](SECURITY.md) for
trust boundaries. Finish with `git diff --check`.

## Prepare a change

Keep changes focused and follow nearby code and tests. Put coverage in
[`tests/unit`](../tests/unit) or [`tests/integration`](../tests/integration),
checking observable behavior and meaningful failure cases. Separate unrelated
refactors. Explain non-obvious constraints rather than narrating the implementation.

Tool arguments, public outputs, source references, timestamps, pagination,
configuration, and limits are client contracts. Update schemas, projections,
tests, and the tool reference together when changing them. Preserve existing
investigations and saved evidence when adding optional features.

## Engineering invariants

- Keep source identity, snapshot revision, and content hashes distinct. Cache
  keys include the snapshot and applicable timing/crop contract; equal request
  parameters alone do not prove equal content.
- Investigations stay pinned to their snapshots. Pin local video/sidecar bytes;
  pin remote captions on first successful acquisition. Repair must preserve
  pinned content rather than silently substitute changed provider data.
- Frame timestamps describe requests, not measured selected-frame timestamps.
  Keep local container origins, caption timing, and remote section timing aligned.
  Remote sections need validated format and timeline coverage. The time-zero
  HLS exception must retain its first-frame equivalence and timing checks.
- Count only returned evidence as observed. Cached or scan-only frames do not
  close gaps. Preserve crops and nominal/requested/decoded timing distinctions;
  sampling never proves continuous coverage.
- Panels, rulers, hints, and grouping are presentations or analysis. Keep
  canonical frames and every original observation/resource available. Grouping
  must not change evidence counts, gaps, authorization, or source identity.
- Resource authorization belongs to an investigation's returned artifacts.
  Cache hits and guessed hashes never grant access. Resource reads validate
  saved bytes and do not reacquire missing evidence or add observations.
- Bound acquisition, analysis, memory allocations, output, and subprocess work.
  Cancellation must clean up process trees and temporary files. Shared work
  stops only when its last observer detaches. Failed work cannot be recorded
  as a successful acquisition; earlier independently validated outputs may remain.
- Keep schema compatibility explicit; do not silently reinterpret incompatible
  stored data. Signed cadence cursors are process-local and restart-sensitive.
- Stage installations separately under one lock, verify them before activation,
  and replace the active selector atomically. Do not overwrite a running generation
  or add network acquisition to normal launcher startup.

All acquisition paths must preserve the [file, network, subprocess, and untrusted-content
boundaries](SECURITY.md#trust-boundaries). Follow existing validation paths when
adding a source, media format, or analysis option.

## Releases and pull requests

The [CI workflow](workflows/ci.yml) tests supported Node versions. The
[release workflow](workflows/release.yml) qualifies the packed artifact across
six native targets and supported Node versions, runs compatibility gates, and
publishes npm packages and GitHub Releases. Use those workflows; a local test run does
not replace release qualification.

Native tool pins live in [`src/distribution/manifest.ts`](../src/distribution/manifest.ts).
When changing FFmpeg pins, check the [upstream retention policy](https://github.com/FFmpeg-Builds/FFmpeg-Builds#release-retention-policy).
Leave package versions and publication to the owner or designated maintainers
unless they request a version change.

Pull requests should explain the problem, resulting behavior, and validation.
Include reproduction steps for fixes and state any check that failed or could
not run. Keep the final title and description aligned with the submitted change.

## License

Contributions are submitted under [Apache License 2.0](../LICENSE), subject to
its contribution terms. Submit only material you have the right to contribute,
and retain applicable third-party licenses and attribution notices.
