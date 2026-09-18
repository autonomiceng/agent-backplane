// Informational credential catalog; repository SQL migrations own the table and its grants.
import { sql } from "drizzle-orm";
import { check, customType, foreignKey, pgSchema, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { principals } from "./tenancy.ts";

const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

export const principalKeys = pgSchema("control").table("principal_keys", {
  workspaceId: uuid("workspace_id").notNull(),
  principalId: uuid("principal_id").notNull(),
  prefix: text("prefix").notNull().unique(),
  secretHash: bytea("secret_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  rotatedAt: timestamp("rotated_at", { withTimezone: true }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (table) => [
  primaryKey({ columns: [table.workspaceId, table.principalId] }),
  foreignKey({ columns: [table.workspaceId, table.principalId], foreignColumns: [principals.workspaceId, principals.id] }),
  check("principal_keys_prefix_check", sql`${table.prefix} ~ '^[0-9a-f]{24}$'`),
  check("principal_keys_secret_hash_check", sql`octet_length(${table.secretHash}) = 32`),
]);
