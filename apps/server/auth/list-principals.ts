// Lists Principal metadata while retaining the User's Organization membership lock.
// Built-in system Principals (retention, operations) are migration-owned and hidden.
import type { Pool } from "../platform/pool.ts";
import type { ListPrincipalsInput, PrincipalsPage } from "./list-principals-input.ts";
import { queryWorkspaceAccess } from "./workspace-access-query.ts";

function decodeCursor(after: string, workspaceId: string) {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(after)) return null;
    const decoded = Buffer.from(after, "base64url");
    if (decoded.toString("base64url") !== after) return null;
    const value: unknown = JSON.parse(decoded.toString("utf8"));
    if (typeof value !== "object" || value === null
      || !("v" in value) || value.v !== 1
      || !("workspaceId" in value) || value.workspaceId !== workspaceId
      || !("id" in value) || typeof value.id !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.id)) return null;
    return value.id;
  } catch { return null; }
}

export async function listPrincipals(pool: Pool, userId: string, workspaceId: string, input: ListPrincipalsInput): Promise<
  { ok: true; page: PrincipalsPage } | { ok: false; reason: "workspace_forbidden" | "invalid_input" | "principal_list_failed" }
> {
  workspaceId = workspaceId.toLowerCase();
  const cursor = input.after === undefined ? null : decodeCursor(input.after, workspaceId);
  if (input.after !== undefined && cursor === null) return { ok: false, reason: "invalid_input" };
  try {
    return await pool.begin(async (tx) => {
      const access = await queryWorkspaceAccess(tx, userId, workspaceId);
      if (!access.allowed) return { ok: false, reason: access.reason };
      const limit = input.limit ?? 50;
      const rows = await tx<{
        id: string; workspaceId: string; name: string; status: "active" | "revoked";
        prefix: string | null; createdAt: Date | null; lastUsedAt: Date | null; rotatedAt: Date | null; revokedAt: Date | null;
      }[]>`
        SELECT p.id, p.workspace_id AS "workspaceId", p.name, p.status,
          k.prefix, k.created_at AS "createdAt", k.last_used_at AS "lastUsedAt",
          k.rotated_at AS "rotatedAt", k.revoked_at AS "revokedAt"
        FROM control.principals p LEFT JOIN control.principal_keys k
          ON k.workspace_id = p.workspace_id AND k.principal_id = p.id
        WHERE p.workspace_id = ${workspaceId} AND p.system IS NULL
          AND (${cursor}::uuid IS NULL OR p.id > ${cursor}::uuid)
        ORDER BY p.id LIMIT ${limit + 1}`;
      const items = rows.slice(0, limit).map((row) => ({
        id: row.id, workspaceId: row.workspaceId, name: row.name, status: row.status,
        credential: row.prefix === null || row.createdAt === null ? null : {
          prefix: row.prefix, createdAt: row.createdAt.toISOString(), lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
          rotatedAt: row.rotatedAt?.toISOString() ?? null, revokedAt: row.revokedAt?.toISOString() ?? null,
        },
      }));
      const last = items.at(-1);
      const nextCursor = rows.length > limit && last
        ? Buffer.from(JSON.stringify({ v: 1, workspaceId, id: last.id })).toString("base64url") : null;
      return { ok: true, page: { items, nextCursor } };
    });
  } catch { return { ok: false, reason: "principal_list_failed" }; }
}
