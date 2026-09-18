// Principal revocation pauses begun Effects inside the User's existing bound transaction.
import type { EmitAudit, RunTransaction } from "../runs/with-run-context.ts";
import { emitDeliveryEvents, type DeliveryResult } from "./delivery-result.ts";

export async function pauseEffectsIn(tx: RunTransaction, emit: EmitAudit, workspaceId: string, principalId: string): Promise<number> {
  const [row] = await tx<{ result: Pick<DeliveryResult, "events"> }[]>`
    SELECT queue.pause_effects(${workspaceId}, ${principalId}) AS result`;
  if (!row) throw new Error("queue_unavailable");
  await emitDeliveryEvents(emit, row.result);
  return row.result.events.filter((event) => event.kind === "effect.paused").length;
}
