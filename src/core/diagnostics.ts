import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";

export type DiagnosticFields = Readonly<
  Record<string, string | number | boolean | null>
>;

export type ExactFrameStage =
  | "sourceResolutionMs"
  | "exactFrameCacheLookupMs"
  | "artifactCacheLookupMs"
  | "boundedArtifactCacheLookupMs"
  | "reusableArtifactCacheLookupMs"
  | "remoteBoundedAcquisitionMs"
  | "remoteReusableAcquisitionMs"
  | "mediaProbeTimingValidationMs"
  | "artifactValidationMs"
  | "mediaArtifactCommitMs"
  | "reusableMediaFallbackMs"
  | "ffmpegExactFrameExtractionMs"
  | "jpegValidationMs"
  | "canonicalExactFrameArtifactCommitMs"
  | "serviceResultConstructionMs"
  | "mcpResultConstructionMs";

type CacheState = "hit" | "miss" | "not-needed";
type ExactFrameStatus = "pending" | "succeeded" | "failed" | "cancelled";

export type DiagnosticCoverage = Readonly<{
  startSeconds: number;
  endSeconds: number;
  startPts: string | null;
  endPts: string | null;
  durationTs: string | null;
  timeBase: string | null;
}>;

export type FrameSelection = Readonly<{
  path: "local-direct" | "bounded-section" | "reusable-evidence";
  transportCacheHit: boolean;
  sectionStartMs: number | null;
  sectionEndMs: number | null;
  physicalSeekMs: number;
  coverage: DiagnosticCoverage | null;
}>;

type FrameState = {
  readonly index: number;
  readonly atMs: number;
  exactFrameCacheHit: boolean | null;
  boundedArtifactCache: CacheState;
  reusableArtifactCache: CacheState;
  extractionPath: string | null;
  sectionBounds: string | null;
  validatedBoundedCoverage: string | null;
  physicalSeekMs: number | null;
  fallbackOccurred: boolean;
  readonly fallbackReasons: Set<string>;
  status: ExactFrameStatus;
  finalCode: string | null;
};

type FrameStageValues = Partial<Record<ExactFrameStage, number>>;

export type ExactFrameDiagnosticSeed = Readonly<{
  requestKind?: string;
  presentation?: string;
  requestedTimestampsMs?: readonly number[];
}>;

type SubprocessCategory = "yt-dlp" | "ffmpeg" | "ffprobe" | "other";

const diagnosticStorage = new AsyncLocalStorage<ExactFrameDiagnosticTrace>();

function emptyStages(): Record<ExactFrameStage, number> {
  return {
    sourceResolutionMs: 0,
    exactFrameCacheLookupMs: 0,
    artifactCacheLookupMs: 0,
    boundedArtifactCacheLookupMs: 0,
    reusableArtifactCacheLookupMs: 0,
    remoteBoundedAcquisitionMs: 0,
    remoteReusableAcquisitionMs: 0,
    mediaProbeTimingValidationMs: 0,
    artifactValidationMs: 0,
    mediaArtifactCommitMs: 0,
    reusableMediaFallbackMs: 0,
    ffmpegExactFrameExtractionMs: 0,
    jpegValidationMs: 0,
    canonicalExactFrameArtifactCommitMs: 0,
    serviceResultConstructionMs: 0,
    mcpResultConstructionMs: 0,
  };
}

function roundedMs(value: number): number {
  return Math.max(0, Math.round(value));
}

function compact(values: readonly string[]): string | null {
  return values.length === 0 ? null : values.join(",");
}

function compactNumberList(values: readonly number[]): string | null {
  return values.length === 0 ? null : values.join(",");
}

function errorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  if (error instanceof Error && error.name === "AbortError") return "CANCELLED";
  return "INTERNAL_ERROR";
}

function subprocessCategory(name: string): SubprocessCategory {
  if (name === "yt-dlp") return "yt-dlp";
  if (name === "ffmpeg") return "ffmpeg";
  if (name === "ffprobe") return "ffprobe";
  return "other";
}

function formatCoverage(coverage: DiagnosticCoverage): string {
  return [
    `start=${coverage.startSeconds}`,
    `end=${coverage.endSeconds}`,
    `startPts=${coverage.startPts ?? "null"}`,
    `endPts=${coverage.endPts ?? "null"}`,
    `durationTs=${coverage.durationTs ?? "null"}`,
    `timeBase=${coverage.timeBase ?? "null"}`,
  ].join(";");
}

function formatSectionBounds(
  startMs: number | null,
  endMs: number | null,
): string | null {
  return startMs === null || endMs === null ? null : `${startMs}-${endMs}`;
}

/** Request-local exact-frame trace; disabled tracing does not affect evidence */
export class ExactFrameDiagnosticTrace {
  readonly correlationId = randomUUID().replaceAll("-", "").slice(0, 16);
  readonly #started = performance.now();
  readonly #stages = emptyStages();
  readonly #frames = new Map<number, FrameState>();
  readonly #frameStages = new Map<number, FrameStageValues>();
  readonly #subprocessCounts = new Map<SubprocessCategory, number>();
  readonly #subprocessRoleCounts = new Map<string, number>();
  readonly #subprocessWallMs = new Map<SubprocessCategory, number>();
  readonly #fallbackReasons = new Set<string>();
  #sourceRef: string | null = null;
  #sourceDurationMs: number | null = null;
  #requestKind: string | null = null;
  #presentation: string | null = null;
  #requestedTimestampsMs: number[] = [];
  #remoteAcquisitionOccurred = false;
  #remoteBoundedAcquisitionOccurred = false;
  #remoteReusableAcquisitionOccurred = false;
  #newTransportArtifactBytes = 0;
  #status: "running" | "succeeded" | "failed" | "cancelled" = "running";
  #finalCode: string | null = null;
  #emitted = false;
  #ytDlpWallMs = 0;
  #ffprobeWallMs = 0;
  #ffmpegWallMs = 0;

  constructor(seed: ExactFrameDiagnosticSeed = {}) {
    this.#requestKind = seed.requestKind ?? null;
    this.#presentation = seed.presentation ?? null;
    this.setRequestedTimestamps(seed.requestedTimestampsMs ?? []);
  }

  setRequest(values: ExactFrameDiagnosticSeed): void {
    if (values.requestKind !== undefined) {
      this.#requestKind = values.requestKind;
    }
    if (values.presentation !== undefined) {
      this.#presentation = values.presentation;
    }
    if (values.requestedTimestampsMs !== undefined) {
      this.setRequestedTimestamps(values.requestedTimestampsMs);
    }
  }

  setRequestedTimestamps(values: readonly number[]): void {
    this.#requestedTimestampsMs = values.filter((value) =>
      Number.isSafeInteger(value)
    );
    for (const [index, atMs] of this.#requestedTimestampsMs.entries()) {
      this.ensureFrame(index, atMs);
    }
  }

  setSource(sourceRef: string, durationMs: number): void {
    this.#sourceRef = sourceRef;
    this.#sourceDurationMs = Number.isSafeInteger(durationMs)
      ? durationMs
      : null;
  }

  ensureFrame(index: number, atMs: number): void {
    if (this.#frames.has(index)) return;
    this.#frames.set(index, {
      index,
      atMs,
      exactFrameCacheHit: null,
      boundedArtifactCache: "not-needed",
      reusableArtifactCache: "not-needed",
      extractionPath: null,
      sectionBounds: null,
      validatedBoundedCoverage: null,
      physicalSeekMs: null,
      fallbackOccurred: false,
      fallbackReasons: new Set<string>(),
      status: "pending",
      finalCode: null,
    });
  }

  markExactFrameCache(index: number, atMs: number, hit: boolean): void {
    this.ensureFrame(index, atMs);
    const frame = this.#frames.get(index)!;
    frame.exactFrameCacheHit = hit;
    if (hit) {
      frame.extractionPath = "exact-cache";
      frame.status = "succeeded";
      frame.finalCode = null;
    }
  }

  markCacheStatus(
    index: number,
    atMs: number,
    kind: "bounded" | "reusable",
    status: CacheState,
  ): void {
    this.ensureFrame(index, atMs);
    const frame = this.#frames.get(index)!;
    if (kind === "bounded") frame.boundedArtifactCache = status;
    else frame.reusableArtifactCache = status;
  }

  markRequestedSection(
    index: number,
    atMs: number,
    startMs: number,
    endMs: number,
  ): void {
    this.ensureFrame(index, atMs);
    this.#frames.get(index)!.sectionBounds = formatSectionBounds(
      startMs,
      endMs,
    );
  }

  markFrameSelection(
    index: number,
    atMs: number,
    selection: FrameSelection,
  ): void {
    this.ensureFrame(index, atMs);
    const frame = this.#frames.get(index)!;
    frame.extractionPath = selection.path;
    frame.sectionBounds = formatSectionBounds(
      selection.sectionStartMs,
      selection.sectionEndMs,
    );
    frame.validatedBoundedCoverage = selection.coverage === null
      ? null
      : formatCoverage(selection.coverage);
    frame.physicalSeekMs = Number.isFinite(selection.physicalSeekMs)
      ? Math.round(selection.physicalSeekMs * 1_000) / 1_000
      : null;
    if (selection.path === "bounded-section") {
      frame.boundedArtifactCache = selection.transportCacheHit ? "hit" : "miss";
    }
    if (selection.path === "reusable-evidence") {
      frame.reusableArtifactCache = selection.transportCacheHit
        ? "hit"
        : "miss";
    }
  }

  markFallback(index: number, atMs: number, reason: string): void {
    this.ensureFrame(index, atMs);
    const safeReason = /^[a-z0-9][a-z0-9-]{0,63}$/u.test(reason)
      ? reason
      : "unknown";
    const frame = this.#frames.get(index)!;
    frame.fallbackOccurred = true;
    frame.fallbackReasons.add(safeReason);
    this.#fallbackReasons.add(safeReason);
  }

  markFrameStatus(
    index: number,
    atMs: number,
    status: Exclude<ExactFrameStatus, "pending">,
    finalCode: string | null = null,
  ): void {
    this.ensureFrame(index, atMs);
    const frame = this.#frames.get(index)!;
    frame.status = status;
    frame.finalCode = finalCode;
  }

  addStage(stage: ExactFrameStage, elapsedMs: number): void {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return;
    this.#stages[stage] += elapsedMs;
  }

  addFrameStage(
    index: number,
    stage: ExactFrameStage,
    elapsedMs: number,
  ): void {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return;
    const values = this.#frameStages.get(index) ?? {};
    values[stage] = (values[stage] ?? 0) + elapsedMs;
    this.#frameStages.set(index, values);
  }

  markRemoteAcquisition(kind: "media_section" | "evidence_media"): void {
    this.#remoteAcquisitionOccurred = true;
    if (kind === "media_section") this.#remoteBoundedAcquisitionOccurred = true;
    else this.#remoteReusableAcquisitionOccurred = true;
  }

  addNewTransportArtifactBytes(bytes: number): void {
    if (Number.isSafeInteger(bytes) && bytes >= 0) {
      this.#newTransportArtifactBytes += bytes;
    }
  }

  recordSubprocess(
    name: string,
    wallMs: number,
    role: string | undefined,
  ): void {
    const category = subprocessCategory(name);
    const elapsed = Number.isFinite(wallMs) && wallMs >= 0 ? wallMs : 0;
    this.#subprocessCounts.set(
      category,
      (this.#subprocessCounts.get(category) ?? 0) + 1,
    );
    this.#subprocessWallMs.set(
      category,
      (this.#subprocessWallMs.get(category) ?? 0) + elapsed,
    );
    if (role !== undefined && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(role)) {
      this.#subprocessRoleCounts.set(
        role,
        (this.#subprocessRoleCounts.get(role) ?? 0) + 1,
      );
    }
    if (role === "yt-dlp-acquisition") this.#ytDlpWallMs += elapsed;
    if (role === "ffprobe-media-probe") this.#ffprobeWallMs += elapsed;
    if (role === "ffmpeg-exact-frame") this.#ffmpegWallMs += elapsed;
  }

  markFailure(error: unknown): void {
    const code = errorCode(error);
    this.#status = code === "CANCELLED" ? "cancelled" : "failed";
    this.#finalCode = code;
    for (const frame of this.#frames.values()) {
      if (frame.status !== "pending") continue;
      frame.status = this.#status;
      frame.finalCode = code;
    }
  }

  finish(): void {
    if (this.#emitted) return;
    this.#emitted = true;
    if (this.#status === "running") this.#status = "succeeded";
    for (const frame of this.#frames.values()) {
      if (frame.status === "pending") {
        frame.status = this.#status;
        frame.finalCode = this.#finalCode;
      }
    }

    for (
      const frame of [...this.#frames.values()].sort(
        (left, right) => left.index - right.index,
      )
    ) {
      const stage = this.#frameStages.get(frame.index) ?? {};
      diagnosticLog(true, "exact-frame-item", {
        schemaVersion: 1,
        sourceRef: this.#sourceRef,
        sourceDurationMs: this.#sourceDurationMs,
        requestKind: this.#requestKind,
        presentation: this.#presentation,
        frameIndex: frame.index,
        atMs: frame.atMs,
        status: frame.status,
        finalCode: frame.finalCode,
        exactFrameCacheHit: frame.exactFrameCacheHit,
        boundedArtifactCache: frame.boundedArtifactCache,
        reusableArtifactCache: frame.reusableArtifactCache,
        extractionPath: frame.extractionPath,
        sectionBounds: frame.sectionBounds,
        validatedBoundedCoverage: frame.validatedBoundedCoverage,
        physicalSeekMs: frame.physicalSeekMs,
        fallbackOccurred: frame.fallbackOccurred,
        fallbackReasonCategory: compact([...frame.fallbackReasons].sort()),
        exactFrameCacheLookupMs: roundedMs(stage.exactFrameCacheLookupMs ?? 0),
        ffmpegExactFrameExtractionMs: roundedMs(
          stage.ffmpegExactFrameExtractionMs ?? 0,
        ),
        jpegValidationMs: roundedMs(stage.jpegValidationMs ?? 0),
        canonicalExactFrameArtifactCommitMs: roundedMs(
          stage.canonicalExactFrameArtifactCommitMs ?? 0,
        ),
      });
    }

    const cacheCounts = (
      kind: "boundedArtifactCache" | "reusableArtifactCache",
      state: CacheState,
    ): number =>
      [...this.#frames.values()].filter((frame) => frame[kind] === state)
        .length;
    const counts = (map: ReadonlyMap<SubprocessCategory, number>): string =>
      ["yt-dlp", "ffprobe", "ffmpeg", "other"]
        .map((name) => `${name}=${map.get(name as SubprocessCategory) ?? 0}`)
        .join(",");
    const roleCounts = [...this.#subprocessRoleCounts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([role, count]) => `${role}=${count}`)
      .join(",");
    const requestedSectionBounds = [
      ...new Set(
        [...this.#frames.values()]
          .map((frame) => frame.sectionBounds)
          .filter((value): value is string => value !== null),
      ),
    ];
    const validatedCoverage = [
      ...new Set(
        [...this.#frames.values()]
          .map((frame) => frame.validatedBoundedCoverage)
          .filter((value): value is string => value !== null),
      ),
    ];
    const physicalSeeks = [...this.#frames.values()]
      .filter((frame) => frame.physicalSeekMs !== null)
      .map((frame) => `${frame.atMs}:${frame.physicalSeekMs}`);
    const extractionPaths = [...this.#frames.values()].map(
      (frame) => `${frame.atMs}:${frame.extractionPath ?? "unresolved"}`,
    );
    const stage = this.#stages;
    diagnosticLog(true, "exact-frame-request", {
      schemaVersion: 1,
      operation: "get_frames",
      sourceRef: this.#sourceRef,
      sourceDurationMs: this.#sourceDurationMs,
      requestKind: this.#requestKind,
      presentation: this.#presentation,
      requestedTimestampsMs: compactNumberList(this.#requestedTimestampsMs),
      requestedSectionBounds: compact(requestedSectionBounds),
      validatedBoundedCoverage: compact(validatedCoverage),
      physicalSeekMs: compact(physicalSeeks),
      extractionPath: compact(extractionPaths),
      fallbackOccurred: this.#fallbackReasons.size > 0,
      fallbackReasonCategory: compact([...this.#fallbackReasons].sort()),
      exactFrameCacheHits: [...this.#frames.values()].filter(
        (frame) => frame.exactFrameCacheHit === true,
      ).length,
      exactFrameCacheMisses: [...this.#frames.values()].filter(
        (frame) => frame.exactFrameCacheHit === false,
      ).length,
      boundedArtifactCacheHits: cacheCounts("boundedArtifactCache", "hit"),
      boundedArtifactCacheMisses: cacheCounts("boundedArtifactCache", "miss"),
      boundedArtifactCacheNotNeeded: cacheCounts(
        "boundedArtifactCache",
        "not-needed",
      ),
      reusableArtifactCacheHits: cacheCounts("reusableArtifactCache", "hit"),
      reusableArtifactCacheMisses: cacheCounts("reusableArtifactCache", "miss"),
      reusableArtifactCacheNotNeeded: cacheCounts(
        "reusableArtifactCache",
        "not-needed",
      ),
      remoteAcquisitionOccurred: this.#remoteAcquisitionOccurred,
      remoteBoundedAcquisitionOccurred: this.#remoteBoundedAcquisitionOccurred,
      remoteReusableAcquisitionOccurred:
        this.#remoteReusableAcquisitionOccurred,
      newTransportArtifactBytes: this.#newTransportArtifactBytes,
      networkBytesMeasured: null,
      subprocessCounts: counts(this.#subprocessCounts),
      subprocessRoleCounts: roleCounts || null,
      ytDlpProcessCount: this.#subprocessRoleCounts.get("yt-dlp-acquisition") ??
        0,
      ffprobeProcessCount:
        this.#subprocessRoleCounts.get("ffprobe-media-probe") ?? 0,
      ffmpegProcessCount:
        this.#subprocessRoleCounts.get("ffmpeg-exact-frame") ?? 0,
      ytDlpWallMs: roundedMs(this.#ytDlpWallMs),
      ffprobeWallMs: roundedMs(this.#ffprobeWallMs),
      ffmpegWallMs: roundedMs(this.#ffmpegWallMs),
      requestTotalMs: roundedMs(performance.now() - this.#started),
      sourceResolutionMs: roundedMs(stage.sourceResolutionMs),
      exactFrameCacheLookupMs: roundedMs(stage.exactFrameCacheLookupMs),
      artifactCacheLookupMs: roundedMs(stage.artifactCacheLookupMs),
      boundedArtifactCacheLookupMs: roundedMs(
        stage.boundedArtifactCacheLookupMs,
      ),
      reusableArtifactCacheLookupMs: roundedMs(
        stage.reusableArtifactCacheLookupMs,
      ),
      remoteBoundedAcquisitionMs: roundedMs(stage.remoteBoundedAcquisitionMs),
      remoteReusableAcquisitionMs: roundedMs(stage.remoteReusableAcquisitionMs),
      mediaProbeTimingValidationMs: roundedMs(
        stage.mediaProbeTimingValidationMs,
      ),
      artifactValidationMs: roundedMs(stage.artifactValidationMs),
      mediaArtifactCommitMs: roundedMs(stage.mediaArtifactCommitMs),
      artifactValidationCommitMs: roundedMs(
        stage.artifactValidationMs + stage.mediaArtifactCommitMs,
      ),
      reusableMediaFallbackMs: roundedMs(stage.reusableMediaFallbackMs),
      ffmpegExactFrameExtractionMs: roundedMs(
        stage.ffmpegExactFrameExtractionMs,
      ),
      jpegValidationMs: roundedMs(stage.jpegValidationMs),
      canonicalExactFrameArtifactCommitMs: roundedMs(
        stage.canonicalExactFrameArtifactCommitMs,
      ),
      serviceResultConstructionMs: roundedMs(stage.serviceResultConstructionMs),
      mcpResultConstructionMs: roundedMs(stage.mcpResultConstructionMs),
      resultConstructionMs: roundedMs(
        stage.serviceResultConstructionMs + stage.mcpResultConstructionMs,
      ),
      status: this.#status,
      finalCode: this.#finalCode,
    });
  }
}

/** Get the active exact-frame trace */
export function currentExactFrameDiagnosticTrace():
  | ExactFrameDiagnosticTrace
  | null {
  return diagnosticStorage.getStore() ?? null;
}

/** Run an operation with request-local exact-frame tracing */
export async function withExactFrameDiagnostics<T>(
  enabled: boolean,
  seed: ExactFrameDiagnosticSeed,
  operation: (trace: ExactFrameDiagnosticTrace | null) => Promise<T>,
): Promise<T> {
  const existing = currentExactFrameDiagnosticTrace();
  if (existing) return await operation(existing);
  if (!enabled) return await operation(null);
  const trace = new ExactFrameDiagnosticTrace(seed);
  return await diagnosticStorage.run(trace, async () => {
    try {
      return await operation(trace);
    } catch (error) {
      trace.markFailure(error);
      throw error;
    } finally {
      trace.finish();
    }
  });
}

export async function measureDiagnosticAsync<T>(
  trace: ExactFrameDiagnosticTrace | null,
  stage: ExactFrameStage,
  operation: () => Promise<T>,
  frameIndex?: number,
): Promise<T> {
  if (trace === null) return await operation();
  const started = performance.now();
  try {
    return await operation();
  } finally {
    const elapsedMs = performance.now() - started;
    trace.addStage(stage, elapsedMs);
    if (frameIndex !== undefined) {
      trace.addFrameStage(frameIndex, stage, elapsedMs);
    }
  }
}

export function recordDiagnosticSubprocess(
  name: string,
  wallMs: number,
  role?: string,
): void {
  currentExactFrameDiagnosticTrace()?.recordSubprocess(name, wallMs, role);
}

/** Write opt-in diagnostics to stderr and the debug file */
export function diagnosticLog(
  enabled: boolean,
  event: string,
  fields: DiagnosticFields = {},
): void {
  if (!enabled) return;
  let line: string;
  try {
    const trace = currentExactFrameDiagnosticTrace();
    line = JSON.stringify({
      event,
      timestamp: new Date().toISOString(),
      ...(trace === null ? {} : { correlationId: trace.correlationId }),
      ...fields,
    });
  } catch {
    return;
  }
  try {
    process.stderr.write(`Urma debug ${line}\n`);
  } catch {
    // Ignore stderr diagnostic failures
  }
  const file = process.env.URMA_DEBUG_FILE?.trim();
  if (!file) return;
  try {
    appendFileSync(file, `${line}\n`, { encoding: "utf8", flag: "a" });
  } catch {
    // Ignore debug-file failures
  }
}

export function debugFromEnvironment(): boolean {
  return (
    process.env.URMA_DEBUG === "1" ||
    process.env.URMA_DEBUG?.toLowerCase() === "true"
  );
}
