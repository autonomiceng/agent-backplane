import { afterEach, describe, expect, test } from "bun:test";
import { testApp } from "../testing/session.ts";
import { adminUrl, emptyDatabase, migratedDatabase } from "../testing/postgres.ts";
import { createPool, type Pool } from "./pool.ts";
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
