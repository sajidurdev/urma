# Contributing

<p align="center">
  <img src="assets/contribution.png" alt="Contributing to Urma" width="100%" />
</p>

For behavior changes, run the commands below and update the relevant tests and
documentation. Preserve the documented evidence, security, and distribution
boundaries.

## Development setup

Install the locked dependencies from the repository root:

```sh
pnpm install --frozen-lockfile
```

Build and type-check the project:

```sh
pnpm build
pnpm exec tsc -p tsconfig.json --noEmit
```

Run the unit and integration suites:

```sh
pnpm exec node --test dist/tests/unit/*.test.js
pnpm exec node --test dist/tests/integration/*.test.js
```

## Change expectations

- Preserve the five-tool MCP surface and its JSON-RPC behavior.
- Keep evidence bounded, investigation-scoped, and provenance-bearing.
- Keep subprocesses on the approved managed runtime paths and preserve the
  local-file and remote-source security boundaries.
- Update the relevant documentation and tests when behavior changes.
- Use comments for non-obvious invariants or trade-offs. Keep local comments
  short and remove comments that only restate the next line.

The native distribution and release workflow qualify the packed npm artifact
on six platforms. Changes to installation, launchers, managed binaries, or
release metadata require the corresponding distribution checks to remain
passing.
