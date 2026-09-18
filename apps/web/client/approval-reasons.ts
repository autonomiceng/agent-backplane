// The inbox adapter and screen share the permitted decisions for each machine-code reason.
import type { DecisionResult } from "./approval-state.ts";
type ApprovalReason = { code: "reviewed" | "policy_denied" | "insufficient_evidence";
  label: string; decisions: DecisionResult["decision"][] };
export const approvalReasons = [
  { code: "reviewed", label: "reviewed", decisions: ["approve"] },
  { code: "policy_denied", label: "policy_denied", decisions: ["reject"] },
  { code: "insufficient_evidence", label: "insufficient_evidence", decisions: ["reject"] },
] satisfies ApprovalReason[];
export function reasonPermitsDecision(code: string, decision: DecisionResult["decision"]): boolean {
  return approvalReasons.some((reason) => reason.code === code && reason.decisions.some((permitted) => permitted === decision));
}
