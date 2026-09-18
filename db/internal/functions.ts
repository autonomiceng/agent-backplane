// Informational Function ownership catalog; repository SQL owns enforcement and grants.
import { sql } from "drizzle-orm";
import { check, foreignKey, pgSchema, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { principals, workspaces } from "./tenancy.ts";
import { runs } from "./runs.ts";
export const functions = pgSchema("control").table("functions", {
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id), name: text("name").notNull(),
  principalId: uuid("principal_id").notNull(), runId: uuid("run_id").notNull().references(() => runs.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}, (t) => [primaryKey({ columns: [t.workspaceId, t.name] }), unique().on(t.workspaceId, t.name, t.principalId),
  foreignKey({ columns: [t.workspaceId, t.principalId], foreignColumns: [principals.workspaceId, principals.id] }),
  check("functions_name_check", sql`${t.name} ~ '^[a-z][a-z0-9-]{0,62}$'`)]);
