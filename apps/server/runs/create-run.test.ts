import { expect, test } from "bun:test";
import { Elysia, t } from "elysia";
import { createPool } from "../platform/pool.ts";
import { migratedDatabase } from "../testing/postgres.ts";
import { createRun, issueKey, principalFixture } from "../testing/session.ts";
import { runParams, type Run } from "./create-run-input.ts";
import { runSession } from "./run-session.ts";
import { withRunContext } from "./with-run-context.ts";

test("incorrect Run stamps accept foreign ownership or survive a failed creation transaction", async () => {
  const pool = createPool(await migratedDatabase());
  try {
    const { app, cookie, workspaceId, principalId } = await principalFixture(pool);
    const key = await issueKey(app, cookie, workspaceId, principalId);
    const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };
    const url = `http://localhost/api/v1/workspaces/${workspaceId}/runs`;
    const response = await app.handle(new Request(url, {
      method: "POST", headers, body: JSON.stringify({ harness: "Codex", model: "model", label: "test", metadata: { attempt: 1 } }),
    }));
    expect(response.status).toBe(201);
    const run = await response.json() as Run;
    expect(run).toMatchObject({ workspaceId, principalId, harness: "Codex", model: "model", label: "test", metadata: { attempt: 1 } });
    expect(await pool<{ principal_id: string; run_id: string; user_id: null; objects: string[]; row_count: string; metadata: string }[]>`SELECT principal_id, run_id, user_id, objects, row_count::text, metadata::text
      FROM audit.events WHERE kind = 'runs.created'`).toEqual([
      { principal_id: principalId, run_id: run.id, user_id: null, objects: [run.id], row_count: "1", metadata: "{}" },
    ]);
    const [persisted] = await pool`SELECT created_at, last_seen_at FROM control.runs WHERE id = ${run.id}`;
    expect(run.createdAt).toBe(persisted.created_at.toISOString());
    expect(run.lastSeenAt).toBe(persisted.last_seen_at.toISOString());

    const unexpected = await app.handle(new Request(url, { method: "POST", headers: { ...headers, "x-backplane-run": run.id }, body: "{}" }));
    expect(unexpected.status).toBe(400);
    expect(await unexpected.json()).toEqual({ error: "run_header_unexpected" });
    const unknownField = await app.handle(new Request(url, { method: "POST", headers, body: JSON.stringify({ principalId }) }));
    expect(unknownField.status).toBe(422);
    const invalidBody = await app.handle(new Request(url, { method: "POST", headers, body: JSON.stringify({ label: "x".repeat(257), metadata: [] }) }));
    expect(invalidBody.status).toBe(422);

    let rolledBackRun: string | null = null;
    await expect(withRunContext(pool, { workspaceId, principalId }, async (_tx, emit, runId) => {
      rolledBackRun = runId;
      expect(runId).toBeString();
      await emit("runs.created", [runId!], 1, {});
      throw new Error("forced_failure");
    }, { newRun: {} })).rejects.toThrow("forced_failure");
    expect(await pool`SELECT id FROM control.runs WHERE id = ${rolledBackRun}`).toHaveLength(0);
    expect(await pool`SELECT position FROM audit.events WHERE run_id = ${rolledBackRun}`).toHaveLength(0);
    expect(await pool`SELECT id FROM control.runs`).toHaveLength(1);

    const secondPrincipalResponse = await app.handle(new Request(`http://localhost/api/v1/workspaces/${workspaceId}/principals`, {
      method: "POST", headers: { origin: "http://localhost", cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Other Principal" }),
    }));
    expect(secondPrincipalResponse.status).toBe(201);
    const secondPrincipal = await secondPrincipalResponse.json() as { id: string };
    const secondKey = await issueKey(app, cookie, workspaceId, secondPrincipal.id);
    const foreignPrincipalRun = await createRun(app, secondKey, workspaceId);
    const secondWorkspaceResponse = await app.handle(new Request("http://localhost/api/v1/workspaces", {
      method: "POST", headers: { origin: "http://localhost", cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Other Workspace" }),
    }));
    expect(secondWorkspaceResponse.status).toBe(201);
    const secondWorkspace = await secondWorkspaceResponse.json() as { id: string };
    const foreignPrincipalResponse = await app.handle(new Request(`http://localhost/api/v1/workspaces/${secondWorkspace.id}/principals`, {
      method: "POST", headers: { origin: "http://localhost", cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Foreign Principal" }),
    }));
    expect(foreignPrincipalResponse.status).toBe(201);
    const foreignPrincipal = await foreignPrincipalResponse.json() as { id: string };
    const foreignKey = await issueKey(app, cookie, secondWorkspace.id, foreignPrincipal.id);
    const foreignWorkspaceRun = await createRun(app, foreignKey, secondWorkspace.id);
    const bound = new Elysia().use(runSession(pool)).post("/api/v1/workspaces/:workspaceId/write", async ({ run }) => {
      await withRunContext(pool, run, async (_tx, emit) => { await emit("test.write", [], 0, {}); });
      return run;
    }, {
      run: true, params: runParams,
      response: { 200: t.Object({ workspaceId: t.String(), principalId: t.String(), runId: t.String() }),
        400: t.Object({ error: t.String() }), 401: t.Object({ error: t.String() }),
        403: t.Object({ error: t.String() }), 503: t.Object({ error: t.String() }) },
      detail: { operationId: "testRunWrite" },
    });
    const writeUrl = `http://localhost/api/v1/workspaces/${workspaceId}/write`;
    for (const runId of [foreignPrincipalRun, foreignWorkspaceRun, crypto.randomUUID()]) {
      const rejected = await bound.handle(new Request(writeUrl, { method: "POST", headers: { ...headers, "x-backplane-run": runId } }));
      expect(rejected.status).toBe(403);
      expect(await rejected.json()).toEqual({ error: "run_forbidden" });
      await expect(pool`SELECT audit.bind_context(${workspaceId}, ${principalId}, ${runId}, NULL, ${crypto.randomUUID()})`.then())
        .rejects.toMatchObject({ message: "run_forbidden" });
    }
    const missing = await bound.handle(new Request(writeUrl, { method: "POST", headers }));
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: "run_required" });
    const malformed = await bound.handle(new Request(writeUrl, { method: "POST", headers: { ...headers, "x-backplane-run": "broken" } }));
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "run_invalid" });
    const repeatedHeaders = new Headers({ ...headers, "x-backplane-run": run.id });
    repeatedHeaders.append("x-backplane-run", run.id);
    const repeated = await bound.handle(new Request(writeUrl, { method: "POST", headers: repeatedHeaders }));
    expect(repeated.status).toBe(400);
    expect(await repeated.json()).toEqual({ error: "run_invalid" });
    const accepted = await bound.handle(new Request(writeUrl, { method: "POST", headers: { ...headers, "x-backplane-run": run.id.toUpperCase() } }));
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ workspaceId, principalId, runId: run.id });
    expect(await pool<{ principal_id: string; run_id: string; user_id: null }[]>`SELECT principal_id, run_id, user_id FROM audit.events WHERE kind = 'test.write'`).toEqual([
      { principal_id: principalId, run_id: run.id, user_id: null },
    ]);
    const [seen] = await pool`SELECT last_seen_at > ${persisted.last_seen_at} AS advanced FROM control.runs WHERE id = ${run.id}`;
    expect(seen.advanced).toBe(true);
    expect(await pool<{ kind: string }[]>`SELECT kind FROM audit.events WHERE run_id = ${run.id} ORDER BY position`)
      .toEqual([{ kind: "runs.created" }, { kind: "test.write" }]);
  } finally {
    await pool.close();
  }
});
