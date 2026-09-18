// The standalone SQL endpoint owns the transaction and records failures after rollback.
import { quotaAccounting } from "../platform/quotas.ts";
import type { Pool } from "../platform/pool.ts";
import { recordRejection } from "../runs/record-rejection.ts";
import type { RunContext } from "../runs/run-context.ts";
import { withRunContext } from "../runs/with-run-context.ts";
import type { SqlInput, SqlResponse } from "./execute-sql-input.ts";
import { executeSqlIn, sqlFailure } from "./execute-sql-in.ts";
import { prepareSql } from "./prepare-sql.ts";

export async function executeSql(pool: Pool, context: RunContext, input: SqlInput): Promise<
  { ok: true; response: SqlResponse } | ReturnType<typeof sqlFailure>
> {
  const prepared = await prepareSql(context, input);
  if (!prepared.ok) {
    await recordRejection(pool, { context, kind: "sql.execute", objects: [], reason: prepared.error, sqlstate: null });
    return { ok: false, status: 422, error: prepared.error };
  }
  try {
    const response = await withRunContext(pool, context, async (tx, emit) => {
      const quota = await quotaAccounting(tx, context);
      quota.add("sql_statement_bytes", Buffer.byteLength(input.statement));
      const response = await executeSqlIn(tx, emit, context, prepared);
      quota.add("sql_rows", Number(response.rowCount));
      await quota.commit();
      return response;
    },
      { timeouts: { statementMs: 2000, lockMs: 250 } });
    return { ok: true, response };
  } catch (error) {
    const result = sqlFailure(error);
    await recordRejection(pool, { context, kind: "sql.execute", objects: [], reason: result.error, sqlstate: result.sqlstate ?? null });
    return result;
  }
}
