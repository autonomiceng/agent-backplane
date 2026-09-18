// Apply commits verified SQL, the Migration ledger and its Audit Event under one bound Run and revision CAS.
import { GateError } from "../approvals/gate-policy.ts";
import { approvalError, approvalErrorStatus } from "../approvals/approval-error.ts";
import { consumeMigrationApproval } from "../approvals/consume-in.ts";
import { migrationRevisionPolicy } from "../approvals/approval-migration-policy.ts";
import { migrationTarget } from "../approvals/migration-target.ts";
import { parse } from "libpg-query";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { Pool } from "../platform/pool.ts";
import { recordRejection } from "../runs/record-rejection.ts";
import type { RunContext } from "../runs/run-context.ts";
import { withRunContext } from "../runs/with-run-context.ts";
import { executeMigration } from "./execute-migration.ts";
import { migrationPolicy } from "./migration-policy.ts";
import type { ApplyInput, ApplyResponse, applyMigrationErrorResponse } from "./apply-migration-input.ts";

type Failure = { ok: false; status: 404 | 408 | 409 | 422 | 503 } & typeof applyMigrationErrorResponse.static;
class MigrationRejected extends Error {
  constructor(readonly result: Failure) { super(result.error); }
}
function failure(error: unknown): Failure {
  if (error instanceof MigrationRejected) return error.result;
  if (error instanceof GateError) {
    const { reason } = approvalError(error), status = approvalErrorStatus(reason);
    if (status === 404 || status === 409 || status === 422) return { ok: false, status, error: reason };
  }
  const code = typeof error === "object" && error !== null && "errno" in error && typeof error.errno === "string" ? error.errno : "";
  const sqlstate = /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
  if (error instanceof Error && error.message === "revision_stale") return { ok: false, status: 409, error: "revision_stale" };
  if (error instanceof Error && error.message === "preview_mismatch") return { ok: false, status: 409, error: "preview_mismatch" };
  if (error instanceof Error && error.message === "workspace_contract_invalid") return { ok: false, status: 422, error: "workspace_contract_invalid" };
  if (sqlstate === "57014") return { ok: false, status: 408, error: "sql_statement_timeout", sqlstate };
  if (sqlstate === "55P03") return { ok: false, status: 408, error: "sql_lock_timeout", sqlstate };
  if (sqlstate === "25P04") return { ok: false, status: 408, error: "sql_transaction_timeout", sqlstate };
  return sqlstate ? { ok: false, status: 422, error: "migration_error", sqlstate }
    : { ok: false, status: 503, error: "migration_unavailable" };
}

export async function applyMigration(pool: Pool, context: Extract<RunContext, { principalId: string }>, input: ApplyInput): Promise<
  { ok: true; response: ApplyResponse } | Failure
> {
  const schema = `ws_${context.workspaceId.replaceAll("-", "")}`;
  const plan = await migrationPolicy(input.sql, schema);
  const sqlHash = createHash("sha256").update(input.sql).digest("hex");
  try {
    const response = await withRunContext(pool, context, async (tx, emit) => {
      await tx.unsafe("SET LOCAL statement_timeout = 2000");
      await tx.unsafe("SET LOCAL lock_timeout = 250");
      await tx.unsafe("SET LOCAL transaction_timeout = 10000");
      const [ledger] = await tx<{ revision: number }[]>`SELECT coalesce(max(revision), 0) AS revision
        FROM control.workspace_migrations WHERE workspace_id = ${context.workspaceId}`;
      const revisionFailure = migrationRevisionPolicy(String(ledger?.revision), input.expectedRevision);
      if (revisionFailure) throw new Error(revisionFailure);
      if (Buffer.byteLength(input.sql) > 65536) throw new MigrationRejected({ ok: false, status: 422, error: "invalid_input" });
      if (!plan.ok) throw new MigrationRejected({ ok: false, status: 422, error: plan.reason, statementIndex: plan.statementIndex });
      if (plan.destructive && !input.destructive) throw new MigrationRejected({ ok: false, status: 422, error: "migration_destructive_unflagged" });
      if (input.sqlHash !== sqlHash || BigInt(input.previewPosition) > 9223372036854775807n) throw new Error("preview_mismatch");
      const [preview] = await tx`SELECT 1 FROM audit.events WHERE workspace_id = ${context.workspaceId}
        AND position = ${input.previewPosition}::bigint AND kind = 'migration.previewed' AND principal_id = ${context.principalId}
        AND metadata @> ${{ revision: input.expectedRevision, sqlHash, destructive: plan.destructive, policyVersion: 1 }}::jsonb`;
      if (!preview) throw new Error("preview_mismatch");
      const names = [...plan.tables];
      for (const raw of (await parse(input.sql)).stmts ?? []) {
        const drop = raw.stmt && "DropStmt" in raw.stmt ? raw.stmt.DropStmt : undefined;
        const comment = raw.stmt && "CommentStmt" in raw.stmt ? raw.stmt.CommentStmt : undefined;
        const indexes = drop?.removeType === "OBJECT_INDEX" ? drop.objects ?? []
          : comment?.objtype === "OBJECT_INDEX" && comment.object ? [comment.object] : [];
        for (const index of indexes) {
          const part = "List" in index ? index.List.items?.at(-1) : undefined;
          if (part && "String" in part && part.String.sval) names.push(part.String.sval);
        }
      }
      const [conflict] = await tx`SELECT 1 FROM control.approval_gates g
        JOIN pg_namespace n ON n.nspname=${schema} JOIN pg_class c ON c.relnamespace=n.oid
        LEFT JOIN pg_index i ON i.indexrelid=c.oid LEFT JOIN pg_class t ON t.oid=i.indrelid
        WHERE g.workspace_id=${context.workspaceId} AND g.target_kind='row' AND g.enabled
          AND g.selector=n.nspname || '.' || coalesce(t.relname,c.relname)
          AND c.relname=ANY(${tx.array(names, "TEXT")}) LIMIT 1`;
      if (conflict) throw new MigrationRejected({ ok: false, status: 422, error: "approval_gate_conflict" });
      const gate = await migrationTarget(tx, context.workspaceId);
      if (gate.epoch && !input.approvalId) throw new MigrationRejected({ ok: false, status: 422, error: "approval_required",
        target: { targetKind: "migration", targetId: sqlHash, targetVersion: String(input.expectedRevision) } });
      if (input.approvalId) await consumeMigrationApproval(tx, emit, context, { ...input, approvalId: input.approvalId }, gate);
      const { tables } = await executeMigration(tx, schema, input.sql, plan, "apply");
      const revision = input.expectedRevision + 1;
      const name = input.name.trim();
      const [applied] = await tx<{ appliedAt: Date }[]>`INSERT INTO control.workspace_migrations
        (workspace_id, revision, name, sql, sql_hash, statements, destructive, applied_by, run_id, expires_at)
        VALUES (${context.workspaceId}, ${revision}, ${name}, ${input.sql}, ${Buffer.from(sqlHash, "hex")},
          ${plan.statements.length}, ${plan.destructive}, ${context.principalId}, ${context.runId}, queue.capture_expiry(${context.workspaceId}))
        RETURNING applied_at AS "appliedAt"`;
      if (!applied) throw new Error("migration_unavailable");
      await emit("migration.applied", tables, plan.statements.length, { revision, sqlHash, destructive: plan.destructive, policyVersion: 1 });
      return { revision, name, sqlHash, appliedAt: applied.appliedAt.toISOString() };
    }, { timeouts: { statementMs: 2000, lockMs: 250 } });
    return { ok: true, response };
  } catch (error) {
    const result = failure(error);
    await recordRejection(pool, { context, kind: "migration.applied", objects: [], reason: result.error, sqlstate: result.sqlstate ?? null });
    return result;
  }
}
