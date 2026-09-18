// Informational Approval catalog; repository SQL owns the audit FK and bound-context trigger.
import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, pgSchema, text, timestamp, uniqueIndex, index, customType, jsonb, uuid } from "drizzle-orm/pg-core";
import { principals, workspaces } from "./tenancy.ts";
import { runs } from "./runs.ts";
import { deliveries } from "./deliveries.ts";
const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });
export const approvals = pgSchema("control").table("approvals", {
  id: uuid("id").primaryKey().defaultRandom(), workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  targetKind: text("target_kind").notNull(), targetId: text("target_id").notNull(), targetVersion: text("target_version").notNull(),
  requestedBy: uuid("requested_by").notNull(), requestedRunId: uuid("requested_run_id").notNull().references(() => runs.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(), decision: text("decision"), reason: text("reason"),
  gateEpoch: uuid("gate_epoch"), actionHash: bytea("action_hash"), rowTable: text("row_table"), rowKey: jsonb("row_key"),
  previewPosition: bigint("preview_position", { mode: "bigint" }),
  consumedPosition: bigint("consumed_position", { mode: "bigint" }),
  decisionPosition: bigint("decision_position", { mode: "bigint" }), releasedDeliveryId: uuid("released_delivery_id"),
}, (table) => [
  foreignKey({ name: "approvals_workspace_released_delivery_fk", columns: [table.workspaceId, table.releasedDeliveryId], foreignColumns: [deliveries.workspaceId, deliveries.id] }),
  foreignKey({ columns: [table.workspaceId, table.requestedBy], foreignColumns: [principals.workspaceId, principals.id] }),
  uniqueIndex("approvals_target_unique").on(table.workspaceId, table.targetKind, table.targetId, table.targetVersion).where(sql`${table.targetKind} = 'message'`),
  index("approvals_inbox").on(table.workspaceId, sql`(${table.decision} IS NOT NULL)`, table.createdAt, table.id),
  index("approvals_row_consumptions").on(table.workspaceId, table.targetId, table.consumedPosition.desc())
    .where(sql`${table.targetKind} = 'row' AND ${table.consumedPosition} IS NOT NULL`),
  check("approvals_migration_target_check", sql`${table.targetKind} <> 'migration' OR (${table.gateEpoch} IS NOT NULL AND ${table.actionHash} IS NOT NULL
    AND ${table.targetId} = encode(${table.actionHash},'hex') AND ${table.targetVersion} ~ '^(0|[1-9][0-9]*)$'
    AND ${table.previewPosition} IS NOT NULL AND ${table.rowTable} IS NULL AND ${table.rowKey} IS NULL)`),
  check("approvals_action_hash_check", sql`octet_length(${table.actionHash}) = 32`),
  check("approvals_consumed_check", sql`${table.consumedPosition} IS NULL OR (${table.targetKind} IN ('row','migration') AND ${table.decision} IS NOT DISTINCT FROM 'approve')`),
  check("approvals_target_kind_check", sql`${table.targetKind} IN ('message','row','migration')`),
  check("approvals_target_id_check", sql`length(${table.targetId}) BETWEEN 1 AND 512`),
  check("approvals_target_version_check", sql`length(${table.targetVersion}) BETWEEN 1 AND 128`),
  check("approvals_decision_check", sql`${table.decision} IN ('approve', 'reject')`),
  check("approvals_reason_check", sql`${table.reason} ~ '^[a-z][a-z0-9_]{0,63}$'`),
  check("approvals_expiry_check", sql`${table.expiresAt} > ${table.createdAt} AND ${table.expiresAt} <= ${table.createdAt} + interval '24 hours'`),
  check("approvals_outcome_check", sql`(${table.decision} IS NULL AND num_nonnulls(${table.reason}, ${table.decisionPosition}, ${table.releasedDeliveryId}) = 0)
    OR (${table.decision} IS NOT NULL AND ${table.reason} IS NOT NULL AND ${table.decisionPosition} IS NOT NULL
      AND ((${table.targetKind} = 'message' AND ${table.decision} = 'approve') = (${table.releasedDeliveryId} IS NOT NULL)))`),
]);
