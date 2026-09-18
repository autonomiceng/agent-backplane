// Physical recovery control; administrative bootstrap arms it and User release definers advance it.
import { sql } from "drizzle-orm";
import { bigint, boolean, check, customType, pgSchema, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth.ts";
import { workspaces } from "./tenancy.ts";
const control = pgSchema("control");
const lsn = customType<{ data: string }>({ dataType: () => "pg_lsn" });
export const restoreGate = control.table("restore_gate", {
  singleton: boolean("singleton").primaryKey(), epoch: uuid("epoch"), active: boolean("active").notNull(),
  backupId: text("backup_id"), targetLsn: lsn("target_lsn"),
}, (t) => [check("restore_gate_singleton_check", sql`${t.singleton}`), check("restore_gate_check", sql`NOT ${t.active} OR ${t.epoch} IS NOT NULL`)]);
export const restoreWorkspaces = control.table("restore_workspaces", {
  epoch: uuid("epoch").notNull(), workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  generation: uuid("generation").notNull().defaultRandom(), minimumHead: bigint("minimum_head", { mode: "bigint" }).notNull(),
  rotated: boolean("rotated").notNull().default(false), done: boolean("done").notNull().default(false),
  releasedBy: text("released_by").references(() => user.id),
}, (t) => [primaryKey({ columns: [t.epoch, t.workspaceId] }), check("restore_workspaces_minimum_head_check", sql`${t.minimumHead}>=0`)]);
