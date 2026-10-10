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
 * Some direct-media records omit `vcodec`; a shared fallback keeps policy,
 * snapshots, and timeline checks consistent
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
