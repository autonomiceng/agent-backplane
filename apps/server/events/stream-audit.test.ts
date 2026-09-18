import { expect, test } from "bun:test";
import { createPool } from "../platform/pool.ts";
import { adminUrl } from "../testing/postgres.ts";
import { applyMigration, createRun, migrationFixture } from "../testing/session.ts";
import type { AuditPage } from "./read-audit-input.ts";

function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("expected fixture value");
  return value;
}

async function* frames(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return;
      buffered += decoder.decode(next.value, { stream: true });
      let end: number;
      while ((end = buffered.indexOf("\n\n")) >= 0) {
        const frame = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        const lines = frame.split("\n");
        yield { event: lines.find((line) => line.startsWith("event: "))?.slice(7),
          id: lines.find((line) => line.startsWith("id: "))?.slice(4),
          data: JSON.parse(lines.find((line) => line.startsWith("data: "))?.slice(6) ?? "null") as
            AuditPage["events"][number] & { head: string; generation: string } };
      }
    }
  } finally { await reader.cancel(); }
}

async function nextFrame(stream: ReturnType<typeof frames>) {
  const next = await stream.next();
  if (next.done) throw new Error("stream ended before the expected frame");
  return next.value;
}

test("reconnect skips or duplicates committed events across batches and an in-flight lower writer", async () => {
  const f = await migrationFixture(3);
  const admin = createPool(adminUrl(f.url));
  const disconnects: AbortController[] = [];
  const server = Bun.serve({ port: 0, fetch: f.app.fetch, idleTimeout: 0 });
  try {
    await applyMigration(f.app, f.key, f.runId, f.workspaceId, "CREATE TABLE items (id int PRIMARY KEY)");
    const created = await f.app.handle(new Request(`http://localhost/api/v1/workspaces/${f.workspaceId}/queues`, {
      method: "POST", headers: { authorization: `Bearer ${f.key}`, "x-backplane-run": f.runId, "content-type": "application/json" },
      body: JSON.stringify({ name: "feed" }),
    }));
    expect(created.status).toBe(201);
    for (let i = 0; i < 105; i++) await createRun(f.app, f.key, f.workspaceId);
    const url = new URL(`/api/v1/workspaces/${f.workspaceId}/events`, server.url);
    const open = async (id?: string) => {
      const controller = new AbortController(); disconnects.push(controller);
      const response = await fetch(id ? `${url}?since=broken&generation=broken` : url, {
        headers: { authorization: `Bearer ${f.key}`, ...(id ? { "last-event-id": id } : {}) }, signal: controller.signal,
      });
      expect(response.status).toBe(200);
      return frames(must(response.body));
    };
    const first = await open();
    const ready = (await nextFrame(first));
    expect(ready.event).toBe("ready");
    const received: AuditPage["events"] = [];
    let lastId = must(ready.id);
    for (let i = 0; i < 101; i++) {
      const frame = (await nextFrame(first));
      expect(frame.event).toBe("audit");
      expect(frame.id).toBe(`v1:${f.workspaceId}:${ready.data.generation}:${frame.data.position}`);
      received.push(frame.data); lastId = must(frame.id);
    }
    await first.return();
    await createRun(f.app, f.key, f.workspaceId);
    const second = await open(lastId);
    expect((await second.next()).value?.id).toBe(lastId);
    const baselineResponse = await f.app.handle(new Request(`http://localhost/api/v1/workspaces/${f.workspaceId}/audit?limit=500`, {
      headers: { authorization: `Bearer ${f.key}` },
    }));
    expect(baselineResponse.status).toBe(200);
    const baseline = await baselineResponse.json() as AuditPage;
    while (received.length < baseline.events.length) {
      const frame = (await nextFrame(second));
      expect(frame.event).toBe("audit"); received.push(frame.data); lastId = must(frame.id);
    }
    expect(received).toEqual(baseline.events);
    await second.return();

    // The SQL and migration endpoints give up on a lock after 250 ms; queue send waits up to the 2 s default,
    // so an admin SHARE lock on queue.messages keeps a bound writer in flight for the whole observation window.
    const locked = Promise.withResolvers<void>();
    const unlock = Promise.withResolvers<void>();
    const blocker = admin.begin(async (tx) => {
      await tx`LOCK TABLE queue.messages IN SHARE MODE`;
      locked.resolve(); await unlock.promise;
    });
    let writer: Promise<Response> | undefined;
    let following: Promise<string> | undefined;
    const live = await open(lastId);
    expect((await live.next()).value?.data.head).toBe(baseline.nextAfter);
    try {
      await locked.promise;
      writer = f.app.handle(new Request(`http://localhost/api/v1/workspaces/${f.workspaceId}/queues/feed/messages`, {
        method: "POST", headers: { authorization: `Bearer ${f.key}`, "x-backplane-run": f.runId, "content-type": "application/json" },
        body: JSON.stringify({ idempotencyKey: "in-flight", payload: { task: "in-flight" } }),
      }));
      const [start] = await admin<{ at: Date }[]>`SELECT clock_timestamp() AS at`;
      let waiting = false;
      while (!waiting) {
        const [state] = await admin<{ waiting: boolean; expired: boolean }[]>`SELECT EXISTS (
          SELECT FROM pg_stat_activity WHERE datname = current_database() AND usename = 'bp_server'
            AND wait_event_type = 'Lock'
        ) AS waiting, clock_timestamp() > ${must(start).at}::timestamptz + interval '1 second' AS expired`;
        if (must(state).expired) throw new Error("HTTP writer never reached its table lock");
        waiting = must(state).waiting;
      }
      following = createRun(f.app, f.key, f.workspaceId);
      let premature = false;
      const next = nextFrame(live).then((frame) => { premature = true; return frame; });
      await admin`SELECT pg_sleep(1.05)`;
      expect(premature).toBe(false);
      unlock.resolve(); await blocker;
      expect((await writer)?.status).toBe(201);
      await following;
      const committed = await next;
      expect(committed.event).toBe("audit");
      expect(committed.data.kind).toBe("queue.send");
      expect(committed.data.position).toBe(String(BigInt(baseline.nextAfter) + 1n));
      received.push(committed.data);
      const complete = await f.app.handle(new Request(`http://localhost/api/v1/workspaces/${f.workspaceId}/audit?limit=500`, {
        headers: { authorization: `Bearer ${f.key}` },
      }));
      const expected = (await complete.json() as AuditPage).events;
      while (received.length < expected.length) received.push((await nextFrame(live)).data);
      expect(received).toEqual(expected);
    } finally {
      unlock.resolve(); await Promise.allSettled([blocker, writer, following]); await live.return();
    }
  } finally {
    for (const controller of disconnects) controller.abort();
    await server.stop(true);
    await Promise.all([f.pool.close(), admin.close()]);
  }
}, 30_000);
