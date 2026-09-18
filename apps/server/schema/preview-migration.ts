// Preview rolls back speculative schema work before emitting the sole successful Audit Event.
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { Pool } from "../platform/pool.ts";
import { recordRejection } from "../runs/record-rejection.ts";
import type { RunContext } from "../runs/run-context.ts";
import { withRunContext } from "../runs/with-run-context.ts";
import { executeMigration } from "./execute-migration.ts";
import { migrationPolicy } from "./migration-policy.ts";
import type { MigrationInput, PreviewResponse } from "./preview-migration-input.ts";

type Failure = { ok: false; status: 408 | 409 | 422 | 503; error: string; sqlstate?: string; statementIndex?: number };
class MigrationRejected extends Error {
  constructor(readonly result: Failure) { super(result.error); }
}
function failure(error: unknown): Failure {
  if (error instanceof MigrationRejected) return error.result;
  const code = typeof error === "object" && error !== null && "errno" in error && typeof error.errno === "string" ? error.errno : "";
  const sqlstate = /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
  if (error instanceof Error && error.message === "revision_stale") return { ok: false, status: 409, error: "revision_stale" };
  if (error instanceof Error && error.message === "workspace_contract_invalid") return { ok: false, status: 422, error: "workspace_contract_invalid" };
  if (sqlstate === "57014") return { ok: false, status: 408, error: "sql_statement_timeout", sqlstate };
  if (sqlstate === "55P03") return { ok: false, status: 408, error: "sql_lock_timeout", sqlstate };
  if (sqlstate === "25P04") return { ok: false, status: 408, error: "sql_transaction_timeout", sqlstate };
  return sqlstate ? { ok: false, status: 422, error: "migration_error", sqlstate }
    : { ok: false, status: 503, error: "migration_unavailable" };
}

export async function previewMigration(pool: Pool, context: RunContext, input: MigrationInput): Promise<
  { ok: true; response: PreviewResponse } | Failure
> {
  const schema = `ws_${context.workspaceId.replaceAll("-", "")}`;
  const plan = await migrationPolicy(input.sql, schema);
  const rejection = async (result: Failure) => {
    await recordRejection(pool, { context, kind: "migration.previewed", objects: [], reason: result.error, sqlstate: result.sqlstate ?? null });
    return result;
  };
  const sqlHash = createHash("sha256").update(input.sql).digest("hex");
  try {
    const response = await withRunContext(pool, context, async (tx, emit) => {
      await tx.unsafe("SET LOCAL statement_timeout = 2000");
      await tx.unsafe("SET LOCAL lock_timeout = 250");
      await tx.unsafe("SET LOCAL transaction_timeout = 10000");
      const [ledger] = await tx<{ revision: number }[]>`SELECT coalesce(max(revision), 0) AS revision
        FROM control.workspace_migrations WHERE workspace_id = ${context.workspaceId}`;
      if (ledger?.revision !== input.expectedRevision) throw new Error("revision_stale");
      if (Buffer.byteLength(input.sql) > 65536) throw new MigrationRejected({ ok: false, status: 422, error: "invalid_input" });
      if (!plan.ok) throw new MigrationRejected({ ok: false, status: 422, error: plan.reason, statementIndex: plan.statementIndex });
      if (plan.destructive && !input.destructive) throw new MigrationRejected({ ok: false, status: 422, error: "migration_destructive_unflagged" });
      const { tables, ...facts } = await executeMigration(tx, schema, input.sql, plan, "preview");
      const position = await emit("migration.previewed", tables, plan.statements.length,
        { revision: input.expectedRevision, sqlHash, destructive: plan.destructive, policyVersion: 1 });
      return { revision: input.expectedRevision, sqlHash, previewPosition: position.toString(),
        statements: plan.statements, destructive: plan.destructive, ...facts };
    }, { timeouts: { statementMs: 2000, lockMs: 250 } });
    return { ok: true, response };
  } catch (error) { return rejection(failure(error)); }
}
