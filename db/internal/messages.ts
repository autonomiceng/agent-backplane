// Informational immutable Message catalog; repository SQL migrations own storage and grants.
import { sql } from "drizzle-orm";
import { bigint, check, customType, foreignKey, pgSchema, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { queues } from "./queues.ts";
import { runs } from "./runs.ts";
import { principals } from "./tenancy.ts";

const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

export const messages = pgSchema("queue").table("messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  queue: text("queue").notNull(),
  pgmqMsgId: bigint("pgmq_msg_id", { mode: "bigint" }).notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  payloadHash: bytea("payload_hash").notNull(),
  producerPrincipalId: uuid("producer_principal_id").notNull(),
  producerRunId: uuid("producer_run_id").notNull().references(() => runs.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, (table) => [
  foreignKey({ columns: [table.workspaceId, table.queue], foreignColumns: [queues.workspaceId, queues.name] }),
  foreignKey({ columns: [table.workspaceId, table.producerPrincipalId], foreignColumns: [principals.workspaceId, principals.id] }),
  unique().on(table.workspaceId, table.queue, table.idempotencyKey),
  unique().on(table.workspaceId, table.queue, table.pgmqMsgId),
  unique().on(table.workspaceId, table.queue, table.id),
  check("messages_idempotency_key_check", sql`octet_length(${table.idempotencyKey}) BETWEEN 1 AND 256`),
  check("messages_payload_hash_check", sql`octet_length(${table.payloadHash}) = 32`),
]);
