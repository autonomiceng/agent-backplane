// User settings take effect for every pending Approval; repeated writes emit nothing.
import type { Pool } from "../platform/pool.ts";
import type { RunContext } from "../runs/run-context.ts";
import { approvalWrite, type ApprovalResult } from "./approval-transaction.ts";
import { approvalMember } from "../auth/decision-session.ts";
import type { setSettingsInput } from "./set-settings-input.ts";
export type SetSettingsResult = ApprovalResult<typeof setSettingsInput.static>;
export function setSettings(pool: Pool, context: Extract<RunContext, { userId: string }>, allowSelfApproval: boolean): Promise<SetSettingsResult> {
  return approvalWrite(pool, context, "approval.settings", [context.workspaceId], async (tx, emit) => {
    await approvalMember(tx, context);
    const [previous] = await tx<{ allow: boolean }[]>`SELECT allow_self_approval AS allow FROM control.approval_settings
      WHERE workspace_id = ${context.workspaceId} FOR UPDATE`;
    if ((previous?.allow ?? false) !== allowSelfApproval) {
      await tx`INSERT INTO control.approval_settings (workspace_id, allow_self_approval) VALUES (${context.workspaceId}, ${allowSelfApproval})
        ON CONFLICT (workspace_id) DO UPDATE SET allow_self_approval = EXCLUDED.allow_self_approval`;
      await emit("approval.settings", [context.workspaceId], 1, { allowSelfApproval });
    }
    return { allowSelfApproval };
  });
}
