// Audit read contracts expose only envelopes and decimal cursors, never Run payload fields.
import { t } from "elysia";

export const readAuditInput = t.Object({
  runId: t.Optional(t.String({ format: "uuid" })),
  after: t.Optional(t.String({ pattern: "^[0-9]+$", default: "0" })),
  limit: t.Optional(t.Integer({ minimum: 1, maximum: 500, default: 100 })),
}, { additionalProperties: false });
export const auditEnvelope = t.Object({
  position: t.String({ pattern: "^[0-9]+$" }),
  kind: t.String(),
  objects: t.Array(t.String()),
  row_count: t.Nullable(t.String({ pattern: "^[0-9]+$" })),
  occurred_at: t.String({ format: "date-time" }),
  principal_id: t.Nullable(t.String({ format: "uuid" })),
  run_id: t.Nullable(t.String({ format: "uuid" })),
  user_id: t.Nullable(t.String()),
  metadata: t.Record(t.String(), t.Unknown()),
}, { additionalProperties: false });
export const readAuditResponse = t.Object({ events: t.Array(auditEnvelope), nextAfter: t.String() });

export type AuditPage = typeof readAuditResponse.static;

export type AuditQuery = { runId?: string; after: string; limit: number };

export const MAX_POSITION = 9223372036854775807n;

// Bun returns jsonb as a string or an object depending on the expression; anything that is not a plain object becomes {}.
export function jsonObject(value: unknown): Record<string, unknown> {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}
