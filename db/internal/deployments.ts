// Immutable deployment catalog; the migration permits only registered-to-active-to-retired updates.
import { sql } from "drizzle-orm";
import { check, customType, date, foreignKey, integer, pgSchema, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { functions } from "./functions.ts";
import { principalKeys } from "./principal-keys.ts";
import { runs } from "./runs.ts";
const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });
export const deployments = pgSchema("control").table("deployments", {
  workspaceId: uuid("workspace_id").notNull(), functionName: text("function_name").notNull(), id: uuid("id").notNull(),
  bundle: bytea("bundle").notNull(), bundleHash: bytea("bundle_hash").generatedAlwaysAs(sql`sha256(bundle)`),
  size: integer("size").generatedAlwaysAs(sql`octet_length(bundle)`), entryPoint: text("entry_point").notNull(),
  compatibilityDate: date("compatibility_date").notNull(), outboundUrls: text("outbound_urls").array().notNull(),
  configHash: bytea("config_hash").notNull(), runtimeDigest: text("runtime_digest").notNull(), principalId: uuid("principal_id").notNull(),
  runId: uuid("run_id").notNull().references(() => runs.id), createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  status: text("status").notNull().default("registered"),
}, (t) => [primaryKey({ columns: [t.workspaceId, t.id] }),
  foreignKey({ columns: [t.workspaceId, t.functionName, t.principalId], foreignColumns: [functions.workspaceId, functions.name, functions.principalId] }),
  foreignKey({ columns: [t.workspaceId, t.principalId], foreignColumns: [principalKeys.workspaceId, principalKeys.principalId] }),
  uniqueIndex("deployment_active").on(t.workspaceId, t.functionName).where(sql`${t.status} = 'active'`),
  check("deployments_bundle_check", sql`octet_length(${t.bundle}) BETWEEN 1 AND 4194304`),
  check("deployments_entry_point_check", sql`${t.entryPoint} = 'default'`),
  check("deployments_outbound_urls_check", sql`cardinality(${t.outboundUrls}) <= 16`),
  check("deployments_config_hash_check", sql`octet_length(${t.configHash}) = 32`),
  check("deployments_runtime_digest_check", sql`${t.runtimeDigest} ~ '^[0-9a-f]{64}$'`),
  check("deployments_status_check", sql`${t.status} IN ('registered', 'active', 'retired')`)]);
