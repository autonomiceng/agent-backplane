import { expect, test } from "bun:test";
import { createPool } from "../platform/pool.ts";
import { migratedDatabase } from "../testing/postgres.ts";
import { createRun, issueKey, principalFixture } from "../testing/session.ts";
import type { AuditPage } from "./read-audit-input.ts";

test("payload leaks into envelopes or bigint positions lose their decimal representation", async () => {
  const pool = createPool(await migratedDatabase());
  try {
    const { app, cookie, workspaceId, principalId } = await principalFixture(pool);
    const key = await issueKey(app, cookie, workspaceId, principalId);
    const secret = "sk-secret-never-copy-to-audit";
    const created = await app.handle(new Request(`http://localhost/api/v1/workspaces/${workspaceId}/runs`, {
      method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ label: secret, metadata: { secret } }),
    }));
    expect(created.status).toBe(201);
    const before = await pool`SELECT id, last_seen_at FROM control.runs`;
    const response = await app.handle(new Request(`http://localhost/api/v1/workspaces/${workspaceId}/audit`, {
      headers: { authorization: `Bearer ${key}` },
    }));
    expect(response.status).toBe(200);
    const page = await response.json() as AuditPage;
    expect(page.events).toHaveLength(4);
    for (const event of page.events) {
      expect(Object.keys(event).sort()).toEqual([
        "kind", "metadata", "objects", "occurred_at", "position", "principal_id", "row_count", "run_id", "user_id",
      ]);
      expect(typeof event.position).toBe("string");
      expect(event.row_count).toBe("1");
      expect(event.occurred_at).toBe(new Date(event.occurred_at).toISOString());
      expect(typeof event.metadata).toBe("object");
      expect(event.metadata).not.toBeNull();
      expect(JSON.stringify(event.metadata)).not.toContain(secret);
    }
    expect(page.events.at(-1)?.metadata).toEqual({});
    expect(JSON.stringify(page)).not.toContain(secret);
    expect(await pool`SELECT id, last_seen_at FROM control.runs`).toEqual(before);
  } finally {
    await pool.close();
  }
});

test("cursor skips or duplicates events across pages, empty reads or a Run filter", async () => {
  const pool = createPool(await migratedDatabase());
  try {
    const { app, cookie, workspaceId, principalId } = await principalFixture(pool);
    const key = await issueKey(app, cookie, workspaceId, principalId);
    const headers = { authorization: `Bearer ${key}` };
    const url = `http://localhost/api/v1/workspaces/${workspaceId}/audit`;
    // Cross position 9 so ordering decimal text instead of the bigint column loses the first event.
    for (let i = 0; i < 5; i++) await createRun(app, key, workspaceId);
    const baseline = await app.handle(new Request(url, { headers }));
    expect(baseline.status).toBe(200);
    const after = (await baseline.json() as AuditPage).nextAfter;
    const runs: string[] = [];
    for (let i = 0; i < 5; i++) runs.push(await createRun(app, key, workspaceId));
    const firstResponse = await app.handle(new Request(`${url}?after=${after}&limit=3`, { headers }));
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json() as AuditPage;
    expect(first.events).toHaveLength(3);
    const secondResponse = await app.handle(new Request(`${url}?after=${first.nextAfter}&limit=3`, { headers }));
    expect(secondResponse.status).toBe(200);
    const second = await secondResponse.json() as AuditPage;
    expect(second.events).toHaveLength(2);
    const events = [...first.events, ...second.events];
    expect(events.map((event) => event.run_id)).toEqual(runs);
    expect(events.map((event) => event.position)).toEqual([1n, 2n, 3n, 4n, 5n].map((offset) => String(BigInt(after) + offset)));
    expect(first.nextAfter).toBe(first.events.at(-1)!.position);
    expect(second.nextAfter).toBe(second.events.at(-1)!.position);
    const emptyResponse = await app.handle(new Request(`${url}?after=${second.nextAfter}`, { headers }));
    expect(emptyResponse.status).toBe(200);
    expect(await emptyResponse.json()).toEqual({ events: [], nextAfter: second.nextAfter });
    const filtered = await app.handle(new Request(`${url}?runId=${runs[2]}&after=${after}`, { headers }));
    expect(filtered.status).toBe(200);
    expect(await filtered.json()).toEqual({ events: [events[2]], nextAfter: events[2]!.position });
    const invalidAfter = await app.handle(new Request(`${url}?after=-1`, { headers }));
    expect(invalidAfter.status).toBe(400);
    const overflowAfter = await app.handle(new Request(`${url}?after=9223372036854775808`, { headers }));
    expect(overflowAfter.status).toBe(400);
    const maxAfter = await app.handle(new Request(`${url}?after=9223372036854775807`, { headers }));
    expect(maxAfter.status).toBe(200);
    expect(await invalidAfter.json()).toEqual({ error: "invalid_query" });
    const invalidLimit = await app.handle(new Request(`${url}?limit=501`, { headers }));
    expect(invalidLimit.status).toBe(400);
    expect(await invalidLimit.json()).toEqual({ error: "invalid_query" });
    const invalidRun = await app.handle(new Request(`${url}?runId=broken`, { headers }));
    expect(invalidRun.status).toBe(400);
    expect(await invalidRun.json()).toEqual({ error: "invalid_query" });
  } finally {
    await pool.close();
  }
});
