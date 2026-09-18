// Queue functions return ledger data and ordered Audit Event envelopes to the adapters.
import { t } from "elysia";
import type { EmitAudit } from "../runs/with-run-context.ts";

export const deliveryState = t.Union([
  t.Literal("scheduled"), t.Literal("ready"), t.Literal("leased"), t.Literal("begun"), t.Literal("effect-paused"), t.Literal("held"),
  t.Literal("ambiguous"), t.Literal("succeeded"), t.Literal("dead-lettered"), t.Literal("cancelled"),
]);
export type DeliveryState = typeof deliveryState.static;

export type DeliveryResult<State extends DeliveryState = DeliveryState> = {
  data: {
    id: string;
    message_id: string;
    attempt: number;
    state: State;
    lease_expires_at: string;
    next_attempt_at: string | null;
  } | null;
  events: { kind: string; objects: string[]; metadata: Record<string, unknown> }[];
  payload?: unknown;
};

export async function emitDeliveryEvents(emit: EmitAudit, result: Pick<DeliveryResult, "events">): Promise<void> {
  for (const event of result.events) await emit(event.kind, event.objects, 1, event.metadata);
}
