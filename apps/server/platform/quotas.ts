// SQL, transactions and sends aggregate committed costs under the Workspace cursor.
import { t } from "elysia";
import type { RunContext } from "../runs/run-context.ts";
import type { RunTransaction } from "../runs/with-run-context.ts";
import type { Pool } from "./pool.ts";

export const defaultQuotas = { sql_statement_bytes: 1048576, sql_rows: 10000, transaction_operations: 600, queue_sends: 600, open_sse_streams: 16 };
export type Quotas = typeof defaultQuotas;
export type Resource = Exclude<keyof Quotas, "open_sse_streams">;
export const quotaResponse = t.Object({
  error: t.Literal("quota_exceeded"), resource: t.Union([t.Literal("sql_statement_bytes"), t.Literal("sql_rows"), t.Literal("transaction_operations"), t.Literal("queue_sends")]),
  limit: t.Integer(), window: t.Object({ start: t.String(), end: t.String() }), retryAfterSeconds: t.Integer(),
  operationIndex: t.Optional(t.Integer({ minimum: 0, maximum: 15 })),
});
export type QuotaFailure = typeof quotaResponse.static;
export class QuotaExceeded extends Error {
  constructor(readonly body: QuotaFailure) { super("quota_exceeded"); }
}
export function quotaHttp(body: QuotaFailure): Response {
  return Response.json(body, { status: 429, headers: { "cache-control": "no-store", "retry-after": String(body.retryAfterSeconds) } });
}
export function fitsQuota(used: number, cost: number, limit: number): boolean { return cost <= limit - used; }
export async function readQuotas(tx: Pool | RunTransaction, workspaceId: string): Promise<Quotas> {
  const [row] = await tx<Quotas[]>`SELECT sql_statement_bytes, sql_rows, transaction_operations, queue_sends, open_sse_streams
    FROM control.workspace_quotas WHERE workspace_id = ${workspaceId}`;
  return row ?? { ...defaultQuotas };
}
export async function quotaAccounting(tx: RunTransaction, context: RunContext) {
  const limits = await readQuotas(tx, context.workspaceId);
  const [clock] = await tx<{ now: Date; start: Date }[]>`SELECT now, date_trunc('minute', now) AS start FROM (SELECT clock_timestamp() AS now) clock`;
  if (!clock) throw new Error("quotas_unavailable");
  const end = new Date(clock.start.getTime() + 60000);
  const usage = "principalId" in context ? await tx<{ resource: Resource; used: string }[]>`
    SELECT resource, used::text FROM control.quota_usage WHERE workspace_id = ${context.workspaceId}
      AND principal_id = ${context.principalId} AND window_start = ${clock.start}` : [];
  const costs = new Map<Resource, number>();
  return {
    add(resource: Resource, cost: number, operationIndex?: number) {
      if (!("principalId" in context) || cost === 0) return;
      const total = (costs.get(resource) ?? 0) + cost;
      if (!fitsQuota(Number(usage.find((row) => row.resource === resource)?.used ?? 0), total, limits[resource])) {
        throw new QuotaExceeded({ error: "quota_exceeded", resource, limit: limits[resource],
          window: { start: clock.start.toISOString(), end: end.toISOString() },
          retryAfterSeconds: Math.max(1, Math.ceil((end.getTime() - clock.now.getTime()) / 1000)),
          ...(operationIndex === undefined ? {} : { operationIndex }) });
      }
      costs.set(resource, total);
    },
    async commit() {
      if (!("principalId" in context)) return;
      for (const [resource, cost] of [...costs].sort(([a], [b]) => a.localeCompare(b))) {
        await tx`INSERT INTO control.quota_usage (workspace_id, principal_id, resource, window_start, used)
          VALUES (${context.workspaceId}, ${context.principalId}, ${resource}, ${clock.start}, ${cost})
          ON CONFLICT (workspace_id, principal_id, resource) DO UPDATE SET window_start = EXCLUDED.window_start,
            used = CASE WHEN control.quota_usage.window_start = EXCLUDED.window_start
              THEN control.quota_usage.used + EXCLUDED.used ELSE EXCLUDED.used END`;
      }
    },
  };
}
