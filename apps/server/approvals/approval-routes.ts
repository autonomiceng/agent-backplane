// App composition registers Approval requests, decisions and User-controlled policies.
import { Elysia } from "elysia";
import type { Auth } from "../auth/auth.ts";
import type { Pool } from "../platform/pool.ts";
import { requestRoute } from "./request-route.ts";
import { decideRoute } from "./decide-route.ts";
import { setDelegationRoute } from "./set-delegation-route.ts";
import { setSettingsRoute } from "./set-settings-route.ts";
import { setGateRoute } from "./set-gate-route.ts";
import { listApprovalsRoute } from "./list-approvals-route.ts";
export function approvalRoutes(pool: Pool, auth: Auth, authUrl: string) {
  return new Elysia({ name: "approvals" }).use(listApprovalsRoute(pool, auth)).use(requestRoute(pool)).use(decideRoute(pool, auth, authUrl))
    .use(setDelegationRoute(pool, auth, authUrl)).use(setSettingsRoute(pool, auth, authUrl)).use(setGateRoute(pool, auth, authUrl));
}
