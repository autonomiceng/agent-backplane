// Informational blob catalog; repository SQL owns provenance and grants.
import { sql } from "drizzle-orm";
import { bigint, check, customType, foreignKey, index, pgSchema, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { workspaces, principals } from "./tenancy.ts";
import { runs } from "./runs.ts";
export const blobs = pgSchema("control").table("blobs", {
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id), id: uuid("id").notNull(), key: text("key").notNull(),
  size: bigint("size", { mode: "number" }).notNull(), sha256: customType<{ data: Buffer }>({ dataType: () => "bytea" })("sha256").notNull(),
  contentType: text("content_type").notNull(), principalId: uuid("principal_id").notNull(), runId: uuid("run_id").notNull().references(() => runs.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(), expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t) => [primaryKey({ columns: [t.workspaceId, t.id] }), unique().on(t.workspaceId, t.key), index("blob_expiry").on(t.workspaceId, t.expiresAt, t.id),
  foreignKey({ columns: [t.workspaceId, t.principalId], foreignColumns: [principals.workspaceId, principals.id] }),
  check("blobs_key_check", sql`octet_length(${t.key}) BETWEEN 1 AND 256 AND ${t.key} ~ '^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}(/[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}){0,3}$'`),
  check("blobs_size_check", sql`${t.size} BETWEEN 0 AND 4194304`), check("blobs_sha256_check", sql`octet_length(${t.sha256})=32`),
  check("blobs_content_type_check", sql`octet_length(${t.contentType}) BETWEEN 1 AND 128 AND ${t.contentType} !~ '[[:cntrl:]]'`),
  check("blobs_check", sql`${t.expiresAt}>${t.createdAt}`)]);
