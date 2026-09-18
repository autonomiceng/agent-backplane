// Mounts User credential management and Principal authentication beside tenancy routes.
import { Elysia } from "elysia";
import type { Pool } from "../platform/pool.ts";
import type { Auth } from "./auth.ts";
import { getPrincipalKeyRoute } from "./get-principal-key-route.ts";
import { issuePrincipalKeyRoute } from "./issue-principal-key-route.ts";
import { revokePrincipalRoute } from "./revoke-principal-route.ts";
import { whoamiRoute } from "./whoami-route.ts";

export function principalCredentialRoutes(pool: Pool, auth: Auth, authUrl: string) {
  return new Elysia({ name: "principal-credentials" })
    .use(issuePrincipalKeyRoute(pool, auth, authUrl)).use(getPrincipalKeyRoute(pool, auth, authUrl))
    .use(revokePrincipalRoute(pool, auth, authUrl)).use(whoamiRoute(pool));
}
