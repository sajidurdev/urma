# Contributing

<p align="center">
  <img src="https://raw.githubusercontent.com/sajidurdev/urma/main/docs/assets/contribution.png" alt="Contributing to Urma" width="100%" />
</p>

Contributions are welcome, including bug fixes, documentation corrections,
tests, and improvements within the [product scope](PRODUCT_SCOPE.md).

For behavior changes, run the commands below and update the relevant tests and
documentation. Preserve the documented evidence, security, and distribution
boundaries.

## Development setup

Use the Node.js 24 version in [`.node-version`](../.node-version) and the pnpm
version declared in `package.json`.
The test suites also use `ffmpeg`, `ffprobe`, and `yt-dlp` from `PATH`. Media
fixtures require an FFmpeg build with `libx264`. See
[`ci.yml`](../.github/workflows/ci.yml) for the CI tool setup and
[`manifest.ts`](../src/distribution/manifest.ts) for pinned native versions.
Packaged installations use their own managed tools; setup does not add them
to your development shell's `PATH`.

Install the locked dependencies from the repository root:

```sh
pnpm install --frozen-lockfile
```

Build and type-check the project:

```sh
pnpm build
pnpm typecheck
```

Run the unit and integration suites:

```sh
pnpm test:unit
pnpm test:integration
```

Each test script builds first. `pnpm check` runs the type-check and both suites.
For package metadata or CI/release changes, also run:

```sh
node scripts/validate-metadata.mjs
node --test scripts/tests/*.test.mjs
```

## Change expectations

- Keep each pull request focused on one problem. Separate unrelated refactors
  and formatting changes.
- Follow the surrounding module structure and naming. Put MCP schemas and
  projections in `src/mcp`, evidence orchestration in `src/evidence`, acquisition
  work in `src/acquisition`, and persistence in `src/store`.
- Place tests in the corresponding `tests/unit` or `tests/integration` suite.
  Test observable behavior and meaningful failure cases.
- Preserve the five-tool MCP surface and its JSON-RPC behavior.
- Preserve source references, timestamps, result limits, and the investigation's
  record of presented evidence.
- Keep subprocesses on the approved managed runtime paths and preserve the
  local-file and remote-source security boundaries.
- Update the relevant documentation and tests when behavior changes.
- Use comments for non-obvious invariants or trade-offs. Keep local comments
  short and remove comments that only restate the next line.

The native distribution and release workflow qualify the packed npm artifact
on six platforms. Changes to installation, launchers, managed binaries, or
release metadata require the corresponding distribution checks to remain
passing.

## Documentation quality

Check tool arguments against `src/mcp/schemas.ts` and public response fields
against `src/mcp/projection.ts`. Use `src/config.ts` for environment variables
and defaults. Keep setup instructions in the README and detailed evidence
semantics in `EVIDENCE_MODEL.md`.

Put prerequisites before commands, label placeholder values, and describe
limits beside the behavior they constrain. Remove repeated summaries and
claims that have no basis in the implementation.

Review AI-assisted changes as carefully as any other submission. Verify the
commands, links, examples, and claims, and report which checks you ran.

## Pull request structure

Use a specific title and organize the description around:

1. **Problem:** what is wrong or missing, with reproduction steps when relevant.
2. **Change:** what the patch does and any behavior or scope changes.
3. **Validation:** checks run and their results, including anything not tested.

For documentation-only changes, check examples, links, and consistency with
the implementation. Run the relevant build and test checks for code changes.
For installation or release changes, also check the qualification workflow in
`.github/workflows/release.yml`.

## License

Contributions are submitted under the project's [Apache License 2.0](../LICENSE),
subject to its contribution terms. Contributors retain copyright in their
respective contributions. Only submit material you have the right to
contribute, and retain applicable third-party license and attribution notices.
