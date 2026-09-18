// User policy mutations map the bound adapter result to HTTP responses.
import type { BlobStore } from "../blobs/blob-store.ts";
import { Elysia } from "elysia";
import type { Auth } from "../auth/auth.ts";
import type { Pool } from "../platform/pool.ts";
import { retentionFailures } from "./retention-error-input.ts";
import { retentionSession } from "./retention-session.ts";
import { validationError } from "../auth/validation-error.ts";
import { runParams } from "../runs/create-run-input.ts";
import { purgeInput, purgeResponse } from "./purge-payloads-input.ts";
import { purgePayloads } from "./purge-payloads.ts";

export function purgePayloadsRoute(pool: Pool, auth: Auth, authUrl: string, blobStore?: BlobStore) {
  return new Elysia({ name: "purge-payloads" }).use(retentionSession(pool, auth, authUrl))
    .post("/api/v1/workspaces/:workspaceId/retention/purge", async ({ retentionActor, retentionWorkspace, body, status }) => {
      if (retentionActor.kind !== "user") return status(403, { error: "retention_forbidden" });
      const result = await purgePayloads(pool, { workspaceId: retentionWorkspace, userId: retentionActor.userId }, body.limit ?? 100, blobStore);
      if (!result.ok) return status(result.status, { error: result.error });
      return result.value;
    }, {
      retentionAccess: true, params: runParams, body: purgeInput, response: { 200: purgeResponse, ...retentionFailures }, error: validationError,
      detail: { "x-backplane-auth": "user", "x-backplane-run": "none", operationId: "purgePayloads", tags: ["retention"] },
    });
}
