// Read the guarded primitive capture for an authorized Audit Event request.
import type { Pool } from "../platform/pool.ts";
import type { payloadResponse } from "./read-payload-input.ts";
import { retentionError, type RetentionFailure } from "./retention-error.ts";

export async function readPayload(pool: Pool, workspaceId: string, position: string): Promise<
  { ok: true; value: typeof payloadResponse.static } | RetentionFailure
> {
  try {
    const rows = await pool<{ kind: "message" | "migration" | "reconciliation"; value: string; expiresAt: Date }[]>`
      SELECT kind,value::text,expires_at AS "expiresAt" FROM queue.audit_payload(${workspaceId},${position}::bigint)`;
    return { ok: true, value: { position, payloads: rows.map((row) => {
      const value: unknown = JSON.parse(row.value);
      return { kind: row.kind, value, expiresAt: row.expiresAt.toISOString() };
    }) } };
  } catch (error) {
    const failure = retentionError(error);
    return { ...failure, error: failure.status === 503 ? "payload_read_failed" : failure.error };
  }
}
