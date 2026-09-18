// HTTP contract for a bounded live Migration preview and its audit receipt.
import { t } from "elysia";

export const previewMigrationInput = t.Object({
  name: t.String({ minLength: 1, maxLength: 120, pattern: "\\S" }),
  sql: t.String({ minLength: 1, maxLength: 65536 }),
  expectedRevision: t.Integer({ minimum: 0, maximum: 2147483646 }),
  destructive: t.Boolean({ default: false }),
}, { additionalProperties: false });
export const previewMigrationResponse = t.Object({
  revision: t.Integer(), sqlHash: t.String({ pattern: "^[a-f0-9]{64}$" }), previewPosition: t.String({ pattern: "^[0-9]+$" }),
  statements: t.Array(t.Object({ kind: t.String(), target: t.String(), destructive: t.Boolean() })),
  destructive: t.Boolean(), locks: t.Array(t.Object({ relation: t.String(), modes: t.Array(t.String()) })), elapsedMs: t.Number(),
});
export const migrationErrorResponse = t.Object({ error: t.String(), sqlstate: t.Optional(t.String()), statementIndex: t.Optional(t.Integer()) });
export type MigrationInput = typeof previewMigrationInput.static;
export type PreviewResponse = typeof previewMigrationResponse.static;
