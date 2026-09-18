// Informational atomic handoff receipt catalog; repository SQL owns grants and context enforcement.
import { sql } from "drizzle-orm";
import { bigint, check, customType, foreignKey, jsonb, pgSchema, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { principals } from "./tenancy.ts";

const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });
export const transactionReceipts = pgSchema("control").table("transaction_receipts", {
  workspaceId: uuid("workspace_id").notNull(), principalId: uuid("principal_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(), requestHash: bytea("request_hash").notNull(),
  response: jsonb("response").notNull(), position: bigint("position", { mode: "bigint" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, (table) => [
  primaryKey({ columns: [table.workspaceId, table.principalId, table.idempotencyKey] }),
  foreignKey({ columns: [table.workspaceId, table.principalId], foreignColumns: [principals.workspaceId, principals.id] }),
  check("transaction_receipts_idempotency_key_check", sql`octet_length(${table.idempotencyKey}) BETWEEN 1 AND 256`),
  check("transaction_receipts_request_hash_check", sql`octet_length(${table.requestHash}) = 32`),
  check("transaction_receipts_response_check", sql`jsonb_typeof(${table.response}) = 'object' AND octet_length(${table.response}::text) <= 16384`),
  check("transaction_receipts_position_check", sql`${table.position} > 0`),
]);
