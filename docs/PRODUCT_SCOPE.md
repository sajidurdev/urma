# Product scope

<p align="center">
  <img src="https://raw.githubusercontent.com/sajidurdev/urma/main/docs/assets/product-scope.png" alt="Urma product scope" width="100%" />
</p>

Urma retrieves captions and selected frames from finite videos through MCP.
It supports caption search, caption reads, visual overviews, and frame requests
at specific times. The [tool reference](EVIDENCE_MODEL.md) describes those
operations, and the [README](../README.md) covers installation.

## Source admission

### Remote videos

Urma uses yt-dlp to resolve public video URLs. A source must resolve to one
video with a positive, finite duration. Supported media forms include
progressive files, finite HLS playlists, and static DASH timelines.

Compatibility checks cover public fixtures from X / Twitter,
Facebook Reel, Instagram Reel, Loom, Streamable, and Mux-hosted HLS. This is
fixture-based coverage; provider access and delivery formats can change.

Other providers, including YouTube single-video URLs, are best effort. yt-dlp
support by itself does not guarantee that Urma can inspect or retrieve frames
from a source.

Urma rejects live and upcoming streams, playlists and other multi-video
results, private videos, sources requiring login or payment, and DRM-protected
media. Remote URLs must use HTTP or HTTPS on the default port, without embedded
credentials, and pass the [network checks](SECURITY.md#remote-url-and-network-boundary).

### Local videos

Local videos must be regular files inside a directory allowed by
`URMA_LOCAL_ROOTS`. Access is disabled when no roots are configured. Resolved
symlink and junction targets must also remain inside an allowed root.

For a video such as `demo.mp4`, Urma checks for `demo.vtt`, then `demo.srt` in
the same directory. The selected sidecar uses the same access checks as the
video. UNC inputs require `URMA_ALLOW_UNC` as well as an allowed root.

## Captions and visual results

Captions come from the source or a local sidecar. Urma does not transcribe
audio, translate captions, or repair automatic captions. Search performs
literal phrase or term matching in one selected track; it does not use
semantic search.

Overviews contain up to 12 visual samples. Frame requests return JPEGs at
chosen times, as an ordered burst, or as a paged fixed-cadence schedule.
Sampling can miss events between frames. Urma does not run OCR, object or
action recognition, or model-based video analysis.

## Runtime and storage

Urma runs as a local stdio MCP server on native Node.js 22.16+ (22.x), 24.x,
or 26.x. Supported platforms are Windows x64/arm64, macOS x64/arm64, and Linux
x64/arm64 with glibc. Setup supplies the required FFmpeg, ffprobe, and yt-dlp
versions.

The installation, SQLite database, and media cache live in a user-owned local
data directory. Network data directories are unsupported. Installed versions
are kept separately so updates can be checked before activation and a retained
previous version can be restored.

Urma is designed for a single local user and does not provide hosted multi-user
isolation. MCP clients control how the returned text and images are processed,
including whether they are sent to a model service.
