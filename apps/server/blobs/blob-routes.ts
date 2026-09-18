// App composition registers the three blob verbs with their shared store.
import { Elysia } from "elysia";
import type { Auth } from "../auth/auth.ts";
import type { Pool } from "../platform/pool.ts";
import type { BlobStore } from "./blob-store.ts";
import { putBlobRoute } from "./put-blob-route.ts";
import { getBlobRoute } from "./get-blob-route.ts";
import { deleteBlobRoute } from "./delete-blob-route.ts";
export function blobRoutes(pool: Pool, auth: Auth, authUrl: string, store?: BlobStore) {
  return new Elysia({ name: "blobs" }).use(putBlobRoute(pool, store)).use(getBlobRoute(pool, auth, store))
    .use(deleteBlobRoute(pool, auth, authUrl, store));
}
