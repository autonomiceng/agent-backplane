// Either actor can read captures through the guarded payload adapter.
import { Elysia } from "elysia";
import type { Auth } from "../auth/auth.ts";
import type { Pool } from "../platform/pool.ts";
import { retentionFailures } from "./retention-error-input.ts";
import { retentionSession } from "./retention-session.ts";
import { MAX_POSITION } from "../events/read-audit-input.ts";
import { payloadParams, payloadResponse } from "./read-payload-input.ts";
import { readPayload } from "./read-payload.ts";

export function readPayloadRoute(pool: Pool, auth: Auth, authUrl: string) {
  return new Elysia({ name: "read-payload" }).use(retentionSession(pool, auth, authUrl))
    .get("/api/v1/workspaces/:workspaceId/audit/:position/payload", async ({ params, status }) => {
      if (BigInt(params.position) > MAX_POSITION) return status(400, { error: "invalid_query" });
      const result = await readPayload(pool, params.workspaceId, params.position);
      if (!result.ok) return status(result.status, { error: result.error });
      return result.value;
    }, {
      retentionAccess: false, params: payloadParams, response: { 200: payloadResponse, ...retentionFailures },
      error({ code, status }) { if (code === "VALIDATION") return status(400, { error: "invalid_query" }); },
      detail: { "x-backplane-auth": "either", "x-backplane-run": "none", operationId: "readAuditPayload", tags: ["retention"] },
    });
}
