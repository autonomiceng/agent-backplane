import { afterEach, describe, expect, test } from "bun:test";
import { testApp } from "../testing/session.ts";
import { adminUrl, emptyDatabase, migratedDatabase } from "../testing/postgres.ts";
import { createPool, poolSnapshot, type Pool } from "./pool.ts";
import { readOperationsConfig } from "./operations.ts";
import type { Readiness } from "./readiness.ts";

const pools: Pool[] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.close({ timeout: 1 })));
});

async function ready(url: string): Promise<{ status: number; body: Readiness }> {
  const pool = createPool(url);
  pools.push(pool);
  const res = await (await testApp(pool, { operations: readOperationsConfig({ BP_OPERATIONS_TOKEN: "test" }) })).handle(new Request("http://localhost/health/ready", { headers: { authorization: "Bearer test" } }));
  return { status: res.status, body: (await res.json()) as Readiness };
}

describe("GET /health/ready", () => {
  test("an unreachable database answers 503 and names the cause", async () => {
    const { status, body } = await ready("postgres://nobody:nothing@127.0.0.1:1/none");
    expect(status).toBe(503);
    expect(body.status).toBe("not_ready");
    expect(body.problems[0]!).toStartWith("database unavailable:");
  });

  test("a database without pgmq or protected schemas answers 503 listing each gap", async () => {
    const { status, body } = await ready(await emptyDatabase());
    expect(status).toBe(503);
    expect(body.postgres.major).toBe(18);
    expect(body.pgmq).toEqual({ compatible: false, version: null });
    expect(body.problems).toContain("protected schema control missing");
  });

  test("a superuser runtime is refused while bp_server answers ready", async () => {
    const url = await migratedDatabase();
    const admin = await ready(adminUrl(url));
    expect(admin.status).toBe(503);
    expect(admin.body.problems).toEqual(["runtime role is superuser"]);
    const { status, body } = await ready(url);
    expect(body.runtimeRole).toEqual({ name: "bp_server", superuser: false });
    expect(status).toBe(200);
    expect(body).toMatchObject({ status: "ready", postgres: { major: 18 }, pgmq: { compatible: true, version: "1.12.0" } });
  });
});

test("concurrent readiness requests share one probe and refresh a completed failure after the cache TTL", async () => {
  const url = await migratedDatabase(), pool = createPool(url), admin = createPool(adminUrl(url));
  pools.push(pool, admin);
  const app = await testApp(pool);
  const request = () => app.handle(new Request("http://localhost/health/ready"));
  await admin.begin(async tx => {
    await tx`LOCK TABLE control.schema_version IN ACCESS EXCLUSIVE MODE`;
    const pending = Array.from({ length: 6 }, () => request());
    const deadline = performance.now() + 1000;
    while (performance.now() < deadline) {
      const [blocked] = await admin`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND usename = 'bp_server' AND wait_event_type = 'Lock'`;
      if (blocked.n > 0) break;
      await Bun.sleep(10);
    }
    expect(poolSnapshot(pool)).toEqual({ inUse: 1, waiting: 0 });
    const responses = await Promise.all(pending);
    expect(responses.map(response => response.status)).toEqual([503, 503, 503, 503, 503, 503]);
    expect(poolSnapshot(pool)).toEqual({ inUse: 0, waiting: 0 });
    for (const response of responses) expect((await response.json()).problems).toContain("database_unavailable");
  });
  const cached = await request();
  expect(cached.status).toBe(503);
  expect(cached.headers.get("cache-control")).toBe("no-store");
  await Bun.sleep(1100);
  expect((await request()).status).toBe(200);
}, 10000);
