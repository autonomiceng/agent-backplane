// One current-minute committed counter per Principal and resource.
import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, pgSchema, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { principals } from "./tenancy.ts";

export const quotaUsage = pgSchema("control").table("quota_usage", {
  workspaceId: uuid("workspace_id").notNull(), principalId: uuid("principal_id").notNull(),
  resource: text("resource").notNull(), windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  used: bigint("used", { mode: "bigint" }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.workspaceId, table.principalId, table.resource] }),
  foreignKey({ columns: [table.workspaceId, table.principalId], foreignColumns: [principals.workspaceId, principals.id] }),
  check("quota_usage_resource_check", sql`${table.resource} IN ('sql_statement_bytes', 'sql_rows', 'transaction_operations', 'queue_sends')`),
  check("quota_usage_used_check", sql`${table.used} >= 0`),
  check("quota_usage_window_start_check", sql`mod(extract(epoch FROM ${table.windowStart}), 60) = 0`),
]);
