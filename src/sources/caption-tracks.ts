import { captionTrackRef, type SourceRef } from "../core/ids.js";
import type { TranscriptKind } from "../core/model.js";
import type {
  CaptionTrackSummary,
  CaptionVariantSummary,
} from "./types.js";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function kind(value: unknown): TranscriptKind | null {
  return value === "manual" ||
      value === "automatic" ||
      value === "sidecar" ||
      value === "unknown"
    ? value
    : null;
}

export function makeCaptionTrack(
  sourceRef: SourceRef,
  sourceRevision: string,
  value: {
    language: string;
    kind: TranscriptKind;
    displayName: string | null;
    formats: readonly string[];
    providerTrackId: string | null;
    variants?: readonly CaptionVariantSummary[];
  },
): CaptionTrackSummary {
  return {
    ...value,
    trackRef: captionTrackRef(
      sourceRef,
      sourceRevision,
      value.language,
      value.kind,
      value.providerTrackId,
    ),
  };
}

export function hydrateCaptionTracks(
  sourceRef: SourceRef,
  sourceRevision: string,
  value: unknown,
): CaptionTrackSummary[] {
  const output: CaptionTrackSummary[] = [];
  for (const raw of Array.isArray(value) ? value : []) {
    if (!record(raw)) continue;
    const language = typeof raw.language === "string" &&
        /^[A-Za-z0-9._-]{1,100}$/.test(raw.language)
      ? raw.language
      : null;
    const trackKind = kind(raw.kind);
    if (!language || !trackKind) continue;
    const providerTrackId = typeof raw.providerTrackId === "string"
      ? raw.providerTrackId.slice(0, 256)
      : null;
    const displayName = typeof raw.displayName === "string"
      ? raw.displayName.slice(0, 200)
      : null;
    const formats = Array.isArray(raw.formats)
      ? raw.formats
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.slice(0, 32))
        .slice(0, 20)
      : [];
    const variants = Array.isArray(raw.variants)
      ? raw.variants.filter(record).flatMap((item) => {
        const variantId = typeof item.variantId === "string"
          ? item.variantId.slice(0, 256)
          : null;
        const format = typeof item.format === "string"
          ? item.format.slice(0, 32)
          : null;
        const providerVariantId = item.providerVariantId === null ||
            typeof item.providerVariantId === "string"
          ? item.providerVariantId === null
            ? null
            : item.providerVariantId.slice(0, 256)
          : null;
        return variantId && format
          ? [{ variantId, format, providerVariantId }]
          : [];
      }).slice(0, 20)
      : [];
    output.push(
      makeCaptionTrack(sourceRef, sourceRevision, {
        language,
        kind: trackKind,
        displayName,
        formats,
        providerTrackId,
        variants,
      }),
    );
    if (output.length >= 200) break;
  }
  return output;
}
