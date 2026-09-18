// App composition registers reconciliation and its User-managed delegation.
import { Elysia } from "elysia";
import type { Auth } from "../auth/auth.ts";
import type { Pool } from "../platform/pool.ts";
import { reconcileRoute } from "./reconcile-route.ts";
import { setReconciliationDelegationRoute } from "./set-reconciliation-delegation-route.ts";
export function reconciliationRoutes(pool: Pool, auth: Auth, authUrl: string) {
  return new Elysia({ name: "reconciliations" }).use(reconcileRoute(pool, auth, authUrl))
    .use(setReconciliationDelegationRoute(pool, auth, authUrl));
}
