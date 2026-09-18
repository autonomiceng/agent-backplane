// Run-authenticated claim translates fenced queue outcomes into the HTTP contract.
import { Elysia, t } from "elysia";
import { validationError } from "../auth/validation-error.ts";
import type { Pool } from "../platform/pool.ts";
import { runSession } from "../runs/run-session.ts";
import { claimInput, claimParams, claimResponse } from "./claim-input.ts";
import { claim } from "./claim.ts";
import { queueErrorStatus } from "./queue-error.ts";

export function claimRoute(pool: Pool) {
  return new Elysia({ name: "claim" }).use(runSession(pool)).post(
    "/api/v1/workspaces/:workspaceId/queues/:queue/claim",
    async ({ run, params, status, set }) => {
      set.headers["Cache-Control"] = "no-store";
      const result = await claim(pool, run, params.queue);
      if (!result.ok) return status(queueErrorStatus(result.reason), { error: result.reason });
      return result.claim;
    },
    {
      run: true,
      transform({ body, status }) {
        if (typeof body !== "object" || body === null || Array.isArray(body)
          || Object.keys(body).some((key) => !Object.hasOwn(claimInput.properties, key))) {
          throw status(422, { error: "invalid_input" });
        }
      },
      // Preserve JSON null for an empty Queue instead of the framework's empty body.
      mapResponse({ responseValue }) {
        if (responseValue === null) return new Response("null", { headers: { "content-type": "application/json", "Cache-Control": "no-store" } });
      },
      body: claimInput,
      params: claimParams,
      response: {
        200: t.Nullable(claimResponse),
        400: t.Object({ error: t.String() }),
        401: t.Object({ error: t.String() }),
        403: t.Object({ error: t.String() }),
        404: t.Object({ error: t.String() }),
        409: t.Object({ error: t.String() }),
        410: t.Object({ error: t.String() }),
        413: t.Object({ error: t.String() }),
        422: t.Object({ error: t.String() }),
        503: t.Object({ error: t.String() }),
      },
      error: validationError,
      detail: { "x-backplane-auth": "principal", "x-backplane-run": "required", operationId: "claimMessage", tags: ["queue"] },
    },
  );
}
