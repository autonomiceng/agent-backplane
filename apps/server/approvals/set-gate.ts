// User policy writes share the Workspace cursor with requests and execution.
import type { Pool } from "../platform/pool.ts";
import type { RunContext } from "../runs/run-context.ts";
import { approvalWrite } from "./approval-transaction.ts";
import { approvalMember } from "../auth/decision-session.ts";
import { rowTable } from "./row-target.ts";
import type { setGateInput, setGateResponse } from "./set-gate-input.ts";
export function setGate(pool: Pool, context: Extract<RunContext, { userId: string }>, input: typeof setGateInput.static) {
  return approvalWrite<typeof setGateResponse.static>(pool, context, "approval.gate", [], async (tx, emit) => {
    await approvalMember(tx, context);
    const table = rowTable(context.workspaceId, input.selector);
    if (input.targetKind === "migration" && input.selector !== "migration") throw new Error("invalid_input");
    if (input.targetKind === "row") await tx`SELECT control.lock_approval_row(${context.workspaceId}, ${table})`;
    const selector = input.targetKind === "migration" ? "migration" : `ws_${context.workspaceId.replaceAll("-", "")}.${table}`;
    const [changed] = await tx<{ epoch: string }[]>`INSERT INTO control.approval_gates (workspace_id,target_kind,selector,enabled,declared_by)
      VALUES (${context.workspaceId}, ${input.targetKind}, ${selector}, ${input.enabled}, ${context.userId})
      ON CONFLICT (workspace_id,target_kind,selector) DO UPDATE SET enabled=EXCLUDED.enabled,
        epoch=gen_random_uuid(), declared_by=EXCLUDED.declared_by WHERE approval_gates.enabled IS DISTINCT FROM EXCLUDED.enabled RETURNING epoch`;
    const [gate] = changed ? [changed] : await tx<{ epoch: string }[]>`SELECT epoch FROM control.approval_gates
      WHERE workspace_id=${context.workspaceId} AND target_kind=${input.targetKind} AND selector=${selector}`;
    if (!gate) throw new Error("approval_unavailable");
    if (changed) await emit("approval.gate", [], 1, { targetKind: input.targetKind, epoch: gate.epoch, enabled: input.enabled });
    return { ...input, selector, epoch: gate.epoch, mutations: input.targetKind === "migration" ? ["apply"] : ["update", "delete"] };
  });
}
