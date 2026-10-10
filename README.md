# Urma

<div align="center">
  <img src="https://raw.githubusercontent.com/sajidurdev/urma/main/assets/urma-banner.png" alt="Urma" width="100%" />
  <br /><br />
  <strong>Retrieve video captions and frames through MCP.</strong>
  <br />
  A stdio MCP server for bounded caption and visual evidence.
  <br /><br />
  <a href="#try-urma">Try Urma</a>
  ·
  <a href="#install-and-connect-a-host">Install</a>
  ·
  <a href="#tools">Tools</a>
  ·
  <a href="#configuration">Configuration</a>
  ·
  <a href="#documentation">Documentation</a>
  <br /><br />
  <sub><code>urma-mcp</code> · MCP stdio · Node.js 22.16+ (22.x), 24.x, 26.x</sub>
</div>

<br />

> **Release candidate:** Use the `rc` npm tag for RC testing.

Urma retrieves captions and sampled frames from videos with a known end time.
Each result identifies its source snapshot and requested timestamps or range.
The host chooses what to retrieve, interprets the results, and decides how to
process or send the evidence to a model.

Urma runs locally and stores its cache on your filesystem. Remote videos still
require network access.

The server uses MCP stdio. A host starts one Urma process for a session and
owns its lifecycle. Urma does not run a daemon or expose an HTTP API.

## Requirements

- Native Node.js `>=22.16.0 <23`, `>=24.0.0 <25`, or `>=26.0.0 <27`.
- A user-owned local filesystem with at least 1 GiB free for Urma's data root.
- One of these runtime targets: Windows x64 or arm64, macOS x64 or arm64, or
  Linux x64 or arm64 with glibc.

Urma installs the pinned FFmpeg, ffprobe, and yt-dlp artifacts it needs. Do
not install those tools separately for the packaged runtime. Urma does not
install or manage Node.js.

## Try Urma

1. Install the current RC with `npx -y urma-mcp@rc setup`.
2. [Register your MCP host](#register-a-generic-json-host), then restart it.
3. Give the host a video URL or allowed local path and ask it to locate a moment
   using captions or an overview.
4. Request exact frames around that moment to verify the visual claim.

Example prompt (replace `<video URL>` with your source):

> Inspect this product-demo video: `<video URL>`. Use captions to find where the presenter
> mentions dark mode, use the overview to locate the settings screen, then
> request exact frames around that timestamp to verify whether the dark-mode
> toggle is enabled. If the returned frames do not show the toggle clearly,
> say that the evidence is insufficient.

## Install and connect a host

### Install the runtime

Run the npm bootstrap with a supported Node.js version:

```sh
npx -y urma-mcp@rc setup
```

The `rc` tag can move between candidates. To find its exact version without
installing it:

```sh
npm view urma-mcp dist-tags.rc
```

For a repeatable install, replace `rc` in the setup command with the exact
version returned above.

Setup downloads and verifies the pinned native tools, checks that the installed
runtime can serve MCP requests, and selects the new installation for future
launches. Each installation is stored in a separate directory called a
generation. If setup fails during an update, the previously active generation
remains selected.

The default data roots are:

| Platform | Root |
| --- | --- |
| Windows | `%LOCALAPPDATA%\Urma` |
| macOS | `~/Library/Application Support/Urma` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/urma` |

Use `--data-dir PATH` with `setup`, or set `URMA_DATA_DIR`, to select another
user-owned local directory. Network and UNC paths are outside the supported
installation boundary.

### Register a generic JSON host

If the host uses the usual `mcpServers` JSON shape, setup can add or update the
`urma` entry and preserve other entries. For an existing `urma` object, setup
replaces `command`, `args`, and `env.URMA_DATA_DIR` while preserving other host
options and environment values:

```sh
npx -y urma-mcp@rc setup --client generic --config "/absolute/path/to/mcp.json"
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
After registration, restart the host and check that it lists the [five tools](#tools).

For a host with a different configuration format, create the equivalent
stdio entry with the same absolute Node executable, launcher path, and
`URMA_DATA_DIR` value.

## Using Urma

### Tools

| Tool | Returns |
| --- | --- |
| `inspect_video` | A source snapshot and a new investigation reference. |
| `search_transcript` | Literal matches in one selected caption track. |
| `read_transcript` | Timestamped caption segments in a bounded interval. |
| `get_overview` | A visual overview with up to 12 sampled cells. |
| `get_frames` | Exact JPEG points, ordered sparse points, or a fixed-cadence schedule. |

Call `inspect_video` for a new source, then use its `investigationRef` for each
evidence request. A typical search starts with captions or an overview to find
a time range, then uses `get_frames` to check selected moments.

### Source and caption inputs

`inspect_video` accepts a policy-approved HTTP(S) source, a local path under
`URMA_LOCAL_ROOTS`, or a returned `sourceRef`. By default,
`freshness: "reuse"` reuses a remote snapshot; local files and sidecars are
checked again. Use `freshness: "refresh"` to resolve the source again. Local
`.vtt` and `.srt` sidecars are supported. See
[Product scope](docs/PRODUCT_SCOPE.md#source-admission) for supported sources.
The [Evidence Model](docs/EVIDENCE_MODEL.md) covers caption-track selection,
search, and pagination.

Caption search and reads use one source-provided track; Urma does not
transcribe speech. A caption match can locate a moment to verify with frames,
but it does not establish that a visual event occurred.

### Visual inputs

`get_overview` returns up to 12 sparse locator samples. `get_frames` supports
explicit points, ordered bursts, and paged cadence schedules. The
[Evidence Model](docs/EVIDENCE_MODEL.md) defines request bounds, panel output,
pagination, and the limits of each result.

### Example tool arguments

For a local video, first add its parent directory to `URMA_LOCAL_ROOTS` in the
host's Urma environment and restart the host. Call `inspect_video` with the
absolute path to your file:

```json
{ "source": "/absolute/path/to/video.mp4" }
```

Use the returned `investigationRef` in subsequent calls. For example, these
`get_frames` arguments request a panel at 1 and 5 seconds from a video longer
than 5 seconds. Replace the example reference with the value from inspection:

```json
{
  "investigationRef": "urma:investigation:0123456789abcdef0123456789abcdef",
  "request": { "kind": "points", "timesMs": [1000, 5000] },
  "presentation": "panel"
}
```

To continue a cadence page, pass `investigationRef` and the returned
`nextCursor` as `cursor`, without a new `request`.

### Resources and errors

Successful evidence results include resource links for artifacts already
presented to that investigation. Reopening an artifact does not add temporal
coverage. The state resource exposes persisted acquisition and presentation
state. See the [Evidence Model](docs/EVIDENCE_MODEL.md#resources-and-state) for
resource templates and authorization rules.

Top-level MCP failures return `isError: true` with a JSON text object
containing `code`, `retryable`, and `detail`. A cadence page can report a failed
slot while continuing with other targets.

### Evidence rules

For caption search, `partial: false` means all matches under the selected
track's matching rules were returned. It says nothing about uncaptioned
speech or visual events. Sampled frames describe only the returned points; they
do not establish coverage between them.

See [Evidence Model](docs/EVIDENCE_MODEL.md) for the full contract.

## Configuration and troubleshooting

### Limits

Runtime defaults are:

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

### Configuration

| Variable | Purpose |
| --- | --- |
| `URMA_DATA_DIR` | Selects the persistent Urma data root. |
| `URMA_LOCAL_ROOTS` | Platform-delimited list of roots allowed for local videos and sidecars. |
| `URMA_ALLOW_UNC` | Allows UNC paths when set to `1` or `true`; the path must still be under an allowed root. |
| `URMA_DEBUG` | Writes opt-in acquisition and subprocess diagnostics to stderr when set to `1` or `true`. |
| `URMA_DEBUG_FILE` | Appends diagnostics to a JSONL file when `URMA_DEBUG` is enabled. |

Set these variables in the host's Urma `env` entry, then restart the host.
Separate local roots with `;` on Windows and `:` on macOS/Linux. Use absolute
paths so root selection does not depend on the host's working directory.

The packaged launcher uses the selected generation's absolute native-tool
paths. It does not look up FFmpeg, ffprobe, or yt-dlp through `PATH`.

### CLI and maintenance

The npm entry point exposes setup and version checks:

```sh
npx -y urma-mcp@rc --version
npx -y urma-mcp@rc setup
```

The `npx` version command reports the npm candidate's version, not the installed
generation. To check the installed generation, use the Node and launcher paths
printed by setup.

Before using launcher `--version`, `doctor`, `rollback`, or `recover`, set
`URMA_DATA_DIR` if setup used a custom data root.

```sh
"/absolute/path/to/node" "/absolute/path/to/Urma/launcher-v1.mjs" --version
```

After setup, run the read-only doctor through the persistent launcher:

```sh
"/absolute/path/to/node" "/absolute/path/to/Urma/launcher-v1.mjs" doctor
```

In PowerShell, prefix the quoted executable path with `&`:

```powershell
& "C:\path\to\node.exe" "C:\path\to\Urma\launcher-v1.mjs" doctor
```

Doctor checks the selected runtime, Node version, SQLite, native-tool
versions, storage, blob access, local roots, and frame-schedule limits. It
prints its report to stderr and exits with status 0 when no check fails
(warnings are allowed), or 1 when a check fails.

To diagnose host behavior, use the host's `URMA_LOCAL_ROOTS` and other Urma
settings. If setup did not complete, report its error instead.

The launcher also provides local generation recovery:

```sh
"/absolute/path/to/node" "/absolute/path/to/Urma/launcher-v1.mjs" rollback
"/absolute/path/to/node" "/absolute/path/to/Urma/launcher-v1.mjs" recover
```

`rollback` selects the retained previous generation after integrity and state
compatibility checks. `recover` restores the selection recorded in
`ACTIVE.backup.json`.

Normal MCP startup selects one generation for the process. It does not invoke
npm, make a network request, check for updates, modify `PATH`, or download
dependencies. A later setup affects new processes only.

## Boundaries

Urma v0.1 does not transcribe audio, recognize objects or actions, or call a
model. It supports finite videos without authentication or DRM. See
[Product scope](docs/PRODUCT_SCOPE.md) for supported sources and exclusions.

## Security

Local paths require explicit allowed roots. Remote HTTP(S) work uses a
process-local Safe Proxy that validates destinations and DNS results before
connecting. Filesystem-backed probe and extraction inputs are passed to FFmpeg
and ffprobe through a file descriptor with an `fd`-only protocol allowlist.
Installed native tools are receipt-bound and hash-checked before first use.
Subprocesses use argument arrays, `shell: false`, an allowlisted environment,
bounded output, deadlines, cancellation, and process-tree cleanup.

These controls protect the local application boundary under the trusted
Node/FFmpeg/ffprobe/yt-dlp runtime model. They are not an operating-system
sandbox against a compromised trusted executable.

See [Security](docs/SECURITY.md) for the full boundary and failure behavior.

## Development

Use the Node.js 24.21.0 version pinned in `.node-version` and the pnpm version
declared in `package.json` for development and publishing. The supported runtime
versions are listed under [Requirements](#requirements). See the
[development prerequisites](docs/CONTRIBUTING.md#development-setup) for native
tools used by the tests. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm check
```

Contributions are welcome. Follow the [contribution guide](docs/CONTRIBUTING.md)
for code structure, documentation standards, and pull request expectations.

## RC testing

External testers can report installation, MCP-host, or source/provider problems
through the [RC bug-report template](https://github.com/sajidurdev/urma/issues/new?template=bug-report.md).
Include reproduction steps, your OS/architecture, Node.js and host versions,
the installed Urma version, and expected versus actual behavior. For a
source-specific issue, include a public URL or a description of a reproducible
local video. Add relevant [doctor output](#cli-and-maintenance) if setup
completed; otherwise include the setup error. Remove credentials, private
URLs, and personal paths before posting logs.

## License

Urma is licensed under [Apache License 2.0](LICENSE). Third-party dependencies
and downloaded native tools retain their own licenses. The installed
generation's `licenses/` directory records native component licenses and
upstream references; preserve the accompanying upstream notices when
redistributing those tools. Urma's license does not grant rights to videos or
captions retrieved from other sources.

## Documentation

- [Product scope](docs/PRODUCT_SCOPE.md) — current v0.1 behavior and exclusions.
- [Architecture](docs/ARCHITECTURE.md) — runtime layers, persistence, caching, and acquisition decisions.
- [Evidence Model](docs/EVIDENCE_MODEL.md) — what each result means and what it cannot establish.
- [Security](docs/SECURITY.md) — path, network, subprocess, installation, and cache controls.
- [Contributing](docs/CONTRIBUTING.md) — local setup, validation commands, and change expectations.
