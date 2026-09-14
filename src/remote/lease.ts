import type { CandidateKey, SourceRef } from "../core/ids.js";
import type { SnapshotRef } from "../core/model.js";

/**
 * Process-local only. Never persist, log, return through MCP, or put this in a
 * snapshot descriptor. Delivery URLs may contain short-lived credentials.
 */
export type RemoteAcquisitionLease = Readonly<{
  snapshotRef: SnapshotRef;
  candidateKey: CandidateKey;
  sourceRef: SourceRef;
  formatId: string;
  deliveryUrl: string;
  expiresAtMs: number;
}>;
