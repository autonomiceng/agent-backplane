// Migration adapters supply receipt, gate and database-time facts to these pure policies.
export type MigrationGate = { epoch: string | null; targetVersion: string };
export type MigrationApproval = {
  target_kind: string; target_id: string; target_version: string; requested_by: string;
  gate_epoch: string | null; action_hash: string | null; decision: string | null; consumed: boolean;
  expired: boolean; decision_position: string | null; preview_position: string | null;
};
export type MigrationPolicyResult = "revision_stale" | "approval_gate_not_found" | "approval_stale"
  | "approval_mismatch" | "approval_not_found" | "approval_consumed" | "approval_expired" | "approval_not_approved" | null;
export function migrationRevisionPolicy(currentRevision: string, expectedRevision: number): "revision_stale" | null {
  return currentRevision === String(expectedRevision) ? null : "revision_stale";
}
export function migrationRequestPolicy(target: MigrationGate & { previewMatches: boolean }, expectedRevision: number): MigrationPolicyResult {
  if (!target.epoch) return "approval_gate_not_found";
  if (migrationRevisionPolicy(target.targetVersion, expectedRevision)) return "approval_stale";
  return target.previewMatches ? null : "approval_mismatch";
}
export function migrationConsumptionPolicy(gate: MigrationGate,
  input: { expectedRevision: number; sqlHash: string; previewPosition: string }, principalId: string,
  approval: MigrationApproval | undefined): MigrationPolicyResult {
  const revision = migrationRevisionPolicy(gate.targetVersion, input.expectedRevision);
  if (revision) return revision;
  if (!approval) return "approval_not_found";
  if (approval.requested_by !== principalId || approval.target_kind !== "migration"
    || approval.target_id !== input.sqlHash || approval.action_hash !== input.sqlHash) return "approval_mismatch";
  if (approval.consumed) return "approval_consumed";
  if (approval.expired) return "approval_expired";
  if (!gate.epoch || approval.gate_epoch !== gate.epoch || approval.target_version !== gate.targetVersion) return "approval_stale";
  if (approval.preview_position !== BigInt(input.previewPosition).toString()) return "approval_mismatch";
  if (approval.decision !== "approve") return "approval_not_approved";
  return null;
}
