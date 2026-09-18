// Informational quota settings catalog; repository SQL owns grants and context enforcement.
import { sql } from "drizzle-orm";
import { check, integer, pgSchema, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "./tenancy.ts";

export const workspaceQuotas = pgSchema("control").table("workspace_quotas", {
  workspaceId: uuid("workspace_id").primaryKey().references(() => workspaces.id),
  sqlStatementBytes: integer("sql_statement_bytes").notNull().default(1048576),
  sqlRows: integer("sql_rows").notNull().default(10000),
  transactionOperations: integer("transaction_operations").notNull().default(600),
  queueSends: integer("queue_sends").notNull().default(600),
  openSseStreams: integer("open_sse_streams").notNull().default(16),
}, (table) => [
  check("workspace_quotas_sql_statement_bytes_check", sql`${table.sqlStatementBytes} BETWEEN 0 AND 1073741824`),
  check("workspace_quotas_sql_rows_check", sql`${table.sqlRows} BETWEEN 0 AND 1000000000`),
  check("workspace_quotas_transaction_operations_check", sql`${table.transactionOperations} BETWEEN 0 AND 1000000000`),
  check("workspace_quotas_queue_sends_check", sql`${table.queueSends} BETWEEN 0 AND 1000000000`),
  check("workspace_quotas_open_sse_streams_check", sql`${table.openSseStreams} BETWEEN 0 AND 16`),
]);
