// Listing and recovery serialize the public ledger envelope without Receipt or dispatch internals.
import { t } from "elysia";
import { deliveryState, type DeliveryResult, type DeliveryState } from "./delivery-result.ts";

export const deliveryEnvelope = t.Object({
  id: t.String({ format: "uuid" }),
  workspaceId: t.String({ format: "uuid" }),
  queue: t.String(),
  messageId: t.String({ format: "uuid" }),
  chainId: t.String({ format: "uuid" }),
  parentId: t.Nullable(t.String({ format: "uuid" })),
  attempt: t.Integer({ minimum: 1 }),
  maxAttempts: t.Integer({ minimum: 1 }),
  current: t.Boolean(),
  state: deliveryState,
  consumerPrincipalId: t.Nullable(t.String({ format: "uuid" })),
  consumerRunId: t.Nullable(t.String({ format: "uuid" })),
  leaseExpiresAt: t.Nullable(t.String({ format: "date-time" })),
  claimedAt: t.Nullable(t.String({ format: "date-time" })),
  completedAt: t.Nullable(t.String({ format: "date-time" })),
  failureCode: t.Nullable(t.String()),
  nextAttemptAt: t.Nullable(t.String({ format: "date-time" })),
  heldBy: t.Nullable(t.String({ format: "uuid" })),
  heldAt: t.Nullable(t.String({ format: "date-time" })),
  effectStartedAt: t.Nullable(t.String({ format: "date-time" })),
  createdAt: t.String({ format: "date-time" }),
}, { additionalProperties: false });

export type DeliveryEnvelope = typeof deliveryEnvelope.static;
export type DeliveryEnvelopeRow = {
  id: string; workspace_id: string; queue: string; message_id: string; chain_id: string; parent_id: string | null;
  attempt: number; max_attempts: number; current: boolean; state: DeliveryState;
  consumer_principal_id: string | null; consumer_run_id: string | null;
  lease_expires_at: string | null; claimed_at: string | null; completed_at: string | null;
  failure_code: string | null; next_attempt_at: string | null; held_by: string | null;
  held_at: string | null; effect_started_at: string | null; created_at: string;
};
export type RecoveryResult = Pick<DeliveryResult, "events"> & { data: DeliveryEnvelopeRow | null };

export function serializeDelivery(row: DeliveryEnvelopeRow): DeliveryEnvelope {
  return {
    id: row.id, workspaceId: row.workspace_id, queue: row.queue, messageId: row.message_id,
    chainId: row.chain_id, parentId: row.parent_id, attempt: row.attempt, maxAttempts: row.max_attempts,
    current: row.current, state: row.state, consumerPrincipalId: row.consumer_principal_id,
    consumerRunId: row.consumer_run_id, leaseExpiresAt: row.lease_expires_at, claimedAt: row.claimed_at,
    completedAt: row.completed_at, failureCode: row.failure_code, nextAttemptAt: row.next_attempt_at,
    heldBy: row.held_by, heldAt: row.held_at, effectStartedAt: row.effect_started_at, createdAt: row.created_at,
  };
}
