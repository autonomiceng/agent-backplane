// User-only full replacement keeps usage intact and emits only effective changes.
import { Elysia, t, getSchemaValidator } from "elysia";
import type { Auth } from "../auth/auth.ts";
import { userSession } from "../auth/user-session.ts";
import { queryWorkspaceAccess } from "../auth/workspace-access-query.ts";
import { validationError } from "../auth/validation-error.ts";
import { runParams } from "../runs/create-run-input.ts";
import { withRunContext } from "../runs/with-run-context.ts";
import type { Pool } from "./pool.ts";
import { readQuotas } from "./quotas.ts";

const settings = t.Object({
  sql_statement_bytes: t.Integer({ minimum: 0, maximum: 1073741824 }),
  sql_rows: t.Integer({ minimum: 0, maximum: 1000000000 }),
  transaction_operations: t.Integer({ minimum: 0, maximum: 1000000000 }),
  queue_sends: t.Integer({ minimum: 0, maximum: 1000000000 }),
  open_sse_streams: t.Integer({ minimum: 0, maximum: 16 }),
}, { additionalProperties: false });
const error = t.Object({ error: t.String() });
class WorkspaceForbidden extends Error {}
export function setQuotasRoute(pool: Pool, auth: Auth, authUrl: string) {
  const validator = getSchemaValidator(settings, { normalize: false });
  return new Elysia({ name: "set-quotas" }).use(userSession(auth, authUrl)).put(
    "/api/v1/workspaces/:workspaceId/quotas", async ({ user, params, body, status }) => {
      try {
        if (!(await queryWorkspaceAccess(pool, user.id, params.workspaceId)).allowed) return status(403, { error: "workspace_forbidden" });
        return await withRunContext(pool, { workspaceId: params.workspaceId, userId: user.id }, async (tx, emit) => {
          if (!(await queryWorkspaceAccess(tx, user.id, params.workspaceId)).allowed) throw new WorkspaceForbidden();
          const previous = await readQuotas(tx, params.workspaceId);
          if (Object.entries(body).every(([key, value]) => Reflect.get(previous, key) === value)) return body;
          await tx`INSERT INTO control.workspace_quotas (workspace_id, sql_statement_bytes, sql_rows, transaction_operations, queue_sends, open_sse_streams)
            VALUES (${params.workspaceId}, ${body.sql_statement_bytes}, ${body.sql_rows}, ${body.transaction_operations}, ${body.queue_sends}, ${body.open_sse_streams})
            ON CONFLICT (workspace_id) DO UPDATE SET sql_statement_bytes = EXCLUDED.sql_statement_bytes, sql_rows = EXCLUDED.sql_rows,
              transaction_operations = EXCLUDED.transaction_operations, queue_sends = EXCLUDED.queue_sends, open_sse_streams = EXCLUDED.open_sse_streams`;
          await emit("quota.updated", [], null, body);
          return body;
        });
      } catch (cause) { return cause instanceof WorkspaceForbidden ? status(403, { error: "workspace_forbidden" }) : status(503, { error: "quotas_unavailable" }); }
    }, {
      user: true, body: settings, params: runParams,
      async parse({ request, status }) {
        let body: unknown;
        try { body = await request.json(); } catch { return status(422, { error: "invalid_input" }); }
        if (!validator?.Check(body)) return status(422, { error: "invalid_input" });
        return body;
      },
      response: { 200: settings, 401: error, 403: error, 422: error, 503: error }, error: validationError,
      detail: { "x-backplane-auth": "user", "x-backplane-run": "none", operationId: "setWorkspaceQuotas", tags: ["platform"] },
    });
}
