// Workspace-scoped metadata lookup shared by the three blob adapters.
import type { Pool } from "../platform/pool.ts";
import type { RunTransaction } from "../runs/with-run-context.ts";
import type { blobResponse } from "./put-blob-input.ts";
export async function blobMetadata(sql: Pool | RunTransaction, workspace: string, id: string) {
  const [row] = await sql<(typeof blobResponse.static & { expired: boolean })[]>`SELECT workspace_id,id,key,size::integer,
    encode(sha256,'hex') AS sha256,content_type,principal_id,run_id,
    to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
    to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at,
    expires_at<=clock_timestamp() AS expired FROM control.blobs WHERE workspace_id=${workspace} AND id=${id}`;
  return row;
}
