// Ownership decision from plain Run facts; run-session translates denial before opening a writing transaction.
import type { PrincipalIdentity } from "../auth/principal-key.ts";

export function runAccess(principal: PrincipalIdentity, run: PrincipalIdentity | null):
  { allowed: true } | { allowed: false; reason: "run_forbidden" } {
  return run !== null && run.workspaceId === principal.workspaceId && run.principalId === principal.principalId
    ? { allowed: true } : { allowed: false, reason: "run_forbidden" };
}
