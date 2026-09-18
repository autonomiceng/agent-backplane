// HTTP contract for createPrincipal, including its Workspace-scoped route parameter.
import { t } from "elysia";

export const createPrincipalInput = t.Object({ name: t.String({ minLength: 1, maxLength: 120, pattern: "\\S" }) });
export const createPrincipalParams = t.Object({ workspaceId: t.String({ format: "uuid" }) });
export const principalResponse = t.Object({
  id: t.String({ format: "uuid" }),
  workspaceId: t.String({ format: "uuid" }),
  name: t.String(),
  roleName: t.String(),
  status: t.Union([t.Literal("active"), t.Literal("revoked")]),
  createdAt: t.String({ format: "date-time" }),
});
