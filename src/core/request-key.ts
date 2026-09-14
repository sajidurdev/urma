import { sha256, stableJson } from "./ids.js";

export function deterministicRequestKey(
  sourceRevision: string,
  operation: string,
  parameters: unknown,
  producerVersion: string,
): string {
  if (!sourceRevision || !operation || !producerVersion) {
    throw new TypeError(
      "Request identity requires source revision, operation, and producer version",
    );
  }
  return sha256(
    stableJson({ sourceRevision, operation, parameters, producerVersion }),
  );
}
