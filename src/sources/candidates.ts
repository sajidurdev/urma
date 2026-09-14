import { snapshotCandidateKey, type CandidateKey, type SourceRef } from "../core/ids.js";
import type { FormatSummary, ResolvedSource } from "./types.js";

export type SafeFormatDescription = Readonly<{
  formatId: string;
  ext: string | null;
  protocol: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  estimatedBytes: number | null;
  rows: number | null;
  columns: number | null;
}>;

export function safeFormatDescription(format: FormatSummary): SafeFormatDescription {
  return {
    formatId: format.formatId ?? format.id,
    ext: format.ext,
    protocol: format.protocol,
    width: format.width,
    height: format.height,
    fps: format.fps,
    videoCodec: format.videoCodec,
    audioCodec: format.audioCodec,
    estimatedBytes: format.estimatedBytes,
    rows: format.rows,
    columns: format.columns,
  };
}

export function candidateKeyForFormat(
  sourceRef: SourceRef,
  revision: string,
  format: FormatSummary,
): CandidateKey {
  return format.candidateKey ?? snapshotCandidateKey(
    { sourceRef, revision },
    safeFormatDescription(format),
  );
}

export function candidateKeyForSourceFormat(
  source: ResolvedSource,
  format: FormatSummary,
): CandidateKey {
  return candidateKeyForFormat(source.sourceRef, source.revision, format);
}
