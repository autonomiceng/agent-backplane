// Informational catalog for the tenancy adapters; repository SQL migrations own these tables.
import { sql } from "drizzle-orm";
import { check, foreignKey, pgSchema, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { systemPrincipals } from "./system-principals.ts";
import { organization } from "./auth.ts";

const control = pgSchema("control");

export const workspaces = control.table("workspaces", {
  id: uuid("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organization.id),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [check("workspaces_name_check", sql`length(btrim(${table.name})) BETWEEN 1 AND 120`)]);

export const principals = control.table("principals", {
  id: uuid("id").notNull(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  name: text("name").notNull(),
  roleName: text("role_name").notNull().unique(),
  system: text("system"),
  status: text("status").default("active").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  primaryKey({ columns: [table.workspaceId, table.id] }),
  foreignKey({columns:[table.system,table.id],foreignColumns:[systemPrincipals.name,systemPrincipals.id]}),
  uniqueIndex("principal_system").on(table.workspaceId,table.system).where(sql`${table.system} IS NOT NULL`),
  check("principals_system_check",sql`${table.system} IN ('retention','operations')`),
  check("principals_name_check", sql`length(btrim(${table.name})) BETWEEN 1 AND 120`),
  check("principals_role_name_check", sql`octet_length(${table.roleName}) <= 63`),
  check("principals_status_check", sql`${table.status} IN ('active', 'revoked')`),
]);
