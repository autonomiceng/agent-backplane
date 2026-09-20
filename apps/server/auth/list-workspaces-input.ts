import { t } from "elysia";
import { workspaceResponse } from "./create-workspace-input.ts";

export const listWorkspacesInput = t.Object({
  after: t.Optional(t.String({ minLength: 1, maxLength: 1024 })),
  limit: t.Optional(t.Integer({ minimum: 1, maximum: 100, default: 50 })),
}, { additionalProperties: false });
export const listWorkspacesResponse = t.Object({
  items: t.Array(workspaceResponse),
  nextCursor: t.Nullable(t.String()),
});
export type ListWorkspacesInput = typeof listWorkspacesInput.static;
export type WorkspacesPage = typeof listWorkspacesResponse.static;
