// The inbox contract exposes stored target descriptors and database-observed expiry.
import { t } from "elysia";
import { decision } from "./decide-input.ts";
const uuid = t.String({ format: "uuid" }), timestamp = t.String({ format: "date-time" });
export const listApprovalsInput = t.Object({
  state: t.Optional(t.Union([t.Literal("pending"), t.Literal("decided")], { default: "pending" })),
  limit: t.Optional(t.Integer({ minimum: 1, maximum: 100, default: 50 })),
  after: t.Optional(t.String({ minLength: 1, maxLength: 1024 })),
}, { additionalProperties: false });
export const approvalEnvelope = t.Object({
  id: uuid, workspaceId: uuid, requestedBy: uuid, requestedRunId: uuid, createdAt: timestamp,
  expiresAt: timestamp, expired: t.Boolean(), targetId: t.String(), targetVersion: t.String(),
  target: t.Union([
    t.Object({ kind: t.Literal("message"), queue: t.String(), messageId: uuid, deliveryId: uuid }),
    t.Object({ kind: t.Literal("row"), table: t.String(), primaryKey: t.String(), targetVersion: t.String(),
      actionHash: t.String({ pattern: "^[a-f0-9]{64}$" }) }),
    t.Object({ kind: t.Literal("migration"), sqlHash: t.String({ pattern: "^[a-f0-9]{64}$" }),
      expectedRevision: t.Integer({ minimum: 0 }) }),
  ]),
  decision: t.Nullable(decision), reason: t.Nullable(t.String()),
  decisionPosition: t.Nullable(t.String({ pattern: "^[0-9]+$" })), releasedDeliveryId: t.Nullable(uuid),
});
export const listApprovalsResponse = t.Object({ items: t.Array(approvalEnvelope), nextCursor: t.Nullable(t.String()), observedAt: timestamp });
export type Approval = typeof approvalEnvelope.static;
export type ApprovalsPage = typeof listApprovalsResponse.static;
export type ListApprovalsInput = typeof listApprovalsInput.static;
