// Get addresses one opaque UUID inside a Workspace.
import { t } from "elysia";
export const getBlobParams = t.Object({ workspaceId: t.String({ format: "uuid" }), id: t.String({ format: "uuid" }) });
