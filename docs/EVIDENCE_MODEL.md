# Evidence model

<p align="center">
  <img src="https://raw.githubusercontent.com/sajidurdev/urma/main/docs/assets/evidence-model.png" alt="Urma evidence model" width="100%" />
</p>

Urma exposes five tools over MCP. Call `inspect_video` to open a source, then
use its `investigationRef` to request captions or images from that snapshot.

- [Inspect a video](#inspect_video)
- [Search or read captions](#caption-evidence)
- [Get a visual overview](#overview-semantics)
- [Get frames or a panel](#exact-frames-and-panels)
- [Sample at a fixed cadence](#fixed-cadence-schedules)
- [Read saved resources](#resources-and-state)

## Times and references

Times are nonnegative integer milliseconds from the start of the source.
An interval `[startMs, endMs)` includes its start and excludes its end. It must
satisfy `startMs < endMs`, with `endMs` no later than the video duration. A
point timestamp must be earlier than the duration.

A source reference identifies a local or remote video. An investigation
reference identifies the snapshot opened by inspection. An artifact reference
identifies saved content, such as a JPEG, by its SHA-256 hash. Treat these
references and pagination cursors as opaque values returned by the server.

The examples below use placeholder references. Replace them with values from
your calls. Examples with time ranges assume a video at least 30 seconds long.

## `inspect_video`

Open a URL, an allowed local file, or a previously returned `sourceRef`:

```json
{ "source": "/absolute/path/to/demo.mp4" }
```

| Argument | Required | Description |
| --- | --- | --- |
| `source` | Yes | HTTP(S) URL, local path, or `sourceRef`; up to 4,096 characters. |
| `freshness` | No | `reuse` (default) or `refresh`. |

Inspection returns `sourceRef`, `investigationRef`, source metadata and
validated duration, capabilities, caption tracks, cache information, and
`stateResource`. A source must describe one finite video; see
[Product scope](PRODUCT_SCOPE.md#source-admission) for accepted inputs.

For a known remote URL or a `sourceRef`, `reuse` opens the latest saved
snapshot. `refresh` resolves the source again. Passing a local path reads its
video and selected caption sidecar again, so changed bytes produce a new
revision. Passing a local `sourceRef` with `reuse` opens its saved snapshot
without rereading the path.

Each inspection creates a new investigation. Later calls remain tied to its
snapshot, even if another inspection refreshes the source. Caption reads and
overviews are optional; a frame request can follow inspection directly.

## Caption evidence

Urma uses source-provided captions and local sidecars. Supported formats are
JSON3, WebVTT, and SRT. It does not transcribe audio, merge tracks, translate
captions, or correct automatic captions.

Both caption tools accept an optional `trackRef` from `inspect_video`. When
omitted, Urma prefers manual captions, then local sidecars, automatic captions,
and tracks of unknown kind. Within each kind it prefers the original language,
then English, then stable lexical order. Responses identify the selected track
and its language, kind, display name, and provider identifier when available.

If no usable track is available, the call fails with `CAPTIONS_UNAVAILABLE`.
That differs from a successful search that returns no matches. Tracks marked
`unknown` may be listed by inspection but cannot be acquired without a known
origin.

### `search_transcript`

Find a phrase in the selected caption track:

```json
{
  "investigationRef": "urma:investigation:0123456789abcdef0123456789abcdef",
  "query": "dark mode"
}
```

| Argument | Required | Description |
| --- | --- | --- |
| `investigationRef` | Yes | Reference returned by inspection. |
| `query` or `queries` | Yes | Exactly one query string, or an array of 1–20 query strings. Each query must contain non-whitespace text and be at most 256 characters. |
| `trackRef` | No | Caption track to search. |
| `mode` | No | `phrase` (default) or `terms`. |
| `limit` | No | 1–20 results; default 5. For a batch, applies to each query before merging. |

Search normalizes Unicode with NFKC, ignores case, and treats separators as
spaces. `phrase` finds a normalized substring. `terms` requires every
normalized term to occur as a substring in the same cue. Matching is literal,
without semantic ranking.

A single-query hit includes the matching cue's text and timestamps, plus up to
one preceding and one following cue as context. For several queries, use
`queries` instead of `query`:

```json
{
  "investigationRef": "urma:investigation:0123456789abcdef0123456789abcdef",
  "queries": ["dark mode", "settings"],
  "limit": 10
}
```

Batch searches match each query independently, merge overlapping spans, and
return hits in timestamp order. Each hit includes `matchedQueries`. A batch
returns at most 20 merged hits and 16,000 caption characters.

Search scans at most 10,000 segments per query and can stop earlier at its
candidate limit. The result reports whether it found and returned every match:

| Field | Meaning |
| --- | --- |
| `candidateHitCount` | Number of candidates observed. |
| `candidateCountComplete` | Whether the candidate count is complete. |
| `omittedHits` | Exact number omitted when the count is complete; otherwise `null`. |
| `partial` | `true` if the scan was incomplete or result limits omitted matches. |

`partial: false` means all matches under the selected track's matching rules
were returned. A complete search with no hits means the track contained no
matching cue. It does not rule out uncaptioned speech or a visual event.

### `read_transcript`

Read captions overlapping a time range:

```json
{
  "investigationRef": "urma:investigation:0123456789abcdef0123456789abcdef",
  "startMs": 10000,
  "endMs": 20000
}
```

| Argument | Required | Description |
| --- | --- | --- |
| `investigationRef` | Yes | Reference returned by inspection. |
| `startMs`, `endMs` | Yes | Half-open time range to read. |
| `trackRef` | No | Caption track to read. |
| `cursor` | No | `nextCursor` from a previous page with the same investigation, range, and track. |

The result includes `requestedRange`, `returnedRange`, the selected `track`,
and timestamped `segments`. Overlapping cues retain their full timestamps, so
`returnedRange` can extend beyond the requested range.

A page contains at most 200 segments or 16,000 caption characters. If more
segments remain, `partial` is `true` and `nextCursor` identifies the next page.
Repeat the original arguments with that cursor:

```json
{
  "investigationRef": "urma:investigation:0123456789abcdef0123456789abcdef",
  "startMs": 10000,
  "endMs": 20000,
  "cursor": "<nextCursor>"
}
```

Replace `<nextCursor>` with the returned value. If you selected `trackRef`,
include it again. A cursor cannot be reused for another range or track.

## Overview semantics

### `get_overview`

Get a visual overview of a time range:

```json
{
  "investigationRef": "urma:investigation:0123456789abcdef0123456789abcdef",
  "startMs": 10000,
  "endMs": 30000
}
```

`investigationRef` is required. `startMs` defaults to `0` and `endMs` defaults
to the source duration; omit both for the whole video.

Urma requests 12 temporally distributed points. A short interval can produce
fewer distinct samples. It prefers a source's native storyboard and otherwise
decodes a copy of the video for navigation.

The response includes an image panel, its resource link, and a `cells` array
with each sample's timestamp and provenance. `requestedInterval` records the
range requested. `observedCoverage.sampleTimestampsMs` records the returned
samples, and `adjacentSpacingMs` records the gaps between them. Coverage is
`sample-points-only`, with `continuous: false`.

Current overview timestamps are nominal sample times. An overview is useful
for finding a likely scene; requesting exact frames at its timestamps is a
separate operation. Cell spacing does not guarantee observation of the video
between those cells.

Repeated overviews report their relationship in `sampling.sampleReuse`:

| `relation` | Meaning |
| --- | --- |
| `not-scoped` | Whole-source overview. |
| `no-prior-overview` | No comparable overview has been presented in this investigation. |
| `same-samples` | The underlying samples match an earlier overview. |
| `different-subset` | A scoped storyboard selected another subset of the same underlying samples. |
| `new-decoded-samples` | Navigation media produced a new set of decoded samples. |

`reusedUnderlyingSamples` concerns the images themselves. Reusing downloaded
media alone does not mean an overview shows the same samples.

## Exact frames and panels

### `get_frames`

Request specific timestamps:

```json
{
  "investigationRef": "urma:investigation:0123456789abcdef0123456789abcdef",
  "request": { "kind": "points", "timesMs": [10000, 11000] }
}
```

Or request evenly spaced samples from an interval:

```json
{
  "investigationRef": "urma:investigation:0123456789abcdef0123456789abcdef",
  "request": { "kind": "burst", "startMs": 10000, "endMs": 12000, "count": 4 },
  "presentation": "panel"
}
```

| Argument | Required | Description |
| --- | --- | --- |
| `investigationRef` | Yes | Reference returned by inspection. |
| `request` | Yes, for a new request | A `points`, `burst`, or `cadence` request. |
| `presentation` | No | `individual` (default) or `panel`. |
| `cursor` | For cadence continuation | Returned `nextCursor`; omit `request` when using it. |
| `pageSize` | No; cadence only | Targets per page, up to the configured server maximum. |
| `maxTargets` | No; cadence only | Caller limit on the total schedule size, subject to the server limit. |

`points` accepts 1–12 unique timestamps and preserves their request order.
`burst` accepts a half-open interval and `count` from 2 to 12, returning its
samples in time order. [Cadence requests](#fixed-cadence-schedules) can span
several pages.

Urma selects the first decodable presentation frame at or after each requested
time. A target need not coincide with a video's frame boundary. Returned
`atMs`, `timestampMs`, and `requestedAtMs` values record the requested times;
they are not measured decoder presentation timestamps.

With `individual`, the result contains each JPEG and its resource link. With
`panel`, the result contains one combined JPEG with timestamp labels and links
to the individual frame artifacts. A panel preserves request order and is
created only after all requested explicit frames succeed.

## Fixed-cadence schedules

To sample once per second over 30 seconds:

```json
{
  "investigationRef": "urma:investigation:0123456789abcdef0123456789abcdef",
  "request": { "kind": "cadence", "startMs": 0, "endMs": 30000, "cadenceMs": 1000 },
  "pageSize": 12
}
```

`cadenceMs` must be a positive integer. Targets are `startMs + i * cadenceMs`
for zero-based index `i`, while the target is earlier than `endMs`. This example
has 30 targets, from 0 through 29 seconds. Urma checks the total count before
acquiring frames.

The default server limits are 12 targets per page and 120 per schedule. Set
`pageSize` or `maxTargets` to impose smaller limits. Server limits are
[configurable](../README.md#acquisition-limits), but pages cannot exceed 12.

Each page reports the schedule, page indexes, slots, status counts,
`scheduleComplete`, and `nextCursor`. Slots retain their zero-based schedule
index and requested timestamp:

| Status | Meaning |
| --- | --- |
| `success` | The frame was acquired and returned. |
| `error` | The target failed; `error` contains `code`, `retryable`, and `detail`. |
| `unfinished` | Work for that target did not finish in this page. |

To continue, pass the investigation and returned cursor without a new request:

```json
{
  "investigationRef": "urma:investigation:0123456789abcdef0123456789abcdef",
  "cursor": "<nextCursor>"
}
```

Include `presentation: "panel"` on each call if you want panels. A cadence page
gets a panel only when every slot on that page succeeds. Error and unfinished
slots remain visible in the result and have no frame artifact.

Cursors are signed for the running server process. A cursor from another
investigation or incompatible snapshot is rejected. After a server restart,
start again with the original cadence request.

A cadence schedule observes discrete moments. Even a completed schedule can
miss events between targets.

## Resources and state

Successful results provide resource links for saved artifacts. Their URI form
is:

```text
urma://investigation/<investigationId>/artifact/<artifactHash>
```

An artifact is readable only after it has been returned to that investigation.
Reading the resource returns the same validated bytes. It does not acquire
more frames or add observations. A panel and its individual frames have
separate resources. Missing or corrupt artifacts fail to read; resource reads
do not reacquire them.

Each tool also returns `stateResource`, with this URI form:

```text
urma://investigation/<investigationId>/state
```

It reports the investigation's saved source, acquisition, cache, artifact,
and presentation state. Source data can be cached across investigations,
while each investigation records its own returned evidence. A state resource
that exceeds the 32 MiB read limit fails rather than returning truncated JSON.

## Errors

Tool execution failures return `isError: true` with a JSON text object
containing `code`, `retryable`, and `detail`. Cadence requests can report a
failure in one slot while returning successful frames for others.

Common conditions include disabled local access (`LOCAL_SOURCE_DISABLED`), a
file outside configured roots (`LOCAL_PATH_OUTSIDE_ROOT`), unavailable captions
(`CAPTIONS_UNAVAILABLE`), and an exceeded output limit (`OUTPUT_LIMIT_EXCEEDED`).
Check the error detail and the [configuration](../README.md#configuration)
before retrying. For installation or runtime problems, run
[doctor](../README.md#cli-and-maintenance).
