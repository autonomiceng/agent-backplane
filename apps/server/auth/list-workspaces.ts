import type { Pool } from "../platform/pool.ts";
import type { ListWorkspacesInput, WorkspacesPage } from "./list-workspaces-input.ts";

function decodeCursor(after: string, userId: string) {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(after)) return null;
    const decoded = Buffer.from(after, "base64url");
    if (decoded.toString("base64url") !== after) return null;
    const value: unknown = JSON.parse(decoded.toString("utf8"));
    if (typeof value !== "object" || value === null
      || !("v" in value) || value.v !== 1
      || !("userId" in value) || value.userId !== userId
      || !("id" in value) || typeof value.id !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.id)) return null;
    return value.id;
  } catch { return null; }
}

export async function listWorkspaces(pool: Pool, userId: string, input: ListWorkspacesInput): Promise<
  { ok: true; page: WorkspacesPage } | { ok: false; reason: "invalid_input" | "workspace_list_failed" }
> {
  const cursor = input.after === undefined ? null : decodeCursor(input.after, userId);
  if (input.after !== undefined && cursor === null) return { ok: false, reason: "invalid_input" };
  try {
    return await pool.begin(async tx => {
      await tx`SET LOCAL statement_timeout = '5s'`;
      await tx`SET LOCAL lock_timeout = '2s'`;
      const limit = input.limit ?? 50;
      const rows = await tx<{ id: string; organizationId: string; name: string; createdAt: Date }[]>`
        SELECT DISTINCT w.id, w.organization_id AS "organizationId", w.name, w.created_at AS "createdAt"
        FROM control.workspaces w JOIN control.member m ON m."organizationId" = w.organization_id
        WHERE m."userId" = ${userId} AND (${cursor}::uuid IS NULL OR w.id > ${cursor}::uuid)
        ORDER BY w.id LIMIT ${limit + 1}`;
      const items = rows.slice(0, limit).map(row => ({ ...row, createdAt: row.createdAt.toISOString() }));
      const last = items.at(-1);
      const nextCursor = rows.length > limit && last
        ? Buffer.from(JSON.stringify({ v: 1, userId, id: last.id })).toString("base64url") : null;
      return { ok: true, page: { items, nextCursor } };
    });
  } catch { return { ok: false, reason: "workspace_list_failed" }; }
}
