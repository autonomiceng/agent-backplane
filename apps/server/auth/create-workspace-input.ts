// HTTP contract for createWorkspace; the route trims accepted names before persistence.
import { t } from "elysia";

export const createWorkspaceInput = t.Object({ name: t.String({ minLength: 1, maxLength: 120, pattern: "\\S" }) });
export const workspaceResponse = t.Object({
  id: t.String({ format: "uuid" }),
  organizationId: t.String(),
  name: t.String(),
  createdAt: t.String({ format: "date-time" }),
});
