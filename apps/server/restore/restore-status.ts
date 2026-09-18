// The status route reads restore progress after locking current User membership.
import type { Pool } from "../platform/pool.ts";
import { queryWorkspaceAccess } from "../auth/workspace-access-query.ts";
import type { restoreStatusResponse } from "./restore-status-input.ts";
export async function restoreStatus(pool: Pool, userId: string, workspaceId: string) {
  try {
    return await pool.begin(async (tx) => {
      if (!(await queryWorkspaceAccess(tx, userId, workspaceId)).allowed) return { error: "workspace_forbidden" };
      const [row] = await tx<(typeof restoreStatusResponse.static)[]>`SELECT g.active,g.epoch,p.generation,
        p.minimum_head::text AS "minimumHead",coalesce(p.rotated,false) AS rotated,coalesce(p.done,false) AS done,
        p.released_by AS "releasedBy",(SELECT count(*)::int FROM queue.delivery_envelopes WHERE workspace_id=${workspaceId}
          AND state IN ('begun','leased') AND (envelope->>'current')::boolean) AS pending
        FROM control.restore_gate g LEFT JOIN control.restore_workspaces p ON p.epoch=g.epoch AND p.workspace_id=${workspaceId}
        WHERE g.singleton`;
      return row ?? { error: "restore_unavailable" };
    });
  } catch { return { error: "restore_unavailable" }; }
}
