// Request-owned audit snapshots, framing, and bounded stream resources. No transaction survives a query.
import type { Pool } from "../platform/pool.ts";
import { streamAccessQuery, type StreamAccess } from "./stream-access.ts";
import { streamError, validateStreamCursor, type CursorState, type StreamCursor, type StreamError } from "./stream-audit-input.ts";

export const STREAM_BYTES = 256 * 1024;
type SnapshotRow = { denied: "unauthorized" | "workspace_forbidden" | null; actor: string;
  gated: boolean; generation: string | null; head: string; retentionFloor: string; frames: string[]; positions: string[]; oversized: boolean };
export type StreamSnapshot = { ok: true; actor: string; state: CursorState; frames: string[]; positions: string[] }
  | { ok: false; error: StreamError };

// One gate per app bounds polling, including opens; cancellation also removes queued work.
export class StreamQueries {
  private active = 0;
  private readonly waiters = new Set<() => void>();

  async run<T>(query: PromiseLike<T> & { cancel(): void }, signal: AbortSignal): Promise<T> {
    const deadline = new AbortController();
    const abort = () => deadline.abort();
    const timer = setTimeout(abort, 5000);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    let acquired = false, settled = false;
    // Cancelling a query that already settled produces a late unhandled rejection during teardown.
    const cancel = () => { if (!settled) { try { query.cancel(); } catch { /* already settled */ } } };
    try {
      while (this.active >= 2 && !deadline.signal.aborted) {
        await new Promise<void>((resolve) => {
          const wake = () => { this.waiters.delete(wake); deadline.signal.removeEventListener("abort", wake); resolve(); };
          this.waiters.add(wake);
          deadline.signal.addEventListener("abort", wake, { once: true });
        });
      }
      deadline.signal.throwIfAborted();
      this.active++; acquired = true;
      deadline.signal.addEventListener("abort", cancel, { once: true });
      const result = await query;
      settled = true;
      deadline.signal.throwIfAborted();
      return result;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      deadline.signal.removeEventListener("abort", cancel);
      if (acquired) {
        this.active--;
        for (const wake of this.waiters) wake();
      }
    }
  }
}

export async function auditSnapshot(pool: Pool, queries: StreamQueries, signal: AbortSignal, workspaceId: string,
  access: StreamAccess, cursor: StreamCursor, options: { data: boolean; actor?: string }): Promise<StreamSnapshot> {
  // The access timer supplies fresh facts every five seconds. Data ticks reuse the accepted actor between rechecks.
  const authorization = options.actor === undefined ? streamAccessQuery(pool, access, workspaceId)
    : pool`SELECT NULL::text AS denied, ${options.actor}::text AS actor`;
  const query = pool<SnapshotRow[]>`
    WITH access AS MATERIALIZED (${authorization}), state AS MATERIALIZED (
      SELECT CASE WHEN g.active THEN coalesce(p.generation,c.generation) ELSE c.generation END AS generation,
        g.active AS gated,c.last_position,c.retention_floor FROM audit.cursor c
      CROSS JOIN control.restore_gate g LEFT JOIN control.restore_workspaces p ON p.epoch=g.epoch AND p.workspace_id=c.workspace_id, access a
      WHERE c.workspace_id = ${workspaceId}::uuid AND a.denied IS NULL
    ), candidates AS MATERIALIZED (
      SELECT e.position, 'event: audit' || chr(10) || 'id: v1:' || ${workspaceId} || ':' || s.generation::text || ':' || e.position::text
        || chr(10) || 'data: ' || jsonb_build_object(
          'position', e.position::text, 'kind', e.kind, 'objects', e.objects, 'row_count', e.row_count::text,
          'occurred_at', to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'principal_id', e.principal_id, 'run_id', e.run_id, 'user_id', e.user_id,
          'metadata', CASE WHEN jsonb_typeof(e.metadata) = 'object' THEN e.metadata ELSE '{}'::jsonb END
        )::text || chr(10) || chr(10) AS frame
      FROM audit.events e, state s
      WHERE ${options.data} AND NOT s.gated AND e.workspace_id = ${workspaceId}::uuid
        AND e.position > ${cursor.after}::bigint AND e.position <= s.last_position
        AND ${cursor.after}::bigint BETWEEN s.retention_floor AND s.last_position
        AND (${cursor.generation ?? null}::uuid IS NULL OR s.generation = ${cursor.generation ?? null}::uuid)
        AND (${cursor.workspaceId ?? workspaceId}::uuid = ${workspaceId}::uuid)
      ORDER BY e.position LIMIT 100
    ), sized AS MATERIALIZED (
      SELECT position, frame, sum(octet_length(frame)) OVER (ORDER BY position) AS bytes FROM candidates
    )
    SELECT a.denied, a.actor, s.gated, s.generation::text, s.last_position::text AS head, s.retention_floor::text AS "retentionFloor",
      ARRAY(SELECT frame FROM sized WHERE bytes <= ${STREAM_BYTES} ORDER BY sized.position) AS frames,
      ARRAY(SELECT position::text FROM sized WHERE bytes <= ${STREAM_BYTES} ORDER BY sized.position) AS positions,
      coalesce((SELECT bytes > ${STREAM_BYTES} FROM sized ORDER BY position LIMIT 1), false) AS oversized
    FROM access a LEFT JOIN state s ON true`;
  try {
    const [row] = await queries.run(query, signal);
    if (!row) return { ok: false, error: { error: "events_unavailable" } };
    if (row.denied) return { ok: false, error: { error: row.denied } };
    if (!row.generation) return { ok: false, error: { error: "events_unavailable" } };
    const state = { generation: row.generation, head: row.head, retentionFloor: row.retentionFloor };
    if (row.gated) return { ok: false, error: { error: "cursor_expired", resync: true, ...state } };
    const error = validateStreamCursor(cursor, workspaceId, state);
    if (error) return { ok: false, error };
    if (row.oversized) return { ok: false, error: { error: "event_too_large" } };
    return { ok: true, actor: row.actor, state, frames: row.frames, positions: row.positions };
  } catch (error) {
    return { ok: false, error: { error: streamError(error).reason } };
  }
}

export function streamAudit(pool: Pool, queries: StreamQueries, request: Request, workspaceId: string, access: StreamAccess,
  { actor, state, frames, positions }: Extract<StreamSnapshot, { ok: true }>, after: string, release: () => void,
  { slowConsumerMs = 30_000, accessIntervalMs = 5_000, dataIntervalMs = 1_000 }: {
    slowConsumerMs?: number; accessIntervalMs?: number; dataIntervalMs?: number;
  } = {}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const lifetime = new AbortController();
  const pending = new Set<Promise<void>>();
  let offset = 0;
  let closed = false;
  let dataBusy = false;
  let accessBusy = false;
  let lastProgress = performance.now();
  let lastHeartbeat = lastProgress;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let dataTimer: ReturnType<typeof setInterval>;
  let accessTimer: ReturnType<typeof setInterval>;
  const cursor = () => ({ after, generation: state.generation });
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(dataTimer); clearInterval(accessTimer);
    request.signal.removeEventListener("abort", abort);
    lifetime.abort();
    frames = []; positions = [];
    void Promise.allSettled(pending).then(release);
  };
  const finish = (error?: StreamError) => {
    if (closed) return;
    if (error) {
      const frame = encoder.encode(`event: error\ndata: ${JSON.stringify(error)}\n\n`);
      if ((controller.desiredSize ?? 0) >= frame.byteLength) controller.enqueue(frame);
    }
    controller.close();
    cleanup();
  };
  const abort = () => finish();
  let flushing = false;
  // enqueue can re-enter through pull, so the cursor advances before the frame leaves.
  const flush = () => {
    if (flushing) return;
    flushing = true;
    try {
      while (!closed && offset < frames.length) {
        const frame = frames[offset];
        const position = positions[offset];
        if (frame === undefined || position === undefined) break;
        const bytes = encoder.encode(frame);
        if ((controller.desiredSize ?? 0) < bytes.byteLength) break;
        after = position;
        offset++;
        lastProgress = performance.now();
        controller.enqueue(bytes);
      }
      if (offset === frames.length) { frames = []; positions = []; offset = 0; }
    } finally { flushing = false; }
  };
  const track = (work: Promise<void>) => {
    pending.add(work);
    void work.then(() => pending.delete(work), (error: unknown) => {
      finish({ error: streamError(error).reason });
      pending.delete(work);
    });
  };
  const dataTick = async () => {
    if (closed || dataBusy) return;
    const now = performance.now();
    if (now - lastProgress >= slowConsumerMs) { finish({ error: "slow_consumer" }); return; }
    flush();
    if (frames.length > 0 || (controller.desiredSize ?? 0) < STREAM_BYTES) return;
    dataBusy = true;
    try {
      const snapshot = await auditSnapshot(pool, queries, lifetime.signal, workspaceId, access, cursor(), { data: true, actor: actor });
      if (closed) return;
      if (!snapshot.ok) { finish(snapshot.error); return; }
      frames = snapshot.frames; positions = snapshot.positions;
      flush();
      if (frames.length === 0 && now - lastHeartbeat >= 15_000) {
        const heartbeat = encoder.encode("event: heartbeat\ndata: {}\n\n");
        if ((controller.desiredSize ?? 0) >= heartbeat.byteLength) {
          controller.enqueue(heartbeat); lastProgress = now; lastHeartbeat = now;
        }
      }
    } finally { dataBusy = false; }
  };
  const accessTick = async () => {
    if (closed || accessBusy) return;
    accessBusy = true;
    try {
      const snapshot = await auditSnapshot(pool, queries, lifetime.signal, workspaceId, access, cursor(), { data: false });
      if (!closed && !snapshot.ok) finish(snapshot.error);
    } finally { accessBusy = false; }
  };
  return new ReadableStream<Uint8Array>({
    start(output) {
      controller = output;
      controller.enqueue(encoder.encode(`event: ready\nid: v1:${workspaceId}:${state.generation}:${after}\ndata: ${JSON.stringify({
        generation: state.generation, after, head: state.head, retentionFloor: state.retentionFloor,
      })}\n\n`));
      dataTimer = setInterval(() => track(dataTick()), dataIntervalMs);
      accessTimer = setInterval(() => track(accessTick()), accessIntervalMs);
      request.signal.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted) abort();
    },
    pull() { if (!closed) flush(); },
    cancel() { cleanup(); return Promise.allSettled(pending).then(() => {}); },
  }, { highWaterMark: STREAM_BYTES, size: (chunk) => chunk?.byteLength ?? 0 });
}
