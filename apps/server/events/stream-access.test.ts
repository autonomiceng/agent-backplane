import { expect, test } from "bun:test";
import { createPool } from "../platform/pool.ts";
import { adminUrl, migratedDatabase } from "../testing/postgres.ts";
import { issueKey, principalFixture, signIn } from "../testing/session.ts";

function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("expected fixture value");
  return value;
}

test("a stream leaks a foreign Workspace or survives rotation, revocation, sign-out, session expiry, or membership removal", async () => {
  const url = await migratedDatabase();
  const pool = createPool(url);
  const admin = createPool(adminUrl(url));
  const controllers: AbortController[] = [];
  const bodies: ReadableStream<Uint8Array>[] = [];
  try {
    const { app, cookie, workspaceId, principalId } = await principalFixture(pool);
    let key = await issueKey(app, cookie, workspaceId, principalId);
    const eventsUrl = `http://localhost/api/v1/workspaces/${workspaceId}/events`;
    const open = async (headers: Record<string, string>, target = eventsUrl) => {
      const controller = new AbortController(); controllers.push(controller);
      const response = await app.handle(new Request(target, { headers, signal: controller.signal }));
      if (response.status === 200 && response.body) bodies.push(response.body);
      return response;
    };
    const user = await open({ cookie, "x-backplane-run": "ignored" });
    const principal = await open({ authorization: `Bearer ${key}` });
    expect(user.status).toBe(200);
    expect(principal.status).toBe(200);
    expect(await pool`SELECT id FROM control.runs`).toHaveLength(0);
    const other = await app.handle(new Request("http://localhost/api/v1/workspaces", {
      method: "POST", headers: { origin: "http://localhost", cookie, "content-type": "application/json" }, body: '{"name":"Other"}',
    }));
    expect(other.status).toBe(201);
    const otherId = (await other.json() as { id: string }).id;
    const foreign = await open({ authorization: `Bearer ${key}` }, `http://localhost/api/v1/workspaces/${otherId}/events`);
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toEqual({ error: "workspace_forbidden" });
    const bearer = await open({ authorization: "Bearer invalid", cookie });
    expect(bearer.status).toBe(401);
    expect(await bearer.json()).toEqual({ error: "unauthorized" });
    const signedOutText = user.text();
    // Leave the Principal body unread while its credential is withdrawn; timer checks must still close it.
    key = await issueKey(app, cookie, workspaceId, principalId);
    const revoked = await open({ authorization: `Bearer ${key}` });
    expect(revoked.status).toBe(200);
    const revoke = await app.handle(new Request(`http://localhost/api/v1/workspaces/${workspaceId}/principals/${principalId}/revoke`, {
      method: "POST", headers: { origin: "http://localhost", cookie, "content-type": "application/json" },
    }));
    expect(revoke.status).toBe(200);
    const memberCookie = await signIn(app);
    const member = await open({ cookie: memberCookie });
    expect(member.status).toBe(200);
    const [identity] = await admin<{ id: string }[]>`SELECT id FROM control."user" WHERE email = 'credentials@example.com'`;
    expect(identity).toBeDefined();
    const expiryCookie = await signIn(app);
    const expiring = await open({ cookie: expiryCookie });
    expect(expiring.status).toBe(200);
    const expiredText = expiring.text();
    const expirySession = await (await app.handle(new Request("http://localhost/api/auth/get-session", { headers: { cookie: expiryCookie } }))).json() as { session: { id: string } };
    const expiredSessions = await admin<{ id: string }[]>`UPDATE control.session
      SET "expiresAt" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 minute'
      WHERE id = ${expirySession.session.id} RETURNING id`;
    expect(expiredSessions).toHaveLength(1);
    // Better Auth's CSRF check (now pinned on in every environment) requires an Origin on cookie-bearing POSTs.
    const signedOut = await app.handle(new Request("http://localhost/api/auth/sign-out", {
      method: "POST", headers: { cookie, "content-type": "application/json", origin: "http://localhost" }, body: "{}",
    }));
    expect(signedOut.status).toBe(200);
    const [signout, expiry] = await Promise.all([signedOutText, expiredText]);
    await admin`DELETE FROM control.member WHERE "userId" = ${must(identity).id}`;
    const membership = await member.text();
    expect(expiry).toEndWith('event: error\ndata: {"error":"unauthorized"}\n\n');
    expect(signout).toEndWith('event: error\ndata: {"error":"unauthorized"}\n\n');
    expect(membership).toEndWith('event: error\ndata: {"error":"workspace_forbidden"}\n\n');
    const rotatedText = await principal.text();
    const revokedText = await revoked.text();
    expect(rotatedText).toStartWith("event: ready\n");
    expect(rotatedText).toEndWith('event: error\ndata: {"error":"unauthorized"}\n\n');
    expect(revokedText).toEndWith('event: error\ndata: {"error":"unauthorized"}\n\n');
    expect((await open({ authorization: `Bearer ${key}` })).status).toBe(401);
    expect((await open({ cookie: memberCookie })).status).toBe(403);
    expect((await open({ cookie })).status).toBe(401);
    expect(await pool`SELECT id FROM control.runs`).toHaveLength(0);
  } finally {
    for (const controller of controllers) controller.abort();
    await Promise.allSettled(bodies.filter((body) => !body.locked).map((body) => body.cancel()));
    await Promise.all([pool.close(), admin.close()]);
  }
}, 20_000);
