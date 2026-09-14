import type { ResolvedSource } from "../sources/types.js";

export type FrameTransportDecision = Readonly<{
  primary: "local-direct" | "hls-bounded-section" | "reusable-evidence";
  fallback: "none" | "reusable-evidence";
  basis: "local-source" | "targetable-hls-advertised" | "no-targetable-hls";
}>;

export function chooseFrameTransport(
  source: ResolvedSource,
): FrameTransportDecision {
  if (source.kind === "local") {
    return { primary: "local-direct", fallback: "none", basis: "local-source" };
  }
  const hls = source.formats.some(
    (format) =>
      format.protocol?.startsWith("m3u8") === true &&
      format.videoCodec !== null &&
      format.videoCodec !== "none" &&
      format.ext !== "mhtml" &&
      (format.height ?? 0) <= 1080,
  );
  return hls
    ? {
      primary: "hls-bounded-section",
      fallback: "none",
      basis: "targetable-hls-advertised",
    }
    : {
      primary: "reusable-evidence",
      fallback: "none",
      basis: "no-targetable-hls",
    };
}
