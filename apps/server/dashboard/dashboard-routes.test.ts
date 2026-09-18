import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Elysia } from "elysia";
import { createApi } from "../../web/client/api.ts";
import { eventId, initialTimeline, reduceAudit, timelineEvents, type AuditEvent } from "../../web/client/audit-state.ts";
import { renderTimeline } from "../../web/testing/render-timeline.tsx";
import { createRun, sqlFixture } from "../testing/session.ts";
import { dashboardRoutes } from "./dashboard-routes.ts";

test("dashboard static wiring or Eden pagination includes another Run or misorders timeline rows", async () => {
  const f = await sqlFixture("CREATE TABLE items (id int PRIMARY KEY)");
  const root = await mkdtemp(join(tmpdir(), "bp-dashboard-"));
  try {
    await mkdir(join(root, "assets"));
    const html = '<!doctype html><div id="root"></div><script src="/dashboard/assets/app-123.js"></script>';
    await Bun.write(join(root, "index.html"), html);
    await Bun.write(join(root, "assets/app-123.js"), "window.dashboard = true;");
    // The fixture app already serves the production build under the same plugin name, so the temp build gets its own app.
    const app = new Elysia().use(dashboardRoutes(pathToFileURL(root + "/")));
    const get = (path: string) => app.handle(new Request(`http://localhost${path}`));
    const path = `/dashboard/workspaces/${f.workspaceId}/runs/${f.runId}`;
    const page = await get(path);
    expect(page.status).toBe(200);
    expect(await page.text()).toBe(html);
    expect(page.headers.get("cache-control")).toBe("no-cache");
    expect(await (await get("/dashboard")).text()).toBe(html);
    const asset = await get("/dashboard/assets/app-123.js");
    expect(await asset.text()).toBe("window.dashboard = true;");
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect((await get("/dashboard/assets/missing.js")).status).toBe(404);
    expect((await get("/dashboard/assets/index.html")).status).toBe(404);
    expect((await get("/dashboard/assets/nested/app.js")).status).toBe(404);
    expect((await get("/api/missing")).status).toBe(404);
    await rm(join(root, "index.html"));
    expect((await get(path)).status).toBe(503);

    const otherRun = await createRun(f.app, f.key, f.workspaceId);
    for (let i = 0; i < 12; i++) {
      expect((await f.sql("INSERT INTO items (id) VALUES ($1)", [i],
        { key: f.key, runId: i % 2 === 0 ? f.runId : otherRun })).status).toBe(200);
    }
    const fetcher: typeof fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      request.headers.set("cookie", f.cookie);
      return f.app.handle(request);
    }, { preconnect: fetch.preconnect });
    const api = createApi("http://localhost", fetcher);
    const events: AuditEvent[] = [];
    let after = "0";
    while (true) {
      const result = await api.api.v1.workspaces({ workspaceId: f.workspaceId }).audit.get({ query: { after, limit: 3 } });
      if (result.error) throw new Error(JSON.stringify(result.error));
      events.push(...result.data.events);
      if (result.data.events.length === 0) break;
      expect(BigInt(result.data.nextAfter)).toBeGreaterThan(BigInt(after));
      after = result.data.nextAfter;
    }
    expect(events.some((row) => row.run_id === otherRun)).toBe(true);
    const selected: AuditEvent[] = [];
    let selectedAfter = "0";
    while (true) {
      const result = await api.api.v1.workspaces({ workspaceId: f.workspaceId }).audit.get({
        query: { runId: f.runId, after: selectedAfter, limit: 3 },
      });
      if (result.error) throw new Error(JSON.stringify(result.error));
      selected.push(...result.data.events);
      if (result.data.events.length === 0) break;
      selectedAfter = result.data.nextAfter;
    }
    let state = initialTimeline(f.workspaceId, f.runId);
    const snapshot = { generation: "generation", after: "0", head: after, retentionFloor: "0" };
    state = reduceAudit(state, { type: "history", epoch: 0, snapshot, events: events.toReversed() }).state;
    state = reduceAudit(state, { type: "ready", epoch: 0, ready: { ...snapshot, after },
      id: eventId(f.workspaceId, snapshot.generation, after) }).state;
    const rows = timelineEvents(state).map(([, event]) => event);
    expect(rows).toEqual(selected);
    expect(rows.filter((event) => event.kind === "sql.execute")).toHaveLength(6);
    const markup = renderTimeline(state);
    expect([...markup.matchAll(/data-position="([0-9]+)"/g)].map((match) => match[1])).toEqual(selected.map((event) => event.position));
    expect(markup).toContain("<details><summary>Metadata</summary>");
    expect(markup).not.toContain("<details open");
    expect(markup).toContain(selected[0]?.occurred_at ?? "missing timestamp");
  } finally { try { await f.pool.close(); } finally { await rm(root, { recursive: true, force: true }); } }
});
