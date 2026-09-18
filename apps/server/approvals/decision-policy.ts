// Decision adapters supply database-time and target-version facts to this pure policy.
export function decisionPolicy(facts: {
  targetKind?: string; decided: boolean; expired: boolean; current: boolean; state: string | null;
  targetVersion: string; heldVersion: string | null; allowSelfApproval: boolean;
  principalId: string | null; requestedBy: string; requestedRunPrincipalId: string;
}): "approval_decided" | "approval_expired" | "approval_stale" | "approval_self_forbidden" | null {
  if (facts.decided) return "approval_decided";
  if (facts.expired) return "approval_expired";
  if (!facts.current || ((facts.targetKind ?? "message") === "message" && facts.state !== "held") || facts.targetVersion !== facts.heldVersion) return "approval_stale";
  if (!facts.allowSelfApproval && (facts.principalId === facts.requestedBy
    || facts.principalId === facts.requestedRunPrincipalId)) return "approval_self_forbidden";
  return null;
}
