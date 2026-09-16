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
 * Direct-media records may omit vcodec for video containers
 * Keep the fallback in one place so policy, snapshots, and timeline checks agree
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
