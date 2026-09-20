import { expect, test } from "bun:test";
import { createPool } from "../platform/pool.ts";
import { adminUrl, migratedDatabase } from "../testing/postgres.ts";
import { testApp, signUp } from "../testing/session.ts";
import type { Workspace } from "./create-workspace.ts";

test("Workspace listing leaks other Organizations or retains removed membership across pages", async () => {
  const url = await migratedDatabase();
  const pool = createPool(url);
  const admin = createPool(adminUrl(url));
  try {
    const app = await testApp(pool);
    const cookie = await signUp(app, "owner@example.com");
    const otherCookie = await signUp(app, "other@example.com");
    const [other] = await pool`SELECT id FROM control."user" WHERE email = 'other@example.com'`;
    // Organization administration has no public API; these are identity-only fixtures in a disposable database.
    await admin`DROP INDEX control.organization_singleton`;
    await admin`INSERT INTO control.organization (id, name, slug, "createdAt") VALUES ('other', 'Other', 'other', now())`;
    await admin`INSERT INTO control.member (id, "organizationId", "userId", role, "createdAt")
      VALUES (${crypto.randomUUID()}, 'other', ${other.id}, 'member', now())`;
    const workspaces: Workspace[] = [];
    for (const name of ["Research", "Support"]) {
      const response = await app.handle(new Request("http://localhost/api/v1/workspaces", {
        method: "POST", headers: { cookie, origin: "http://localhost", "content-type": "application/json" },
        body: JSON.stringify({ name }),
      }));
      expect(response.status).toBe(201);
      workspaces.push(await response.json() as Workspace);
    }
    workspaces.sort((a, b) => a.id.localeCompare(b.id));
    const list = (session = cookie, query = "") => app.handle(new Request(`http://localhost/api/v1/workspaces${query}`, {
      headers: session ? { cookie: session } : {},
    }));
    expect((await list("")).status).toBe(401);
    const foreign = await list(otherCookie);
    expect(foreign.status).toBe(200);
    expect(await foreign.json()).toEqual({ items: [], nextCursor: null });
    const first = await list(cookie, "?limit=1");
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    const page = await first.json() as { items: Workspace[]; nextCursor: string };
    expect(page.items).toEqual([workspaces[0]!]);
    expect(page.nextCursor).toBeString();
    expect(await (await list(cookie, `?limit=1&after=${page.nextCursor}`)).json()).toEqual({ items: [workspaces[1]!], nextCursor: null });
    expect((await list(cookie, "?limit=101")).status).toBe(422);
    expect((await list(cookie, "?after=broken")).status).toBe(422);
    await admin`INSERT INTO control.member (id, "organizationId", "userId", role, "createdAt")
      VALUES (${crypto.randomUUID()}, 'default', ${other.id}, 'member', now())`;
    const joined = await (await list(otherCookie, "?limit=1")).json() as { items: Workspace[]; nextCursor: string };
    expect(joined.items).toEqual([workspaces[0]!]);
    await admin`DELETE FROM control.member WHERE "userId" = ${other.id} AND "organizationId" = 'default'`;
    expect(await (await list(otherCookie, `?limit=1&after=${joined.nextCursor}`)).json()).toEqual({ items: [], nextCursor: null });
    expect(await (await list(cookie)).json()).toEqual({ items: workspaces, nextCursor: null });
  } finally { await Promise.all([pool.close(), admin.close()]); }
});
