// Atomic handoffs validate all operations and hash their canonical request before borrowing a writing transaction.
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { RunContext } from "../runs/run-context.ts";
import { prepareSql, type PreparedSql } from "../sql/prepare-sql.ts";
import type { TransactionFailure, TransactionInput } from "./execute-transaction-input.ts";

type PreparedOperation = Exclude<TransactionInput["operations"][number], { sql: unknown }>
  | { sql: PreparedSql; expectRows?: number };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("invalid_input");
  return encoded;
}

export async function transactionPolicy(context: Extract<RunContext, { principalId: string }>, input: TransactionInput): Promise<
  { ok: true; operations: PreparedOperation[]; deliveryIds: string[]; requestHash: Buffer;
    values: { operationIndex: number; send: boolean; value: unknown }[] } | TransactionFailure
> {
  const invalid = (error: string, operationIndex?: number): TransactionFailure => ({
    ok: false, status: 422, error, ...(operationIndex === undefined ? {} : { operationIndex }),
  });
  if (input.operations.length < 1 || input.operations.length > 16
    || Buffer.byteLength(input.idempotencyKey) < 1 || Buffer.byteLength(input.idempotencyKey) > 256) return invalid("invalid_input");
  if (Buffer.byteLength(JSON.stringify(input)) > 2097152) return invalid("transaction_bounds_exceeded");
  const operations: PreparedOperation[] = [];
  const deliveries = new Set<string>();
  const values: { operationIndex: number; send: boolean; value: unknown }[] = [];
  let statements = 0;
  let bytes = 0;
  for (const [operationIndex, operation] of input.operations.entries()) {
    if ("sql" in operation) {
      statements += Buffer.byteLength(operation.sql.statement);
      bytes += Buffer.byteLength(JSON.stringify(operation.sql.params));
      if (statements > 65536 || bytes > 1048576) return invalid("transaction_bounds_exceeded", operationIndex);
      const sql = await prepareSql(context, operation.sql);
      if (!sql.ok) return invalid(sql.error, operationIndex);
      const { expectRows } = operation.sql;
      if (expectRows !== undefined && (sql.decision.kind === "select" || !Number.isSafeInteger(expectRows) || expectRows < 0)) {
        return invalid("invalid_input", operationIndex);
      }
      operations.push({ sql, ...(expectRows === undefined ? {} : { expectRows }) });
      values.push({ operationIndex, send: false, value: operation.sql.params });
    } else if ("send" in operation) {
      const size = Buffer.byteLength(JSON.stringify(operation.send.payload));
      bytes += size;
      if (size > 262144 || bytes > 1048576) return invalid("transaction_bounds_exceeded", operationIndex);
      const keyBytes = Buffer.byteLength(operation.send.idempotencyKey);
      if (keyBytes < 1 || keyBytes > 256) return invalid("invalid_input", operationIndex);
      values.push({ operationIndex, send: true, value: operation.send.payload });
      operations.push(operation);
    } else {
      const delivery = "ack" in operation ? operation.ack : operation.hold;
      const id = delivery.deliveryId.toLowerCase();
      if (deliveries.has(id)) return invalid("invalid_input", operationIndex);
      deliveries.add(id);
      operations.push(operation);
    }
  }
  const requestHash = createHash("sha256").update(canonical({
    version: 1, workspaceId: context.workspaceId, principalId: context.principalId, request: input,
  })).digest();
  return { ok: true, operations, deliveryIds: [...deliveries].sort(), requestHash, values };
}
