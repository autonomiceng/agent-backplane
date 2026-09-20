// Private installation migration evidence. Runtime receives only intent SELECT.
import { sql } from "drizzle-orm";
import { check, jsonb, pgSchema, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
export const blobStorageMigration = pgSchema("control").table("blob_storage_migration", {
  id: uuid("id").primaryKey(), phase: text("phase").notNull(),
  databaseId: uuid("database_id").notNull(), sourceStoreId: uuid("source_store_id").notNull(), sourceGeneration: uuid("source_generation").notNull(),
  targetStoreId: uuid("target_store_id").notNull(), targetGeneration: uuid("target_generation").notNull(),
  checkpointSha256: text("checkpoint_sha256").notNull(), artifactsSha256: text("artifacts_sha256").notNull(), inventorySha256: text("inventory_sha256").notNull(),
  snapshot: jsonb("snapshot").notNull(), target: jsonb("target").notNull(),
}, t => [check("blob_storage_migration_snapshot_check", sql.raw("COALESCE(jsonb_typeof(snapshot) = 'object'\n    AND snapshot ?& ARRAY['systemId','timeline','postgres','schema','pgmq','heads']\n    AND snapshot - ARRAY['systemId','timeline','postgres','schema','pgmq','heads'] = '{}'::jsonb\n    AND snapshot->>'systemId' ~ '^[0-9]+$' AND snapshot->>'timeline' ~ '^[0-9]+$'\n    AND snapshot->>'postgres' ~ '^[0-9]+$' AND snapshot->>'schema' ~ '^[0-9]+$'\n    AND snapshot->>'pgmq' ~ '^[0-9]+([.][0-9]+)*$' AND jsonb_typeof(snapshot->'heads') = 'array', false)")),
  check("blob_storage_migration_target_check", sql`COALESCE(jsonb_typeof(target) = 'object'
    AND target ?& ARRAY['project','volume','bucket','endpoint','image','credentialsSha256']
    AND target - ARRAY['project','volume','bucket','endpoint','image','credentialsSha256'] = '{}'::jsonb
    AND target->>'project' ~ '^[a-z0-9][a-z0-9_-]{0,127}$'
    AND target->>'volume' ~ '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$'
    AND target->>'bucket' ~ '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$'
    AND target->>'endpoint' = 'http://rustfs:9000'
    AND target->>'image' = 'sha256:8cc9801755448b71a786705ce76692c77e14936cccd87cf2fc31842e58f4d1ff'
    AND target->>'credentialsSha256' ~ '^[0-9a-f]{64}$', false)`),
  uniqueIndex("blob_storage_migration_current").on(sql`(true)`).where(sql`${t.phase} <> 'aborted'`),
  uniqueIndex("blob_storage_migration_target_volume").on(sql`(${t.target}->>'volume')`),
  check("blob_storage_migration_phase_check", sql`${t.phase} IN ('copying','committed_pending_checkpoint','complete','aborted')`),
  check("blob_storage_migration_checkpoint_sha256_check", sql`${t.checkpointSha256} ~ '^[0-9a-f]{64}$'`),
  check("blob_storage_migration_artifacts_sha256_check", sql`${t.artifactsSha256} ~ '^[0-9a-f]{64}$'`),
  check("blob_storage_migration_inventory_sha256_check", sql`${t.inventorySha256} ~ '^[0-9a-f]{64}$'`),
  check("blob_storage_migration_check", sql`${t.sourceStoreId} <> ${t.targetStoreId} AND ${t.sourceGeneration} <> ${t.targetGeneration}`)]);
export const blobStorageMigrationCompletion = pgSchema("control").table("blob_storage_migration_completion", {
  migrationId: uuid("migration_id").primaryKey().references(() => blobStorageMigration.id),
  checkpointSha256: text("checkpoint_sha256").notNull(), artifactsSha256: text("artifacts_sha256").notNull(),
}, t => [check("blob_storage_migration_completion_checkpoint_sha256_check", sql`${t.checkpointSha256} ~ '^[0-9a-f]{64}$'`),
  check("blob_storage_migration_completion_artifacts_sha256_check", sql`${t.artifactsSha256} ~ '^[0-9a-f]{64}$'`)]);
