// Requests bind held Messages, exact row proposals or Principal-owned Migration previews.
import { t } from "elysia";
import { receiptInput } from "../queue/receipt-input.ts";
export const messageRequestInput = t.Object({
  deliveryId: t.String({ format: "uuid" }), ...receiptInput.properties,
  expiresInSeconds: t.Optional(t.Integer({ minimum: 1, maximum: 86400 })),
}, { additionalProperties: false });
export const rowRequestInput = t.Object({ targetKind: t.Literal("row"), table: t.String({ minLength: 1, maxLength: 128 }),
  primaryKey: t.Union([t.Record(t.String(), t.Unknown()), t.String({ description: "Canonical typed primary key JSON text returned by a gate descriptor." })]), targetVersion: t.String({ pattern: "^[a-f0-9]{64}$" }),
  sql: t.Object({ statement: t.String({ minLength: 1, maxLength: 65536 }), params: t.Array(t.Unknown(), { maxItems: 100 }),
    expectRows: t.Literal(1) }, { additionalProperties: false }),
  expiresInSeconds: messageRequestInput.properties.expiresInSeconds,
}, { additionalProperties: false });
export const migrationRequestInput = t.Object({ targetKind: t.Literal("migration"),
  sqlHash: t.String({ pattern: "^[a-f0-9]{64}$" }), expectedRevision: t.Integer({ minimum: 0, maximum: 2147483646 }),
  previewPosition: t.String({ pattern: "^[0-9]+$", maxLength: 19 }),
  expiresInSeconds: messageRequestInput.properties.expiresInSeconds,
}, { additionalProperties: false });
export const requestInput = t.Union([messageRequestInput, rowRequestInput, migrationRequestInput]);
export const approvalParams = t.Object({ workspaceId: t.String({ format: "uuid" }) });
export const requestResponse = t.Object({
  id: t.String({ format: "uuid" }), targetKind: t.Union([t.Literal("message"), t.Literal("row"), t.Literal("migration")]), targetId: t.String(), actionHash: t.Optional(t.String()),
  targetVersion: t.String(), expiresAt: t.String({ format: "date-time" }),
});
