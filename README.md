# Urma

<div align="center">
  <img src="https://raw.githubusercontent.com/sajidurdev/urma/main/assets/urma-banner.png" alt="Urma" width="100%" />
  <br /><br />
  <strong>Retrieve video captions and frames through MCP.</strong>
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

Urma gives MCP clients access to captions and frames from public video URLs
and local video files. Search captions for a topic, browse a visual overview,
or retrieve frames at specific timestamps.

Urma runs locally and keeps its cache on your filesystem. Your MCP client
starts the server over stdio and receives the requested text and images.
Remote videos require network access.

## Try Urma

1. Install with `npx -y urma-mcp@latest setup`.
2. [Connect your MCP client](#register-a-generic-json-host) and restart it.
3. Give the client a video URL and a question about the video.

For example, replace `<video URL>` in this prompt with a public product demo:

> In this demo, where does the presenter discuss dark mode, and is the toggle
> enabled on screen? `<video URL>`

For a local file, [allow its directory](#local-videos) first. See
[supported sources](docs/PRODUCT_SCOPE.md#source-admission) for provider and
format limitations.

## Install and connect a host

### Requirements

- Native Node.js `>=22.16.0 <23`, `>=24.0.0 <25`, or `>=26.0.0 <27`.
- Windows x64/arm64, macOS x64/arm64, or Linux x64/arm64 with glibc.
- A user-owned local directory with at least 1 GiB free for the installation.

Setup installs the required versions of FFmpeg, ffprobe, and yt-dlp. You only
need to install Node.js yourself.

### Install the runtime

```sh
npx -y urma-mcp@latest setup
```

Setup downloads and verifies the native tools, tests the installed server, and
prints the paths needed by your MCP client. Updates are installed separately
from the current runtime; a failed update leaves the current installation
selected.

For a repeatable installation, pin the package version:

```sh
npx -y urma-mcp@0.1.0 setup
```

Urma uses these default data directories:

| Platform | Directory |
| --- | --- |
| Windows | `%LOCALAPPDATA%\Urma` |
| macOS | `~/Library/Application Support/Urma` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/urma` |

To choose another directory, pass `--data-dir PATH` to setup or set
`URMA_DATA_DIR`. The data directory must be on a user-owned local filesystem;
network and UNC locations are unsupported.

### Register a generic JSON host

For clients that use an `mcpServers` JSON configuration, setup can write the
entry for you:

```sh
npx -y urma-mcp@latest setup --client generic --config "/absolute/path/to/mcp.json"
```

The configuration path must be absolute. Setup preserves unrelated entries.
If an `urma` entry already exists, setup updates `command`, `args`, and
`env.URMA_DATA_DIR`, leaving its other settings in place.

To configure a client manually, use the absolute paths printed by setup:

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

On Windows, escape backslashes in JSON, for example `C:\\Users\\you\\AppData\\Local\\Urma`.
For clients with a different configuration format, use the same Node
executable, launcher, and environment settings in a stdio server entry.

Restart the client after saving the configuration. It should list the five
tools below. If registration fails, setup reports that separately from the
runtime installation; you can still configure the installed server manually.

## Tools

| Tool | Use it to |
| --- | --- |
| `inspect_video` | Open a video and list its duration, metadata, and caption tracks. |
| `search_transcript` | Find literal phrases or terms in a caption track. |
| `read_transcript` | Read timestamped captions for a time range. |
| `get_overview` | Browse up to 12 visual samples from a video or time range. |
| `get_frames` | Retrieve JPEG frames at chosen times, in a burst, or at a fixed interval. |

Start with `inspect_video`. For an allowed local file, its arguments are:

```json
{ "source": "/absolute/path/to/demo.mp4" }
```

Use the returned `investigationRef` for subsequent calls. For example, these
`search_transcript` arguments find mentions of dark mode:

```json
{
  "investigationRef": "urma:investigation:0123456789abcdef0123456789abcdef",
  "query": "dark mode"
}
```

Replace the example reference with the one from inspection. If a match occurs
near 10 seconds, these `get_frames` arguments request a panel at 10 and 11
seconds from a video longer than 11 seconds:

```json
{
  "investigationRef": "urma:investigation:0123456789abcdef0123456789abcdef",
  "request": { "kind": "points", "timesMs": [10000, 11000] },
  "presentation": "panel"
}
```

All times are integer milliseconds from the start of the video. Caption
search uses source-provided captions; Urma does not transcribe audio. Overviews
and frame requests show selected moments, so brief events between samples can
be missed.

The [tool reference](docs/EVIDENCE_MODEL.md) covers all arguments, pagination,
result fields, and timing guarantees.

## Configuration

Set environment variables in the client's Urma `env` entry and restart the
client after changing them.

### Local videos

Local file access is disabled by default. Set `URMA_LOCAL_ROOTS` to the
directories that Urma may read. Use absolute paths, separated by `;` on
Windows or `:` on macOS/Linux. For example:

```json
{
  "URMA_LOCAL_ROOTS": "/home/you/Videos:/home/you/Demos"
}
```

This example is an `env` fragment for macOS/Linux. On Windows, a single root
might be `"URMA_LOCAL_ROOTS": "C:\\Users\\you\\Videos"`.

Urma looks for captions beside the video: `demo.vtt` first, then `demo.srt` for
`demo.mp4`. Sidecars must also be inside an allowed root. Symlinks and junctions
are checked against their resolved locations.

| Variable | Purpose |
| --- | --- |
| `URMA_DATA_DIR` | Installation, database, and cache directory. |
| `URMA_LOCAL_ROOTS` | Directories allowed for local videos and caption sidecars. |
| `URMA_ALLOW_UNC` | Set to `1` or `true` to allow UNC video inputs under an allowed root. This does not allow a UNC data directory. |
| `URMA_DEBUG` | Set to `1` or `true` to write diagnostic logs to stderr. |
| `URMA_DEBUG_FILE` | Append diagnostic logs to a JSONL file when debugging is enabled. |

### Acquisition limits

These limits bound downloads and frame schedules. Override them with positive
integer values; byte limits use bytes and the timeout uses milliseconds.

| Variable | Default |
| --- | ---: |
| `URMA_MAX_TARGETED_MEDIA_BYTES` | 67,108,864 (64 MiB) |
| `URMA_MAX_NAVIGATION_COPY_BYTES` | 268,435,456 (256 MiB); also used for timeline validation |
| `URMA_MAX_REUSABLE_EVIDENCE_MEDIA_BYTES` | 536,870,912 (512 MiB) |
| `URMA_MAX_REMOTE_ACQUISITION_WALL_MS` | 180,000 (3 minutes) |
| `URMA_MAX_FRAME_SCHEDULE_PAGE_TARGETS` | 12; cannot be increased above 12 |
| `URMA_MAX_FRAME_SCHEDULE_TARGETS` | 120 |

Inline image responses have a fixed 8 MiB ceiling, and resource reads have a
fixed 32 MiB ceiling. Tool-specific caption and sampling limits are listed in
the [tool reference](docs/EVIDENCE_MODEL.md).

## CLI and maintenance

Run setup again to update Urma. Restart the MCP client to use the new
installation; an already running server keeps its current version.

The npm version command reports the package selected by the tag:

```sh
npx -y urma-mcp@latest --version
```

To check the installed version or diagnose a problem, use the Node and launcher
paths printed by setup. If setup used a custom data directory, set
`URMA_DATA_DIR` to that directory before running launcher commands:

```sh
"/absolute/path/to/node" "/absolute/path/to/Urma/launcher-v1.mjs" --version
"/absolute/path/to/node" "/absolute/path/to/Urma/launcher-v1.mjs" doctor
```

In PowerShell, prefix a quoted executable path with `&`:

```powershell
& "C:\path\to\node.exe" "C:\path\to\Urma\launcher-v1.mjs" doctor
```

Doctor checks the runtime, native tools, storage, local roots, and configured
limits without changing the installation. Its report goes to stderr. Exit
status `0` means no check failed, although warnings may remain; `1` means at
least one check failed. Use the same `URMA_DATA_DIR`, `URMA_LOCAL_ROOTS`, and
other Urma settings as your MCP client.

If an update causes problems, the launcher provides two recovery commands:

```sh
"/absolute/path/to/node" "/absolute/path/to/Urma/launcher-v1.mjs" rollback
"/absolute/path/to/node" "/absolute/path/to/Urma/launcher-v1.mjs" recover
```

`rollback` selects the retained previous installation after integrity and
state-compatibility checks. `recover` restores the installation selection
saved in `ACTIVE.backup.json`. Restart the MCP client afterward.

## Reporting problems

Use the [bug-report template](https://github.com/sajidurdev/urma/issues/new?template=bug-report.md).
Include reproduction steps, your OS and architecture, Node.js and MCP client
versions, and the installed Urma version. For source-specific problems,
include a public URL or describe a local file that reproduces the failure.

Include doctor output if setup completed, or the setup error if it did not.
Remove credentials, private URLs, and personal paths before posting logs.

## Security

Urma restricts local files to configured roots, validates remote destinations,
and verifies its managed native tools. It is intended for one trusted local
user. See [Security](docs/SECURITY.md) for the controls, assumptions, and MCP
integration considerations.

## Development

From the repository root, using Node.js 24 and the pnpm version in
`package.json`:

```sh
pnpm install --frozen-lockfile
pnpm check
```

See [Contributing](docs/CONTRIBUTING.md) for native-tool prerequisites, code
structure, and validation commands.

## Documentation

- [Product scope](docs/PRODUCT_SCOPE.md): supported sources and limitations.
- [Tool reference](docs/EVIDENCE_MODEL.md): arguments, results, and examples.
- [Architecture](docs/ARCHITECTURE.md): source snapshots, acquisition, caching, and installation design.
- [Security](docs/SECURITY.md): filesystem, network, subprocess, and resource boundaries.
- [Contributing](docs/CONTRIBUTING.md): development setup and contribution guidelines.

## License

Urma is licensed under [Apache License 2.0](LICENSE). Dependencies and downloaded
native tools retain their own licenses. The installed runtime's `licenses/`
directory contains native component licenses and upstream references; preserve
their notices when redistributing those tools. Urma's license does not grant
rights to retrieved videos or captions.
