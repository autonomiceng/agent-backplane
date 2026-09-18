import { expect, test } from "bun:test";
import { SQL } from "bun";
import type { Principal } from "./create-principal.ts";
import type { PrincipalKeyMetadata } from "./principal-key-query.ts";
import { createPool } from "../platform/pool.ts";
import { withRunContext } from "../runs/with-run-context.ts";
import { adminUrl, migratedDatabase } from "../testing/postgres.ts";
import { createRun, issueKey, principalFixture } from "../testing/session.ts";

test("revocation misses active requests when the key authenticates or a new transaction still binds", async () => {
  const url = await migratedDatabase();
  const pool = createPool(url);
  const revoker = new SQL({ url, max: 1 });
  const agent = new SQL({ url, max: 1 });
  const admin = createPool(adminUrl(url));
  try {
    const { app, cookie, workspaceId, principalId } = await principalFixture(pool);
    const key = await issueKey(app, cookie, workspaceId, principalId);
    const principalUrl = `http://localhost/api/v1/workspaces/${workspaceId}/principals/${principalId}`;
    const context = { workspaceId, principalId, runId: await createRun(app, key, workspaceId) };
    expect(await withRunContext(pool, context, async () => "bound")).toBe("bound");
    const response = await app.handle(new Request(`${principalUrl}/revoke`, { method: "POST", headers: { origin: "http://localhost", cookie, "content-type": "application/json" } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ principalId, workspaceId, status: "revoked", effectsPausedThisRequest: 0 });
    const whoami = await app.handle(new Request(`http://localhost/api/v1/workspaces/${workspaceId}/whoami`, {
      headers: { authorization: `Bearer ${key}` },
    }));
    expect(whoami.status).toBe(401);
    await expect(withRunContext(pool, context, async () => "bound")).rejects.toMatchObject({ message: "principal_revoked" });
    const [user] = await pool`SELECT id FROM control."user"`;
    expect(await withRunContext(pool, { workspaceId, userId: user!.id }, async () => "bound")).toBe("bound");
    const second = await app.handle(new Request(`${principalUrl}/revoke`, { method: "POST", headers: { origin: "http://localhost", cookie, "content-type": "application/json" } }));
    expect(second.status).toBe(200);
    const issue = await app.handle(new Request(`${principalUrl}/keys`, { method: "POST", headers: { origin: "http://localhost", cookie, "content-type": "application/json" } }));
    expect(issue.status).toBe(409);
    expect(await issue.json()).toEqual({ error: "principal_revoked" });
    const metadata = await app.handle(new Request(`${principalUrl}/keys`, { headers: { cookie } }));
    expect((await metadata.json() as PrincipalKeyMetadata).revokedAt).not.toBeNull();
    const events = await pool`SELECT kind, user_id, objects FROM audit.events
      WHERE kind IN ('principal.key_issued', 'principal.revoked') ORDER BY position`;
    expect(events).toEqual([
      { kind: "principal.key_issued", user_id: user?.id, objects: [principalId] },
      { kind: "principal.revoked", user_id: user?.id, objects: [principalId] },
    ]);

    const created = await app.handle(new Request(`http://localhost/api/v1/workspaces/${workspaceId}/principals`, {
      method: "POST", headers: { origin: "http://localhost", cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Waiting Principal" }),
    }));
    expect(created.status).toBe(201);
    const waitingPrincipal = await created.json() as Principal;
    const waitingRunId = await createRun(app, await issueKey(app, cookie, workspaceId, waitingPrincipal.id), workspaceId);
    const [backend] = await agent`SELECT pg_backend_pid() AS pid`;
    const updated = Promise.withResolvers<void>();
    const commit = Promise.withResolvers<void>();
    const revocation = withRunContext(revoker, { workspaceId, userId: user!.id }, async (tx, emit) => {
      await tx`UPDATE control.principals SET status = 'revoked' WHERE workspace_id = ${workspaceId} AND id = ${waitingPrincipal.id}`;
      await tx`UPDATE control.principal_keys SET revoked_at = clock_timestamp()
        WHERE workspace_id = ${workspaceId} AND principal_id = ${waitingPrincipal.id}`;
      await emit("principal.revoked", [waitingPrincipal.id], 1, {});
      updated.resolve();
      await commit.promise;
    });
    let waiting: Promise<string> | undefined;
    try {
      await Promise.race([updated.promise, revocation]);
      waiting = withRunContext(agent, { workspaceId, principalId: waitingPrincipal.id, runId: waitingRunId }, async () => "bound");
      // Observe early failures while polling; the rejection assertion below still checks their cause.
      void waiting.catch(() => {});
      const deadline = Date.now() + 5000;
      let waitingPid: number | undefined;
      while (Date.now() < deadline) {
        const [waiter] = await admin`SELECT pid FROM pg_stat_activity
          WHERE datname = current_database() AND pid = ${backend?.pid}
            AND wait_event_type = 'Lock' AND query LIKE '%bind_context%'`;
        if (waiter) {
          waitingPid = waiter.pid;
          break;
        }
        await Bun.sleep(20);
      }
      expect(waitingPid).toBe(backend?.pid);
      expect(waitingPid).toBeDefined();
      commit.resolve();
      await revocation;
      await expect(waiting).rejects.toMatchObject({ message: "principal_revoked" });
    } finally {
      commit.resolve();
      await Promise.allSettled([revocation, waiting]);
    }
  } finally {
    await Promise.all([pool.close(), revoker.close(), agent.close(), admin.close()]);
  }
}, 10000);

test("revoking a system Principal returns principal_not_found without changing its status", async () => {
  const pool = createPool(await migratedDatabase());
  try {
    const { app, cookie, workspaceId } = await principalFixture(pool);
    const [principal] = await pool`SELECT id FROM control.principals WHERE workspace_id=${workspaceId} AND system='retention'`;
    const response = await app.handle(new Request(`http://localhost/api/v1/workspaces/${workspaceId}/principals/${principal.id}/revoke`, {
      method: "POST", headers: { cookie, origin: "http://localhost", "content-type": "application/json" },
    }));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "principal_not_found" });
    const [after] = await pool`SELECT status FROM control.principals WHERE workspace_id=${workspaceId} AND id=${principal.id}`;
    expect(after.status).toBe("active");
  } finally { await pool.close(); }
});
