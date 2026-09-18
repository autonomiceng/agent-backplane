// Informational gate catalog; repository SQL owns User context enforcement.
import { sql } from "drizzle-orm";
import { boolean, check, pgSchema, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "./tenancy.ts";
import { user } from "./auth.ts";
export const approvalGates = pgSchema("control").table("approval_gates", {
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id), targetKind: text("target_kind").notNull(),
  selector: text("selector").notNull(), enabled: boolean("enabled").notNull(), epoch: uuid("epoch").notNull().defaultRandom(),
  declaredBy: text("declared_by").notNull().references(() => user.id),
}, (t) => [primaryKey({ columns: [t.workspaceId, t.targetKind, t.selector] }),
  check("approval_gates_target_kind_check", sql`${t.targetKind} IN ('row','migration')`),
  check("approval_gates_selector_check", sql`${t.targetKind} <> 'migration' OR ${t.selector} = 'migration'`)]);
