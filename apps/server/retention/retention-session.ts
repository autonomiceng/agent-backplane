// Retention routes share Workspace authorization and User-only mutation checks.
import { Elysia } from "elysia";
import type { Auth } from "../auth/auth.ts";
import { resolveStreamAccess, streamAccessQuery } from "../events/stream-access.ts";
import type { Pool } from "../platform/pool.ts";

export function retentionSession(pool: Pool, auth: Auth, authUrl: string) {
  return new Elysia({ name: "retention-session" }).macro({
    retentionAccess: (userOnly: boolean) => ({
      async resolve({ request, params, status, set }) {
        set.headers["Cache-Control"] = "no-store";
        if (!("workspaceId" in params) || typeof params.workspaceId !== "string") return status(422, { error: "invalid_input" });
        try {
          const access = await resolveStreamAccess(auth, request.headers);
          if (!access) return status(401, { error: "unauthorized" });
          const workspaceId = params.workspaceId.toLowerCase();
          const [authorized] = await pool<{ denied: "unauthorized" | "workspace_forbidden" | null }[]>`
            SELECT denied FROM (${streamAccessQuery(pool, access, workspaceId)}) a`;
          if (!authorized) return status(503, { error: "retention_unavailable" });
          if (authorized.denied) return status(authorized.denied === "unauthorized" ? 401 : 403, { error: authorized.denied });
          if (userOnly && access.kind !== "user") return status(403, { error: "retention_forbidden" });
          if (request.method !== "GET") {
            const origin = request.headers.get("origin");
            if ((origin !== null && origin !== new URL(authUrl).origin)
              || request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return status(403, { error: "origin_forbidden" });
          }
          return { retentionActor: access, retentionWorkspace: workspaceId };
        } catch { return status(503, { error: "retention_unavailable" }); }
      },
    }),
  });
}
