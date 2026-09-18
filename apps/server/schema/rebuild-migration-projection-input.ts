// User rebuild requests carry no ledger input; the result identifies the projected snapshot.
import { t } from "elysia";
export const rebuildMigrationProjectionInput = t.Object({}, { additionalProperties: false });
export const rebuildMigrationProjectionResponse = t.Object({
  workspaceId: t.String({ format: "uuid" }), revision: t.Integer(),
  mode: t.Union([t.Literal("git"), t.Literal("directory")]), commit: t.Nullable(t.String()),
});
export type ProjectionResponse = typeof rebuildMigrationProjectionResponse.static;
