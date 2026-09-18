// Migration-owned built-in identities; Workspace memberships share their immutable ID.
import { sql } from "drizzle-orm";
import { check, pgSchema, text, unique, uuid } from "drizzle-orm/pg-core";
export const systemPrincipals = pgSchema("control").table("system_principals", {
  name: text("name").primaryKey(),
  id: uuid("id").notNull().defaultRandom().unique(),
}, (table) => [unique().on(table.name,table.id),check("system_principals_name_check",sql`${table.name} IN ('retention','operations')`)]);
