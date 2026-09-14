import {
  remoteSourceRef,
  youtubeRemoteIdentity,
  type RemoteIdentity,
  type SourceRef,
} from "../core/ids.js";
import { UrmaError } from "../core/errors.js";

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
]);
const PATH_FORMS = new Set(["shorts", "live", "embed"]);

export type YouTubeIdentity = Readonly<{
  videoId: string;
  remoteIdentity: RemoteIdentity;
  sourceRef: SourceRef;
  canonicalUrl: string;
  origin: string;
  alias: string;
}>;

export function parseYouTubeUrl(value: string): YouTubeIdentity {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new UrmaError(
      "INVALID_SOURCE",
      `Source ${
        JSON.stringify(value)
      } is neither an Urma sourceRef, an allowed local path, nor a valid remote URL`,
      { cause: error },
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UrmaError(
      "UNSUPPORTED_SOURCE",
      `Remote source scheme ${url.protocol} is unsupported; remote sources must use HTTP or HTTPS`,
    );
  }
  if (url.username || url.password || (url.port && url.port !== "80" && url.port !== "443")) {
    throw new UrmaError(
      "UNSUPPORTED_SOURCE",
      "Remote source URLs must not contain userinfo or a non-standard port",
    );
  }
  const host = url.hostname.toLowerCase();
  let videoId: string | null = null;
  if (host === "youtu.be") {
    videoId = url.pathname.split("/").filter(Boolean)[0] ?? null;
  } else if (YOUTUBE_HOSTS.has(host)) {
    const pieces = url.pathname.split("/").filter(Boolean);
    if (url.pathname === "/watch" || url.pathname === "/watch/") {
      if (
        url.searchParams.has("list") ||
        url.searchParams.has("playlist") ||
        url.searchParams.has("index")
      ) {
        throw new UrmaError(
          "UNSUPPORTED_SOURCE",
          "YouTube playlists and collection parameters are unsupported; provide one video URL",
        );
      }
      videoId = url.searchParams.get("v");
    } else if (pieces[0] && PATH_FORMS.has(pieces[0])) {
      videoId = pieces[1] ?? null;
    }
  } else {
    throw new UrmaError(
      "UNSUPPORTED_SOURCE",
      `Remote host ${
        JSON.stringify(host)
      } is unsupported by the YouTube extractor; use the generic remote URL path for other HTTP(S) sources`,
    );
  }
  if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    throw new UrmaError(
      "INVALID_SOURCE",
      `YouTube URL does not contain a valid 11-character video ID; use a watch, youtu.be, shorts, live, or embed video URL`,
    );
  }
  const remoteIdentity = youtubeRemoteIdentity(videoId);
  return {
    videoId,
    remoteIdentity,
    sourceRef: remoteSourceRef(remoteIdentity),
    canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
    origin: url.origin,
    alias: value,
  };
}
