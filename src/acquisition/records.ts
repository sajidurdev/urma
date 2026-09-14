import { randomUUID } from "node:crypto";
import { diagnosticLog } from "../core/diagnostics.js";
import type { InvestigationRef, SourceRef } from "../core/ids.js";
import type { AcquisitionMethod } from "../core/model.js";
import { normalizeError } from "../core/errors.js";
import type { UrmaStore } from "../store/store.js";

export type AcquisitionHandle = Readonly<{
  id: string;
  started: number;
  succeed(values?: {
    networkBytes?: number | null;
    networkAccountingComplete?: boolean;
    metadata?: Readonly<Record<string, unknown>>;
  }): void;
  fail(error: unknown): void;
}>;
export function startAcquisition(
  store: UrmaStore,
  values: {
    sourceRef: SourceRef;
    sourceRevision: string;
    investigationRef: InvestigationRef | null;
    operation: string;
    requestKey: string;
    method: AcquisitionMethod;
    startedMonotonic?: number;
    startedAt?: string;
    debug?: boolean;
  },
): AcquisitionHandle {
  const {
    startedMonotonic,
    startedAt: providedStartedAt,
    debug = false,
    ...record
  } = values;
  const id = randomUUID();
  const started = startedMonotonic ?? performance.now();
  const startedAt = providedStartedAt ?? new Date().toISOString();
  store.beginAcquisition({
    id,
    ...record,
    status: "running",
    startedAt,
    completedAt: null,
    wallMs: null,
    networkBytes: null,
    networkAccountingComplete: false,
    errorCode: null,
    metadata: {},
  });
  return {
    id,
    started,
    succeed(result = {}) {
      const wallMs = Math.round(performance.now() - started);
      store.finishAcquisition(id, {
        status: "succeeded",
        completedAt: new Date().toISOString(),
        wallMs,
        networkBytes: result.networkBytes ?? null,
        networkAccountingComplete: result.networkAccountingComplete ?? false,
        errorCode: null,
        metadata: result.metadata ?? {},
      });
      const metadata = result.metadata ?? {};
      diagnosticLog(debug, "acquisition", {
        operation: record.operation,
        method: record.method,
        investigationRef: record.investigationRef,
        status: "succeeded",
        wallMs,
        networkBytes: result.networkBytes ?? null,
        batch: typeof metadata.batch === "boolean" ? metadata.batch : null,
        cacheHit: typeof metadata.cacheHit === "boolean"
          ? metadata.cacheHit
          : null,
        cacheHits: typeof metadata.cacheHits === "number"
          ? metadata.cacheHits
          : null,
        imageCount: typeof metadata.imageCount === "number"
          ? metadata.imageCount
          : null,
        imageBytes: typeof metadata.imageBytes === "number"
          ? metadata.imageBytes
          : null,
        logicalQueries: typeof metadata.logicalQueries === "number"
          ? metadata.logicalQueries
          : null,
        uniqueHits: typeof metadata.uniqueHits === "number"
          ? metadata.uniqueHits
          : null,
        resultCharacters: typeof metadata.resultCharacters === "number"
          ? metadata.resultCharacters
          : null,
        resultBytes: typeof metadata.resultBytes === "number"
          ? metadata.resultBytes
          : null,
        candidateHitCount: typeof metadata.candidateHitCount === "number"
          ? metadata.candidateHitCount
          : null,
        omittedHits: typeof metadata.omittedHits === "number"
          ? metadata.omittedHits
          : null,
        duplicateSpansEliminated:
          typeof metadata.duplicateSpansEliminated === "number"
            ? metadata.duplicateSpansEliminated
            : null,
        partial: typeof metadata.partial === "boolean"
          ? metadata.partial
          : null,
        timestampsRequested: typeof metadata.timestampsRequested === "number"
          ? metadata.timestampsRequested
          : null,
        framesReturned: typeof metadata.framesReturned === "number"
          ? metadata.framesReturned
          : null,
      });
    },
    fail(error) {
      const normalized = normalizeError(error);
      const wallMs = Math.round(performance.now() - started);
      store.finishAcquisition(id, {
        status: normalized.code === "CANCELLED" ? "cancelled" : "failed",
        completedAt: new Date().toISOString(),
        wallMs,
        networkBytes: null,
        networkAccountingComplete: false,
        errorCode: normalized.code,
        metadata: { message: normalized.message },
      });
      diagnosticLog(debug, "acquisition", {
        operation: record.operation,
        method: record.method,
        investigationRef: record.investigationRef,
        status: normalized.code === "CANCELLED" ? "cancelled" : "failed",
        wallMs,
        errorCode: normalized.code,
        networkBytes: null,
        cacheHit: null,
        cacheHits: null,
        imageCount: null,
        imageBytes: null,
        logicalQueries: null,
        uniqueHits: null,
        resultCharacters: null,
        resultBytes: null,
        candidateHitCount: null,
        omittedHits: null,
        duplicateSpansEliminated: null,
        partial: null,
        timestampsRequested: null,
        framesReturned: null,
        batch: null,
      });
    },
  };
}
