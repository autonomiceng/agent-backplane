// User policy reads map the adapter result to the retention contract.
import { Elysia } from "elysia";
import type { Auth } from "../auth/auth.ts";
import type { Pool } from "../platform/pool.ts";
import { retentionFailures } from "./retention-error-input.ts";
import { retentionSession } from "./retention-session.ts";
import { validationError } from "../auth/validation-error.ts";
import { runParams } from "../runs/create-run-input.ts";
import { getRetentionResponse } from "./get-retention-input.ts";
import { getRetention } from "./get-retention.ts";

export function getRetentionRoute(pool: Pool, auth: Auth, authUrl: string) {
  return new Elysia({ name: "get-retention" }).use(retentionSession(pool, auth, authUrl))
    .get("/api/v1/workspaces/:workspaceId/retention", async ({ retentionWorkspace, status }) => {
      const result = await getRetention(pool, retentionWorkspace);
      if (!result.ok) return status(result.status, { error: result.error });
      return result.value;
    }, {
      retentionAccess: true, params: runParams, response: { 200: getRetentionResponse, ...retentionFailures }, error: validationError,
      detail: { "x-backplane-auth": "user", "x-backplane-run": "none", operationId: "getRetention", tags: ["retention"] },
    });
}
