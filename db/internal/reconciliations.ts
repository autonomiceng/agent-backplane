// Informational decision catalog; repository SQL owns the audit position FK.
import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, pgSchema, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { principals, workspaces } from "./tenancy.ts";
import { runs } from "./runs.ts";
import { deliveries } from "./deliveries.ts";
export const reconciliations = pgSchema("control").table("reconciliations", {
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  id: uuid("id").primaryKey().defaultRandom(), workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  deliveryId: uuid("delivery_id").notNull().references(() => deliveries.id), outcome: text("outcome").notNull(),
  evidence: text("evidence"), principalId: uuid("principal_id"), runId: uuid("run_id").references(() => runs.id), userId: text("user_id"),
  successorDeliveryId: uuid("successor_delivery_id").references(() => deliveries.id), decisionPosition: bigint("decision_position", { mode: "bigint" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, (table) => [
  foreignKey({ columns: [table.workspaceId, table.principalId], foreignColumns: [principals.workspaceId, principals.id] }),
  unique().on(table.workspaceId, table.id), unique().on(table.workspaceId, table.deliveryId, table.outcome),
  uniqueIndex("reconciliation_definitive").on(table.workspaceId, table.deliveryId).where(sql`${table.outcome} <> 'unknown'`),
  check("reconciliations_outcome_check", sql`${table.outcome} IN ('applied','not_applied','unknown')`),
  check("reconciliations_evidence_check", sql`octet_length(convert_to(${table.evidence},'UTF8')) BETWEEN 1 AND 4096`),
  check("reconciliations_actor_check", sql`(${table.principalId} IS NOT NULL AND ${table.runId} IS NOT NULL AND ${table.userId} IS NULL)
    OR (${table.principalId} IS NULL AND ${table.runId} IS NULL AND ${table.userId} IS NOT NULL)`),
  check("reconciliations_successor_check", sql`(${table.outcome} = 'not_applied') = (${table.successorDeliveryId} IS NOT NULL)`),
]);
