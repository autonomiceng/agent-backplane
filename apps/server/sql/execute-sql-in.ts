// Standalone SQL and atomic handoffs share role switching, result wrappers and audit emission.
import { QuotaExceeded, type QuotaFailure } from "../platform/quotas.ts";
import { checkRowApproval, consumeRowApproval } from "../approvals/consume-in.ts";
import { approvalError, approvalErrorStatus } from "../approvals/approval-error.ts";
import { GateError, type RowDescriptor } from "../approvals/gate-policy.ts";
import { Buffer } from "node:buffer";
import { parse } from "libpg-query";
import type { RunContext } from "../runs/run-context.ts";
import type { EmitAudit, RunTransaction } from "../runs/with-run-context.ts";
import type { SqlResponse } from "./execute-sql-input.ts";
import { checkSqlRelations, RelationContractError, type PreparedSql } from "./prepare-sql.ts";

type SqlFailure = { ok: false; quota?: QuotaFailure; status: 429 | 403 | 404 | 408 | 409 | 422 | 503; error: string; sqlstate?: string; target?: RowDescriptor };
class ResultTooLarge extends Error {}

function identifier(name: string) {
  // S03 Principal roles encode two UUIDs as 22-character base64url components.
  if (!/^(?:[a-z0-9_]+|bp_p_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{22})$/.test(name)) throw new Error("sql_identifier_invalid");
  return `"${name}"`;
}
// PostgreSQL JSON supplies numeric values, ISO timestamps and bytea as \\x-prefixed hex text.
function decodeRow(value: unknown): Record<string, unknown> {
  const row: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (row === null || typeof row !== "object" || Array.isArray(row)) throw new Error("sql_result_invalid");
  return Object.fromEntries(Object.entries(row));
}
export function sqlFailure(error: unknown): SqlFailure {
  if (error instanceof QuotaExceeded) return { ok: false, status: 429, error: "quota_exceeded", quota: error.body };
  const approval = approvalError(error);
  const status = approvalErrorStatus(approval.reason);
  if (approval.reason.startsWith("approval_") && (status === 404 || status === 409 || status === 422)) return {
    ok: false, status, error: approval.reason, ...(error instanceof GateError && error.target ? { target: error.target } : {}),
  };
  if (error instanceof ResultTooLarge) return { ok: false, status: 422, error: "sql_result_too_large" };
  if (error instanceof RelationContractError) return { ok: false, status: 422, error: "sql_relation_contract" };
  const code = typeof error === "object" && error !== null && "errno" in error && typeof error.errno === "string" ? error.errno : "";
  const sqlstate = /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
  if (sqlstate === "57014") return { ok: false, status: 408, error: "sql_statement_timeout", sqlstate };
  if (sqlstate === "55P03") return { ok: false, status: 408, error: "sql_lock_timeout", sqlstate };
  if (sqlstate === "42501") return { ok: false, status: 403, error: "sql_permission_denied", sqlstate };
  if (sqlstate === "42P01" || sqlstate === "42703") return { ok: false, status: 422, error: "sql_unknown_object", sqlstate };
  if (sqlstate && /^(42|22|23)/.test(sqlstate)) return { ok: false, status: 422, error: "sql_error", sqlstate };
  return { ok: false, status: 503, error: "sql_unavailable" };
}

export async function executeSqlIn(tx: RunTransaction, emit: EmitAudit, context: RunContext, prepared: PreparedSql, operationIndex = 0): Promise<SqlResponse> {
  const { schema, decision, input } = prepared;
  if (schema !== `ws_${context.workspaceId.replaceAll("-", "")}`) throw new Error("sql_identifier_invalid");
  // Parser offsets are bytes. Remove the optional statement delimiter before nesting the original SQL.
  const raw = (await parse(input.statement)).stmts?.[0];
  if (!raw?.stmt) throw new Error("sql_unavailable");
  const start = raw.stmt_location ?? 0;
  const statement = Buffer.from(input.statement).subarray(start, raw.stmt_len ? start + raw.stmt_len : undefined).toString();
  const ast = Object.values(raw.stmt)[0];
  const returning = ast !== null && typeof ast === "object" && "returningClause" in ast;
  const returnsRows = decision.kind === "select" || returning;
  const source = decision.kind === "select" ? "__bp_q" : "__bp_c";
  const query = returnsRows ? `WITH ${source} AS (${statement}\n),
    __bp_s AS (SELECT to_jsonb(${source}) AS row FROM ${source} LIMIT 1001),
    __bp_t AS (SELECT ${returning ? "(SELECT count(*) FROM __bp_c) AS affected," : ""}
      count(*) AS n, coalesce(sum(octet_length(row::text)), 0) AS bytes FROM __bp_s)
    SELECT CASE WHEN __bp_t.bytes > 1048576 THEN NULL ELSE __bp_s.row END AS row,
      __bp_t.n, __bp_t.bytes ${returning ? ", __bp_t.affected" : ""}
    FROM __bp_s CROSS JOIN __bp_t` : statement;
  // Row gates trust this shared server executor; the provenance trigger does not enforce Approvals.
  const approval = await checkRowApproval(tx, context, prepared);
  if (approval) { await tx`SET LOCAL TimeZone = 'UTC'`; await tx`SET LOCAL DateStyle = 'ISO, YMD'`; await tx`SET LOCAL bytea_output = 'hex'`; }
  await checkSqlRelations(tx, prepared);
  const [role] = await tx<{ name: string }[]>`SELECT control.prepare_sql_roles() AS name`;
  if (!role) throw new Error("sql_unavailable");
  await tx.unsafe(`SET LOCAL ROLE ${identifier(role.name)}`);
  await tx.unsafe(`SET LOCAL search_path = ${identifier(schema)}`);
  const result = await tx.unsafe<{ row: unknown; n: string; bytes: string; affected?: string }[] & { count: number }>(query, input.params);
  if (returnsRows && Number(result[0]?.bytes ?? 0) > 1048576) throw new ResultTooLarge();
  const n = Number(result[0]?.n ?? 0);
  const rowCount = returning ? Number(result[0]?.affected ?? 0) : returnsRows ? Math.min(n, 1000) : result.count;
  const rows = returnsRows ? result.slice(0, 1000).map((row) => decodeRow(row.row)) : [];
  const response = { rows, rowCount: String(rowCount), truncated: returnsRows && n > 1000 };
  if (Buffer.byteLength(JSON.stringify(response)) > 1024 * 1024) throw new ResultTooLarge();
  await tx.unsafe(`SET LOCAL ROLE NONE`);
  await tx`SET LOCAL search_path = pg_catalog`;
  await emit("sql.execute", decision.relations, rowCount, { fingerprint: decision.fingerprint, kind: decision.kind });
  if (approval) await consumeRowApproval(tx, emit, context.workspaceId, approval, response.rowCount, operationIndex);
  return response;
}
