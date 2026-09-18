// Informational retention policy catalog; repository SQL owns User context enforcement.
import { sql } from "drizzle-orm";
import { check, integer, pgSchema, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "./tenancy.ts";
export const retentionSettings = pgSchema("control").table("retention_settings", {
  workspaceId: uuid("workspace_id").primaryKey().references(() => workspaces.id),
  seconds: integer("seconds").notNull().default(2592000),
}, (table) => [check("retention_settings_seconds_check", sql`${table.seconds} BETWEEN 1 AND 31536000`)]);
