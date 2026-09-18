// Reads historical descriptors without locking live targets; cursors retain PostgreSQL microseconds.
import type { Pool } from "../platform/pool.ts";
import type { Approval, ApprovalsPage, ListApprovalsInput } from "./list-approvals-input.ts";
function decodeCursor(after: string, workspaceId: string, state: string) {
  try {
    const bytes = Buffer.from(after, "base64url");
    if (bytes.toString("base64url") !== after) return null;
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (typeof value !== "object" || value === null || !("v" in value) || value.v !== 1
      || !("workspaceId" in value) || value.workspaceId !== workspaceId || !("state" in value) || value.state !== state
      || !("createdAt" in value) || typeof value.createdAt !== "string"
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value.createdAt)
      || !Number.isFinite(Date.parse(value.createdAt))
      || new Date(value.createdAt).toISOString().slice(0, 19) !== value.createdAt.slice(0, 19)
      || !("id" in value) || typeof value.id !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.id)) return null;
    return { createdAt: value.createdAt, id: value.id };
  } catch { return null; }
}
export async function listApprovals(pool: Pool, workspaceId: string, input: ListApprovalsInput): Promise<
  { ok: true; page: ApprovalsPage } | { ok: false; reason: "invalid_input" | "approval_unavailable" }
> {
  const scope = { v: 1, workspaceId: workspaceId.toLowerCase(), state: input.state ?? "pending" };
  const cursor = input.after === undefined ? null : decodeCursor(input.after, scope.workspaceId, scope.state);
  if (input.after !== undefined && cursor === null) return { ok: false, reason: "invalid_input" };
  try {
    return await pool.begin(async (tx) => {
      const [stamp] = await tx<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      if (!stamp) throw new Error("approval_unavailable");
      const observedAt = stamp.now.toISOString(), limit = input.limit ?? 50;
      const rows = await tx<(Omit<Approval, "target"> & { kind: string; queue: string | null; messageId: string | null;
        rowTable: string | null; rowKey: string | null; actionHash: string | null })[]>`
        SELECT a.id, a.workspace_id AS "workspaceId", a.requested_by AS "requestedBy", a.requested_run_id AS "requestedRunId",
          to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
          to_char(a.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "expiresAt",
          a.expires_at <= ${observedAt}::timestamptz AS expired, a.target_id AS "targetId", a.target_version AS "targetVersion",
          a.decision, a.reason, a.decision_position::text AS "decisionPosition", a.released_delivery_id AS "releasedDeliveryId",
          a.target_kind AS kind, d.queue, d.envelope->>'message_id' AS "messageId",
          a.row_table AS "rowTable", a.row_key::text AS "rowKey", encode(a.action_hash, 'hex') AS "actionHash"
        FROM control.approvals a LEFT JOIN queue.delivery_envelopes d
          ON a.target_kind = 'message' AND d.workspace_id = a.workspace_id AND d.id::text = a.target_id
        WHERE a.workspace_id = ${scope.workspaceId} AND (a.decision IS NOT NULL) = ${scope.state === "decided"}
          AND (${cursor?.createdAt ?? null}::timestamptz IS NULL
            OR (a.created_at, a.id) > (${cursor?.createdAt ?? null}::timestamptz, ${cursor?.id ?? null}::uuid))
        ORDER BY a.created_at, a.id LIMIT ${limit + 1}`;
      const items = rows.slice(0, limit).map(({ kind, queue, messageId, rowTable, rowKey, actionHash, ...item }): Approval => {
        if (kind === "message" && queue && messageId) return { ...item, target: { kind, queue, messageId, deliveryId: item.targetId } };
        if (kind === "row" && rowTable && rowKey && actionHash && /^[a-f0-9]{64}$/.test(actionHash)) {
          const key: unknown = JSON.parse(rowKey);
          if (typeof key === "object" && key !== null && !Array.isArray(key) && Object.keys(key).length > 0
            && /^[a-f0-9]{64}$/.test(item.targetVersion))
            return { ...item, target: { kind, table: rowTable, primaryKey: rowKey, targetVersion: item.targetVersion, actionHash } };
        }
        if (kind === "migration" && actionHash === item.targetId && /^[a-f0-9]{64}$/.test(item.targetId)
          && /^(0|[1-9][0-9]*)$/.test(item.targetVersion) && Number.isSafeInteger(Number(item.targetVersion)))
          return { ...item, target: { kind, sqlHash: item.targetId, expectedRevision: Number(item.targetVersion) } };
        throw new Error("approval_unavailable");
      });
      const last = items.at(-1);
      const nextCursor = rows.length > limit && last
        ? Buffer.from(JSON.stringify({ ...scope, createdAt: last.createdAt, id: last.id })).toString("base64url") : null;
      return { ok: true, page: { items, nextCursor, observedAt } };
    });
  } catch { return { ok: false, reason: "approval_unavailable" }; }
}
