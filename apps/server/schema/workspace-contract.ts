// Migration execution and the test-only table fixture share the Workspace attribution contract.
import type { SavepointSQL } from "bun";
import { migrationPolicy } from "./migration-policy.ts";

export async function installContract(tx: SavepointSQL, schema: string, table: string): Promise<void> {
  const columns = await tx<{ name: string }[]>`SELECT a.attname AS name FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ${schema} AND c.relname = ${table} AND NOT a.attisdropped
      AND a.attname IN ('principal_id', 'run_id')`;
  const missing = ["principal_id", "run_id"].filter((name) => !columns.some((column) => column.name === name));
  if (missing.length) {
    const rows = await tx`SELECT 1 FROM ${tx(schema)}.${tx(table)} LIMIT 1`;
    if (rows.length) throw new Error("workspace_contract_invalid");
    for (const name of missing) await tx`ALTER TABLE ${tx(schema)}.${tx(table)} ADD COLUMN ${tx(name)} uuid NOT NULL`;
  }
  const [stamp] = await tx`SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = ${schema} AND c.relname = ${table} AND t.tgname = 'bp_stamp'`;
  if (!stamp) await tx`CREATE TRIGGER bp_stamp BEFORE INSERT OR UPDATE OR DELETE ON ${tx(schema)}.${tx(table)}
    FOR EACH ROW EXECUTE FUNCTION audit.stamp_workspace_row()`;
  await tx`ALTER TABLE ${tx(schema)}.${tx(table)} ENABLE ALWAYS TRIGGER bp_stamp`;
  await tx`GRANT SELECT, INSERT, UPDATE, DELETE ON ${tx(schema)}.${tx(table)} TO ${tx(`bp_${schema}`)}`;
}

export async function verifyContract(tx: SavepointSQL, schema: string): Promise<void> {
  const invalid = await tx`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ${schema} AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND (
      c.relkind <> 'r' OR c.relowner <> 'bp_executor'::regrole OR c.relpersistence <> 'p'
      OR (SELECT count(*) FROM pg_attribute a WHERE a.attrelid = c.oid AND NOT a.attisdropped
        AND a.attname IN ('principal_id', 'run_id') AND a.atttypid = 'pg_catalog.uuid'::regtype
        AND a.attnotnull AND a.attgenerated = '' AND a.attidentity = '' AND NOT a.atthasdef) <> 2
      OR EXISTS (SELECT FROM pg_attribute a WHERE a.attrelid = c.oid AND NOT a.attisdropped
        AND (a.attgenerated <> '' OR a.attidentity <> ''))
      OR (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid = c.oid AND NOT t.tgisinternal) <> 1
      OR NOT EXISTS (SELECT FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname = 'bp_stamp'
        AND t.tgenabled = 'A' AND t.tgfoid = 'audit.stamp_workspace_row()'::regprocedure
        AND t.tgtype = 31 AND t.tgnargs = 0 AND t.tgqual IS NULL AND t.tgattr = ''::int2vector)
      OR EXISTS (SELECT FROM pg_rewrite r WHERE r.ev_class = c.oid)
      OR EXISTS (SELECT FROM pg_policy p WHERE p.polrelid = c.oid))`;
  if (invalid.length) throw new Error("workspace_contract_invalid");
  const defaults = await tx<{ expression: string }[]>`SELECT pg_get_expr(d.adbin, d.adrelid) AS expression
    FROM pg_attrdef d JOIN pg_class c ON c.oid = d.adrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ${schema}`;
  for (const value of defaults) {
    const decision = await migrationPolicy(`ALTER TABLE contract_check ALTER COLUMN value SET DEFAULT ${value.expression}`, schema);
    if (!decision.ok) throw new Error("workspace_contract_invalid");
  }
}
