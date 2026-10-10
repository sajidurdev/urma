import type { CandidateKey, SourceRef } from "../core/ids.js";
import type { SnapshotRef } from "../core/model.js";

/**
 * Delivery URLs may contain short-lived credentials. Keep leases in process memory;
 * do not persist or expose them in logs, MCP responses, or snapshot descriptors
 */
export type RemoteAcquisitionLease = Readonly<{
  snapshotRef: SnapshotRef;
  candidateKey: CandidateKey;
  sourceRef: SourceRef;
  formatId: string;
  deliveryUrl: string;
  expiresAtMs: number;
}>;
