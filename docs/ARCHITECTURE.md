# Architecture

Urma is an MCP adapter around a deterministic evidence service. The host
chooses the question and the next observation. Urma resolves the source,
acquires bounded media or captions, validates the result, stores provenance,
and records what the investigation received.

## Runtime shape

```text
MCP host ──stdio──> MCP server ──> EvidenceService
                                      ├─ SourceResolver
                                      ├─ TranscriptAcquirer
                                      ├─ OverviewAcquirer
                                      ├─ FrameAcquirer
                                      ├─ SQLite store
                                      └─ content-addressed blob store

CLI ──────────────> setup / doctor
launcher-v1.mjs ──> selected immutable generation

Evidence acquisition ──> Safe Proxy / generation-local yt-dlp, ffprobe, ffmpeg
```

The MCP server validates inputs and service results with the schemas in
`src/mcp/schemas.ts`. It then sends a compact projection through MCP. The
projection keeps identities, timestamps, completeness, pagination, provenance,
and resource references. Internal state summaries and transport details do not
form part of the public projection.

The server exposes five tools and two resource templates. `stdio.ts` owns the
MCP transport and shuts down the application on input close or process
termination. Protocol messages use stdout. Opt-in diagnostics use stderr and,
when configured, a JSONL file.

There is no semantic ranking, planner, media analyst, or model call inside
Urma. Those responsibilities remain with the MCP host.

## Distribution and startup

The npm package is the bootstrap and release channel. On an existing native
Node.js 24 LTS installation, `urma setup`:

1. Detects the supported platform target and validates the user-owned local
   data root.
2. Copies the packaged Urma runtime and materializes the exact native artifacts
   named by the release manifest.
3. Verifies archive contents, executable identities, and hashes.
4. Runs native qualification and a persisted-runtime MCP smoke test.
5. Writes the receipt and publishes a complete immutable generation.
6. Atomically selects that generation for new launcher processes.

The generation contains the runtime, `ffmpeg`, `ffprobe`, `yt-dlp`, assets,
licensing notices, and `receipt.json`. The persistent root contains the
launcher, the active selector, installation generations, staging data, state,
and the application database/blob store.

`ACTIVE.json` is the authoritative generation selector. Setup writes a
temporary selector, flushes it, and renames it into place. Before an update,
the previous selector is retained in `ACTIVE.backup.json`. A new setup does not
overwrite an existing generation in place. Staging and the final generation
share the installation filesystem, and setup operations use one installation
lock.

The launcher reads the selected generation, validates its receipt and contained
paths, and starts the recorded runtime with absolute paths. It also accepts
the local `doctor`, `rollback`, and `recover` commands. `setup` must run from
the npm entry point. `rollback` verifies the retained generation and persistent
state before selecting it. `recover` restores the selector recorded in
`ACTIVE.backup.json`.

Normal MCP startup does not invoke npm, inspect `PATH`, download dependencies,
or check provider freshness. A process keeps the generation selected when it
starts; a later setup affects later processes.

The supported targets are:

```text
windows-x64
windows-arm64
macos-x64
macos-arm64
linux-x64-glibc
linux-arm64-glibc
```

Linux requires glibc. The data root must be a user-owned local filesystem path.

## Source identity and snapshots

The resolver admits two source kinds:

```text
local
remote
```

YouTube is normalized as a remote source. A logical source reference identifies
the source identity rather than a particular delivery URL:

```text
urma:source:local:<32 lowercase hexadecimal characters>
urma:source:remote:v1:<64 lowercase hexadecimal characters>
```

The resolver accepts a supported HTTP(S) URL, a root-confined local path, or a
previously returned source reference. For a source reference, `reuse` loads
the latest stored snapshot and `refresh` resolves the source again. A remote
refresh records a new snapshot; a local refresh produces a new revision when
the pinned video or selected sidecar has changed.

Each snapshot records:

- the source identity and revision;
- observation time and a positive finite duration;
- the validated timeline basis (`progressive`, `hls`, `dash`, or `container`);
- safe metadata, chapters, capabilities, and provider-safe origins;
- caption track summaries and remote format candidates; and
- the resolver, normalization, and source-policy versions used for admission.

Remote delivery locators are leases, not source identity. A format identifier
is a selector inside a snapshot-bound acquisition operation and is not a
global cache key. Remote timeline admission validates a progressive/container
probe, a finite HLS media playlist with `#EXT-X-ENDLIST`, or a static DASH MPD
with a finite `mediaPresentationDuration`. Dynamic, live, and multi-entry
results are rejected.

For a local source, Urma first resolves the path and configured roots to real
paths, then pins the video bytes. A local revision includes the pinned video
content and the selected caption sidecar's path/content/format or its explicit
absence. File statistics alone do not define the revision.

## Investigations and evidence

`inspect_video` creates an investigation that pins:

```text
(sourceRef, snapshotRevision, durationMs)
```

Source-level cache and singleflight work can be reused. Presentations are
recorded separately for each investigation. A new investigation starts with
zero presented evidence even when the required bytes already exist in the
cache.

The normal evidence path is:

1. Resolve or reuse a finite source snapshot.
2. Choose and acquire one caption track when a transcript operation needs it.
3. Acquire a 12-cell sparse overview for visual navigation when requested.
4. Acquire exact frames at explicit points, ordered burst points, or fixed
   cadence targets.
5. Record the returned evidence and its resource authorization in the
   investigation.

### Captions

Caption acquisition parses JSON3, WebVTT, and SRT data into timestamped
segments. A selected track remains identified by its track reference, language,
kind, display name, and provider identifier when available. Urma does not merge
tracks, translate text, repair automatic captions, or run speech-to-text.

Search uses normalized literal matching over one selected track. Read requests
use a source-global half-open interval. Search and read presentations retain
the track identity and requested scope.

### Overviews

An overview has a fixed request count of 12. The acquisition prefers a native
storyboard and otherwise decodes navigation media. The returned cells are
locator samples. Their observed coverage is `sample-points-only` with
`continuous: false`; the implementation does not infer a sampling resolution
from cell spacing.

The overview panel is a locator artifact. Its cells carry sample provenance and
map to the panel's investigation-scoped resource. The overview path does not
turn those samples into exact-frame evidence.

### Exact frames

An exact-frame request is evaluated against validated video timing. Urma asks
for the first decodable presentation frame at or after the requested source
timestamp. A physical decoder seek position is an implementation detail and is
not reported as the selected presentation time in the current MCP schedule
schema.

Explicit point requests and ordered bursts use the same canonical frame
acquirer and content-addressed artifact identity. Remote HLS acquisition uses
bounded sections around the requested target and validates the resulting video
stream timing before committing the section.

An exact-frame panel is produced after the canonical frames exist. It uses up
to 12 request-ordered frames in a deterministic row-major layout. The panel is
a non-canonical locator artifact; each cell maps to its canonical frame by
timestamp and investigation-scoped resource.

### Fixed cadence

A cadence request defines a half-open interval and a positive integer cadence.
For index `i`, the target is:

```text
startMs + i * cadenceMs, while target < endMs
```

The server computes the complete target count before acquisition. Pages contain
at most the configured page limit, defaulting to 12, and a schedule contains at
most the configured total limit, defaulting to 120. Each slot retains its
schedule index and is `success`, `error`, or `unfinished`.

The continuation cursor is opaque and signed. It binds the investigation,
source snapshot, duration, representation, timeline and selection contracts,
schedule definition, total target count, and next index. A later call must use
the returned cursor without a new request. There is no future-page media cache;
successful slots use the ordinary exact-frame artifacts.

## Cache, artifacts, and storage

Urma separates three concerns:

```text
source identity → snapshot identity → artifact content identity
```

An artifact has one role:

- `locator`: overview images and derived panels;
- `transport`: navigation media and bounded media sections; or
- `evidence`: exact frames, ordered sparse frame points, and transcript artifacts.

Request keys identify deterministic operations by source revision, normalized
parameters, and contract version. Artifact content is identified by its
SHA-256 digest. A content-addressed blob is stored at:

```text
blobs/<first two hash characters>/<next two hash characters>/<sha256>
```

Blob writes go through a temporary file, validation, hashing, and atomic
promotion. A corrupt existing blob is quarantined before replacement. Reads
verify the expected path, size, and SHA-256 digest.

SQLite is authoritative for source records, snapshots, locators,
investigations, transcript tracks and segments, artifacts, acquisitions,
derivations, presentations, and presentation authorization. The current schema
version is 5. Incompatible pre-launch state is rejected; Urma does not migrate
it silently.

An artifact resource is readable only when its artifact content has been
presented to the requesting investigation. The resource namespace is:

```text
urma://investigation/<investigationId>/artifact/<artifactHash>
```

Reading an authorized resource reopens existing content. It does not create a
presentation or add temporal coverage. The investigation state resource is
derived from the persisted records and is bounded by the resource limit.

## Remote acquisition and subprocesses

The process-local Safe Proxy listens on loopback and supports HTTP forwarding
and TLS-preserving HTTPS `CONNECT`. It resolves DNS, validates every returned
address, and dials the validated address directly. Each redirect, manifest,
fragment, caption, storyboard, and delivery destination enters the same checks.

Remote yt-dlp calls receive an internal hermetic argument profile and the Safe
Proxy. Direct FFmpeg and ffprobe HTTP(S) inputs receive an explicit proxy and a
restricted protocol allowlist. Child environments are allowlisted, and proxy
configuration is rejected from those environments. Native executables are
generation-local and receipt-bound.

Subprocess output, media, manifests, and caption data have independent byte
limits. Timeouts and cancellation terminate the process tree. A failed or
cancelled acquisition does not create a successful cache record.

Equivalent deterministic acquisitions use singleflight. Each observer can
cancel independently. Shared work stops when no observer remains.

## Invariants

```text
Source is not an investigation.
Cache is not presented evidence.
Transport is not evidence.
Evidence presentation is investigation-scoped.
Every artifact has source, revision, producer, and content provenance.
Every expensive operation has a bounded budget and deadline.
Every cache promotion is validated and atomic.
Every failure remains explicit.
MCP stdout remains protocol-only.
```

The public evidence contract, including coverage and completeness semantics,
is defined in [Evidence Model](EVIDENCE_MODEL.md). The current release boundary
is defined in [Product scope](PRODUCT_SCOPE.md), and the threat model and
security controls are in [Security](SECURITY.md).
