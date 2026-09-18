// Parses the Run header for run-session; Headers combines repeated values with commas, which are invalid here.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseRunHeader(value: string | null):
  { ok: true; runId: string } | { ok: false; reason: "run_required" | "run_invalid" } {
  if (value === null) return { ok: false, reason: "run_required" };
  if (value.length !== 36 || !UUID.test(value)) return { ok: false, reason: "run_invalid" };
  return { ok: true, runId: value.toLowerCase() };
}
