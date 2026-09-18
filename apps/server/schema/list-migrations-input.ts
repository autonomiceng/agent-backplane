// Ledger pagination and review metadata consumed by the list route and projection.
import { t } from "elysia";
export const listMigrationsInput = t.Object({
  afterRevision: t.Optional(t.Integer({ minimum: 0, maximum: 2147483647, default: 0 })),
  limit: t.Optional(t.Integer({ minimum: 1, maximum: 100, default: 50 })),
}, { additionalProperties: false });
export const migrationEntry = t.Object({
  workspaceId: t.String({ format: "uuid" }), revision: t.Integer(), name: t.String(), sql: t.String(),
  sqlHash: t.String(), statements: t.Integer(), destructive: t.Boolean(),
  appliedBy: t.String({ format: "uuid" }), runId: t.String({ format: "uuid" }), appliedAt: t.String({ format: "date-time" }),
});
export const listMigrationsResponse = t.Object({
  workspaceId: t.String({ format: "uuid" }), currentRevision: t.Integer(), migrations: t.Array(migrationEntry),
  nextAfterRevision: t.Nullable(t.Integer()),
});
export type MigrationEntry = typeof migrationEntry.static;
