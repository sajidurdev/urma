type ModelRecord = Record<string, unknown>;

function record(value: unknown): ModelRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as ModelRecord
    : null;
}

function without(value: ModelRecord, fields: readonly string[]): ModelRecord {
  const result = { ...value };
  for (const field of fields) delete result[field];
  return result;
}

function identityFrom(
  output: ModelRecord,
): { investigationRef: string; stateResource: string } {
  const summary = record(output.stateSummary);
  const investigationRef = typeof output.investigationRef === "string"
    ? output.investigationRef
    : typeof summary?.investigationRef === "string"
    ? summary.investigationRef
    : null;
  const stateResource = typeof output.stateResource === "string"
    ? output.stateResource
    : typeof summary?.stateResource === "string"
    ? summary.stateResource
    : null;
  if (investigationRef === null || stateResource === null) {
    throw new Error(
      "Validated evidence output omitted investigation identity or state resource",
    );
  }
  return { investigationRef, stateResource };
}

function compactCanonical(value: ModelRecord): ModelRecord {
  return without(value, ["mimeType", "byteSize", "cacheHit"]);
}

function compactSearch(output: ModelRecord): void {
  if (typeof output.query !== "string" || !Array.isArray(output.hits)) return;
  output.hits = output.hits.map((hit) => {
    const value = record(hit);
    if (value === null || !Array.isArray(value.context)) return hit;
    let matchingCueRemoved = false;
    return {
      ...value,
      context: value.context.filter((entry) => {
        const context = record(entry);
        const isMatchingCue = context !== null &&
          context.startMs === value.startMs &&
          context.endMs === value.endMs &&
          context.text === value.text;
        if (isMatchingCue && !matchingCueRemoved) {
          matchingCueRemoved = true;
          return false;
        }
        return true;
      }),
    };
  });
}

function compactOverview(output: ModelRecord): void {
  delete output.requestedCount;
  delete output.interval;
  delete output.cacheHit;
  const artifact = record(output.artifact);
  if (artifact !== null) {
    output.artifact = without(artifact, ["mimeType", "byteSize"]);
  }
  if (Array.isArray(output.cells)) {
    output.cells = output.cells.map((cell) => {
      const value = record(cell);
      return value === null ? cell : without(value, ["artifactId", "resource"]);
    });
  }
  const sampling = record(output.sampling);
  if (sampling !== null) {
    output.sampling = without(sampling, [
      "requestedCount",
      "adjacentSpacingMs",
      "resolutionMs",
    ]);
  }
}

function compactFrameFields(output: ModelRecord): void {
  if (Array.isArray(output.frames)) {
    output.frames = output.frames.map((frame) => {
      const value = record(frame);
      return value === null ? frame : compactCanonical(value);
    });
  }
  if (Array.isArray(output.cells)) {
    output.cells = output.cells.map((cell) => {
      const value = record(cell);
      return value === null ? cell : compactCanonical(value);
    });
  }
  const panel = record(output.panel);
  if (panel !== null) {
    output.panel = without(panel, ["mimeType", "byteSize", "cacheHit"]);
  }
}

function compactSchedule(output: ModelRecord): void {
  const schedule = record(output.schedule);
  if (schedule !== null) {
    output.schedule = without(schedule, ["policyVersion"]);
  }
  if (Array.isArray(output.slots)) {
    output.slots = output.slots.map((slot) => {
      const value = record(slot);
      if (value === null) return slot;
      const compact = without(value, ["timing"]);
      return compact.status === "success"
        ? compactCanonical(compact)
        : compact;
    });
  }
  if (Array.isArray(output.cells)) {
    output.cells = output.cells.map((cell) => {
      const value = record(cell);
      return value === null ? cell : compactCanonical(value);
    });
  }
  const panel = record(output.panel);
  if (panel !== null) {
    output.panel = without(panel, ["mimeType", "byteSize", "cacheHit"]);
  }
}

/**
 * Convert a validated rich EvidenceService record into the compact object
 * registered for MCP. This is intentionally deterministic and keeps every
 * identity, timestamp, completeness, pagination, provenance, and reopenable
 * artifact reference needed by a host model.
 */
export function projectMcpOutput(raw: ModelRecord): ModelRecord {
  const identity = identityFrom(raw);
  const output = without(raw, ["stateSummary"]);
  Object.assign(output, identity);

  if (typeof output.query === "string") {
    compactSearch(output);
  } else if (output.role === "locator") {
    compactOverview(output);
  } else if (output.kind === "scheduled_exact_points") {
    compactSchedule(output);
  } else if (Array.isArray(output.frames) || Array.isArray(output.cells)) {
    compactFrameFields(output);
  }
  return output;
}
