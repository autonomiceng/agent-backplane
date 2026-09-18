import { expect, jest, test } from "bun:test";
import { eventId, timelineEvents, type AuditEvent, type TimelineState } from "./audit-state.ts";
import { subscribeAudit } from "./audit-stream.ts";

test("adapter reconnect loses the Workspace cursor, duplicates sources or events, or publishes after unsubscribe", async () => {
  jest.useFakeTimers();
  const workspaceId = "11111111-1111-4111-8111-111111111111";
  const generation = "22222222-2222-4222-8222-222222222222";
  const runId = "33333333-3333-4333-8333-333333333333";
  const id = (position: string) => eventId(workspaceId, generation, position);
  const ready = (after: string, head = after) => ({ generation, after, head, retentionFloor: "0" });
  const event = (position: string): AuditEvent => ({
    position, run_id: runId, kind: "sql.execute", objects: ["items"], row_count: "1",
    occurred_at: "2026-09-14T00:00:00.000Z", principal_id: null, user_id: null, metadata: { a: 1, b: { c: 2 } },
  });
  const sources: FakeEventSource[] = [];
  let opening = Promise.withResolvers<FakeEventSource>();
  class FakeEventSource extends EventTarget {
    closed = false;
    constructor(readonly url: URL) {
      super();
      sources.push(this);
      opening.resolve(this);
    }
    close() { this.closed = true; }
    frame(type: string, data: unknown, lastEventId: string) {
      this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data), lastEventId }));
    }
  }
  const probes: Request[] = [];
  const fetcher: typeof fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname.endsWith("/audit")) {
      return Response.json({ events: [event("1")], nextAfter: "1" });
    }
    probes.push(request);
    const after = request.headers.get("Last-Event-ID")?.split(":").at(-1) ?? "0";
    return new Response(`event: ready\nid: ${id(after)}\ndata: ${JSON.stringify(ready(after, after === "0" ? "1" : after))}\n\n`,
      { headers: { "content-type": "text/event-stream" } });
  }, { preconnect: fetch.preconnect });
  const published: TimelineState[] = [];
  let unsubscribe = () => {};
  try {
    unsubscribe = subscribeAudit("http://localhost", workspaceId, runId, (state) => published.push(state),
      { fetch: fetcher, EventSource: FakeEventSource as unknown as typeof EventSource });
    const first = await opening.promise;
    expect(first.url.searchParams.get("since")).toBe("1");
    first.frame("ready", ready("1"), id("1"));
    first.frame("audit", event("2"), id("2"));
    first.frame("audit", { ...event("3"), run_id: "other" }, id("3"));
    jest.advanceTimersByTime(50);
    expect(published.at(-1)?.resumeId).toBe(id("3"));

    opening = Promise.withResolvers<FakeEventSource>();
    jest.advanceTimersByTime(20000);
    first.frame("heartbeat", {}, id("3"));
    jest.advanceTimersByTime(20000);
    expect(first.closed).toBe(false);
    first.frame("audit", { ...event("3"), run_id: "other" }, id("3"));
    jest.advanceTimersByTime(29999);
    expect(first.closed).toBe(false);
    jest.advanceTimersByTime(51);
    expect(published.at(-1)?.phase).not.toBe("live");
    first.dispatchEvent(new Event("error"));
    expect(first.closed).toBe(true);
    jest.advanceTimersByTime(1000);
    const replacement = await opening.promise;
    expect(probes).toHaveLength(2);
    expect(probes[1]?.headers.get("Last-Event-ID")).toBe(id("3"));
    expect(replacement.url.searchParams.get("since")).toBe("3");
    expect(replacement.url.searchParams.get("generation")).toBe(generation);
    expect(sources).toHaveLength(2);
    expect(sources.filter((source) => !source.closed)).toEqual([replacement]);
    replacement.frame("ready", ready("3"), id("3"));
    replacement.frame("audit", { ...event("2"), metadata: { b: { c: 2 }, a: 1 } }, id("2"));
    jest.advanceTimersByTime(50);
    const live = published.at(-1);
    if (!live) throw new Error("timeline was not published");
    expect(live.error).toBeNull();
    expect(live.phase).toBe("live");
    expect(timelineEvents(live).map(([, row]) => row.position)).toEqual(["1", "2"]);

    replacement.frame("audit", event("4"), id("4"));
    const count = published.length;
    unsubscribe();
    expect(replacement.closed).toBe(true);
    first.frame("audit", event("5"), id("5"));
    replacement.frame("audit", event("5"), id("5"));
    replacement.dispatchEvent(new Event("error"));
    jest.advanceTimersByTime(60000);
    expect(published).toHaveLength(count);
    expect(sources).toHaveLength(2);
    expect(probes).toHaveLength(2);
  } finally { unsubscribe(); jest.useRealTimers(); }
});


test("invocation scope denial ends streaming without retrying", async () => {
  let calls = 0;
  const published = Promise.withResolvers<TimelineState>();
  const fetcher: typeof fetch = Object.assign(async () => {
    calls++;
    return Response.json({ error: "invocation_scope_forbidden" }, { status: 403 });
  }, { preconnect: fetch.preconnect });
  const unsubscribe = subscribeAudit("http://localhost", "workspace", "run", state => { if (state.error) published.resolve(state); },
    { fetch: fetcher, EventSource: class extends EventTarget {} as unknown as typeof EventSource });
  try {
    expect((await published.promise).error).toBe("invocation_scope_forbidden");
    await Bun.sleep(1100);
    expect(calls).toBe(1);
  } finally { unsubscribe(); }
});
