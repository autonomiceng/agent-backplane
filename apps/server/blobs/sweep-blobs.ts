// Cleanup runs under the Workspace cursor and preserves stored bytes while recovery is gated.
import type { BlobStore } from "./blob-store.ts";
import type { RunContext } from "../runs/run-context.ts";
import type { Pool } from "../platform/pool.ts";
import { withRunContext, type RunTransaction, type EmitAudit } from "../runs/with-run-context.ts";
import { approvalMember } from "../auth/decision-session.ts";
export async function sweepBlobs(tx: RunTransaction, emit: EmitAudit, workspace: string, store: BlobStore, ids?: string[]): Promise<boolean> {
  let removed = 0, pending = false;
  const deadline = performance.now() + 10000;
  try {
    const [gate] = await tx<{ active: boolean }[]>`SELECT active FROM control.restore_gate WHERE singleton`;
    if (!gate || gate.active) return true;
    const refs = ids ? ids.flatMap((id) => [{ id, staging: false }, { id, staging: true }]) : await store.scanPage(workspace);
    for (const ref of refs) {
      if (performance.now() >= deadline) { pending = true; break; }
      try {
        const [row] = await tx`SELECT id FROM control.blobs WHERE workspace_id=${workspace} AND id=${ref.id}`;
        if (!ref.staging && row) continue;
        await store.remove(workspace, ref); removed++;
      } catch { pending = true; }
    }
  } catch { pending = true; }
  if (removed) await emit("blob.cleanup", [], removed, {});
  return pending;
}
export async function cleanupBlobs(pool: Pool, context: RunContext, store?: BlobStore, ids?: string[]): Promise<boolean> {
  if (!store) return Boolean(ids?.length);
  try {
    return await withRunContext(pool, context, async (tx, emit) => {
      if ("userId" in context) await approvalMember(tx, context);
      return sweepBlobs(tx, emit, context.workspaceId, store, ids);
    }, { timeouts: { statementMs: 5000, lockMs: 2000, transactionMs: 10000 } });
  } catch { return true; }
}
