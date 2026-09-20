// Upgrade proof uses historical control rows with bound provenance; no Workspace or queue writes.
import { expect, test } from "bun:test";
import { loadMigrations, migrate } from "../../db/migrations.ts";
import { sqlMigrationRunner } from "../../db/sql-migration-runner.ts";
import { createPool } from "../../apps/server/platform/pool.ts";
import { adminUrl, migratedDatabase } from "../../apps/server/testing/postgres.ts";
import { createRun, issueKey, principalFixture, testApp } from "../../apps/server/testing/session.ts";
import { withRunContext } from "../../apps/server/runs/with-run-context.ts";
import { compatibilityDate, configHash, sha256 } from "../../apps/server/compute/deployment-config.ts";
import type { ComputeLauncher } from "../../apps/server/compute/compute-launcher.ts";

test("migration 33 preserves a stored active legacy deployment and its audit while refusing execution", async () => {
  const url = await migratedDatabase(undefined, 32), pool = createPool(url), admin = createPool(adminUrl(url));
  try {
    const fixture = await principalFixture(pool);
    const { workspaceId, principalId, cookie } = fixture;
    const key = await issueKey(fixture.app, cookie, workspaceId, principalId);
    const runId = await createRun(fixture.app, key, workspaceId);
    const id = crypto.randomUUID(), runtimeDigest = "a".repeat(64);
    const bundle = 'export default { fetch() { return Response.json({ok:true}); } };';
    const hash = configHash({ version: 1, workspaceId, functionName: "legacy", id, bundle, bundleSha256: sha256(bundle),
      entryPoint: "default", compatibilityDate, outboundUrls: [], keyRef: { workspaceId, principalId }, runtimeDigest });
    await withRunContext(pool, { workspaceId, principalId, runId }, async (tx, emit) => {
      await tx`INSERT INTO control.functions (workspace_id, name) VALUES (${workspaceId}, 'legacy')`;
      await tx`INSERT INTO control.deployments (workspace_id, function_name, id, bundle, entry_point,
        compatibility_date, outbound_urls, config_hash, runtime_digest) VALUES (${workspaceId}, 'legacy', ${id}, ${Buffer.from(bundle)},
        'default', ${compatibilityDate}, ${tx.array([], "TEXT")}, ${Buffer.from(hash, "hex")}, ${runtimeDigest})`;
      await emit("function.deploy", ["legacy", id], 1, { runtimeDigest, configHash: hash });
      await tx`UPDATE control.deployments SET status = 'active' WHERE workspace_id = ${workspaceId} AND id = ${id}`;
      await emit("function.activate", ["legacy", id], 1, { deploymentId: id, previousActiveId: null });
    });
    const original = await pool`SELECT * FROM control.deployments WHERE workspace_id = ${workspaceId} AND id = ${id}`;
    const history = await pool`SELECT * FROM audit.events WHERE workspace_id = ${workspaceId} AND kind LIKE 'function.%' ORDER BY position`;
    expect(await migrate(sqlMigrationRunner(admin), await loadMigrations(new URL("../../db/migrations", import.meta.url).pathname))).toEqual([33]);
    let preparations = 0, invocations = 0;
    const compute: ComputeLauncher = { runtimeDigest: `workerd-binary-sha256:${runtimeDigest}`,
      async verify() { return { runtimeDigest: "workerd-binary-sha256:" + "a".repeat(64), controlHash: "b".repeat(64), artifact: { source: "host-declared", reference: "fixture:local", hostObservedImageId: null } }; },
      async prepare() { preparations++; throw Error("legacy deployment must not reach preparation"); },
      async invoke() { invocations++; throw Error("legacy deployment must not reach dispatch"); } };
    const app = await testApp(pool, { compute });
    const headers = { authorization: `Bearer ${key}`, "x-backplane-run": runId, "content-type": "application/json" };
    const base = `http://localhost/api/v1/workspaces/${workspaceId}/functions/legacy`;
    const post = (path: string, body: unknown) => app.handle(new Request(base + path, { method: "POST", headers, body: JSON.stringify(body) }));
    const read = await app.handle(new Request(`${base}/deployments/${id}`, { headers }));
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ id, principalId, runId, runtimeDigest, configHash: hash, status: "active" });
    for (const [path, body] of [[`/deployments/${id}/activate`, { expectedActiveId: id }], ["/invoke", { input: null }]] as const) {
      const refused = await post(path, body);
      expect([refused.status, await refused.json()]).toEqual([503, { error: "compute_unavailable" }]);
    }
    expect([preparations, invocations]).toEqual([0, 0]);
    expect(await pool<{ kind: string; reason: string; principal_id: string; run_id: string }[]>`SELECT kind, reason, principal_id, run_id FROM audit.rejections WHERE workspace_id = ${workspaceId} ORDER BY id`)
      .toEqual(["function.activate", "function.invoke"].map(kind => ({ kind, reason: "compute_unavailable", principal_id: principalId, run_id: runId })));
    expect(await pool`SELECT * FROM control.deployments WHERE workspace_id = ${workspaceId} AND id = ${id}`).toEqual(original);
    expect(await pool`SELECT * FROM audit.events WHERE workspace_id = ${workspaceId} AND kind LIKE 'function.%' ORDER BY position`).toEqual(history);
    const nextId = crypto.randomUUID();
    expect((await post("/deployments", { id: nextId, bundle, entryPoint: "default", outboundUrls: [] })).status).toBe(201);
    expect(await pool<{ runtime_digest: string }[]>`SELECT runtime_digest FROM control.deployments WHERE workspace_id = ${workspaceId} AND id = ${nextId}`)
      .toEqual([{ runtime_digest: compute.runtimeDigest }]);
    expect(await pool`SELECT * FROM control.deployments WHERE workspace_id = ${workspaceId} AND id = ${id}`).toEqual(original);
  } finally { await pool.close(); await admin.close(); }
});
