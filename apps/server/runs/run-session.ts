// Run-bound routes compose Principal authentication with header and ownership checks before their transaction.
import { Elysia } from "elysia";
import { principalSession } from "../auth/principal-session.ts";
import type { Pool } from "../platform/pool.ts";
import { runAccess } from "./run-access.ts";
import { queryRunAccess } from "./run-access-query.ts";
import { parseRunHeader } from "./run-header.ts";

export function runSession(pool: Pool) {
  return new Elysia({ name: "run-session" }).use(principalSession(pool)).macro("run", {
    principal: true,
    async resolve({ request, principal, status }) {
      const parsed = parseRunHeader(request.headers.get("x-backplane-run"));
      if (!parsed.ok) return status(400, { error: parsed.reason });
      try {
        const access = runAccess(principal, await queryRunAccess(pool, parsed.runId));
        if (!access.allowed) return status(403, { error: access.reason });
        return { run: { ...principal, runId: parsed.runId } };
      } catch {
        return status(503, { error: "run_access_failed" });
      }
    },
  });
}
