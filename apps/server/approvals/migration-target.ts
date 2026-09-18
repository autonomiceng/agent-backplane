// Migration requests and decisions read gate and revision facts under the bound Workspace cursor.
import type { RunTransaction } from "../runs/with-run-context.ts";
import type { RunContext } from "../runs/run-context.ts";
import type { migrationRequestInput } from "./request-input.ts";
import type { MigrationGate } from "./approval-migration-policy.ts";
export type MigrationTarget = MigrationGate;
export type MigrationPreviewTarget = MigrationTarget & { targetId: string; table: null; primaryKey: null; previewMatches: boolean };
export async function migrationTarget(tx: RunTransaction, workspaceId: string): Promise<MigrationTarget> {
  const [target] = await tx<MigrationTarget[]>`SELECT
    (SELECT epoch FROM control.approval_gates WHERE workspace_id=${workspaceId}
      AND target_kind='migration' AND selector='migration' AND enabled) AS epoch,
    coalesce(max(revision),0)::text AS "targetVersion" FROM control.workspace_migrations WHERE workspace_id=${workspaceId}`;
  if (!target) throw new Error("approval_unavailable");
  return target;
}
export async function migrationPreviewTarget(tx: RunTransaction, context: Extract<RunContext, { principalId: string }>,
  input: typeof migrationRequestInput.static): Promise<MigrationPreviewTarget> {
  const target = await migrationTarget(tx, context.workspaceId);
  const position = BigInt(input.previewPosition) <= 9223372036854775807n ? input.previewPosition : null;
  const [preview] = await tx`SELECT 1 FROM audit.events WHERE workspace_id=${context.workspaceId}
    AND position=${position}::bigint AND kind='migration.previewed' AND principal_id=${context.principalId}
    AND metadata @> ${{ revision: input.expectedRevision, sqlHash: input.sqlHash, policyVersion: 1 }}::jsonb`;
  return { ...target, targetId: input.sqlHash, table: null, primaryKey: null, previewMatches: Boolean(preview) };
}
