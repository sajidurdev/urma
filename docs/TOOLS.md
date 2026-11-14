# Tool reference

Urma v0.3.0 exposes five MCP tools. Start with `inspect_video`, then use its
`investigationRef` for captions and images. [Installation and configuration](../README.md#quick-start)
are in the README.

- [`inspect_video`](#inspect_video)
- [`search_transcript`](#search_transcript)
- [`read_transcript`](#read_transcript)
- [`get_overview`](#get_overview)
- [`get_frames`](#get_frames)
- [Resources and evidence semantics](#resources-and-evidence-semantics)
- [Limits and errors](#limits-and-errors)

## Shared conventions

Times are nonnegative integer milliseconds from the start of the source.
Ranges are half-open: `[startMs, endMs)` includes the start and excludes the end.
The start must precede the end, which cannot exceed the video duration. Point
requests must be earlier than the duration. Local frames and captions share
the container-relative timeline, even when media timestamps start above zero.

Treat source, investigation, track, artifact, and cursor values as opaque.
Replace the example references with values returned by your calls; the time
examples assume a video at least 30 seconds long. `investigationRef` is required
for every tool after inspection. Cursors accept up to 1,024 characters.

## `inspect_video`

Open a public URL, an allowed local file, or a returned `sourceRef`:

```json
{ "source": "/absolute/path/to/demo.mp4" }
```

- `source` (required): URL, local path, or `sourceRef`; 1–4,096 characters.
  Absolute paths are recommended; relative paths resolve from the server's working directory.
- `freshness`: `reuse` (default) or `refresh`.

Returns `sourceRef`, `investigationRef`, metadata, validated duration,
capabilities, caption tracks, cache information, and `stateResource`.
See [supported sources](../README.md#supported-sources-and-limitations).

Each inspection creates an investigation pinned to a snapshot. Later calls
keep that snapshot even if another inspection refreshes the source. For a known
remote URL or `sourceRef`, `reuse` opens the latest saved snapshot; `refresh`
resolves it again. A direct local path is always checked and pinned again.
A local `sourceRef` with `reuse` reopens its saved snapshot without rereading the path.
Frames can be requested immediately; captions and overviews are optional.

### Caption tracks

Captions come from the platform, local `.vtt`/`.srt` files, or supported embedded
SubRip, WebVTT, and `mov_text` tracks. Urma parses JSON3, WebVTT, and SRT; it does
not transcribe audio, translate, merge tracks, or correct automatic captions.

Both caption tools accept an optional `trackRef` from inspection. Without one,
selection prefers manual captions, sidecars, automatic captions, then unknown
tracks; within each kind, it prefers the original language, then English,
then stable lexical order. Embedded tracks prefer the container default,
then language, then stream index. A sidecar takes priority over embedded tracks.

Embedded tracks have `kind: "unknown"` and `embedded` metadata containing
`streamIndex`, `codec`, and `default`. Unknown tracks without a known origin
cannot be acquired. Embedded extraction reads pinned video bytes, preserves
container-relative cue times, and omits styling. It has a 15-second deadline
(or the smaller media timeout) and the resource-byte limit. Empty or absent
usable tracks fail with `CAPTIONS_UNAVAILABLE`. Bitmap subtitles are unsupported.
Refresh older local snapshots to discover embedded tracks; existing investigations
retain their original track lists.

Caption bytes are pinned on first successful acquisition for a snapshot.
Cache repair must reproduce those bytes. Changed downloads or inconsistent
cached captions fail with `SOURCE_UNAVAILABLE`; inspect with `freshness: "refresh"`
and use the new investigation. A first remote caption download is not guaranteed
to match the provider's content at inspection time.

## `search_transcript`

Find literal text in one caption track:

```json
{
  "investigationRef": "urma:investigation:0123456789abcdef0123456789abcdef",
  "query": "dark mode"
}
```

- Provide exactly one of `query` (string) or `queries` (1–20 strings). Each
  string must contain non-whitespace text and be at most 256 characters.
- `trackRef`: optional caption track.
- `mode`: `phrase` (default) or `terms`.
- `limit`: 1–20 hits, default 5. For a batch, applies per query before merging.

Matching uses Unicode NFKC normalization, ignores case, and treats separators as
spaces. `phrase` finds a normalized substring; `terms` requires every normalized
term as a substring within the same cue. There is no semantic ranking.

Single-query hits contain cue text, timestamps, and up to one adjacent cue on
each side. Batch queries are matched separately, then overlapping spans are
merged in timestamp order with `matchedQueries`. A batch returns at most 20
merged hits and 16,000 caption characters. For example:

```json
{
  "investigationRef": "urma:investigation:0123456789abcdef0123456789abcdef",
  "queries": ["dark mode", "settings"],
  "limit": 10
}
```

Search scans at most 10,000 segments per query and can stop at its 200-candidate
limit. `candidateHitCount` counts observed candidates; `candidateCountComplete`
says whether that count is complete. `omittedHits` is exact only when complete,
otherwise `null`. `partial: true` means scanning or result limits omitted potential
matches. `partial: false` means every match under the selected track's rules
was returned. No hits do not rule out uncaptioned speech or visual events.

## `read_transcript`

Read captions overlapping a range:

```json
{
  "investigationRef": "urma:investigation:0123456789abcdef0123456789abcdef",
  "startMs": 10000,
  "endMs": 20000
}
```

- `startMs`, `endMs` (required): range to read.
- `trackRef`: optional caption track.
- `cursor`: returned `nextCursor` for the same investigation, range, and track.

Returns `requestedRange`, `returnedRange`, the selected `track`, and timestamped
`segments`. Cues retain their full timestamps, so `returnedRange` can extend
outside the requested range. Pages contain at most 200 segments or 16,000 caption
characters. When `partial` is true and `nextCursor` is present, repeat the same
arguments with that cursor, including any selected `trackRef`:

```json
{
  "investigationRef": "urma:investigation:0123456789abcdef0123456789abcdef",
  "startMs": 10000,
  "endMs": 20000,
  "cursor": "<nextCursor>"
}
```

## `get_overview`

Browse a visual overview of the video or a range:

```json
{
  "investigationRef": "urma:investigation:0123456789abcdef0123456789abcdef",
  "startMs": 10000,
  "endMs": 30000
}
```

- `startMs`: default `0`.
- `endMs`: default video duration; omit both bounds for the whole video.
- `rulers`: default `false`; add percentage axes outside each image.

Requests 12 distributed sample points; short intervals can yield fewer distinct
samples. Returns a panel resource, `cells` with sample times and provenance,
`requestedInterval`, and `observedCoverage` with sample times and spacing.
Overview times are nominal. Use them to locate moments for frame requests.
`observedCoverage` is `sample-points-only`, with `continuous: false`.

`sampling.sampleReuse.relation` is `not-scoped` for a whole-video overview or
`no-prior-overview` when no comparable overview has been returned. Otherwise,
`same-samples` means the samples match, `different-subset` means another subset
of the same underlying samples, and `new-decoded-samples` means newly decoded samples.
`reusedUnderlyingSamples` concerns the actual samples; reusing downloaded media
alone does not mean an overview returned the same images.

## `get_frames`

Retrieve selected images, or ask Urma to choose candidate times:

```json
{
  "investigationRef": "urma:investigation:0123456789abcdef0123456789abcdef",
  "request": { "kind": "points", "timesMs": [10000, 11000] },
  "presentation": "panel"
}
```

For a new call, provide `request` with one of these `kind` values:

| Kind | Parameters and behavior |
| --- | --- |
| `points` | `timesMs`: 1–12 unique timestamps; preserves request order. |
| `burst` | `startMs`, `endMs`, `count`: 2–12 evenly spaced samples in time order. |
| `cadence` | `startMs`, `endMs`, positive integer `cadenceMs`; paged fixed intervals. |
| `refine` | Required `budget`: 1–12; optional bounds default to the whole video; `basis`: `visual` (default) or `exact`. |
| `discover` | Required `budget`: 1–12; optional bounds default to the whole video; scan options below. |

Optional top-level arguments:

- `presentation`: `individual` (default) or `panel`.
- `crop`: `{x, y, w, h}` percentages of the individual displayed source frame.
- `rulers`, `diffHints`, `deduplicate`: booleans, each defaulting to `false`.
- `pageSize`: cadence targets per page, 1–12 and no larger than the server limit.
- `maxTargets`: positive integer cadence schedule limit, bounded by the server limit.
- `cursor`: cadence continuation; use instead of `request`.

Urma selects the first decodable presentation frame at or after the requested
time. `atMs`, `timestampMs`, and `requestedAtMs` are requested times, not measured
decoder timestamps. Different requests can select the same frame, including in
variable-frame-rate videos. Acquisition can need a reusable video copy; selected
HLS sources support targeted sections. Neither path guarantees fixed latency.

Individual results contain frame resources. Panels are derived JPEGs with labels
and links to unannotated canonical frames. Explicit panels preserve request order
and require every requested frame to succeed.

### Cadence and continuation

Targets are `startMs + i * cadenceMs`, for zero-based `i`, while earlier than
`endMs`. The server defaults to 12 targets per page and 120 per schedule, and
checks the total before acquiring frames. Smaller caller limits are allowed.
Changing page size does not resample the remaining schedule.

```json
{
  "investigationRef": "urma:investigation:0123456789abcdef0123456789abcdef",
  "request": { "kind": "cadence", "startMs": 0, "endMs": 30000, "cadenceMs": 1000 },
  "pageSize": 12
}
```

Each page includes schedule indexes, slots, counts, `scheduleComplete`, and
`nextCursor`. Slot statuses are `success`, `error` (with `code`, `retryable`,
`detail`), or `unfinished` (work not completed in that page). Only an all-success
page gets a panel. Continuation advances past successes and terminal errors,
then resumes at the first unfinished slot. It does not retry error slots, even
when `retryable` is true. To retry failed timestamps, use a new explicit point
request after checking the error details.
To continue, replace `<nextCursor>` with the returned value:

```json
{
  "investigationRef": "urma:investigation:0123456789abcdef0123456789abcdef",
  "cursor": "<nextCursor>"
}
```

Omit `request`; repeat `presentation: "panel"` if wanted. Cursors bind the
investigation, snapshot, and schedule to the running process. After a server
restart, begin again with the original cadence request.

### Refinement and discovery

`refine` repeatedly splits the largest remaining gap at its midpoint, rounded
down, breaking ties by earlier start. `exact` uses all returned exact-frame
observations, including frames retrieved through refinement or discovery.
`visual` additionally includes overview points. Cached or unreturned work does
not count. Selection compares timestamps across all crop scopes: changing the
crop does not make an observed time eligible again. Crop provenance remains in
state; use explicit point requests to resample a time or inspect another crop.
Selections are returned in selection order, without reusing observed timestamps.
Concurrent calls in one server reserve distinct times; failures release them.
Refinement advances history and is not idempotent.

`refinement` reports `selectedTimesMs`, `basis`, `budget`, `exhausted`, and
`policy: "largest-gap-midpoint-v1"`.
`exhausted` means every integer millisecond in the range is already observed
under the chosen basis.
Its `remainingGaps` reflects investigation history after the call, with
`scope: "investigation"`, the requested `interval`, and up to five `largestGaps`.
`timestampBasis` is `nominal-and-requested` for `visual` or `requested` for `exact`.
Fewer frames,
or an empty `frames` array with no panel, can mean the range is exhausted or
remaining timestamps are reserved by another call. Distinct request times do
not establish distinct scenes.

`discover` searches for visual transitions using scene scores and pixel changes.
It scans the full displayed frame; `crop` affects retrieved images, not the scan.

| Discovery option | Default | Accepted values |
| --- | ---: | --- |
| `maxFrames` | 120 | 4–240 output frames across coarse and fine scans |
| `maxScanMs` | 30000 | 1–30000 ms, starting at the range start |
| `sceneThreshold` | 10 | Greater than 0 and at most 100 |
| `minChangedRatio` | 0.08 | Greater than 0 and at most 1 |
| `keyframeAssist` | `false` | Boolean; optional coarse scan followed by a fine scan |

A candidate qualifies at either threshold. Candidates rank by the larger of
scene score divided by 100 and changed-pixel fraction, with earlier ties first;
selected candidates are retrieved in time order. `candidateCount` and
`omittedCandidateCount` report budget omissions. Keyframe assistance can narrow
the fine scan window and miss transitions elsewhere. Scanning preserves decoded
presentation times without synthesizing frames to impose a constant frame rate.

`discovery` retains scan bounds, thresholds, provenance, decoded times, candidates,
and truncation flags. Candidate request times round decoded times down to integer
milliseconds; their JPEGs still follow ordinary frame selection and expose no
measured selected-frame timestamp. `scanSamplingGaps` includes original range
edges even when scanning stops early. Scan-only frames add no presented evidence.
No candidates means an empty `frames` array with no panel, not proof of no event.

### Crops, rulers, change hints, and grouping

Crops use displayed-source percentages after rotation and sample-aspect-ratio
correction: `x`, `y` are nonnegative, `w`, `h` are positive, and `x+w`, `y+h`
cannot exceed 100. Extra fields and nonfinite values are rejected. Crops operate
before preview scaling; bounds round outward and remain inside the displayed
frame, limited to 32,768 pixels per side and 64 megapixels. Remote resolution
is the selected evidence rendition, which can be below the provider's maximum.

The same crop applies to all targets. Cadence continuations can omit it or repeat
it unchanged; a different crop needs a new schedule. Results retain requested
percentages, source dimensions, integer pixel bounds, and crop provenance.
Rulers sit outside image content and label source coordinates, including crops;
canonical frame resources remain unannotated. Individual ruler previews are
1,360 × 832 pixels; ruler panels are at most 1,600 × 876 pixels.

`diffHints` compares adjacent successful frames in request order, including
reverse-time requests; cadence comparisons stay within the current page.
Regions use source-frame percentage coordinates and padded `suggestedCrop`
values. Overall and per-region `changedPixelRatio` values divide changed pixels
by the entire analysis image; `density` divides them by the region's box area.
A pixel counts as changed at a difference of at least 12 in any RGB channel.
At most 16 regions are returned;
omitted counts and pixel fractions are reported. For crops, boxes map back to
the full displayed frame, while ratios describe the cropped analysis area.
`sourceCrop` identifies that area. Incompatible grids or crops produce an
unavailable comparison with a reason. Hints use a grid up to 256 × 144;
unsupported geometry includes aspect-ratio error above 5% and non-quarter-turn
rotations. Encoding, scaling, and block boundaries can enlarge, merge, or miss
changes. Crop suggestions provide context, not guaranteed text coverage.

`deduplicate` groups images for presentation only. All original observations,
timestamps, canonical resources, crop scopes, and sampling gaps remain.
Groups use their first representative and require compatibility with every
member, preventing chains of approximate matches. Different artifacts group
only without resampling when pixels are identical or differ by a uniform offset
of at most two levels per color channel. Local differences keep frames separate.
A uniform brightness shift can still have meaning; similarity is not semantic equality.

`deduplication` reports counts and groups with representative and member indexes,
requested times, source/snapshot identity, artifact/resource links, measurements,
and panel mappings. Explicit member indexes are zero-based request positions;
original panel `cells[].index` is one-based. Cadence indexes remain schedule
indexes; `panelIndex` is a one-based tile index, or `null` without a panel.
Resource reads and grouping
add no temporal observations. Membership metadata can outweigh image savings.

## Resources and evidence semantics

Every tool returns `stateResource`. Artifact and state resource URI forms are:

```text
Artifact: urma://investigation/<investigationId>/artifact/<artifactHash>
State:    urma://investigation/<investigationId>/state
```

Artifacts are readable only after being returned to that investigation. A cache
hit or guessed hash does not grant access. Reads return validated saved bytes;
missing or corrupt content fails instead of triggering reacquisition. Reopening
resources adds no observations. State records the source/snapshot, calls,
network usage, cache summaries, returned captions/images, and sampling gaps.

`samplingGaps` lists up to five largest gaps, considering interval edges, in
decreasing duration with earlier ties first. Only samples returned in the
response count. Overview times are `nominal`; frame times are `requested`.
Explicit points use the whole-video interval; bursts use their requested range;
cadence pages use the full schedule but only that page's successful slots.
A page with no successes leaves the whole schedule interval as a gap.
Refinement additionally reports investigation-wide gaps. Discovery scan gaps
use `decoded-presentation-floor-ms`, separately from retrieved candidate gaps.
None of these reports establishes continuous visual coverage.

## Limits and errors

[Configurable acquisition and schedule limits](../README.md#acquisition-limits)
bound media work. Inline image responses are limited to 8 MiB and resource reads
to 32 MiB; oversized state resources fail rather than returning truncated JSON.
Embedded captions and visual analysis have 15-second deadlines or the smaller
media timeout. Long inputs can still require substantial decoding or demuxing.

Visual analysis allows two concurrent jobs, one decoder/filter thread per job,
an 8,388,608-pixel input-frame cap, and 64 MiB per native allocation. Scan output
is capped at 240 × 256 × 144 × 3 bytes (25.3125 MiB). Hints and grouping payloads
each have a 128 KiB ceiling; grouping allows at most 12 observations and 66
pairwise comparisons per response. These limits do not cap total process memory.
`maxFrames` limits output frames, not hidden decoding before the requested range.
An analysis error or cancellation before presentation commits no new observations.

Tool execution failures return `isError: true` with a JSON text object containing
`code`, `retryable`, and `detail`. Cadence pages can return mixed slot outcomes.
Common codes include `LOCAL_SOURCE_DISABLED`, `LOCAL_PATH_OUTSIDE_ROOT`,
`CAPTIONS_UNAVAILABLE`, `SOURCE_UNAVAILABLE`, and `OUTPUT_LIMIT_EXCEEDED`.
Read the detail and retryability before retrying. For installation or connection
problems, see [troubleshooting](../README.md#updates-and-troubleshooting).
