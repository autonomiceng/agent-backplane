// Either actor lists Deliveries. Any Authorization header selects credentials and excludes cookie fallback.
import { Elysia, t } from "elysia";
import type { Auth } from "../auth/auth.ts";
import { eitherSession } from "../auth/either-session.ts";
import type { Pool } from "../platform/pool.ts";
import { listDeliveriesInput, listDeliveriesParams, listDeliveriesResponse } from "./list-deliveries-input.ts";
import { queueErrorStatus } from "./queue-error.ts";
import { validationError } from "../auth/validation-error.ts";
import { listDeliveries } from "./list-deliveries.ts";

export function listDeliveriesRoute(pool: Pool, auth: Auth) {
  return new Elysia({ name: "list-deliveries" }).get(
    "/api/v1/workspaces/:workspaceId/queues/:queue/deliveries",
    async ({ request, params, query, status, set }) => {
      set.headers["Cache-Control"] = "no-store";
      try {
        const failure = await eitherSession(pool, auth, request, params.workspaceId);
        if (failure) return status(failure.status, { error: failure.reason });
        const result = await listDeliveries(pool, params.workspaceId, params.queue, query);
        if (!result.ok) return status(queueErrorStatus(result.reason), { error: result.reason });
        return result.page;
      } catch {
        return status(503, { error: "queue_unavailable" });
      }
    },
    {
      params: listDeliveriesParams,
      query: listDeliveriesInput,
      response: {
        200: listDeliveriesResponse,
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
      detail: { "x-backplane-auth": "either", "x-backplane-run": "none", operationId: "listDeliveries", tags: ["queue"] },
    },
  );
}
