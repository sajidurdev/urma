# Security

<p align="center">
  <img src="https://raw.githubusercontent.com/sajidurdev/urma/main/docs/assets/security.png" alt="Urma security" width="100%" />
</p>

Urma is intended for one trusted local user. Its controls restrict file access,
remote destinations, and native-tool execution within the application. They
assume a trusted operating system, Node.js, FFmpeg, ffprobe, and yt-dlp. Urma
is not an operating-system sandbox for a compromised executable.

## Local file boundary

Local input is disabled until `URMA_LOCAL_ROOTS` contains an allowed directory.
For each video or caption sidecar, Urma resolves the file and configured roots
to canonical paths, checks that the file remains inside a root, and requires
a regular file. Symlinks and junctions are checked against their resolved
targets.

UNC inputs require `URMA_ALLOW_UNC` set to `1` or `true` and must still pass
the root check. This setting applies to source files only. The installation
and persistent data directory must be local and accessible to the current
user. On macOS and Linux, setup also checks that the directory, or its nearest
existing parent, is owned by that user. Urma does not detect network storage
behind mapped drives or mount points.

Caption sidecars are checked beside the video as `<basename>.vtt`, then
`<basename>.srt`. The selected file is pinned with the video content and uses
the same path checks. The MCP response exposes an opaque source reference
rather than the canonical local path.

## Installation integrity

Setup verifies native archive hashes before extraction. Extraction rejects
absolute and traversal paths, unsafe names, duplicate or case-colliding
entries, and symlink escapes.

The runtime is staged on the installation filesystem. Before activation, it
must pass native-tool qualification, receipt checks, and a persisted-runtime
MCP smoke test. The receipt records installed component hashes, platform and
policy data, and qualification results.

Setup uses an installation lock and writes each version to a separate
immutable generation. It writes and flushes a temporary active selector before
atomically replacing `ACTIVE.json`. A failed update leaves the previous
selection in use.

`rollback` checks the retained installation's integrity and compatibility with
persistent state before selecting it. `recover` restores the selector saved
in `ACTIVE.backup.json`. See the [maintenance commands](../README.md#cli-and-maintenance).

## Runtime integrity

The launcher validates the Node.js version and platform, active selector,
generation receipt, state schema, and recorded executable paths. Runtime and
native-tool paths must identify regular files inside the selected generation;
the recorded Node executable and execution architecture are checked as well.

Packaged runtimes use the selected generation's FFmpeg, ffprobe, and yt-dlp
paths. Before a native tool is first used in a process, Urma checks its file
against the receipt hash and caches that result for the process. A missing or
modified executable fails the operation; Urma does not fall back to a binary
found on `PATH`.

## Remote URL and network boundary

Remote sources and their subresources must use HTTP or HTTPS on the default
port, without embedded credentials. Urma rejects local or non-public hostnames
and addresses, including private, loopback, link-local, metadata, multicast,
and reserved ranges. DNS results undergo the same address checks as literal
IP addresses.

The process-local Safe Proxy listens on `127.0.0.1` at an ephemeral port. It
supports HTTP forwarding and HTTPS `CONNECT` without terminating TLS. For
each connection, it checks the URL, resolves the hostname, validates every
returned address, and dials a selected validated address directly.

Redirects, delivery URLs, manifests, media fragments, captions, and storyboards
all use these checks. Accepting a hostname once does not authorize a different
address on a later resolution. Provider delivery URLs are temporary acquisition
data and are omitted from public source and artifact records.

Source admission separately checks that the result is one finite video and
rejects live, upcoming, authentication-required, paywalled, DRM-protected, and
multi-entry sources. See [Product scope](PRODUCT_SCOPE.md#source-admission).

These checks provide an application-level server-side request forgery (SSRF)
boundary. A compromised trusted executable could open a connection outside
that path. Preventing such connections requires operating-system or
infrastructure isolation.

## Subprocess controls

Native tools run with argument arrays, `shell: false`, hidden child windows
on Windows, and an allowlisted environment. Children do not inherit arbitrary
application state, credentials, browser profiles, proxy settings, or runtime
hooks.

The yt-dlp invocation disables ambient configuration, plugins, cookies,
external execution, cache, remote components, updates, playlist expansion,
and uncontrolled retries or concurrency. Its JavaScript runtime and FFmpeg
location are supplied from the selected installation.

Remote FFmpeg and ffprobe inputs use an explicit Safe Proxy and the protocol
list `http,https,tcp,tls,httpproxy`. Caller arguments cannot disable the proxy.
For filesystem-backed media, Urma opens a read-only regular file and supplies
a seekable `fd:` input with `-protocol_whitelist fd`. This prevents a local
manifest from resolving nested file or network references through those
wrappers. Setup qualifies seeking and frame extraction, including a check
that a nested DASH file reference is rejected.

The subprocess runner bounds stdout and stderr and enforces deadlines.
Timeouts and cancellation terminate the process tree. Nonzero exits and
output-limit breaches fail the operation.

## Acquisition and cache safety

Downloads have separate limits for targeted media, navigation media, reusable
media, and wall time. Exceeding a limit stops the process tree and removes
temporary acquisition data.

Media is checked for video streams, duration, timing, and size before storage.
JPEG output is checked for valid markers. Captions are parsed before their
database transaction; a cue larger than the response ceiling is rejected.
Failed or cancelled acquisition does not create a successful cache record.

Artifacts are stored by SHA-256. Writes use temporary files and atomic
promotion; reads verify the expected path, size, and hash. A missing or corrupt
artifact fails a resource read. Tool acquisition can replace invalid cached
content, but reading a resource does not trigger reacquisition.

## MCP integration

Caption text, metadata, and images are untrusted source content. Integrations
must keep that content separate from instructions when passing results to a
model. Network validation checks where content comes from; it does not make
captions truthful or source content appropriate to display.

Tool execution errors include a normalized code, retryability flag, and
redacted detail. URL-shaped diagnostics and local path patterns are redacted
from model-facing error text. Public projections omit raw resolver metadata
and internal transport fields.

Artifact resources are available only after the artifact has been returned to
that investigation. A guessed hash, cached content, or presentation to another
investigation does not grant access. These checks track returned evidence;
they do not authenticate users or provide multi-user isolation.

`URMA_DEBUG` and `URMA_DEBUG_FILE` enable diagnostic logs. Treat those logs as
sensitive operational data, protect the selected file, and review logs before
sharing them.
