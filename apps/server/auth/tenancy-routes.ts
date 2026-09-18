// Composes the human tenancy endpoints for createApp.
import { Elysia } from "elysia";
import type { Pool } from "../platform/pool.ts";
import type { Auth } from "./auth.ts";
import { createWorkspaceRoute } from "./create-workspace-route.ts";
import { createPrincipalRoute } from "./create-principal-route.ts";

export function tenancyRoutes(pool: Pool, auth: Auth, authUrl: string) {
  return new Elysia({ name: "tenancy" }).use(createWorkspaceRoute(pool, auth, authUrl)).use(createPrincipalRoute(pool, auth, authUrl));
}
