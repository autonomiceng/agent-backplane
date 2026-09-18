// Global telemetry records each sampling invocation without a Workspace audit event.
import { sql } from "drizzle-orm";
import { bigint, check, pgSchema, timestamp, uuid } from "drizzle-orm/pg-core";
export const diskSamples = pgSchema("control").table("disk_samples", {
  observedAt: timestamp("observed_at", { withTimezone: true }).primaryKey().defaultNow(),
  databaseBytes: bigint("database_bytes", { mode: "bigint" }).notNull(),
  blobBytes: bigint("blob_bytes", { mode: "bigint" }).notNull(),
  runId: uuid("run_id").notNull(),
}, (table) => [
  check("disk_samples_database_bytes_check",sql`${table.databaseBytes}>=0`),
  check("disk_samples_blob_bytes_check",sql`${table.blobBytes}>=0`),
]);
