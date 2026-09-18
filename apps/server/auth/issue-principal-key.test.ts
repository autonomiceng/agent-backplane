import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createPool } from "../platform/pool.ts";
import { migratedDatabase } from "../testing/postgres.ts";
import { issueKey, principalFixture } from "../testing/session.ts";
import type { IssuedPrincipalKey } from "./issue-principal-key.ts";
import type { PrincipalKeyMetadata } from "./principal-key-query.ts";

test("plaintext key storage leaks credential material into rows, audit metadata or GET keys", async () => {
  const pool = createPool(await migratedDatabase());
  try {
    const { app, cookie, workspaceId, principalId } = await principalFixture(pool);
    const url = `http://localhost/api/v1/workspaces/${workspaceId}/principals/${principalId}/keys`;
    const empty = await app.handle(new Request(url, { headers: { cookie } }));
    expect(empty.status).toBe(200);
    expect(await empty.json()).toBeNull();
    const response = await app.handle(new Request(url, { method: "POST", headers: { origin: "http://localhost", cookie, "content-type": "application/json" } }));
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const credential = await response.json() as IssuedPrincipalKey;
    const secret = credential.key.split("_")[2]!;
    const hash = createHash("sha256").update(Buffer.from(secret, "hex")).digest("hex");
    const rows = await pool`SELECT encode(secret_hash, 'hex') AS hash FROM control.principal_keys`;
    expect(rows).toEqual([{ hash }]);
    const metadata = await app.handle(new Request(url, { headers: { cookie } }));
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toEqual({
      prefix: credential.prefix, createdAt: credential.createdAt, rotatedAt: null, lastUsedAt: null, revokedAt: null,
    });
    // A rejected issue request gives the persisted-secret assertion a rejection row to inspect too.
    const absent = await app.handle(new Request(`http://localhost/api/v1/workspaces/${workspaceId}/principals/${crypto.randomUUID()}/keys`, {
      method: "POST", headers: { origin: "http://localhost", cookie, "content-type": "application/json" },
    }));
    expect(absent.status).toBe(404);
    const stored = await pool`SELECT row_to_json(k)::text AS content FROM control.principal_keys k
      UNION ALL SELECT metadata::text FROM audit.events
      UNION ALL SELECT row_to_json(r)::text FROM audit.rejections r`;
    expect(await pool`SELECT id FROM audit.rejections`).toHaveLength(1);
    for (const row of stored) {
      expect(row.content).not.toContain(credential.key);
      expect(row.content).not.toContain(secret);
    }
  } finally {
    await pool.close();
  }
});

test("rotation failure preserves the first key or loses the single row and User-authored history", async () => {
  const pool = createPool(await migratedDatabase());
  try {
    const { app, cookie, workspaceId, principalId } = await principalFixture(pool);
    const first = await issueKey(app, cookie, workspaceId, principalId);
    const whoami = `http://localhost/api/v1/workspaces/${workspaceId}/whoami`;
    expect((await app.handle(new Request(whoami, { headers: { authorization: `Bearer ${first}` } }))).status).toBe(200);
    const keys = `http://localhost/api/v1/workspaces/${workspaceId}/principals/${principalId}/keys`;
    const used = await app.handle(new Request(keys, { headers: { cookie } }));
    expect(used.status).toBe(200);
    expect((await used.json() as PrincipalKeyMetadata).lastUsedAt).toBeString();
    const second = await issueKey(app, cookie, workspaceId, principalId);
    const rotated = await app.handle(new Request(keys, { headers: { cookie } }));
    expect(rotated.status).toBe(200);
    expect((await rotated.json() as PrincipalKeyMetadata).lastUsedAt).toBeNull();
    expect((await app.handle(new Request(whoami, { headers: { authorization: `Bearer ${first}` } }))).status).toBe(401);
    const current = await app.handle(new Request(whoami, { headers: { authorization: `Bearer ${second}` } }));
    expect(current.status).toBe(200);
    expect(await current.json()).toEqual({ principalId, workspaceId });
    const rows = await pool`SELECT prefix, rotated_at FROM control.principal_keys`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.prefix).toBe(second.split("_")[1]);
    expect(rows[0]?.rotated_at).toBeInstanceOf(Date);
    const [user] = await pool`SELECT id FROM control."user"`;
    const events = await pool`SELECT kind, user_id, principal_id, objects, metadata FROM audit.events
      WHERE kind IN ('principal.key_issued', 'principal.key_rotated') ORDER BY position`;
    expect(events).toEqual([
      { kind: "principal.key_issued", user_id: user?.id, principal_id: null, objects: [principalId], metadata: { prefix: first.split("_")[1] } },
      { kind: "principal.key_rotated", user_id: user?.id, principal_id: null, objects: [principalId], metadata: { prefix: second.split("_")[1] } },
    ]);
  } finally {
    await pool.close();
  }
});
