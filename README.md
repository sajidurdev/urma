# Urma

<div align="center">
  <img src="assets/urma-banner.png" alt="Urma" width="100%" />
  <br /><br />
  <strong>Deterministic, local-first video evidence acquisition over MCP.</strong>
  <br />
  A stdio MCP server for bounded caption and visual evidence.
  <br /><br />
  <a href="#install-and-connect-a-host">Install</a>
  ·
  <a href="#tools">Tools</a>
  ·
  <a href="#configuration">Configuration</a>
  ·
  <a href="#documentation">Documentation</a>
  <br /><br />
  <sub><code>@urma/mcp</code> · MCP stdio · Node.js 24 LTS</sub>
</div>

<br />

Urma resolves a finite video source, records the resolution snapshot, and
returns bounded caption or visual evidence with provenance. The MCP host owns
the questions, reasoning, and final interpretation.

Urma exposes five tools:

| Tool | Returns |
| --- | --- |
| `inspect_video` | A source snapshot and a new investigation reference. |
| `search_transcript` | Literal matches in one selected caption track. |
| `read_transcript` | Timestamped caption segments in a bounded interval. |
| `get_overview` | A 12-cell sparse visual locator. |
| `get_frames` | Exact JPEG points, ordered sparse points, or a fixed-cadence schedule. |

The server uses MCP stdio. A host starts one Urma process for a session and
owns its lifecycle. Urma does not run a daemon or expose an HTTP API.

## Install and connect a host

### Requirements

- Native Node.js 24 LTS (`>=24 <25`).
- A user-owned local filesystem for Urma's data root.
- One of these runtime targets: Windows x64 or arm64, macOS x64 or arm64, or
  Linux x64 or arm64 with glibc.

Urma installs the pinned FFmpeg, ffprobe, and yt-dlp artifacts it needs. Do
not install those tools separately for the packaged runtime. Urma does not
install or manage Node.js.

### Install the runtime

Run the npm bootstrap with Node.js 24:

```sh
npx -y @urma/mcp@latest setup
```

Setup downloads the release-manifest artifacts, verifies them, runs native and
persisted-runtime MCP qualification, and publishes a complete immutable
generation. If setup fails during an update, the previously active generation
remains selected.

The default data roots are:

| Platform | Root |
| --- | --- |
| Windows | `%LOCALAPPDATA%\\Urma` |
| macOS | `~/Library/Application Support/Urma` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/urma` |

Use `--data-dir PATH` with `setup`, or set `URMA_DATA_DIR`, to select another
user-owned local directory. Network and UNC paths are outside the supported
installation boundary.

### Register a generic JSON host

If the host uses the usual `mcpServers` JSON shape, setup can add the `urma`
entry and preserve the other entries in the file:

```sh
npx -y @urma/mcp@latest setup --client generic --config "/absolute/path/to/mcp.json"
```

The configuration file path must be absolute. The resulting entry has this
shape; use the absolute paths printed by setup:

```json
{
  "mcpServers": {
    "urma": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/Urma/launcher-v1.mjs"],
      "env": {
        "URMA_DATA_DIR": "/absolute/path/to/Urma"
      }
    }
  }
}
```

On Windows, use the path escaping required by JSON. The `command` and the
launcher path must be absolute. The launcher selects the installed generation
and starts the local Urma runtime; use the npm package only for setup and
version checks.

Host registration and runtime installation are reported separately. A healthy
runtime can be left installed when the configuration file cannot be written.
After registration, restart the host and check that it lists the five tools
above.

For a host with a different configuration format, create the equivalent
stdio entry with the same absolute Node executable, launcher path, and
`URMA_DATA_DIR` value.

## Tools

Call `inspect_video` first for a new source. It accepts an HTTP(S) URL, an
allowed local path, or a previously returned `sourceRef`. It rejects sources
that do not define one finite video timeline. The default
`freshness: "reuse"` uses the latest stored snapshot. Set
`freshness: "refresh"` to resolve the source again instead of reusing the
latest snapshot. Every later tool call uses the returned `investigationRef`.

Use captions to locate likely time ranges, `get_overview` to locate visual
moments, and `get_frames` to verify selected moments. These tools expose
different observations:

- Caption search and reads are limited to the selected source-provided track.
- An overview is a sparse locator with up to 12 returned cells.
- A frame burst is an ordered set of requested points.
- A cadence request is a finite list of exact point requests. It reports each
  page slot as `success`, `error`, or `unfinished`.

All tool calls after inspection require the investigation reference. A source
cache can be reused across investigations, but evidence presentation is
recorded per investigation.

### Source and caption inputs

Urma accepts:

- A generic HTTP(S) video URL admitted by the remote source policy.
- A supported single-video YouTube URL.
- A local video path under a root listed in `URMA_LOCAL_ROOTS`.

Local caption sidecars are optional. Urma checks the video basename with `.vtt`
first and `.srt` second. Local paths remain disabled when
`URMA_LOCAL_ROOTS` is empty.

`search_transcript` accepts either one `query` or a `queries` array. Its
default mode is `phrase`; `terms` requires every normalized term to occur in a
cue. Search is literal and case-insensitive after NFKC normalization. A
matching caption is a lead for visual verification, not visual proof.

`read_transcript` requires a source-global half-open interval,
`[startMs,endMs)`. It returns at most 200 segments or 16,000 caption
characters per page. Use `nextCursor` to continue a partial result.

### Visual inputs

`get_overview` accepts an optional source-global interval. It requests 12
temporally distributed cells. The returned timestamps are the samples that
were observed; they do not describe continuous coverage.

`get_frames` accepts one of these requests:

| Request | Contract |
| --- | --- |
| `points` | 1–12 unique timestamps, each before the source duration. |
| `burst` | A half-open interval and 2–12 ordered samples. |
| `cadence` | A half-open interval and a positive integer `cadenceMs`. |

For `points` and `burst`, the default presentation is `individual`. Set
`presentation: "panel"` to receive one derived JPEG panel plus links to the
canonical frame artifacts. A panel contains at most 12 cells and preserves
request order.

Cadence requests are paged. The default page maximum is 12 targets and the
default schedule maximum is 120 targets. Continue with the returned opaque
`nextCursor`; do not construct a cursor yourself. A cadence schedule is
discrete evidence and does not cover the time between its targets.

## Resources and errors

Successful evidence results include investigation-scoped resource links. An
artifact can be reopened through
`urma://investigation/{investigationId}/artifact/{artifactHash}` only after
that investigation has received it in a tool result. Reopening an artifact
does not add temporal coverage.

The state resource is
`urma://investigation/{investigationId}/state`. It contains persisted
acquisition, cache, and presentation state for that investigation.

Top-level MCP failures return `isError: true` with a JSON text object containing
`code`, `retryable`, and `detail`. A cadence page can instead return an error
in an individual slot and continue with other targets.

## Evidence rules

- A complete caption miss means no match in the selected caption track under
  the requested matching rules. It says nothing about uncaptioned audio or
  video.
- `get_overview` and frame bursts provide sample points. They do not establish
  continuous visual coverage.
- `get_frames` exact points are independent evidence items. A panel is a
  derived presentation of those items and has no separate timestamp identity.
- `partial: false` means the eligible result set was established within the
  applicable search or response limits. It does not turn caption matching or
  sparse sampling into an exhaustive claim about the source.
- Cached media is transport state until a tool result presents it to an
  investigation.

See [Evidence Model](docs/EVIDENCE_MODEL.md) for the full contract.

## Limits

The following defaults come from the runtime configuration:

| Limit | Default |
| --- | ---: |
| Single caption search result limit | 5, maximum 20 |
| Caption query length | 256 characters |
| Batched caption queries | 20 queries, 20 merged hits, 16,000 returned characters |
| Caption read page | 200 segments or 16,000 characters |
| Overview request | 12 requested cells |
| Explicit frame request | 12 points or burst samples |
| Cadence page | 12 targets |
| Cadence schedule | 120 targets |
| Inline image response | 8 MiB |
| Resource read | 32 MiB |
| Targeted media acquisition | 64 MiB |
| Navigation media acquisition | 256 MiB |
| Reusable evidence media | 512 MiB |
| Remote acquisition wall time | 180,000 ms |

The environment variables below override the tunable limits. Values for byte
limits are bytes; the remote wall limit is milliseconds. Each value must be a
positive integer. `URMA_MAX_FRAME_SCHEDULE_PAGE_TARGETS` cannot exceed 12.

| Variable | Overrides |
| --- | --- |
| `URMA_MAX_TARGETED_MEDIA_BYTES` | Targeted media limit. |
| `URMA_MAX_NAVIGATION_COPY_BYTES` | Navigation media and timeline-validation limit. |
| `URMA_MAX_REUSABLE_EVIDENCE_MEDIA_BYTES` | Reusable evidence media limit. |
| `URMA_MAX_REMOTE_ACQUISITION_WALL_MS` | Remote acquisition wall-time limit. |
| `URMA_MAX_FRAME_SCHEDULE_PAGE_TARGETS` | Cadence page limit. |
| `URMA_MAX_FRAME_SCHEDULE_TARGETS` | Cadence schedule limit. |

## Configuration

| Variable | Purpose |
| --- | --- |
| `URMA_DATA_DIR` | Selects the persistent Urma data root. |
| `URMA_LOCAL_ROOTS` | Platform-delimited list of roots allowed for local videos and sidecars. |
| `URMA_ALLOW_UNC` | Allows UNC paths when set to `1` or `true`; the path must still be under an allowed root. |
| `URMA_DEBUG` | Writes opt-in acquisition and subprocess diagnostics to stderr when set to `1` or `true`. |
| `URMA_DEBUG_FILE` | Appends those diagnostics to a caller-selected JSONL file. |

The packaged launcher uses the selected generation's absolute native-tool
paths. It does not look up FFmpeg, ffprobe, or yt-dlp through `PATH`.

## CLI and maintenance

The npm entry point exposes setup and version checks:

```sh
npx -y @urma/mcp@latest --version
npx -y @urma/mcp@latest setup
```

After setup, run the read-only doctor through the persistent launcher:

```sh
/absolute/path/to/node /absolute/path/to/Urma/launcher-v1.mjs doctor
```

Doctor checks the selected runtime, Node version, SQLite/FTS5, native-tool
versions, storage, blob access, local roots, and frame-schedule limits. It
prints its report to stderr and exits with status 0 when all checks pass, or 1
when a check fails.

The launcher also provides local generation recovery:

```sh
/absolute/path/to/node /absolute/path/to/Urma/launcher-v1.mjs rollback
/absolute/path/to/node /absolute/path/to/Urma/launcher-v1.mjs recover
```

`rollback` selects the retained previous generation after integrity and state
compatibility checks. `recover` restores the selection recorded in
`ACTIVE.backup.json`. Set `URMA_DATA_DIR` for a non-default data root.

Normal MCP startup selects one generation for the process. It does not invoke
npm, make a network request, check for updates, modify `PATH`, or download
dependencies. A later setup affects new processes only.

## Boundaries

Urma v0.1 does not perform speech-to-text, OCR, embeddings, vector search,
semantic ranking, VLM or LLM calls, summarization, object recognition, or
automatic scene understanding. It does not select playlist items or access
live, private, paywalled, login-required, or DRM-protected media. It does not
provide audio evidence through MCP, arbitrary HTTP serving, accounts, cloud
sync, dashboards, hosted multi-tenant isolation, background indexing, or
persistent telemetry.

The host decides what evidence to request and whether the returned evidence is
enough for a conclusion.

## Security

Local paths require explicit allowed roots. Remote HTTP(S) work uses a
process-local Safe Proxy that validates destinations and DNS results before
connecting. Installed native tools are receipt-bound and hash-checked before
first use. Subprocesses use argument arrays, `shell: false`, an allowlisted
environment, bounded output, deadlines, cancellation, and process-tree
cleanup.

These controls protect the local application boundary under the trusted
Node/FFmpeg/ffprobe/yt-dlp runtime model. They are not an operating-system
sandbox against a compromised trusted executable.

See [Security](docs/SECURITY.md) for the full boundary and failure behavior.

## Development

```sh
pnpm build
pnpm exec tsc -p tsconfig.json --noEmit
pnpm exec node --test dist/tests/unit/*.test.js
pnpm exec node --test dist/tests/integration/*.test.js
```

The tests cover source resolution, caption selection and limits, cache and
investigation isolation, frame identity, bounded acquisition, subprocess
handling, diagnostics, MCP protocol behavior, installation generations,
archive extraction, selector atomicity, rollback, corruption detection, and
host registration.

## Documentation

- [Product scope](docs/PRODUCT_SCOPE.md) — current v0.1 behavior and exclusions.
- [Architecture](docs/ARCHITECTURE.md) — runtime layers, persistence, caching, and acquisition decisions.
- [Evidence Model](docs/EVIDENCE_MODEL.md) — what each result means and what it cannot establish.
- [Security](docs/SECURITY.md) — path, network, subprocess, installation, and cache controls.
