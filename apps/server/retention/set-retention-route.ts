// User policy mutations map the bound adapter result to HTTP responses.
import { Elysia } from "elysia";
import type { Auth } from "../auth/auth.ts";
import type { Pool } from "../platform/pool.ts";
import { retentionFailures } from "./retention-error-input.ts";
import { retentionSession } from "./retention-session.ts";
import { validationError } from "../auth/validation-error.ts";
import { runParams } from "../runs/create-run-input.ts";
import { setRetentionInput } from "./set-retention-input.ts";
import { setRetention } from "./set-retention.ts";

export function setRetentionRoute(pool: Pool, auth: Auth, authUrl: string) {
  return new Elysia({ name: "set-retention" }).use(retentionSession(pool, auth, authUrl))
    .put("/api/v1/workspaces/:workspaceId/retention", async ({ retentionActor, retentionWorkspace, body, status }) => {
      if (retentionActor.kind !== "user") return status(403, { error: "retention_forbidden" });
      const result = await setRetention(pool, { workspaceId: retentionWorkspace, userId: retentionActor.userId }, body.seconds);
      if (!result.ok) return status(result.status, { error: result.error });
      return result.value;
    }, {
      retentionAccess: true, params: runParams, body: setRetentionInput, response: { 200: setRetentionInput, ...retentionFailures }, error: validationError,
      detail: { "x-backplane-auth": "user", "x-backplane-run": "none", operationId: "setRetention", tags: ["retention"] },
    });
}
