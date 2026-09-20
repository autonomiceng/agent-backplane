// Private installation identity; only fenced operator adoption may populate it.
import { sql } from "drizzle-orm";
import { boolean, check, integer, pgSchema, primaryKey, text, uuid } from "drizzle-orm/pg-core";
export const blobStorageBinding = pgSchema("control").table("blob_storage_binding", {
  singleton: boolean("singleton").primaryKey().default(true),
  databaseId: uuid("database_id").notNull(), storeId: uuid("store_id").notNull(),
  intentKind: text("intent_kind"), checkpointRef: text("checkpoint_ref"),
  retainUnreferenced: boolean("retain_unreferenced").notNull().default(false), inventorySha256: text("inventory_sha256"),
  generation: uuid("generation").notNull(), backend: text("backend").notNull(), phase: text("phase").notNull(),
}, t => [check("blob_storage_binding_singleton_check", sql`${t.singleton}`),
  check("blob_storage_binding_backend_check", sql`${t.backend} IN ('filesystem','s3')`),
  check("blob_storage_binding_intent_kind_check", sql`${t.intentKind} IN ('initialize','adopt','reconcile')`),
  check("blob_storage_binding_inventory_sha256_check", sql`${t.inventorySha256} ~ '^[0-9a-f]{64}$'`),
  check("blob_storage_binding_phase_check", sql`${t.phase} IN ('verifying','ready')`)]);

// Retained physical leftovers have no Workspace FK: bytes may outlive a deleted reference.
export const blobStorageRetained = pgSchema("control").table("blob_storage_retained", {
  workspaceId: uuid("workspace_id").notNull(), id: uuid("id").notNull(), staging: boolean("staging").notNull(),
  size: integer("size").notNull(), sha256: text("sha256").notNull(),
}, t => [primaryKey({ columns: [t.workspaceId, t.id, t.staging] }),
  check("blob_storage_retained_size_check", sql`${t.size} BETWEEN 0 AND 4194304`),
  check("blob_storage_retained_sha256_check", sql`${t.sha256} ~ '^[0-9a-f]{64}$'`)]);
