// Read route authorizes either actor and constructs headers only after the adapter's final metadata check.
import { Elysia } from "elysia";
import type { Auth } from "../auth/auth.ts";
import type { Pool } from "../platform/pool.ts";
import { eitherSession } from "../auth/either-session.ts";
import { validationError } from "../auth/validation-error.ts";
import { blobFailures, blobStatus } from "./blob-error-input.ts";
import { getBlobParams } from "./get-blob-input.ts";
import type { BlobStore } from "./blob-store.ts";
import { getBlob } from "./get-blob.ts";
export function getBlobRoute(pool: Pool, auth: Auth, store?: BlobStore) {
  return new Elysia({ name: "get-blob" }).get("/api/v1/workspaces/:workspaceId/blobs/:id", async ({ request, params }) => {
    try {
      const denied = await eitherSession(pool, auth, request, params.workspaceId);
      if (denied) return Response.json({ error: denied.reason }, { status: denied.status });
    } catch { return Response.json({ error: "blob_unavailable" }, { status: 503 }); }
    const result = await getBlob(pool, params.workspaceId.toLowerCase(), params.id.toLowerCase(), store);
    if (!result.ok) return Response.json({ error: result.error }, { status: blobStatus(result.error) });
    const { bytes, contentType } = result.value;
    return new Response(Buffer.from(bytes), { headers: { "Content-Type": contentType, "Content-Length": String(bytes.length),
      "Cache-Control": "no-store", "Content-Disposition": "attachment", "X-Content-Type-Options": "nosniff" } });
  }, { params: getBlobParams, response: blobFailures, error: validationError,
    detail: { operationId: "getBlob", tags: ["blobs"], "x-backplane-auth": "either", "x-backplane-run": "none",
      responses: { 200: { description: "Private blob bytes, at most 4 MiB", content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } } } } });
}
