// App composition registers User restore operations.
import { Elysia } from "elysia";
import type { Auth } from "../auth/auth.ts";
import type { Pool } from "../platform/pool.ts";
import { restoreStatusRoute } from "./restore-status-route.ts";
import { releaseRestoreRoute } from "./release-restore-route.ts";
export function restoreRoutes(pool: Pool, auth: Auth, authUrl: string) {
  return new Elysia({ name: "restore" }).use(restoreStatusRoute(pool, auth, authUrl)).use(releaseRestoreRoute(pool, auth, authUrl));
}
