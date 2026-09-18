// Delete addresses one opaque UUID inside a Workspace.
import { t } from "elysia";
export const deleteBlobParams = t.Object({ workspaceId: t.String({ format: "uuid" }), id: t.String({ format: "uuid" }) });
