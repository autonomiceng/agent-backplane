// Informational Delivery catalog; queue functions own transitions and Receipt fencing.
import { sql } from "drizzle-orm";
import { bigint, boolean, check, customType, foreignKey, index, integer, pgSchema, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { messages } from "./messages.ts";
import { runs } from "./runs.ts";
import { principals } from "./tenancy.ts";

const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

export const deliveries = pgSchema("queue").table("deliveries", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  queue: text("queue").notNull(),
  messageId: uuid("message_id").notNull(),
  pgmqMsgId: bigint("pgmq_msg_id", { mode: "bigint" }).notNull(),
  chainId: uuid("chain_id").notNull().defaultRandom(),
  parentId: uuid("parent_id"),
  attempt: integer("attempt").notNull().default(1),
  maxAttempts: integer("max_attempts").notNull().default(5),
  current: boolean("current").notNull().default(true),
  state: text("state").notNull().default("ready"),
  receiptTokenHash: bytea("receipt_token_hash"),
  consumerPrincipalId: uuid("consumer_principal_id"),
  consumerRunId: uuid("consumer_run_id").references(() => runs.id),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  failureCode: text("failure_code"),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  heldBy: uuid("held_by"),
  heldAt: timestamp("held_at", { withTimezone: true }),
  effectStartedAt: timestamp("effect_started_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, (table) => [
  foreignKey({ columns: [table.workspaceId, table.queue, table.messageId], foreignColumns: [messages.workspaceId, messages.queue, messages.id] }),
  foreignKey({ columns: [table.workspaceId, table.consumerPrincipalId], foreignColumns: [principals.workspaceId, principals.id] }),
  foreignKey({ columns: [table.workspaceId, table.heldBy], foreignColumns: [principals.workspaceId, principals.id] }),
  unique().on(table.workspaceId, table.queue, table.messageId, table.id),
  foreignKey({ columns: [table.workspaceId, table.queue, table.messageId, table.parentId], foreignColumns: [table.workspaceId, table.queue, table.messageId, table.id] }),
  unique().on(table.messageId, table.chainId, table.attempt),
  uniqueIndex("delivery_current").on(table.messageId).where(sql`${table.current}`),
  uniqueIndex("delivery_dispatch").on(table.workspaceId, table.queue, table.pgmqMsgId).where(sql`${table.current}`),
  index("delivery_begun_expiry").on(table.workspaceId, table.queue, table.leaseExpiresAt, table.id).where(sql`${table.current} AND ${table.state} = 'begun'`),
  index("delivery_begun_principal").on(table.workspaceId, table.consumerPrincipalId, table.id).where(sql`${table.current} AND ${table.state} = 'begun'`),
  check("deliveries_begun_check", sql`${table.state} NOT IN ('begun', 'effect-paused', 'ambiguous') OR ${table.effectStartedAt} IS NOT NULL`),
  check("deliveries_state_check", sql`${table.state} IN ('scheduled', 'ready', 'leased', 'begun', 'held', 'effect-paused', 'ambiguous', 'succeeded', 'dead-lettered', 'cancelled')`),
  check("deliveries_receipt_token_hash_check", sql`octet_length(${table.receiptTokenHash}) = 32`),
  check("deliveries_attempt_check", sql`${table.attempt} BETWEEN 1 AND ${table.maxAttempts}`),
  check("deliveries_receipt_check", sql`(${table.state} IN ('leased', 'begun')) = (${table.receiptTokenHash} IS NOT NULL)`),
]);
