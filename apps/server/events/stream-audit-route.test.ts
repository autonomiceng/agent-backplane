import { expect, test } from "bun:test";
import { frames, nextFrame } from "./testing/frames.ts";
import { Elysia, t } from "elysia";
import { createPool } from "../platform/pool.ts";
import { runSession } from "../runs/run-session.ts";
import { withRunContext } from "../runs/with-run-context.ts";
import { adminUrl } from "../testing/postgres.ts";
import { sqlFixture } from "../testing/session.ts";
import { auditSnapshot, streamAudit, STREAM_BYTES, StreamQueries } from "./stream-audit.ts";
import { hashPrincipalSecret } from "../auth/principal-key-crypto.ts";
import { admitStream } from "./stream-admission.ts";
import { parsePrincipalKey } from "../auth/principal-key.ts";

function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("expected fixture value");
  return value;
}

test("idle, aborted, oversized, or stalled streams retain pool capacity, admission, polling, or unbounded output", async () => {
  const f = await sqlFixture("CREATE TABLE items (id int PRIMARY KEY)");
  const admin = createPool(adminUrl(f.url));
  // Stored envelopes can outgrow today's producers. Exercise those sizes through an authenticated, Run-bound server fixture.
  const app = f.app.use(new Elysia().use(runSession(f.pool)).post(
    "/api/v1/workspaces/:workspaceId/stream-fixture",
    async ({ run, body }) => withRunContext(f.pool, run, async (_tx, emit) => {
      let position = 0n;
      for (let i = 0; i < body.count; i++) position = await emit("sql.execute", ["items"], 0,
        { kind: "select", fingerprint: "f".repeat(body.bytes) });
      return { position: String(position) };
    }), {
      run: true, params: t.Object({ workspaceId: t.String({ format: "uuid" }) }),
      body: t.Object({ count: t.Integer({ minimum: 1, maximum: 100 }), bytes: t.Integer({ minimum: 1, maximum: 300000 }) }),
      response: { 200: t.Object({ position: t.String() }) },
      detail: { operationId: "emitStreamFixture" },
    },
  ));
  const server = Bun.serve({ port: 0, fetch: app.fetch, idleTimeout: 0 });
  const controllers: AbortController[] = [];
  const stalled: Response[] = [];
  try {
    const [initial] = await f.pool<{ head: string; generation: string }[]>`SELECT last_position::text AS head, generation::text
      FROM audit.cursor WHERE workspace_id = ${f.workspaceId}`;
    const path = `/api/v1/workspaces/${f.workspaceId}/events`;
    const resume = `?since=${must(initial).head}&generation=${must(initial).generation}`;
    const open = async () => {
      const controller = new AbortController(); controllers.push(controller);
      return fetch(new URL(`${path}${resume}`, server.url), {
        headers: { authorization: `Bearer ${f.key}` }, signal: controller.signal,
      });
    };
    const active: Response[] = [];
    for (let i = 0; i < 4; i++) {
      const response = await open();
      expect(response.status).toBe(200); active.push(response);
    }
    const limited = await open();
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "stream_limit_exceeded" });
    const readyReader = frames(must(must(active[0]).body));
    expect((await nextFrame(readyReader)).event).toBe("ready");
    const [activity] = await admin<{ idle: number }[]>`SELECT count(*)::int AS idle FROM pg_stat_activity
      WHERE datname = current_database() AND usename = 'bp_server' AND state LIKE 'idle in transaction%'`;
    expect(must(activity).idle).toBe(0);
    expect((await f.sql("INSERT INTO items (id) VALUES (1)")).status).toBe(200);
    must(controllers[0]).abort();
    await readyReader.return().catch(() => {});
    const [start] = await admin<{ at: Date }[]>`SELECT clock_timestamp() AS at`;
    let replacement: Response;
    while (true) {
      replacement = await open();
      if (replacement.status === 200) break;
      expect(replacement.status).toBe(429);
      const [clock] = await admin<{ expired: boolean }[]>`SELECT clock_timestamp() > ${must(start).at}::timestamptz + interval '2 seconds' AS expired`;
      expect(must(clock).expired).toBe(false);
      await replacement.arrayBuffer();
    }
    await must(replacement.body).cancel();
    for (const response of active.slice(1)) await must(response.body).cancel();
    for (const controller of controllers) controller.abort();
    const [cancelStart] = await admin<{ at: Date }[]>`SELECT clock_timestamp() AS at`;
    const reclaimed: Response[] = [];
    while (reclaimed.length < 4) {
      const probe = await open();
      if (probe.status === 200) reclaimed.push(probe);
      else { expect(probe.status).toBe(429); await probe.arrayBuffer(); }
      const [clock] = await admin<{ expired: boolean }[]>`SELECT clock_timestamp() > ${must(cancelStart).at}::timestamptz + interval '2 seconds' AS expired`;
      expect(must(clock).expired).toBe(false);
    }
    await Promise.all(reclaimed.map((response) => must(response.body).cancel()));
    const [backend] = await f.pool<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    const [pollStart] = await admin<{ at: Date }[]>`SELECT clock_timestamp() AS at`;
    let stableSince = must(pollStart).at;
    let lastQueryStart: Date | undefined;
    while (true) {
      const [activity] = await admin<{ query_start: Date; state: string; at: Date; expired: boolean }[]>`SELECT query_start, state,
        clock_timestamp() AS at, clock_timestamp() > ${must(pollStart).at}::timestamptz + interval '3 seconds' AS expired
        FROM pg_stat_activity WHERE pid = ${must(backend).pid}`;
      const current = must(activity);
      expect(current.expired).toBe(false);
      if (current.state !== "idle" || current.query_start.getTime() !== lastQueryStart?.getTime()) stableSince = current.at;
      lastQueryStart = current.query_start;
      if (current.at.getTime() - stableSince.getTime() >= 1100) break;
      await admin`SELECT pg_sleep(0.05)`;
    }

    const emit = async (count: number, bytes: number) => {
      const response = await app.handle(new Request(`http://localhost/api/v1/workspaces/${f.workspaceId}/stream-fixture`, {
        method: "POST", headers: { authorization: `Bearer ${f.key}`, "x-backplane-run": f.runId, "content-type": "application/json" },
        body: JSON.stringify({ count, bytes }),
      }));
      expect(response.status).toBe(200);
      return (await response.json() as { position: string }).position;
    };
    await emit(100, 20000);
    const parsed = must(parsePrincipalKey(`Bearer ${f.key}`));
    const access = { kind: "principal" as const, prefix: parsed.prefix, secretHash: hashPrincipalSecret(parsed.secret) };
    const snapshot = await auditSnapshot(f.pool, new StreamQueries(), new AbortController().signal, f.workspaceId, access,
      { after: must(initial).head, generation: must(initial).generation }, { data: true });
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) throw new Error(snapshot.error.error);
    expect(snapshot.frames.length).toBeGreaterThan(1);
    expect(snapshot.frames.length).toBeLessThan(100);
    expect(snapshot.frames.reduce((sum, frame) => sum + Buffer.byteLength(frame), 0)).toBeLessThanOrEqual(STREAM_BYTES);
    expect(snapshot.positions).toEqual(snapshot.positions.map((_, i) => String(BigInt(must(initial).head) + BigInt(i) + 1n)));
    const limits = { app: 64, workspace: 16, actor: 4 };
    expect(admitStream({ app: 64, workspace: 0, actor: 0 }, limits)).toBe(false);
    expect(admitStream({ app: 0, workspace: 16, actor: 0 }, limits)).toBe(false);
    expect(admitStream({ app: 0, workspace: 0, actor: 4 }, limits)).toBe(false);
    let admitted = 0;
    const queries = new StreamQueries();
    for (let i = 0; i < 4; i++) {
      expect(admitStream({ app: admitted, workspace: admitted, actor: admitted }, limits)).toBe(true);
      admitted++;
      const body = streamAudit(f.pool, queries, new Request(`http://localhost${path}`), f.workspaceId, access,
        snapshot, must(initial).head, () => { admitted--; }, { slowConsumerMs: 1000, accessIntervalMs: 100, dataIntervalMs: 50 });
      stalled.push(new Response(body));
    }
    expect(admitStream({ app: admitted, workspace: admitted, actor: admitted }, limits)).toBe(false);
    const [stallStart] = await admin<{ at: Date }[]>`SELECT clock_timestamp() AS at`;
    while (admitted > 0) {
      const [clock] = await admin<{ expired: boolean }[]>`SELECT clock_timestamp() > ${must(stallStart).at}::timestamptz + interval '2 seconds' AS expired`;
      expect(must(clock).expired).toBe(false);
      await admin`SELECT pg_sleep(0.025)`;
    }
    expect(admitted).toBe(0);
    for (const response of stalled) {
      const bytes = await response.arrayBuffer();
      expect(bytes.byteLength).toBeLessThanOrEqual(STREAM_BYTES);
      expect(new TextDecoder().decode(bytes)).toEndWith('event: error\ndata: {"error":"slow_consumer"}\n\n');
    }
    const [beforeLarge] = await f.pool<{ head: string }[]>`SELECT last_position::text AS head FROM audit.cursor WHERE workspace_id = ${f.workspaceId}`;
    await emit(1, 300000);
    const oversized = await app.handle(new Request(`http://localhost${path}?since=${must(beforeLarge).head}&generation=${must(initial).generation}`, {
      headers: { authorization: `Bearer ${f.key}` },
    }));
    expect(oversized.status).toBe(503);
    expect(await oversized.json()).toEqual({ error: "event_too_large" });
    const following = await auditSnapshot(f.pool, new StreamQueries(), new AbortController().signal, f.workspaceId, access,
      { after: must(beforeLarge).head, generation: must(initial).generation }, { data: true });
    expect(following).toEqual({ ok: false, error: { error: "event_too_large" } });
  } finally {
    for (const controller of controllers) controller.abort();
    await Promise.allSettled(stalled.filter((response) => !response.bodyUsed).map((response) => must(response.body).cancel()));
    await server.stop(true);
    await Promise.all([f.pool.close(), admin.close()]);
  }
}, 15_000);
