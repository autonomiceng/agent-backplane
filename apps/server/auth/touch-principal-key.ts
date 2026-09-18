// Principal sessions record throttled identity telemetry outside Run context, like Better Auth session writes.
import type { Pool } from "../platform/pool.ts";

export async function touchPrincipalKey(pool: Pool, prefix: string): Promise<void> {
  await pool`UPDATE control.principal_keys SET last_used_at = clock_timestamp()
    WHERE prefix = ${prefix} AND (last_used_at IS NULL OR last_used_at <= clock_timestamp() - interval '1 minute')`;
}
