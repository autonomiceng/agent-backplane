// The atomic handoff contract stores counts and identities, never SQL rows or Receipt tokens.
import type { QuotaFailure } from "../platform/quotas.ts";
import { rowDescriptor, type RowDescriptor } from "../approvals/gate-policy.ts";
import { t } from "elysia";
import { createQueueInput } from "../queue/create-queue-input.ts";
import { receiptInput } from "../queue/receipt-input.ts";

const json = t.Recursive((self) => t.Union([
  t.Null(), t.Boolean(), t.Number(), t.String(), t.Array(self), t.Record(t.String(), self),
]));
const key = t.String({ minLength: 1, maxLength: 256 });
const receipt = t.Object({
  deliveryId: t.String({ format: "uuid" }), receipt: receiptInput.properties.receipt,
}, { additionalProperties: false });
export const executeTransactionInput = t.Object({
  idempotencyKey: key,
  operations: t.Array(t.Union([
    t.Object({ sql: t.Object({
      statement: t.String({ minLength: 1, maxLength: 65536 }),
      params: t.Array(json, { maxItems: 100 }),
      approvalId: t.Optional(t.String({ format: "uuid" })),
      expectRows: t.Optional(t.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
    }, { additionalProperties: false }) }, { additionalProperties: false }),
    t.Object({ send: t.Object({
      queue: createQueueInput.properties.name, idempotencyKey: key, payload: json,
    }, { additionalProperties: false }) }, { additionalProperties: false }),
    t.Object({ ack: receipt }, { additionalProperties: false }),
    t.Object({ hold: receipt }, { additionalProperties: false }),
  ]), { minItems: 1, maxItems: 16 }),
}, { additionalProperties: false });
export const executeTransactionResponse = t.Object({
  committed: t.Literal(true), position: t.String({ pattern: "^[1-9][0-9]*$" }),
  results: t.Array(t.Union([
    t.Object({ sql: t.Object({ rowCount: t.String(), truncated: t.Boolean() }, { additionalProperties: false }) }, { additionalProperties: false }),
    t.Object({ send: t.Object({ messageId: t.String({ format: "uuid" }), inserted: t.Boolean() }, { additionalProperties: false }) }, { additionalProperties: false }),
    t.Object({ ack: t.Object({ deliveryId: t.String({ format: "uuid" }), state: t.Literal("succeeded") }, { additionalProperties: false }) }, { additionalProperties: false }),
    t.Object({ hold: t.Object({ deliveryId: t.String({ format: "uuid" }), state: t.Literal("held") }, { additionalProperties: false }) }, { additionalProperties: false }),
  ]), { minItems: 1, maxItems: 16 }),
}, { additionalProperties: false });
export const transactionErrorResponse = t.Object({
  error: t.String(), target: t.Optional(rowDescriptor), operationIndex: t.Optional(t.Integer({ minimum: 0, maximum: 15 })),
  sqlstate: t.Optional(t.String()),
}, { additionalProperties: false });
export type TransactionInput = typeof executeTransactionInput.static;
export type TransactionResponse = typeof executeTransactionResponse.static;
export type TransactionFailure = { ok: false; quota?: QuotaFailure; status: 429 | 403 | 404 | 408 | 409 | 422 | 503;
  error: string; target?: RowDescriptor; operationIndex?: number; sqlstate?: string };
