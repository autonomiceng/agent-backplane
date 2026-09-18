// Informational Run catalog; repository SQL migrations own the table and its grants.
import { sql } from "drizzle-orm";
import { type AnyPgColumn, check, foreignKey, jsonb, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { deployments } from "./deployments.ts";
import { principals } from "./tenancy.ts";

export const runs = pgSchema("control").table("runs", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  principalId: uuid("principal_id").notNull(),
  parentRunId: uuid("parent_run_id").references((): AnyPgColumn => runs.id),
  invocationDeploymentId: uuid("invocation_deployment_id"),
  harness: text("harness"),
  model: text("model"),
  label: text("label"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({ columns: [table.workspaceId, table.principalId], foreignColumns: [principals.workspaceId, principals.id] }),
  foreignKey({ columns: [table.workspaceId, table.invocationDeploymentId], foreignColumns: [deploymentWorkspace(), deploymentId()] }),
  check("invocation_parent_required", sql`${table.invocationDeploymentId} IS NULL OR ${table.parentRunId} IS NOT NULL`),
  check("runs_metadata_check", sql`jsonb_typeof(${table.metadata}) = 'object'`),
]);

function deploymentWorkspace(): AnyPgColumn { return deployments.workspaceId; }
function deploymentId(): AnyPgColumn { return deployments.id; }
