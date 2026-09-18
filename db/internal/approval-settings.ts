// Informational settings catalog; repository SQL owns User context enforcement.
import { boolean, pgSchema, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "./tenancy.ts";
export const approvalSettings = pgSchema("control").table("approval_settings", {
  workspaceId: uuid("workspace_id").primaryKey().references(() => workspaces.id),
  allowSelfApproval: boolean("allow_self_approval").notNull().default(false),
});
