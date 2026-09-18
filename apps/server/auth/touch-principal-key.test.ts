import { expect, test } from "bun:test";
import type { PrincipalKeyMetadata } from "./principal-key-query.ts";
import { createPool } from "../platform/pool.ts";
import { adminUrl, migratedDatabase } from "../testing/postgres.ts";
import { issueKey, principalFixture } from "../testing/session.ts";

test("last-use is missing or written on every authenticated request", async () => {
  const url = await migratedDatabase();
  const pool = createPool(url);
  const admin = createPool(adminUrl(url));
  try {
    const { app, cookie, workspaceId, principalId } = await principalFixture(pool);
    const key = await issueKey(app, cookie, workspaceId, principalId);
    const whoami = `http://localhost/api/v1/workspaces/${workspaceId}/whoami`;
    const headers = { authorization: `Bearer ${key}` };
    expect((await app.handle(new Request(whoami, { headers }))).status).toBe(200);
    const [first] = await pool`SELECT last_used_at::text AS used FROM control.principal_keys`;
    expect(first?.used).not.toBeNull();
    expect((await app.handle(new Request(whoami, { headers }))).status).toBe(200);
    const [second] = await pool`SELECT last_used_at::text AS used FROM control.principal_keys`;
    expect(second?.used).toBe(first?.used);
    await admin`UPDATE control.principal_keys SET last_used_at = clock_timestamp() - interval '2 minutes'`;
    expect((await app.handle(new Request(whoami, { headers }))).status).toBe(200);
    const [third] = await pool`SELECT last_used_at::text AS used FROM control.principal_keys`;
    expect(third?.used > first?.used).toBe(true);
    const metadata = await app.handle(new Request(`http://localhost/api/v1/workspaces/${workspaceId}/principals/${principalId}/keys`, { headers: { cookie } }));
    expect((await metadata.json() as PrincipalKeyMetadata).lastUsedAt).toBe(new Date(third!.used).toISOString());
    const events = await pool`SELECT kind FROM audit.events ORDER BY position`;
    expect(events).toEqual([{ kind: "workspace.created" }, { kind: "principal.created" }, { kind: "principal.key_issued" }]);
  } finally {
    await Promise.all([pool.close(), admin.close()]);
  }
});
