// Upload route maps the Run-bound adapter decision to the binary request contract.
import { Elysia } from "elysia";
import type { Pool } from "../platform/pool.ts";
import { runSession } from "../runs/run-session.ts";
import { runParams } from "../runs/create-run-input.ts";
import { validationError } from "../auth/validation-error.ts";
import { blobFailures, blobStatus } from "./blob-error-input.ts";
import { blobResponse, putBlobQuery, putBlobHeaders } from "./put-blob-input.ts";
import type { BlobStore } from "./blob-store.ts";
import { putBlob } from "./put-blob.ts";
export function putBlobRoute(pool: Pool, store?: BlobStore) {
  return new Elysia({ name: "put-blob" }).use(runSession(pool))
    .post("/api/v1/workspaces/:workspaceId/blobs", async ({ run, query, request, status, set }) => {
      const result = await putBlob(pool, run, store, query.key, request);
      if (!result.ok) return Response.json({ error: result.error }, { status: blobStatus(result.error) });
      set.headers.location = `/api/v1/workspaces/${run.workspaceId}/blobs/${result.value.id}`;
      return status(201, result.value);
    }, { run: true, parse: () => null, params: runParams, query: putBlobQuery, headers: putBlobHeaders,
      response: { 201: blobResponse, ...blobFailures }, error: validationError,
      detail: { operationId: "putBlob", tags: ["blobs"], "x-backplane-auth": "principal", "x-backplane-run": "required",
        requestBody: { required: true, content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } } } });
}
