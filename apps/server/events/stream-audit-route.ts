// Admits authenticated Workspace streams and owns their per-app polling gate and admission counters.
import { readQuotas } from "../platform/quotas.ts";
import { Elysia, type DocumentDecoration } from "elysia";
import type { Auth } from "../auth/auth.ts";
import type { Pool } from "../platform/pool.ts";
import { runParams } from "../runs/create-run-input.ts";
import { admitStream } from "./stream-admission.ts";
import { resolveStreamAccess, streamAccessQuery } from "./stream-access.ts";
import { auditSnapshot, streamAudit, StreamQueries } from "./stream-audit.ts";
import { parseStreamCursor, streamAuditInput, streamError, streamErrorResponse, streamErrorStatus, streamExpired,
  streamFrames, type StreamError } from "./stream-audit-input.ts";

const APP_LIMIT = 64;
const ACTOR_LIMIT = 4;

const streamDetail = { "x-backplane-auth": "either", "x-backplane-run": "none", operationId: "streamAudit", tags: ["events"],
  description: "Follow Audit Events. Last-Event-ID overrides since and generation. Persist full IDs and deduplicate on reconnect.",
  parameters: [{ name: "Last-Event-ID", in: "header", required: false,
    description: "v1:<workspace UUID>:<generation UUID>:<exclusive decimal position>. Overrides both query fields.",
    schema: { type: "string" } }],
  responses: { 200: { description: "Workspace Audit Event stream", content: { "text/event-stream": { schema: { type: "string" } } } } },
  "x-sse-frames": streamFrames } satisfies DocumentDecoration & { "x-sse-frames": typeof streamFrames; "x-backplane-auth": string; "x-backplane-run": string };

export function streamAuditRoute(pool: Pool, auth: Auth, workspaces = new Map<string, number>()) {
  const queries = new StreamQueries();
  let active = 0;
  const actors = new Map<string, number>();
  const failure = (error: StreamError) => Response.json(error, { status: streamErrorStatus(error) });
  return new Elysia({ name: "stream-audit" }).get("/api/v1/workspaces/:workspaceId/events",
    async ({ request, params, server }) => {
      const workspaceId = params.workspaceId.toLowerCase();
      const cursor = parseStreamCursor(request.headers, new URL(request.url).searchParams);
      if (!cursor) return failure({ error: "invalid_input" });
      let admitted = false;
      let actor: string | undefined;
      const release = () => {
        if (!admitted) return;
        admitted = false;
        active--;
        const workspaceCount = (workspaces.get(workspaceId) ?? 1) - 1;
        if (workspaceCount === 0) workspaces.delete(workspaceId); else workspaces.set(workspaceId, workspaceCount);
        if (actor !== undefined) {
          const actorCount = (actors.get(actor) ?? 1) - 1;
          if (actorCount === 0) actors.delete(actor); else actors.set(actor, actorCount);
        }
      };
      try {
        const access = await resolveStreamAccess(auth, request.headers);
        if (!access) return failure({ error: "unauthorized" });
        // Authenticate before admission and before returning any cursor state; the opening batch is fetched after admission.
        const [authorized] = await queries.run(pool<{ denied: "unauthorized" | "workspace_forbidden" | null; actor: string }[]>`
          SELECT * FROM (${streamAccessQuery(pool, access, workspaceId)}) a`, request.signal);
        if (!authorized) return failure({ error: "events_unavailable" });
        if (authorized.denied) return failure({ error: authorized.denied });
        const limits = await readQuotas(pool, workspaceId);
        request.signal.throwIfAborted();
        actor = authorized.actor;
        if (!admitStream({ app: active, workspace: workspaces.get(workspaceId) ?? 0, actor: actors.get(actor) ?? 0 },
          { app: APP_LIMIT, workspace: limits.open_sse_streams, actor: ACTOR_LIMIT })) {
          return failure({ error: "stream_limit_exceeded" });
        }
        active++; workspaces.set(workspaceId, (workspaces.get(workspaceId) ?? 0) + 1); actors.set(actor, (actors.get(actor) ?? 0) + 1);
        admitted = true;
        const first = await auditSnapshot(pool, queries, request.signal, workspaceId, access, cursor, { data: true });
        if (!first.ok) { release(); return failure(first.error); }
        request.signal.throwIfAborted();
        server?.timeout(request, 0);
        return new Response(streamAudit(pool, queries, request, workspaceId, access, first, cursor.after, release), {
          headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" },
        });
      } catch (error) { release(); return failure({ error: streamError(error).reason }); }
    }, {
      params: runParams, query: streamAuditInput,
      response: { 401: streamErrorResponse, 403: streamErrorResponse, 409: streamExpired,
        422: streamErrorResponse, 429: streamErrorResponse, 503: streamErrorResponse },
      error({ code }) { if (code === "VALIDATION") return failure({ error: "invalid_input" }); },
      detail: streamDetail,
    });
}
