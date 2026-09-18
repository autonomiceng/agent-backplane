// Owns the atomic handoff boundary, replay receipt and rejection record after rollback.
import { quotaAccounting } from "../platform/quotas.ts";
import { lockRowApprovals } from "../approvals/consume-in.ts";
import type { Pool } from "../platform/pool.ts";
import { ackIn } from "../queue/ack.ts";
import { holdIn } from "../queue/hold.ts";
import { queueError } from "../queue/queue-error.ts";
import { sendMessageIn } from "../queue/send-message.ts";
import { recordRejection } from "../runs/record-rejection.ts";
import type { RunContext } from "../runs/run-context.ts";
import { withRunContext, type RunTransaction } from "../runs/with-run-context.ts";
import { executeSqlIn, sqlFailure } from "../sql/execute-sql-in.ts";
import type { TransactionFailure, TransactionInput, TransactionResponse } from "./execute-transaction-input.ts";
import { transactionPolicy } from "./transaction-policy.ts";

class TransactionRejected extends Error {
  constructor(readonly result: TransactionFailure) { super(result.error); }
}
function failure(error: unknown): TransactionFailure {
  if (error instanceof TransactionRejected) return error.result;
  const queue = queueError(error);
  if (queue.sqlstate === "40P01") return { ok: false, status: 409, error: "transaction_deadlock", sqlstate: queue.sqlstate };
  if (queue.sqlstate === "25P04") return { ok: false, status: 408, error: "sql_transaction_timeout", sqlstate: queue.sqlstate };
  const sql = sqlFailure(error);
  if (sql.status !== 503) return sql;
  const { reason } = queue;
  if (reason === "receipt_foreign") return { ok: false, status: 403, error: reason };
  if (reason === "queue_not_found" || reason === "delivery_not_found") return { ok: false, status: 404, error: reason };
  if (reason === "idempotency_conflict" || reason === "receipt_stale" || reason === "receipt_expired" || reason === "delivery_conflict") {
    return { ok: false, status: 409, error: reason };
  }
  if (reason === "payload_too_large") return { ok: false, status: 422, error: "transaction_bounds_exceeded" };
  if (reason === "invalid_input") return { ok: false, status: 422, error: reason };
  return { ok: false, status: 503, error: "transaction_unavailable" };
}

export async function executeTransaction(pool: Pool, context: Extract<RunContext, { principalId: string }>, input: TransactionInput,
  options?: { afterOperation?: (operationIndex: number, tx: RunTransaction) => void | Promise<void> }): Promise<
    { ok: true; response: TransactionResponse } | TransactionFailure
  > {
  let operationIndex: number | undefined;
  try {
    const plan = await transactionPolicy(context, input);
    if (!plan.ok) throw new TransactionRejected(plan);
    // PostgreSQL's JSONB spacing and numeric rendering define the queue adapter's byte limit.
    const sizes = await pool.begin(async (tx) => {
      await tx`SET TRANSACTION READ ONLY`;
      await tx`SET LOCAL statement_timeout = 2000`;
      await tx`SET LOCAL lock_timeout = 250`;
      return tx<{ operationIndex: number; send: boolean; bytes: number }[]>`
        SELECT (value->>'operationIndex')::int AS "operationIndex", (value->>'send')::boolean AS send,
          octet_length((value->'value')::text) AS bytes
        FROM jsonb_array_elements(${JSON.stringify(plan.values)}::text::jsonb) WITH ORDINALITY AS entry(value, n)
        ORDER BY n`;
    });
    let bytes = 0;
    for (const size of sizes) {
      bytes += size.bytes;
      if (bytes > 1048576 || (size.send && size.bytes > 262144)) {
        throw new TransactionRejected({ ok: false, status: 422, error: "transaction_bounds_exceeded", operationIndex: size.operationIndex });
      }
    }
    const response = await withRunContext(pool, context, async (tx, emit) => {
      const [receipt] = await tx<{ matches: boolean; response: TransactionResponse }[]>`
        SELECT request_hash = ${plan.requestHash} AS matches, response FROM control.transaction_receipts
        WHERE workspace_id = ${context.workspaceId} AND principal_id = ${context.principalId}
          AND idempotency_key = ${input.idempotencyKey}`;
      if (receipt) {
        if (!receipt.matches) throw new TransactionRejected({ ok: false, status: 409, error: "idempotency_conflict" });
        return receipt.response;
      }
      const quota = await quotaAccounting(tx, context);
      for (const [index, operation] of plan.operations.entries()) {
        quota.add("transaction_operations", 1, index);
        if ("sql" in operation) quota.add("sql_statement_bytes", Buffer.byteLength(operation.sql.input.statement), index);
      }
      for (const id of plan.deliveryIds) {
        operationIndex = input.operations.findIndex((operation) =>
          "ack" in operation ? operation.ack.deliveryId.toLowerCase() === id
            : "hold" in operation && operation.hold.deliveryId.toLowerCase() === id);
        await tx`SELECT queue.lock_transaction_deliveries(${context.workspaceId}, ARRAY[${id}::uuid])`;
      }
      operationIndex = undefined;
      await lockRowApprovals(tx, context.workspaceId, plan.operations.flatMap((op) => "sql" in op && op.sql.input.approvalId ? [op.sql.input.approvalId.toLowerCase()] : []));
      const results: TransactionResponse["results"] = [];
      const kinds: string[] = [];
      for (const [index, operation] of plan.operations.entries()) {
        operationIndex = index;
        if ("sql" in operation) {
          const { rowCount, truncated } = await executeSqlIn(tx, emit, context, operation.sql, index);
          quota.add("sql_rows", Number(rowCount), index);
          if (operation.expectRows !== undefined && rowCount !== String(operation.expectRows)) {
            throw new TransactionRejected({ ok: false, status: 422, error: "assertion_failed", operationIndex });
          }
          results.push({ sql: { rowCount, truncated } }); kinds.push("sql");
        } else if ("send" in operation) {
          const { message, inserted } = await sendMessageIn(tx, emit, context.workspaceId, operation.send.queue, operation.send);
          quota.add("queue_sends", inserted ? 1 : 0, index);
          results.push({ send: { messageId: message.id, inserted } }); kinds.push("send");
        } else if ("ack" in operation) {
          const ack = await ackIn(tx, emit, context.workspaceId, operation.ack.deliveryId, operation.ack.receipt);
          results.push({ ack }); kinds.push("ack");
        } else {
          const held = await holdIn(tx, emit, context.workspaceId, operation.hold.deliveryId, operation.hold.receipt);
          results.push({ hold: { deliveryId: held.id, state: "held" } }); kinds.push("hold");
        }
        // Fault injection here proves rollback even after a successful Receipt-fenced transition.
        await options?.afterOperation?.(index, tx);
      }
      await quota.commit();
      operationIndex = undefined;
      const position = await emit("transaction.committed", kinds, null, { operations: results.length, idempotency_key_present: true });
      const response: TransactionResponse = { committed: true, position: position.toString(), results };
      await tx`INSERT INTO control.transaction_receipts (workspace_id, principal_id, idempotency_key, request_hash, response, position)
        VALUES (${context.workspaceId}, ${context.principalId}, ${input.idempotencyKey}, ${plan.requestHash}, ${response}::jsonb, ${response.position}::bigint)`;
      return response;
    }, { timeouts: { statementMs: 2000, lockMs: 250, transactionMs: 10000 } });
    return { ok: true, response };
  } catch (error) {
    const result = { ...failure(error), ...(operationIndex === undefined ? {} : { operationIndex }) };
    await recordRejection(pool, { context, kind: "transaction.committed",
      objects: result.operationIndex === undefined ? [] : [`operation.${result.operationIndex}`],
      reason: result.error, sqlstate: result.sqlstate ?? null });
    return result;
  }
}
