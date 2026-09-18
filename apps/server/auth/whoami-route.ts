// Provisional Principal identity endpoint; Runs are added in S05.
import { Elysia, t } from "elysia";
import type { Pool } from "../platform/pool.ts";
import { createPrincipalParams } from "./create-principal-input.ts";
import { principalSession } from "./principal-session.ts";
import { validationError } from "./validation-error.ts";

export function whoamiRoute(pool: Pool) {
  return new Elysia({ name: "whoami" }).use(principalSession(pool)).get(
    "/api/v1/workspaces/:workspaceId/whoami",
    ({ principal }) => principal,
    {
      principal: true,
      params: createPrincipalParams,
      response: {
        200: t.Object({ principalId: t.String({ format: "uuid" }), workspaceId: t.String({ format: "uuid" }) }),
        401: t.Object({ error: t.String() }),
        403: t.Object({ error: t.String() }),
        422: t.Object({ error: t.String() }),
        503: t.Object({ error: t.String() }),
      },
      error: validationError,
      detail: { "x-backplane-auth": "principal", "x-backplane-run": "none", operationId: "whoami", tags: ["auth"] },
    },
  );
}
