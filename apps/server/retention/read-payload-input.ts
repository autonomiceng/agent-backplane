// Audit payload reads identify one envelope and return its expiring capture.
import { t } from "elysia";
export const payloadParams = t.Object({ workspaceId: t.String({ format: "uuid" }), position: t.String({ pattern: "^[0-9]+$", maxLength: 19 }) });
export const payloadResponse = t.Object({ position: t.String(), payloads: t.Array(t.Object({
  kind: t.Union([t.Literal("message"), t.Literal("migration"), t.Literal("reconciliation")]), value: t.Unknown(), expiresAt: t.String(),
})) });
