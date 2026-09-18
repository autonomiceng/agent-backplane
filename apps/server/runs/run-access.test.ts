import { expect, test } from "bun:test";
import { runAccess } from "./run-access.ts";
import { parseRunHeader } from "./run-header.ts";

test("foreign Run accepted when ownership or a missing, malformed or repeated header is ignored", () => {
  const principal = { workspaceId: "workspace", principalId: "principal" };
  const denied = { allowed: false, reason: "run_forbidden" } as const;
  expect(runAccess(principal, principal)).toEqual({ allowed: true });
  expect(runAccess(principal, { ...principal, principalId: "other" })).toEqual(denied);
  expect(runAccess(principal, { ...principal, workspaceId: "other" })).toEqual(denied);
  expect(runAccess(principal, null)).toEqual(denied);
  const runId = crypto.randomUUID();
  expect(parseRunHeader(runId.toUpperCase())).toEqual({ ok: true, runId });
  expect(parseRunHeader(null)).toEqual({ ok: false, reason: "run_required" });
  expect(parseRunHeader("broken")).toEqual({ ok: false, reason: "run_invalid" });
  expect(parseRunHeader(`${runId}, ${runId}`)).toEqual({ ok: false, reason: "run_invalid" });
});
