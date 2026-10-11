# Architecture

<p align="center">
  <img src="https://raw.githubusercontent.com/sajidurdev/urma/main/docs/assets/architecture.png" alt="Urma architecture" width="100%" />
</p>

Urma separates MCP request handling from source resolution, media acquisition,
and persistence. `EvidenceService` coordinates those layers and records which
results were returned to each investigation.

## Runtime shape

```text
MCP client ──stdio──> MCP server ──> EvidenceService
                                       ├─ SourceResolver
                                       ├─ TranscriptAcquirer
                                       ├─ OverviewAcquirer
                                       ├─ FrameAcquirer
                                       ├─ SQLite store
                                       └─ content-addressed blob store

launcher-v1.mjs ──> selected installed runtime
acquisition ──────> Safe Proxy / yt-dlp / ffprobe / ffmpeg
```

`src/mcp/schemas.ts` validates tool inputs and service results. The projection
in `src/mcp/projection.ts` selects the public response fields, including source
references, timestamps, completeness, pagination, and resource links. Richer
acquisition and presentation records remain in storage.

The server exposes five tools and two resource templates. `stdio.ts` owns the
transport and shuts down the application when input closes or the process
terminates. Stdout carries protocol messages; opt-in diagnostics go to stderr
and optionally a JSONL file.

## Source identity and snapshots

A remote video's delivery URL can expire or change while the video remains
the same source. A local file can change at the same path. Urma therefore
separates source identity, snapshot revision, and artifact content identity.

```text
source reference → snapshot revision → acquired artifacts
```

Source references have these forms:

```text
urma:source:local:<32 lowercase hexadecimal characters>
urma:source:remote:v1:<64 lowercase hexadecimal characters>
```

`SourceResolver` accepts an HTTP(S) URL, an allowed local path, or a source
reference. With `reuse`, a known remote URL or source reference loads the
latest saved snapshot. `refresh` resolves it again. Direct local paths are
always checked and pinned again.

Remote resolution uses yt-dlp. YouTube single-video URLs have a dedicated
branch that checks the requested video ID; other URLs use the generic branch.
Both apply the remote source policy and validate a finite timeline. Admission
requires a valid progressive/container probe, a finite HLS media playlist with
`#EXT-X-ENDLIST`, or a static DASH MPD with a finite
`mediaPresentationDuration`. Live, dynamic, and multi-entry results are
rejected.

A remote refresh records a new snapshot. Delivery locators belong to that
snapshot's acquisition data and are treated as temporary leases. Format IDs
select representations within the snapshot; they are not global cache keys.

For local sources, the resolver checks canonical paths against allowed roots
and pins the video bytes. The revision includes the video's content and the
selected sidecar's path, content, and format, or its explicit absence. File
statistics alone do not determine whether the source changed.

Snapshots retain duration and timeline validation, observation time, safe
metadata, chapters, capabilities, caption tracks, format candidates, and the
policy and normalization versions used during resolution.

## Investigations and evidence

`inspect_video` creates an investigation tied to a source reference, snapshot
revision, and duration. Later tool calls use that saved snapshot.

Source-level caches can serve several investigations, but each investigation
records its own presentations. Finding an existing artifact in the cache does
not count as returning it to the caller. This separation lets resource reads
check that an investigation has actually received the requested content.

### Captions

`TranscriptAcquirer` parses JSON3, WebVTT, or SRT into timestamped segments
under a selected track. Tracks retain their language, kind, display name, and
provider identifier when available. Search performs normalized literal
matching; reads select segments overlapping a half-open time range.

Caption artifacts and presentations retain the selected track and request
scope. Urma does not merge tracks or generate transcripts from audio.

### Overviews

`OverviewAcquirer` requests 12 temporally distributed points. It prefers a
native storyboard and otherwise decodes navigation media. A short interval can
produce fewer distinct points.

The overview panel is a locator artifact. Each cell retains its sample
provenance; current producers report nominal timing. The response distinguishes
the requested interval from the returned sample timestamps and does not infer
continuous coverage from sample spacing.

Sample identity is also kept separately from transport reuse. A new interval
can select a subset of existing storyboard cells, while decoding new times
from cached navigation media produces new samples.

### Exact frames

`FrameAcquirer` validates video timing and selects the first decodable
presentation frame at or after each requested source time. Point requests,
bursts, and cadence schedules use the same frame acquisition path. Each JPEG
has a content hash and keeps its requested timestamp in the result.

Remote HLS acquisition can download a bounded section around a target instead
of a complete video. The section's requested bounds and validated video-stream
presentation timestamp (PTS) coverage are stored separately. Acquisition only
commits a section after media and timing validation succeed.

Decoder seeks use the container start time, which can differ from the first
video frame's PTS. A complete source copy can supply its first video frame for
a target before that frame. A bounded section ordinarily needs validated PTS
coverage of the target.

There is a narrow exception for source time zero in HLS. Urma compares the
section's first decoded RGB image and display geometry with the first decoded
frame from the selected rendition's initial media segment. Both must have a
positive video delay relative to their container start, and those delays must
match within 1 ms. The playlist must be finite, start at media sequence zero,
and have an end marker. A mismatch or unsupported playlist keeps the ordinary
coverage requirement. Sections for nonzero targets still require PTS coverage.

The public frame timestamps describe the requests. The current extraction
path does not expose a measured selected-frame PTS.

A panel is derived from successfully acquired JPEGs. It preserves their
request order and links back to the individual artifacts. Explicit requests
require all frames to succeed before panel composition. Cadence pages can
return mixed slot outcomes, but only an all-success page gets a panel.

### Fixed cadence

A cadence schedule computes targets from the original start time:

```text
target(i) = startMs + i * cadenceMs, while target(i) < endMs
```

The total count is checked before acquisition. Pages default to at most 12
targets, and schedules default to at most 120. Each slot retains its schedule
index and a `success`, `error`, or `unfinished` status.

Signed continuation cursors bind the investigation, snapshot, schedule, and
frame-selection contract to a next index. The signing key is process-local,
so a restart requires a new request for the schedule. Pages reuse ordinary
frame artifacts; future pages are not acquired in advance.

## Cache, artifacts, and storage

Request keys combine the source revision, normalized arguments, and contract
version. Artifact identities use the SHA-256 digest of their content. Keeping
these keys separate allows equivalent requests to share work without treating
parameters as proof of identical bytes.

Artifacts have one of three roles:

| Role | Content |
| --- | --- |
| `locator` | Overview images and derived frame panels. |
| `transport` | Navigation media and bounded media sections used for extraction. |
| `evidence` | Exact JPEG frames and transcript artifacts. |

Blobs use this layout under the data directory:

```text
blobs/<first two hash characters>/<next two hash characters>/<sha256>
```

Writes use a temporary file, validation, hashing, and atomic promotion. A
corrupt existing blob is quarantined before replacement. Reads check the
expected path, size, and digest. An acquisition can replace invalid cached
content; a resource read only reopens existing validated content.

SQLite stores sources, snapshots, delivery locators, investigations, caption
tracks and segments, artifacts, acquisitions, derivations, and presentations.
It also records which artifacts each investigation may read. The current
schema version is 5; incompatible database schemas are rejected rather than
silently migrated.

The state resource is derived from those persisted records. Like artifact
reads, it is bounded by the resource byte limit. See the
[tool reference](EVIDENCE_MODEL.md#resources-and-state) for public resource URIs.

Equivalent acquisitions share an in-flight operation through singleflight.
Observers can cancel independently; shared work stops when the last observer
detaches. Failed or cancelled work does not create a successful acquisition
record.

## Distribution and startup

The npm package supplies setup and release artifacts. On a supported native
Node.js installation, setup validates the local data directory, stages the
runtime and pinned native tools, verifies hashes and archive contents, and
runs native qualification plus a persisted-runtime MCP smoke test. Only a
qualified installation is selected for launch.

Each installation is stored in an immutable generation containing the runtime,
native tools, assets, license notices, and `receipt.json`. Setup operations use
one installation lock, with staging on the same filesystem as the final
generation. Updates do not overwrite a running generation.

`ACTIVE.json` selects the generation. Setup writes and flushes a temporary
selector, then atomically renames it into place. The previous selector is kept
in `ACTIVE.backup.json` for recovery.

`launcher-v1.mjs` validates the selected generation and receipt, then starts
the recorded runtime with absolute paths. A running process keeps that
generation; a later setup affects new processes. Normal startup does not
invoke npm, download dependencies, or check for updates.

The launcher also accepts `doctor`, `rollback`, and `recover`. Rollback checks
the retained generation's integrity and state compatibility. Recovery restores
`ACTIVE.backup.json`. Setup itself runs from the npm entry point.

## Network and native tools

Remote acquisition passes through a process-local Safe Proxy that validates
URLs and DNS results before dialing a selected address. yt-dlp uses fixed
arguments and an allowlisted environment. Remote FFmpeg and ffprobe inputs
receive an explicit proxy and restricted protocol list. Local media inputs
use a read-only file descriptor with an `fd`-only protocol list.

Packaged runtimes use generation-local, receipt-verified native executables.
Output and media byte limits, deadlines, cancellation, and process-tree
cleanup bound acquisition work. The [security documentation](SECURITY.md)
describes these controls and their trust assumptions in detail.
