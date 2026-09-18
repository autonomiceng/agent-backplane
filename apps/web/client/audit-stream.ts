// Owns snapshot pagination, validated SSE frames, cancellation, and bounded reconnect backoff.
import { createApi } from "./api.ts";
import { eventId, initialTimeline, reduceAudit, type Action, type AuditEvent, type Ready, type TimelineState } from "./audit-state.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isAuditPosition(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)
    && value.length <= 19 && BigInt(value) <= 9223372036854775807n;
}
function isStreamReady(value: unknown): value is Ready {
  return isRecord(value) && typeof value.generation === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.generation)
    && isAuditPosition(value.after) && isAuditPosition(value.head) && isAuditPosition(value.retentionFloor)
    && BigInt(value.retentionFloor) <= BigInt(value.head) && BigInt(value.after) <= BigInt(value.head);
}
function isAuditEvent(value: unknown): value is AuditEvent {
  return isRecord(value) && isAuditPosition(value.position) && typeof value.kind === "string"
    && Array.isArray(value.objects) && value.objects.every((item: unknown) => typeof item === "string")
    && (value.row_count === null || isAuditPosition(value.row_count))
    && typeof value.occurred_at === "string" && Number.isFinite(Date.parse(value.occurred_at))
    && (value.principal_id === null || typeof value.principal_id === "string")
    && (value.run_id === null || typeof value.run_id === "string")
    && (value.user_id === null || typeof value.user_id === "string") && isRecord(value.metadata);
}
class StreamFailure extends Error {
  constructor(readonly reason: string) { super(reason); }
}
function failure(value: unknown): StreamFailure {
  return new StreamFailure(isRecord(value) && typeof value.error === "string" ? value.error : "protocol_error");
}

async function probe(url: URL, signal: AbortSignal, resumeId: string | null, fetcher: typeof fetch): Promise<Ready> {
  const response = await fetcher(url, { credentials: "include", signal,
    headers: resumeId ? { "Last-Event-ID": resumeId } : {} });
  if (!response.ok) {
    const value: unknown = await response.json();
    if (response.status === 409 && isRecord(value) && value.error === "cursor_expired"
      && isStreamReady({ ...value, after: "0" }) && resumeId === null) {
      return { generation: String(value.generation), head: String(value.head),
        retentionFloor: String(value.retentionFloor), after: "0" };
    }
    throw failure(value);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new StreamFailure("protocol_error");
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!buffer.includes("\n\n")) {
      const chunk = await reader.read();
      if (chunk.done) throw new StreamFailure("protocol_error");
      buffer += decoder.decode(chunk.value, { stream: true });
      if (buffer.length > 8192) throw new StreamFailure("protocol_error");
    }
    const frame = buffer.slice(0, buffer.indexOf("\n\n"));
    const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
    const value: unknown = JSON.parse(data ?? "null");
    if (!frame.startsWith("event: ready\n") || !isStreamReady(value)
      || !frame.includes(`\nid: ${eventId(url.pathname.split("/")[4] ?? "", value.generation, value.after)}\n`)) {
      throw new StreamFailure("protocol_error");
    }
    return value;
  } finally { await reader.cancel(); }
}

export function subscribeAudit(origin: string, workspaceId: string, runId: string,
  publish: (state: TimelineState) => void,
  transport: { fetch: typeof fetch; EventSource: typeof EventSource } = { fetch, EventSource }): () => void {
  let state = initialTimeline(workspaceId, runId);
  let stopped = false;
  let source: EventSource | undefined;
  let controller = new AbortController();
  let retry: ReturnType<typeof setTimeout> | undefined;
  let notification: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;
  const url = new URL(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/events`, origin);
  const api = createApi(origin, transport.fetch);
  const close = () => { source?.close(); source = undefined; controller.abort(); clearTimeout(retry); };
  const dispatch = (action: Action) => {
    if (stopped) return;
    const result = reduceAudit(state, action);
    state = result.state;
    if (notification === undefined) notification = setTimeout(() => {
      notification = undefined;
      if (!stopped) publish(state);
    }, 50);
    for (const effect of result.effects) {
      close();
      if (effect === "resync") retry = setTimeout(() => { void connect(); }, 0);
    }
  };
  const fail = (error: unknown, epoch: number) => {
    if (stopped || epoch !== state.epoch) return;
    close();
    const reason = error instanceof StreamFailure ? error.reason : "transport_error";
    if (reason === "cursor_expired") dispatch({ type: "expired", epoch });
    else if (["unauthorized", "workspace_forbidden", "invalid_input", "protocol_error", "event_too_large"].includes(reason)) {
      dispatch({ type: "failed", error: reason, epoch });
    } else {
      dispatch({ type: "disconnected", epoch });
      retry = setTimeout(() => { void connect(); }, Math.min(1000 * 2 ** Math.min(attempts++, 5), 30000));
    }
  };
  const connect = async () => {
    if (stopped || state.error) return;
    controller = new AbortController();
    const signal = controller.signal;
    const epoch = state.epoch;
    const current = () => !stopped && !signal.aborted && epoch === state.epoch;
    const timeout = setTimeout(() => fail(new Error("Handshake timed out"), epoch), 30000);
    signal.addEventListener("abort", () => clearTimeout(timeout), { once: true });
    try {
      const bootstrap = state.generation === null || state.staged !== null;
      const snapshot = await probe(url, signal, bootstrap ? null : state.resumeId, transport.fetch);
      if (!current()) return;
      if (bootstrap) {
        const events: AuditEvent[] = [];
        let after = "0";
        while (BigInt(after) < BigInt(snapshot.head)) {
          const page = await api.api.v1.workspaces({ workspaceId }).audit.get({
            query: { runId, after, limit: 500 }, fetch: { signal },
          });
          if (!current()) return;
          if (page.error) throw failure(page.error.value);
          events.push(...page.data.events.filter((event) => BigInt(event.position) <= BigInt(snapshot.head)));
          if (page.data.events.length === 0 || BigInt(page.data.nextAfter) >= BigInt(snapshot.head)) break;
          if (BigInt(page.data.nextAfter) <= BigInt(after)) throw new StreamFailure("protocol_error");
          after = page.data.nextAfter;
        }
        dispatch({ type: "history", snapshot, events, epoch });
      }
      const target = new URL(url);
      target.searchParams.set("since", state.after);
      target.searchParams.set("generation", state.generation ?? snapshot.generation);
      source = new transport.EventSource(target, { withCredentials: true });
      source.addEventListener("ready", (frame) => {
        if (!current()) return;
        try {
          const value: unknown = JSON.parse(frame.data);
          if (!isStreamReady(value)) throw new StreamFailure("protocol_error");
          clearTimeout(timeout);
          dispatch({ type: "ready", ready: value, id: frame.lastEventId, epoch });
          if (state.phase === "live") attempts = 0;
        } catch (error) { fail(error instanceof SyntaxError ? new StreamFailure("protocol_error") : error, epoch); }
      });
      source.addEventListener("audit", (frame) => {
        if (!current()) return;
        try {
          const value: unknown = JSON.parse(frame.data);
          if (!isAuditEvent(value)) throw new StreamFailure("protocol_error");
          dispatch({ type: "audit", event: value, id: frame.lastEventId, epoch });
          if (state.phase === "live") attempts = 0;
        } catch { fail(new StreamFailure("protocol_error"), epoch); }
      });
      source.addEventListener("error", (frame) => {
        if (!current()) return;
        clearTimeout(timeout);
        if (frame instanceof MessageEvent) {
          try { fail(failure(JSON.parse(frame.data)), epoch); }
          catch { fail(new StreamFailure("protocol_error"), epoch); }
        } else fail(new Error("Connection lost"), epoch);
      });
    } catch (error) { clearTimeout(timeout); if (current()) fail(error, epoch); }
  };
  publish(state);
  void connect();
  return () => { stopped = true; close(); clearTimeout(notification); };
}
