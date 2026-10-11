# Contributing

<p align="center">
  <img src="https://raw.githubusercontent.com/sajidurdev/urma/main/docs/assets/contribution.png" alt="Contributing to Urma" width="100%" />
</p>

Bug fixes, documentation corrections, tests, and improvements within the
[product scope](PRODUCT_SCOPE.md) are welcome.

## Development setup

Use the Node.js 24 version in
[`.node-version`](https://github.com/sajidurdev/urma/blob/main/.node-version)
and the pnpm version in
[`package.json`](https://github.com/sajidurdev/urma/blob/main/package.json).
Tests also require `ffmpeg`, `ffprobe`, and `yt-dlp` on `PATH`, with an FFmpeg
build that includes `libx264`. Packaged installations manage their own native
tools; setup does not add those tools to your development shell's `PATH`.

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
```

Run the unit and integration suites with:

```sh
pnpm test:unit
pnpm test:integration
```

Each test command builds first. `pnpm check` runs the type-check and both
suites. For package metadata, CI, or release changes, also run:

```sh
node scripts/validate-metadata.mjs
node --test scripts/tests/*.test.mjs
```

The [CI workflow](https://github.com/sajidurdev/urma/blob/main/.github/workflows/ci.yml)
shows the native-tool setup used in CI. It runs on pull request updates and
pushes to `main` using Node.js 22.16.0 and the latest 22, 24, and 26 releases.

## Code structure

| Directory | Responsibility |
| --- | --- |
| [`src/mcp`](https://github.com/sajidurdev/urma/tree/main/src/mcp) | Tool schemas, response projections, and MCP transport. |
| [`src/evidence`](https://github.com/sajidurdev/urma/tree/main/src/evidence) | Request orchestration and presentation records. |
| [`src/sources`](https://github.com/sajidurdev/urma/tree/main/src/sources) | Source resolution and snapshots. |
| [`src/acquisition`](https://github.com/sajidurdev/urma/tree/main/src/acquisition) | Caption, overview, and media acquisition. |
| [`src/store`](https://github.com/sajidurdev/urma/tree/main/src/store) | SQLite records and blob storage. |
| [`src/distribution`](https://github.com/sajidurdev/urma/tree/main/src/distribution) | Installation, managed tools, receipts, and launchers. |

See [Architecture](ARCHITECTURE.md) for how these layers fit together. Place
tests in the corresponding
[`tests/unit`](https://github.com/sajidurdev/urma/tree/main/tests/unit) or
[`tests/integration`](https://github.com/sajidurdev/urma/tree/main/tests/integration)
suite, following nearby tests.

## Preparing a change

Keep each change focused on one problem. Follow the surrounding naming and
module structure, and separate unrelated formatting or refactoring work.
Tests should cover observable behavior and meaningful failure cases. Comments
should explain a non-obvious constraint or decision rather than repeat the
code.

Changes to tool arguments, source references, timestamps, pagination, or result
limits affect MCP clients. Update the relevant schemas, projections, tests,
and [tool reference](EVIDENCE_MODEL.md) together. Acquisition changes also need
to preserve [file, network, and subprocess controls](SECURITY.md) and the
investigation's record of returned evidence.

For documentation changes, check examples against
[`src/mcp/schemas.ts`](https://github.com/sajidurdev/urma/blob/main/src/mcp/schemas.ts),
response fields against
[`src/mcp/projection.ts`](https://github.com/sajidurdev/urma/blob/main/src/mcp/projection.ts),
and settings against
[`src/config.ts`](https://github.com/sajidurdev/urma/blob/main/src/config.ts).
Keep installation instructions in the README and detailed tool behavior in
the reference. Verify commands and links, explain placeholders, and keep
necessary limits next to the behavior they constrain.

## Installation and release changes

The [release workflow](https://github.com/sajidurdev/urma/blob/main/.github/workflows/release.yml)
qualifies the packed npm artifact on six platforms. Changes to setup,
launchers, managed binaries, or release metadata need the corresponding
qualification checks.

Pinned native versions live in
[`manifest.ts`](https://github.com/sajidurdev/urma/blob/main/src/distribution/manifest.ts).
When updating FFmpeg pins, check the
[BtbN retention policy](https://github.com/BtbN/FFmpeg-Builds#release-retention-policy)
and choose artifacts that will remain available for the supported release.

Releases are managed by the owner and designated core maintainers. Leave
package versions unchanged unless a maintainer requests a version change.

## Pull requests

Use a specific title. Explain the problem, the resulting behavior, and the
validation performed. Include reproduction steps for a bug and call out any
material limitation or check you could not run. Documentation-only changes
need examples, links, and implementation claims checked; code changes need
the relevant build and tests as well.

## License

Contributions are submitted under the project's
[Apache License 2.0](../LICENSE), subject to its contribution terms.
Contributors retain copyright in their contributions. Only submit material
you have the right to contribute, and retain applicable third-party license
and attribution notices.
