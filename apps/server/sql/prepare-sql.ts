// SQL callers prepare policy and bounds before execution; catalog checks stay inside the bound transaction.
import { Buffer } from "node:buffer";
import type { RunContext } from "../runs/run-context.ts";
import type { RunTransaction } from "../runs/with-run-context.ts";
import type { SqlInput } from "./execute-sql-input.ts";
import { statementPolicy, type StatementDecision } from "./statement-policy.ts";
import { relationContract, type RelationFacts } from "./relation-contract.ts";

export type PreparedSql = { schema: string; decision: Extract<StatementDecision, { ok: true }>; input: SqlInput & { expectRows?: number; approvalId?: string } };
export class RelationContractError extends Error {}

export async function prepareSql(context: RunContext, input: PreparedSql["input"]): Promise<
  ({ ok: true } & PreparedSql) | { ok: false; error: string }
> {
  const schema = `ws_${context.workspaceId.replaceAll("-", "")}`;
  const decision = await statementPolicy(input.statement, schema, input.params.length);
  if (!decision.ok || Buffer.byteLength(input.statement) > 65536 || input.params.length > 100) {
    const error = decision.ok ? "invalid_input" : decision.reason;
    return { ok: false, error };
  }
  return { ok: true, schema, decision, input };
}

export async function checkSqlRelations(tx: RunTransaction, prepared: PreparedSql): Promise<void> {
  const { schema, decision } = prepared;
  const facts = await tx<RelationFacts[]>`SELECT n.nspname AS schema, c.relname AS name,
    c.relkind AS kind, pg_get_userbyid(c.relowner) AS owner,
    p.atttypid = 'pg_catalog.uuid'::regtype AS "principalUuid", p.attnotnull AS "principalNotNull",
    r.atttypid = 'pg_catalog.uuid'::regtype AS "runUuid", r.attnotnull AS "runNotNull",
    EXISTS (SELECT FROM pg_attribute a WHERE a.attrelid = c.oid AND NOT a.attisdropped
      AND a.attgenerated <> '') AS generated,
    (SELECT count(*)::int FROM pg_trigger t WHERE t.tgrelid = c.oid AND NOT t.tgisinternal) AS "triggerCount",
    stamp.tgenabled AS "stampEnabled", stamp.tgfoid = 'audit.stamp_workspace_row()'::regprocedure AS "stampFunction",
    EXISTS (SELECT FROM pg_rewrite rw WHERE rw.ev_class = c.oid) AS rules,
    EXISTS (SELECT FROM pg_policy policy WHERE policy.polrelid = c.oid) AS policies
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attribute p ON p.attrelid = c.oid AND p.attname = 'principal_id' AND NOT p.attisdropped
    LEFT JOIN pg_attribute r ON r.attrelid = c.oid AND r.attname = 'run_id' AND NOT r.attisdropped
    LEFT JOIN pg_trigger stamp ON stamp.tgrelid = c.oid AND stamp.tgname = 'bp_stamp'
    WHERE n.nspname = ${schema} AND c.relname = ANY(${tx.array(decision.relations, "TEXT")})`;
  if (!relationContract(schema, decision.relations, facts).ok) throw new RelationContractError();
}
