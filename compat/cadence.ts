type RecordValue = Record<string, unknown>;

export type CadencePageExpectation = Readonly<{
  startMs: number;
  endMs: number;
  cadenceMs: number;
  totalTargets: number;
  index: number;
  requestedAtMs: number;
}>;

function record(value: unknown): RecordValue | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as RecordValue
    : null;
}

function shown(value: unknown): string {
  if (value === undefined) return "<absent>";
  const json = JSON.stringify(value);
  return json === undefined ? String(value) : json;
}

export function cadenceAssertionFailures(
  value: unknown,
  expected: CadencePageExpectation,
): string[] {
  const output = record(value);
  const schedule = record(output?.schedule);
  const page = record(output?.page);
  const slots = output?.slots;
  const slot = Array.isArray(slots) ? record(slots[0]) : null;
  const failures: string[] = [];
  const check = (label: string, actual: unknown, wanted: unknown): void => {
    if (actual !== wanted) {
      failures.push(`${label}: expected ${shown(wanted)}, observed ${shown(actual)}`);
    }
  };
  check("schedule.kind", schedule?.kind, "fixed-cadence");
  check("schedule.startMs", schedule?.startMs, expected.startMs);
  check("schedule.endMs", schedule?.endMs, expected.endMs);
  check("schedule.cadenceMs", schedule?.cadenceMs, expected.cadenceMs);
  check("schedule.totalTargets", schedule?.totalTargets, expected.totalTargets);
  check("page.startIndex", page?.startIndex, expected.index);
  check("page.endIndexExclusive", page?.endIndexExclusive, expected.index + 1);
  if (!Array.isArray(slots)) {
    failures.push(`slots: expected an array of length 1, observed ${shown(slots)}`);
    return failures;
  }
  check("slots.length", slots.length, 1);
  if (slot === null) {
    failures.push("slot[0]: expected an object, observed <absent or malformed>");
    return failures;
  }
  check("slot.index", slot.index, expected.index);
  check("slot.requestedAtMs", slot.requestedAtMs, expected.requestedAtMs);
  check("slot.status", slot.status, "success");
  check("slot.resource", typeof slot.resource === "string" && slot.resource.length > 0, true);
  return failures;
}
