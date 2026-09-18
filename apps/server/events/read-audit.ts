// Reads explicit envelope columns inside one Workspace without binding context or touching Runs.
import type { Pool } from "../platform/pool.ts";
import { type AuditPage, type AuditQuery, jsonObject } from "./read-audit-input.ts";

export async function readAudit(pool: Pool, workspaceId: string, query: AuditQuery): Promise<AuditPage> {
  type Row = Omit<AuditPage["events"][number], "occurred_at" | "metadata"> & { occurred_at: Date; metadata: unknown };
  const columns = pool`position::text, kind, objects, row_count::text, occurred_at, principal_id, run_id, user_id, metadata`;
  // Two statements instead of a null-guarded predicate so each keeps its index: (workspace, position) or (workspace, run, position).
  // ORDER BY is qualified: the unqualified name would resolve to the text output column and sort lexicographically.
  const rows = query.runId === undefined
    ? await pool<Row[]>`SELECT ${columns} FROM audit.events WHERE workspace_id = ${workspaceId}
        AND position > ${query.after}::bigint ORDER BY audit.events.position LIMIT ${query.limit}`
    : await pool<Row[]>`SELECT ${columns} FROM audit.events WHERE workspace_id = ${workspaceId} AND run_id = ${query.runId}::uuid
        AND position > ${query.after}::bigint ORDER BY audit.events.position LIMIT ${query.limit}`;
  const events = rows.map((row) => ({ ...row, occurred_at: row.occurred_at.toISOString(), metadata: jsonObject(row.metadata) }));
  return { events, nextAfter: events.at(-1)?.position ?? query.after };
}
