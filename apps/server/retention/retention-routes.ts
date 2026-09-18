// App composition registers the four retention operations.
import type { BlobStore } from "../blobs/blob-store.ts";
import { Elysia } from "elysia";
import type { Auth } from "../auth/auth.ts";
import type { Pool } from "../platform/pool.ts";
import { readPayloadRoute } from "./read-payload-route.ts";
import { getRetentionRoute } from "./get-retention-route.ts";
import { setRetentionRoute } from "./set-retention-route.ts";
import { purgePayloadsRoute } from "./purge-payloads-route.ts";

export function retentionRoutes(pool: Pool, auth: Auth, authUrl: string, blobStore?: BlobStore) {
  return new Elysia({ name: "retention" }).use(readPayloadRoute(pool, auth, authUrl)).use(getRetentionRoute(pool, auth, authUrl))
    .use(setRetentionRoute(pool, auth, authUrl)).use(purgePayloadsRoute(pool, auth, authUrl, blobStore));
}
