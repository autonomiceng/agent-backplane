// Informational grants catalog; membership ids intentionally survive membership deletion.
import { foreignKey, pgSchema, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth.ts";
import { principals } from "./tenancy.ts";
export const approvalDelegations = pgSchema("control").table("approval_delegations", {
  workspaceId: uuid("workspace_id").notNull(), principalId: uuid("principal_id").notNull(),
  grantedBy: text("granted_by").notNull().references(() => user.id), memberId: text("member_id").notNull(),
}, (table) => [
  primaryKey({ columns: [table.workspaceId, table.principalId] }),
  foreignKey({ columns: [table.workspaceId, table.principalId], foreignColumns: [principals.workspaceId, principals.id] }),
]);
