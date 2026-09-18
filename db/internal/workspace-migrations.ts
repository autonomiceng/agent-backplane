// Informational Migration ledger catalog; repository SQL owns its constraints and grants.
import { sql } from "drizzle-orm";
import { boolean, check, customType, foreignKey, integer, pgSchema, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { runs } from "./runs.ts";
import { principals, workspaces } from "./tenancy.ts";

const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });
export const workspaceMigrations = pgSchema("control").table("workspace_migrations", {
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  revision: integer("revision").notNull(), name: text("name").notNull(), sql: text("sql"),
  sqlHash: bytea("sql_hash").notNull(), statements: integer("statements").notNull(), destructive: boolean("destructive").notNull(),
  appliedBy: uuid("applied_by").notNull(), runId: uuid("run_id").notNull().references(() => runs.id),
  appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, (table) => [
  primaryKey({ columns: [table.workspaceId, table.revision] }),
  foreignKey({ columns: [table.workspaceId, table.appliedBy], foreignColumns: [principals.workspaceId, principals.id] }),
  check("workspace_migrations_revision_check", sql`${table.revision} > 0`),
  check("workspace_migrations_name_check", sql`length(btrim(${table.name})) BETWEEN 1 AND 120`),
  check("workspace_migrations_sql_hash_check", sql`octet_length(${table.sqlHash}) = 32`),
  check("workspace_migrations_statements_check", sql`${table.statements} BETWEEN 1 AND 100`),
]);
