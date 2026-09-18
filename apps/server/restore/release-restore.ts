// Each release commits one bounded batch and its User-attributed progress together.
import { queryWorkspaceAccess } from "../auth/workspace-access-query.ts";
import type { Pool } from "../platform/pool.ts";
import { withRunContext } from "../runs/with-run-context.ts";
import { recordRejection } from "../runs/record-rejection.ts";
import { emitDeliveryEvents, type DeliveryResult } from "../queue/delivery-result.ts";
export async function releaseRestore(pool: Pool, userId: string, workspaceId: string, epoch: string) {
  const context = { userId, workspaceId };
  try {
    return await withRunContext(pool, context, async (tx, emit) => {
      if (!(await queryWorkspaceAccess(tx, userId, workspaceId)).allowed) throw new Error("workspace_forbidden");
      const [previous] = await tx`SELECT audit.restore_progress(${epoch},${workspaceId},false) AS done`;
      if (previous.done) return { epoch, done: true, processed: 0 };
      const [batch] = await tx<{ result: Pick<DeliveryResult, "events"> }[]>`SELECT queue.restore_batch(${epoch},${workspaceId},100) AS result`;
      if (!batch) throw new Error("restore_unavailable");
      await emitDeliveryEvents(emit, batch.result);
      const [progress] = await tx`SELECT audit.restore_progress(${epoch},${workspaceId},true) AS done`;
      const processed = batch.result.events.length;
      await emit("restore.progress", [workspaceId], processed, { epoch, done: progress.done });
      return { epoch, done: Boolean(progress.done), processed };
    });
  } catch (failure) {
    const error = failure instanceof Error && ["workspace_forbidden", "restore_conflict"].includes(failure.message)
      ? failure.message : "restore_unavailable";
    await recordRejection(pool, { context, kind: "restore.progress", objects: [workspaceId], reason: error, sqlstate: null });
    return { error };
  }
}
