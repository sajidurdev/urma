# Architecture

<p align="center">
  <img src="https://raw.githubusercontent.com/sajidurdev/urma/main/docs/assets/architecture.png" alt="Urma architecture" width="100%" />
</p>

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

The server exposes five tools and two resource templates. `stdio.ts` owns the
MCP transport and shuts down the application on input close or process
termination. Protocol messages go to stdout. Opt-in diagnostics go to stderr
and, when configured, a JSONL file.

## MCP request flow

1. Tool input and output schemas are defined in `src/mcp/schemas.ts` and
   registered by the MCP server. The server validates inputs and service
   results against those schemas and formats tool failures as MCP error results.
2. `inspect_video` resolves or reuses a source snapshot, records a new
   investigation pinned to that snapshot, and returns an `investigationRef`.
3. Evidence calls use that reference to load the pinned snapshot, then route
   caption or visual work through the corresponding acquirer. Acquirers may
   reuse cached content or acquire and validate new content.
4. The evidence service records acquisition and presentation state per
   investigation. The MCP server returns a compact public projection with
   identities, timestamps, completeness, pagination, provenance, and resource
   references. The public result omits internal state summaries and transport
   details.

## Distribution and startup

Setup validates the platform and local data root, copies the packaged runtime,
and installs the native artifacts named by the manifest. Before activation,
it verifies archive contents, executable identities, and hashes, then runs
native qualification and a persisted-runtime MCP smoke test. It writes the
receipt and atomically selects the complete immutable generation.

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

The launcher validates the selected generation's receipt and contained paths,
then starts the recorded runtime with absolute paths. Rollback verifies the
retained generation and persistent state before selecting it. Recovery restores
the selector recorded in `ACTIVE.backup.json`.

Normal MCP startup does not invoke npm, inspect `PATH`, download dependencies,
or check provider freshness. A process keeps the generation selected when it
starts; a later setup affects later processes.

See [Product scope](PRODUCT_SCOPE.md#distribution-and-persistence) for supported
platforms and the [README](../README.md#cli-and-maintenance) for launcher commands.

## Source identity and snapshots

The resolver admits `local` and `remote` sources.

Remote URLs use yt-dlp. YouTube single-video URLs enter a dedicated resolver
branch that checks the requested video ID. Other HTTP(S) URLs use the generic
remote branch. Both apply the remote source policy and finite timeline checks.
See [Product scope](PRODUCT_SCOPE.md#source-admission) for supported sources and
access limits.

A logical source reference identifies the source identity rather than a
particular delivery URL:

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

Source-level cache and in-flight work for equivalent requests can be reused.
Presentations are recorded separately for each investigation.

After inspection, each tool independently acquires the requested caption track,
overview, or frames and records the evidence presented to the investigation.
Caption retrieval and overviews are optional; neither is required before a
frame request.

### Captions

Caption acquisition parses JSON3, WebVTT, and SRT data into timestamped
segments. Search and read operations use one selected track and retain its
identity and requested scope. Matching, pagination, and completeness rules are
defined in [Caption evidence](EVIDENCE_MODEL.md#caption-evidence).

### Overviews

Overview acquisition prefers a native storyboard and otherwise decodes
navigation media. The resulting locator panel retains cell provenance and
resource mappings separately from canonical exact-frame artifacts. See
[Overview semantics](EVIDENCE_MODEL.md#overview-semantics) for the public contract.

### Exact frames

Explicit point requests and ordered bursts use the same canonical frame
acquirer and content-addressed artifact identity. Remote HLS acquisition uses
bounded sections around the requested target and validates the resulting video
stream timing before committing the section.

Decoder seeks use the container's start time, recorded separately from the
video stream's PTS coverage. The timing and source-start validation rules are
defined in [Evidence kinds](EVIDENCE_MODEL.md#evidence-kinds).

Panels are derived from acquired canonical frames. Each cell maps back to its
frame's timestamp and investigation-scoped resource; deriving a panel does not
change the canonical frame identities.

### Fixed cadence

The server validates the complete target count before acquisition, then
processes one page at a time through the exact-frame acquirer. Signed cursors
bind continuation to the investigation, source snapshot, schedule, and selection
contracts. There is no future-page media cache; successful slots use the
ordinary exact-frame artifacts. See
[Fixed-cadence schedules](EVIDENCE_MODEL.md#fixed-cadence-schedules) for target
calculation, page limits, statuses, and cursor use.

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
version is 5. Incompatible database schemas are rejected; Urma does not migrate
them silently.

Resource authorization and state projection are described in
[Resources and state](EVIDENCE_MODEL.md#resources-and-state).

## Remote acquisition and subprocesses

Remote acquisition routes through the process-local Safe Proxy and
generation-local, receipt-bound executables. Destination validation, filesystem
input restrictions, and subprocess limits are described in [Security](SECURITY.md).

Equivalent acquisitions share one in-flight operation (singleflight). Each
observer can cancel independently. Shared work stops when no observer remains.
A failed or cancelled acquisition does not create a successful cache record.
