const VIDEO_EXTENSIONS = new Set([
  "avi",
  "flv",
  "m2ts",
  "m4v",
  "mkv",
  "mov",
  "mp4",
  "mpeg",
  "ogv",
  "ts",
  "webm",
]);

/**
 * yt-dlp's direct-media records can omit vcodec even when the record is a
 * video container. Keep that safe, conservative fallback in one place so
 * policy, snapshots, and timeline admission agree about what is video.
 */
export function videoCodecForFormat(
  format: Readonly<Record<string, unknown>>,
): string | null {
  const codec = typeof format.vcodec === "string" && format.vcodec.length > 0
    ? format.vcodec
    : null;
  if (codec && codec !== "none") return codec;
  const extension = [format.video_ext, format.ext].find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  if (codec !== "none" && extension && VIDEO_EXTENSIONS.has(extension.toLowerCase())) {
    return "unknown";
  }
  return codec;
}
