// Delete route maps logical deletion outcomes; the adapter owns commit resolution and physical cleanup.
import { Elysia } from "elysia";
import type { Auth } from "../auth/auth.ts";
import type { Pool } from "../platform/pool.ts";
import { decisionSession } from "../auth/decision-session.ts";
import { validationError } from "../auth/validation-error.ts";
import { blobFailures, blobStatus } from "./blob-error-input.ts";
import { deleteBlobParams } from "./delete-blob-input.ts";
import type { BlobStore } from "./blob-store.ts";
import { deleteBlob } from "./delete-blob.ts";
export function deleteBlobRoute(pool: Pool, auth: Auth, authUrl: string, store?: BlobStore) {
  return new Elysia({ name: "delete-blob" }).use(decisionSession(pool, auth, authUrl))
    .delete("/api/v1/workspaces/:workspaceId/blobs/:id", async ({ actor, params }) => {
      const result = await deleteBlob(pool, actor, params.id.toLowerCase(), store);
      if (!result.ok) return Response.json({ error: result.error }, { status: blobStatus(result.error) });
      return new Response(null, { status: 204 });
    }, { approver: true, params: deleteBlobParams, response: blobFailures, error: validationError,
      detail: { operationId: "deleteBlob", tags: ["blobs"], "x-backplane-auth": "either", "x-backplane-run": "principal-required",
        responses: { 204: { description: "Blob logically deleted; physical cleanup retries on subsequent writes or purges" } } } });
}
