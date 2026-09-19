# Evidence model

<p align="center">
  <img src="https://raw.githubusercontent.com/sajidurdev/urma/main/docs/assets/evidence-model.png" alt="Urma evidence model" width="100%" />
</p>

Urma reports what it acquired and presented for one investigation. The
returned records describe bounded observations; they do not turn a sample,
caption match, or cache entry into a claim about the whole source.

## Terms

- A **source** is the logical local path or remote identity.
- A **snapshot** is one immutable observation of that source, including its
  validated finite timeline.
- An **investigation** pins one source snapshot and records the evidence
  presented to the host.
- An **artifact** is validated content, identified by its SHA-256 digest.
- A **transport artifact** is acquired media used to produce evidence.
- A **presentation** is the act of returning evidence to one investigation.
- A **cache hit** describes reuse of stored content or acquisition work. It is
  not evidence presentation by itself.

Every evidence call after `inspect_video` names an `investigationRef`. A fresh
investigation starts with no presented evidence, even when source-level bytes
are already cached. The same artifact can be presented to multiple
investigations; each investigation has its own presentation record and
resource authorization.

## Evidence kinds

The visual evidence kinds are:

| Kind | Meaning |
| --- | --- |
| `point` | One exact JPEG frame for a requested source timestamp. |
| `sparse` | Locator samples inside a source-global interval. `get_overview` uses this kind. |
| `ordered_points` | Ordered frame samples inside an interval. A burst uses this kind. |
| `scheduled_exact_points` | A paged fixed-cadence list of exact point requests. |

The v0.1 MCP surface does not expose audio evidence.

For a frame point, Urma validates video timing and asks for the first decodable
presentation frame at or after the requested timestamp. The decoder's physical
seek position is an acquisition detail. It is not the requested timestamp and
does not replace it in evidence provenance.

Downloaded media sections are transport artifacts. Their requested bounds and
their validated video-stream PTS coverage are recorded separately. A transport
section covers an evidence point only after the timing check and frame
validation succeed.

Batching can share remote setup and transport work. It does not combine the
requested intervals or make one target's success validate another target.

## Overview semantics

`get_overview` requests 12 temporally distributed cells for either the whole
source or a source-global interval. The interval is half-open:

```text
[startMs, endMs)
```

The response distinguishes the requested interval from the observed samples:

```json
{
  "requestedInterval": { "startMs": 0, "endMs": 60000 },
  "observedCoverage": {
    "kind": "sample-points-only",
    "continuous": false,
    "sampleTimestampsMs": [0, 5000, 10000],
    "adjacentSpacingMs": [5000, 5000]
  }
}
```

The example is schematic. A real response can contain up to 12 returned cells,
and a short interval can produce fewer than 12 distinct points. The timestamps
in `sampleTimestampsMs` are the cells returned by that call. Urma does not
claim observation between adjacent points. The public MCP response omits the
internal `sampling.resolutionMs` field; sample spacing does not guarantee
coverage between frames.

An overview uses a native storyboard when available and otherwise decodes
navigation media. Its artifact role is `locator`. Current overview producers
report nominal sample timing. Each cell also reports provenance identifying a
storyboard sample or a decoded sample and, for storyboard data, its source
artifact and cell/fragment indexes.

The overview path does not automatically extract exact frames for the cell
timestamps. An overview cell and an exact frame requested at the same time are
different evidence operations.

Repeated overview calls expose their sample relationship through
`sampling.sampleReuse`:

| Relation | Meaning |
| --- | --- |
| `not-scoped` | A whole-source overview. |
| `no-prior-overview` | No comparable overview was previously presented in this investigation. |
| `same-samples` | The returned underlying samples match an earlier overview. |
| `different-subset` | A scoped native storyboard selected another subset of the same underlying samples. |
| `new-decoded-samples` | Navigation media decoded a new set of sample points. |

`reusedUnderlyingSamples` describes visual sample identity. Reusing transport
media alone does not make it `same-samples`.

Whole-source and scoped overviews remain separate presentation events. A
scoped overview does not erase or rewrite the whole-source observation.

## Exact frames and panels

`get_frames` accepts three request forms:

- `points`: 1–12 unique timestamps, each before the source duration;
- `burst`: a half-open interval with 2–12 ordered samples; and
- `cadence`: a half-open interval with a positive integer cadence.

Explicit points and burst samples produce canonical JPEG frame artifacts. Their
results are request-ordered and each frame keeps its requested source-global
timestamp.

`presentation: "panel"` adds a derived JPEG presentation. The panel contains
the requested canonical frames in request order. It has no independent frame
timestamps or evidence identity. Each panel cell links back to its canonical
frame artifact. The exact-frame panel uses 320-pixel cells, a 180-pixel frame
area, and a 32-pixel timestamp area; its maximum response dimensions are
1280×636 for 12 cells.

The panel is created only after all requested explicit frames succeed. A panel
cache hit reuses the derived presentation; it does not change the canonical
frame records.

## Fixed-cadence schedules

A cadence request defines `startMs`, `endMs`, and `cadenceMs`. Target `i` is
computed from the original request:

```text
target(i) = startMs + i * cadenceMs
```

Targets are included while `target(i) < endMs`. The complete target count is
checked before frame acquisition. The default page limit is 12 targets and the
default schedule limit is 120 targets. A caller can lower either applicable
limit; the server page limit cannot exceed 12.

Each page retains the zero-based schedule index and one of these statuses:

| Status | Meaning |
| --- | --- |
| `success` | The exact point was acquired and presented to the investigation. |
| `error` | That target failed; the slot contains `code`, `retryable`, and `detail`. |
| `unfinished` | Work for that target did not finish in the current page. |

The public MCP response omits each slot's internal `timing` record, which
currently contains `selectedPresentationTimeMs: null` and status `unavailable`.
The requested timestamp remains the schedule target; it is not a measured
presentation timestamp (PTS).

Use the returned `nextCursor` to continue. The cursor is opaque and signed; it
is bound to the investigation, source snapshot, duration, frame
representation, timeline and selection contracts, schedule definition, total
target count, and next index. A cursor from another investigation, snapshot,
or schedule is rejected.

When `presentation: "panel"` is requested for a cadence page, Urma creates a
derived panel only when every slot on that page is a terminal success. Error
and unfinished slots remain visible in the page result and have no frame
artifact.

A cadence schedule is discrete point evidence. It says nothing about frames or
events between its targets.

## Caption evidence

Caption tracks are source-provided. A track is identified by `trackRef` and
also reports its language, kind, display name, and provider identifier when
available. The supported kinds are `manual`, `automatic`, `sidecar`, and
`unknown`.

When the caller omits `trackRef`, Urma selects one track by this order:

1. manual;
2. local sidecar;
3. automatic;
4. unknown.

Within each kind, it prefers the source's original language, then English, then
stable lexical order. A caller can select a specific track with a `trackRef`
returned by `inspect_video`. A missing track is `CAPTIONS_UNAVAILABLE`; it is
different from a complete search with zero hits.

Urma parses JSON3, WebVTT, and SRT. It does not merge tracks, translate them,
repair automatic captions, or infer speech that the source did not provide.

### Search

`search_transcript` scans up to 10,000 segments of the selected track for a
literal phrase or literal terms. The text and query are NFKC-normalized,
lowercased, and cleaned so separators become spaces. Phrase mode checks for a
normalized substring.
Terms mode requires every normalized term to occur as a substring.

A single-query hit contains the matching cue and up to one preceding and one
following cue as context. The matching cue is not duplicated in the MCP
context projection.
For a batch, each query is matched independently and overlapping spans are
merged in timestamp order. A batch hit records the queries that matched it.

Search scope is always `selected-caption-track`. It does not include audio,
another caption track, translated captions, or unreturned provider data.

### Read

`read_transcript` accepts a source-global half-open interval and returns
segments that overlap that interval. One page contains at most 200 segments and
16,000 caption characters. A partial page returns a cursor bound to its track
and interval. Restarting with a different track or interval invalidates that
cursor.

## Completeness and limits

Search has a default result limit of 5 and a maximum of 20. It can inspect at
most 10,000 caption segments while establishing candidates. Batched searches
accept at most 20 queries, return at most 20 merged hits, and use a 16,000
character result ceiling.

For a single query:

- `candidateHitCount` is the number of candidates observed;
- `candidateCountComplete` says whether the bounded candidate scan finished;
- `omittedHits` is the exact number omitted by the result limit only when the
  candidate count is complete; and
- `partial` is true when the scan stopped early or a result ceiling omitted a
  candidate.

For a batch, `candidateCountComplete` is false when any query's bounded scan or
per-query limit prevents a complete candidate count. In that case,
`omittedHits` is `null`.

`partial: false` means Urma established the eligible result set under the
applicable limits and returned it within the requested result limit. A complete
zero-match result means no matching cue was found in the selected track under
the matching rules. It does not establish that the phrase is absent from the
audio or video.

`read_transcript` uses `partial` to indicate that more overlapping caption
segments remain in the requested interval. A returned `nextCursor` identifies
the continuation point.

## Resources and state

Successful tool results include resource links for presented artifacts. The
artifact template is:

```text
urma://investigation/<investigationId>/artifact/<artifactHash>
```

The artifact must have been presented to that investigation. A resource read
reopens the same validated bytes; it does not create a presentation or expand
coverage. A panel resource and its canonical frame resources therefore remain
distinct.

The state template is:

```text
urma://investigation/<investigationId>/state
```

It is derived from persisted source, acquisition, cache, artifact, and
presentation records. Tool responses provide its URI as `stateResource` and
omit the internal `stateSummary`. A state resource larger than the configured
byte ceiling fails to read rather than returning truncated JSON.

## What these results do not prove

- A caption miss does not prove that the words were not spoken.
- A caption hit does not prove that the corresponding visual event occurred.
- A sparse overview does not establish continuous scene coverage.
- A burst does not establish continuous motion between points.
- A cadence schedule does not establish coverage between targets.
- A requested timestamp does not by itself identify the decoder's presentation
  PTS.
- Cached or authorized content does not add new temporal coverage when it is
  reopened.

These tools do not establish exhaustive event counts. A host making such a
claim needs evidence for unsampled intervals and a way to distinguish repeated
observations from separate events.
