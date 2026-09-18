import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPool } from "../../../apps/server/platform/pool.ts";
import { migratedDatabase } from "../../../apps/server/testing/postgres.ts";
import { issueKey, principalFixture, transactionFixture } from "../../../apps/server/testing/session.ts";
import type { Claim } from "../../../apps/server/queue/claim-input.ts";
import type { SqlResponse } from "../../../apps/server/sql/execute-sql-input.ts";
import type { AuditPage } from "../../../apps/server/events/read-audit-input.ts";
import type { TransactionResponse } from "../../../apps/server/tx/execute-transaction-input.ts";
import type { Environment } from "./credentials.ts";
import { execute } from "./execute.ts";

async function body<T = { id: string }>(response: Response, status = 200): Promise<T> {
  const value: unknown = await response.json();
  expect({ status: response.status, ...(response.status === status ? {} : { body: value }) }).toEqual({ status });
  return value as T;
}
function client(env: Environment, now = Date.now) {
  const outputs: string[] = [];
  return { outputs, async run(argv: string[], input = "", overrides: Environment = {}) {
    let stdout = "", stderr = "";
    const code = await execute(argv, { env: { ...env, ...overrides }, now, stdin: async () => input,
      stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } });
    outputs.push(stdout, stderr);
    return { code, stdout, stderr };
  } };
}
async function entries(directory: string) {
  const folder = join(directory, "cli", "runs");
  const files = await readdir(folder);
  return Promise.all(files.filter((name) => name.endsWith(".json")).map(async (name) => {
    const path = join(folder, name);
    const value = JSON.parse(await readFile(path, "utf8")) as { id: string; principalId: string; workspaceId: string; lastUsedAt: number };
    return { path, value };
  }));
}

test("CLI reuses a Run across identities, Workspaces, sessions, idle expiry or key rotation, or replaces it for revoked credentials", async () => {
  const pool = createPool(await migratedDatabase());
  const f = await principalFixture(pool);
  const directory = await mkdtemp(join(tmpdir(), "bp-cli-runs-"));
  let now = Date.now();
  try {
    f.app.listen({ hostname: "localhost", port: 0 });
    const url = `http://localhost:${f.app.server!.port}`, key = await issueKey(f.app, f.cookie, f.workspaceId, f.principalId);
    const env = { BP_URL: url, BP_KEY: key, BP_WORKSPACE_ID: f.workspaceId, BP_DATA_DIR: directory, BP_HARNESS: "test", BP_MODEL: "test-model", BP_RUN_LABEL: "cli" };
    const cli = client(env, () => now), keys = [key];
    const runs = () => pool<{ id: string; principal_id: string; workspace_id: string; harness: string; model: string; label: string }[]>`SELECT * FROM control.runs ORDER BY id`;
    const create = async (name: string, overrides: Environment = {}) => {
      const result = await cli.run(["queue", "create-queue", "--body", "-"], JSON.stringify({ name }), overrides);
      expect(result).toMatchObject({ code: 0, stderr: "" });
      const workspaceId = overrides.BP_WORKSPACE_ID ?? f.workspaceId;
      const [event] = await pool<{ run_id: string; principal_id: string }[]>`SELECT run_id, principal_id FROM audit.events
        WHERE workspace_id = ${workspaceId} AND kind = 'queue.created' ORDER BY position DESC LIMIT 1`;
      expect(event).toBeDefined();
      return event!.run_id;
    };
    expect((await cli.run(["--help"])).code).toBe(0);
    expect((await cli.run(["auth", "whoami"])).code).toBe(0);
    expect((await cli.run(["transaction", "--body", "-"], "invalid")).code).toBe(2);
    expect(await runs()).toHaveLength(0);
    const first = await Promise.all([
      cli.run(["queue", "create-queue", "--body", "-"], '{"name":"first"}'),
      cli.run(["queue", "create-queue", "--body", "-"], '{"name":"concurrent"}'),
    ]);
    expect(first.map((r) => [r.code, r.stderr])).toEqual([[0, ""], [0, ""]]);
    const initial = (await runs())[0]!;
    expect(await runs()).toHaveLength(1);
    expect(initial).toMatchObject({ workspace_id: f.workspaceId, principal_id: f.principalId, harness: "test", model: "test-model", label: "cli" });
    expect(await pool<{ run_id: string }[]>`SELECT DISTINCT run_id FROM audit.events WHERE kind = 'queue.created'`).toEqual([{ run_id: initial.id }]);
    expect(await create("reuse", { BP_URL: `${url}/` })).toBe(initial.id);
    const empty = await cli.run(["queue", "claim-message", "--queue", "first"]);
    expect(empty).toEqual({ code: 0, stdout: "null\n", stderr: "" });
    const sessionRun = await create("session", { BP_SESSION: "second" });
    expect(sessionRun).not.toBe(initial.id);
    const userPost = (path: string, value: unknown) => f.app.handle(new Request(`http://localhost/api/v1${path}`, {
      method: "POST", headers: { origin: "http://localhost", cookie: f.cookie, "content-type": "application/json" }, body: JSON.stringify(value),
    }));
    const principal = await body(await userPost(`/workspaces/${f.workspaceId}/principals`, { name: "Other" }), 201);
    const otherKey = await issueKey(f.app, f.cookie, f.workspaceId, principal.id); keys.push(otherKey);
    const otherRun = await create("other", { BP_KEY: otherKey });
    expect(otherRun).not.toBe(initial.id);
    expect((await runs()).find((r) => r.id === otherRun)?.principal_id).toBe(principal.id);
    expect((await entries(directory)).map((e) => e.value.id).sort()).toEqual([initial.id, sessionRun, otherRun].sort());
    const workspace = await body(await userPost("/workspaces", { name: "Other Workspace" }), 201);
    const workspacePrincipal = await body(await userPost(`/workspaces/${workspace.id}/principals`, { name: "Other Workspace Principal" }), 201);
    const workspaceKey = await issueKey(f.app, f.cookie, workspace.id, workspacePrincipal.id); keys.push(workspaceKey);
    const beforeWorkspace = await runs();
    const wrongWorkspace = await cli.run(["queue", "create-queue", "--workspace-id", workspace.id, "--body", "-"], '{"name":"forbidden"}');
    expect(JSON.parse(wrongWorkspace.stderr)).toMatchObject({ error: "workspace_forbidden", status: 403 });
    expect(wrongWorkspace.code).toBe(1); expect(await runs()).toEqual(beforeWorkspace);
    const workspaceRun = await create("workspace", { BP_KEY: workspaceKey, BP_WORKSPACE_ID: workspace.id });
    expect((await runs()).find((r) => r.id === workspaceRun)).toMatchObject({ principal_id: workspacePrincipal.id, workspace_id: workspace.id });
    now += 23 * 60 * 60 * 1000; expect(await create("idle-touch")).toBe(initial.id);
    now += 23 * 60 * 60 * 1000; expect(await create("idle-renewed")).toBe(initial.id);
    now += 24 * 60 * 60 * 1000;
    const expired = await create("expired"); expect(expired).not.toBe(initial.id);
    const rotated = await issueKey(f.app, f.cookie, f.workspaceId, f.principalId); keys.push(rotated);
    const rotatedRun = await create("rotated", { BP_KEY: rotated }); expect(rotatedRun).not.toBe(expired);
    const rotatedEntry = (await entries(directory)).find((e) => e.value.id === rotatedRun)!;
    const cached = JSON.parse(await readFile(rotatedEntry.path, "utf8")) as Record<string, unknown>;
    await writeFile(rotatedEntry.path, JSON.stringify({ ...cached, fingerprint: "changed-secret-fingerprint" }));
    const fingerprintRun = await create("fingerprint", { BP_KEY: rotated }); expect(fingerprintRun).not.toBe(rotatedRun);
    const poisoned = (await entries(directory)).find((e) => e.value.id === fingerprintRun)!;
    await writeFile(poisoned.path, JSON.stringify({ ...poisoned.value, id: otherRun }));
    const forbidden = await fetch(`${url}/api/v1/workspaces/${f.workspaceId}/queues`, {
      method: "POST", headers: { authorization: `Bearer ${rotated}`, "x-backplane-run": otherRun, "content-type": "application/json" }, body: '{"name":"poisoned"}',
    });
    expect(await body<{ error: string }>(forbidden, 403)).toEqual({ error: "run_forbidden" });
    const beforeRecovery = (await runs()).length;
    const recovered = await create("recovered", { BP_KEY: rotated });
    expect(recovered).not.toBe(otherRun); expect((await runs()).length).toBe(beforeRecovery + 1);
    expect((await entries(directory)).find((e) => e.path === poisoned.path)?.value.id).toBe(recovered);
    const explicit = await cli.run(["run", "new", "--body", "-"], JSON.stringify({ label: rotated }), { BP_KEY: rotated });
    expect(explicit.code).toBe(0);
    const explicitRun = JSON.parse(explicit.stdout) as { id: string; label: string };
    expect(explicitRun.label).toBe("[REDACTED]"); expect(explicitRun.id).not.toBe(recovered);
    expect(await create("explicit-reuse", { BP_KEY: rotated })).toBe(explicitRun.id);
    await body(await userPost(`/workspaces/${f.workspaceId}/principals/${f.principalId}/revoke`, {}));
    const beforeRevoked = await runs(), cacheBefore = await readFile(poisoned.path, "utf8");
    const revoked = await cli.run(["queue", "create-queue", "--body", "-"], '{"name":"revoked"}', { BP_KEY: rotated });
    expect(revoked.code).toBe(1); expect(JSON.parse(revoked.stderr)).toMatchObject({ error: "unauthorized", status: 401 });
    expect(await runs()).toEqual(beforeRevoked); expect(await readFile(poisoned.path, "utf8")).toBe(cacheBefore);
    expect((await stat(join(directory, "cli"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(directory, "cli", "runs"))).mode & 0o777).toBe(0o700);
    const cache = await entries(directory);
    for (const entry of cache) expect((await stat(entry.path)).mode & 0o777).toBe(0o600);
    const artifacts = cli.outputs.join("") + (await Promise.all(cache.map((e) => readFile(e.path, "utf8")))).join("");
    for (const credential of keys) { expect(artifacts).not.toContain(credential); expect(artifacts).not.toContain(credential.split("_")[2]!); }
  } finally { try { if (f.app.server) await f.app.stop(); await pool.close(); } finally { await rm(directory, { recursive: true, force: true }); } }
});

test("CLI transaction changes HTTP handoff bytes, repeats effects, loses attribution or reports a different rollback error", async () => {
  const f = await transactionFixture(), directory = await mkdtemp(join(tmpdir(), "bp-cli-tx-"));
  try {
    f.app.listen({ hostname: "localhost", port: 0 });
    const url = `http://localhost:${f.app.server!.port}`;
    const cli = client({ BP_URL: url, BP_KEY: f.key, BP_DATA_DIR: directory });
    const scope = ["--workspace-id", f.workspaceId];
    await body(await f.post("/queues/intake/messages", { idempotencyKey: "cli-intake", payload: { id: 1 } }), 201);
    const claimed = await cli.run(["queue", "claim-message", "--queue", "intake", ...scope]);
    expect(claimed).toMatchObject({ code: 0, stderr: "" });
    const claim = JSON.parse(claimed.stdout) as Claim, runId = (await entries(directory))[0]!.value.id;
    const headers = { ...f.headers, "x-backplane-run": runId };
    const update = (id: number) => ({ sql: { statement: "UPDATE items SET updates = updates + 1 WHERE id = $1", params: [id], expectRows: 1 } });
    const send = (idempotencyKey: string) => ({ send: { queue: "review", idempotencyKey, payload: { id: 1 } } });
    const input = JSON.stringify({ idempotencyKey: "cli-handoff", operations: [update(1), send("cli-successor"), { ack: { deliveryId: claim.deliveryId, receipt: claim.receipt } }] }, null, 2);
    const committed = await cli.run(["transaction", ...scope, "--body", "-"], input);
    expect(committed).toMatchObject({ code: 0, stderr: "" });
    const response = JSON.parse(committed.stdout) as TransactionResponse;
    const eventsBefore = await f.pool`SELECT position FROM audit.events WHERE workspace_id = ${f.workspaceId} ORDER BY position`;
    const replay = await fetch(`${url}/api/v1/workspaces/${f.workspaceId}/transactions`, { method: "POST", headers, body: input });
    expect(await body<TransactionResponse>(replay)).toEqual(response);
    expect(await f.pool`SELECT position FROM audit.events WHERE workspace_id = ${f.workspaceId} ORDER BY position`).toEqual(eventsBefore);
    const rows = async () => (await body<SqlResponse>(await f.post("/sql", { statement: "SELECT * FROM items ORDER BY id", params: [] }, headers))).rows;
    const state = await rows();
    expect(state[0]).toEqual({ id: 1, updates: 1, principal_id: f.principalId, run_id: runId });
    expect(state[1]).toMatchObject({ id: 2, updates: 0 });
    expect(await f.pool<{ producer_principal_id: string; producer_run_id: string }[]>`SELECT producer_principal_id, producer_run_id FROM queue.messages WHERE workspace_id = ${f.workspaceId} AND queue = 'review'`)
      .toEqual([{ producer_principal_id: f.principalId, producer_run_id: runId }]);
    expect(await f.pool<{ state: string }[]>`SELECT state FROM queue.delivery_envelopes WHERE id = ${claim.deliveryId}`).toEqual([{ state: "succeeded" }]);
    expect(await f.pool`SELECT id FROM queue.delivery_envelopes WHERE workspace_id = ${f.workspaceId} AND queue = 'review'`).toHaveLength(1);
    const page = await body<AuditPage>(await fetch(`${url}/api/v1/workspaces/${f.workspaceId}/audit?runId=${runId}&limit=500`, { headers }));
    expect(page.events.filter((e) => ["queue.claim", "queue.send", "queue.ack", "transaction.committed"].includes(e.kind)).map((e) => [e.kind, e.run_id, e.principal_id]))
      .toEqual(["queue.claim", "queue.send", "queue.ack", "transaction.committed"].map((kind) => [kind, runId, f.principalId]));
    const failing = JSON.stringify({ idempotencyKey: "cli-rollback", operations: [update(2), send("rolled-back"), update(999)] });
    const file = join(directory, "tx.json"); await writeFile(file, failing);
    const failed = await cli.run(["transaction", ...scope, "--body", `@${file}`]);
    const http = await fetch(`${url}/api/v1/workspaces/${f.workspaceId}/transactions`, { method: "POST", headers, body: failing });
    const error = await body<{ error: string; operationIndex: number }>(http, 422);
    expect(error).toEqual({ error: "assertion_failed", operationIndex: 2 });
    expect(failed).toMatchObject({ code: 1, stdout: "" });
    expect(JSON.parse(failed.stderr)).toEqual({ error: error.error, status: 422, details: error });
    expect(await rows()).toEqual(state);
    expect(await f.pool`SELECT id FROM queue.delivery_envelopes WHERE workspace_id = ${f.workspaceId} AND queue = 'review'`).toHaveLength(1);
    expect(await f.pool<{ idempotency_key: string }[]>`SELECT idempotency_key FROM control.transaction_receipts WHERE workspace_id = ${f.workspaceId}`).toEqual([{ idempotency_key: "cli-handoff" }]);
  } finally { try { if (f.app.server) await f.app.stop(); await f.pool.close(); } finally { await rm(directory, { recursive: true, force: true }); } }
});
