// Apply extends the Migration request with the exact SQL hash and successful preview receipt.
import { t } from "elysia";
import { previewMigrationInput } from "./preview-migration-input.ts";

export const applyMigrationInput = t.Object({
  ...previewMigrationInput.properties,
  approvalId: t.Optional(t.String({ format: "uuid" })),
  sqlHash: t.String({ pattern: "^[a-f0-9]{64}$" }),
  previewPosition: t.String({ pattern: "^[0-9]+$", maxLength: 19 }),
}, { additionalProperties: false });
export const applyMigrationResponse = t.Object({
  revision: t.Integer(), name: t.String(), sqlHash: t.String({ pattern: "^[a-f0-9]{64}$" }),
  appliedAt: t.String({ format: "date-time" }),
});
export const applyMigrationErrorResponse = t.Object({ error: t.String(), sqlstate: t.Optional(t.String()), statementIndex: t.Optional(t.Integer()),
  target: t.Optional(t.Object({ targetKind: t.Literal("migration"), targetId: t.String(), targetVersion: t.String() })) });
export type ApplyInput = typeof applyMigrationInput.static;
export type ApplyResponse = typeof applyMigrationResponse.static;
