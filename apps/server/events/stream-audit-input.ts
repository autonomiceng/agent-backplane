// SSE contracts and cursor decisions used before opening and on every stream snapshot.
import { t } from "elysia";
import { auditEnvelope, MAX_POSITION } from "./read-audit-input.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const streamAuditInput = t.Object({
  since: t.Optional(t.String()), generation: t.Optional(t.String()),
}, { additionalProperties: false });
export const streamReady = t.Object({ generation: t.String({ format: "uuid" }), after: t.String(), head: t.String(), retentionFloor: t.String() });
export const streamExpired = t.Object({ error: t.Literal("cursor_expired"), resync: t.Literal(true),
  generation: t.String({ format: "uuid" }), retentionFloor: t.String(), head: t.String() });
export const streamErrorResponse = t.Object({ error: t.Union([
  t.Literal("invalid_input"), t.Literal("unauthorized"), t.Literal("workspace_forbidden"), t.Literal("invocation_scope_forbidden"),
  t.Literal("stream_limit_exceeded"), t.Literal("events_unavailable"), t.Literal("event_too_large"), t.Literal("slow_consumer"),
]) });
export const streamFrames = { ready: streamReady, audit: auditEnvelope, heartbeat: t.Object({}), error: t.Union([streamErrorResponse, streamExpired]) };
export type StreamError = typeof streamErrorResponse.static | typeof streamExpired.static;
export type StreamCursor = { after: string; generation?: string; workspaceId?: string };
export type CursorState = { generation: string; head: string; retentionFloor: string };

export function parseStreamCursor(headers: Headers, query: URLSearchParams): StreamCursor | null {
  if ([...query.keys()].some((key) => key !== "since" && key !== "generation")) return null;
  let after = query.get("since") ?? "0";
  let generation = query.get("generation") ?? undefined;
  let workspaceId: string | undefined;
  if (headers.has("last-event-id")) {
    const parts = (headers.get("last-event-id") ?? "").split(":");
    if (parts.length !== 4 || parts[0] !== "v1") return null;
    workspaceId = parts[1]; generation = parts[2]; after = parts[3] ?? "";
    if (!workspaceId || workspaceId.length !== 36 || !uuid.test(workspaceId)) return null;
  }
  const position = /^(0|[1-9][0-9]*)$/.exec(after);
  if (!position || position[0] !== after || after.length > 19 || BigInt(after) > MAX_POSITION
    || (generation !== undefined && (generation.length !== 36 || !uuid.test(generation))) || (after !== "0" && generation === undefined)) return null;
  return { after, ...(generation === undefined ? {} : { generation: generation.toLowerCase() }),
    ...(workspaceId === undefined ? {} : { workspaceId: workspaceId.toLowerCase() }) };
}

export function validateStreamCursor(cursor: StreamCursor, workspaceId: string, state: CursorState): StreamError | null {
  if ((cursor.workspaceId !== undefined && cursor.workspaceId !== workspaceId)
    || (cursor.generation !== undefined && cursor.generation !== state.generation)
    || BigInt(cursor.after) < BigInt(state.retentionFloor) || BigInt(cursor.after) > BigInt(state.head)) {
    return { error: "cursor_expired", resync: true, ...state };
  }
  return null;
}

export function streamError(error: unknown): { reason: "events_unavailable"; sqlstate: string | null } {
  return { reason: "events_unavailable", sqlstate: typeof error === "object" && error !== null
    && "errno" in error && typeof error.errno === "string" ? error.errno : null };
}

export function streamErrorStatus(error: StreamError): 401 | 403 | 409 | 422 | 429 | 503 {
  switch (error.error) {
    case "invalid_input": return 422;
    case "unauthorized": return 401;
    case "workspace_forbidden":
    case "invocation_scope_forbidden": return 403;
    case "cursor_expired": return 409;
    case "stream_limit_exceeded": return 429;
    default: return 503;
  }
}
