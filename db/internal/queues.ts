// Informational Queue catalog; repository SQL migrations own the table and its grants.
import { sql } from "drizzle-orm";
import { check, pgSchema, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "./tenancy.ts";

export const queues = pgSchema("queue").table("queues", {
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  name: text("name").notNull(),
  pgmqQueue: text("pgmq_queue").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, (table) => [
  primaryKey({ columns: [table.workspaceId, table.name] }),
  check("queues_name_check", sql`${table.name} ~ '^[a-z][a-z0-9_-]{0,62}$'`),
  check("queues_pgmq_queue_check", sql`${table.pgmqQueue} ~ '^bp_[0-9a-f]{44}$'`),
]);
