// Read the effective policy for an authorized User without binding a Run.
import type { Pool } from "../platform/pool.ts";
import type { getRetentionResponse } from "./get-retention-input.ts";
import { retentionError, type RetentionFailure } from "./retention-error.ts";

export async function getRetention(pool: Pool, workspaceId: string): Promise<
  { ok: true; value: typeof getRetentionResponse.static } | RetentionFailure
> {
  try {
    const [row] = await pool<{ seconds: number }[]>`SELECT coalesce((SELECT seconds FROM control.retention_settings WHERE workspace_id=${workspaceId}),2592000) AS seconds`;
    if (!row) return { ok: false, status: 503, error: "retention_unavailable" };
    return { ok: true, value: row };
  } catch (error) { return retentionError(error); }
}
