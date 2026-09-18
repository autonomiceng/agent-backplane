// The write transaction boundary. Only Run creation may lock the cursor and insert its Run before binding.
// Only transaction-local timeouts precede this work; callbacks always receive an authoritative bound context.
import type { TransactionSQL } from "bun";
import type { Pool } from "../platform/pool.ts";
import type { RunContext } from "./run-context.ts";
import type { NewRun } from "./create-run-input.ts";

export type RunTransaction = TransactionSQL;
type RunOptions = { newRun?: NewRun; timeouts?: { statementMs: number; lockMs: number; transactionMs?: number } };
// Bun infers the jsonb parameter type from the cast and encodes the value itself; passing a JSON string here would double-encode.
export type EmitAudit = (kind: string, objects: string[], rowCount: number | null, metadata: Record<string, unknown>) => Promise<bigint>;

export function withRunContext<T>(pool: Pool, context: { workspaceId: string; principalId: string },
  fn: (tx: RunTransaction, emit: EmitAudit, runId: string | null) => Promise<T>, options: RunOptions & { newRun: NewRun }): Promise<T>;
export function withRunContext<T>(pool: Pool, context: RunContext,
  fn: (tx: RunTransaction, emit: EmitAudit, runId: string | null) => Promise<T>, options?: Pick<RunOptions, "timeouts">): Promise<T>;
export function withRunContext<T>(pool: Pool, context: RunContext | { workspaceId: string; principalId: string },
  fn: (tx: RunTransaction, emit: EmitAudit, runId: string | null) => Promise<T>, options?: RunOptions): Promise<T> {
  return pool.begin(async (tx) => {
    const { statementMs, lockMs, transactionMs } = options?.timeouts ?? { statementMs: 5000, lockMs: 2000 };
    if (!Number.isSafeInteger(statementMs) || statementMs <= 0 || !Number.isSafeInteger(lockMs) || lockMs <= 0
      || (transactionMs !== undefined && (!Number.isSafeInteger(transactionMs) || transactionMs <= 0))) {
      throw new Error("timeouts_invalid");
    }
    await tx.unsafe(`SET LOCAL statement_timeout = ${statementMs}`);
    await tx.unsafe(`SET LOCAL lock_timeout = ${lockMs}`);
    if (transactionMs !== undefined) await tx.unsafe(`SET LOCAL transaction_timeout = ${transactionMs}`);
    let runId = "runId" in context ? context.runId : null;
    if (options?.newRun) {
      if (!("principalId" in context) || "runId" in context || "userId" in context) throw new Error("context_invalid");
      runId = crypto.randomUUID();
      const { harness, model, label, metadata } = options.newRun;
      await tx`SELECT audit.lock_workspace(${context.workspaceId})`;
      await tx`INSERT INTO control.runs (id, workspace_id, principal_id, harness, model, label, metadata)
        VALUES (${runId}, ${context.workspaceId}, ${context.principalId}, ${harness ?? null},
          ${model ?? null}, ${label ?? null}, ${metadata ?? {}}::jsonb)`;
    }
    const token = crypto.randomUUID();
    if ("invocationHash" in context && context.invocationHash !== undefined) {
      await tx`SELECT audit.bind_context(${context.workspaceId},
        ${"principalId" in context ? context.principalId : null}, ${runId},
        ${"userId" in context ? context.userId : null}, ${token}, ${context.invocationHash})`;
    } else {
      await tx`SELECT audit.bind_context(${context.workspaceId},
        ${"principalId" in context ? context.principalId : null}, ${runId},
        ${"userId" in context ? context.userId : null}, ${token})`;
    }
    if (runId !== null) {
      await tx`UPDATE control.runs SET last_seen_at = clock_timestamp() WHERE id = ${runId}`;
    }
    return fn(tx, async (kind, objects, rowCount, metadata) => {
      const [event] = await tx`SELECT audit.emit(${token}, ${kind}, ${tx.array(objects, "TEXT")},
        ${rowCount}, ${metadata}::jsonb)::text AS position`;
      return BigInt(event.position);
    }, runId);
  });
}
