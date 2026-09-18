import { expect, test } from "bun:test";
import { applyMigration, createRun, issueKey, migrationFixture } from "../testing/session.ts";
import type { ApplyInput } from "../schema/apply-migration-input.ts";
import type { AuditPage } from "../events/read-audit-input.ts";
async function body<T = Record<string, unknown>>(response: Response, status = 200): Promise<NoInfer<T>> {
  const value: unknown = await response.json();
  expect({ status: response.status, ...(response.status === status ? {} : { body: value }) }).toEqual({ status });
  return value as T;
}
async function fixture() {
  const f = await migrationFixture();
  try {
    await applyMigration(f.app, f.key, f.runId, f.workspaceId,
      "CREATE TABLE items (id int PRIMARY KEY, value int NOT NULL); INSERT INTO items (id, value) VALUES (1, 1)");
    const base = `http://localhost/api/v1/workspaces/${f.workspaceId}`;
    const headers = { authorization: `Bearer ${f.key}`, "x-backplane-run": f.runId, "content-type": "application/json" };
    const user = { origin: "http://localhost", cookie: f.cookie, "content-type": "application/json" };
    const post = (path: string, input: unknown, actor: Record<string, string> = headers, method: "POST" | "PUT" = "POST") =>
      f.app.handle(new Request(`${base}${path}`, { method, headers: actor, body: JSON.stringify(input) }));
    const gate = (enabled = true, actor: Record<string, string> = user, targetKind = "migration", selector = "migration") =>
      post("/approvals/gates", { targetKind, selector, enabled }, actor, "PUT");
    const previewed = async (sql: string, expectedRevision = 1): Promise<ApplyInput> => {
      const preview = await body<{ sqlHash: string; previewPosition: string }>(await f.preview(sql, true, expectedRevision));
      return { name: "gated migration", sql, expectedRevision, destructive: true, sqlHash: preview.sqlHash, previewPosition: preview.previewPosition };
    };
    const request = (input: ApplyInput, expiresInSeconds = 3600, actor: Record<string, string> = headers) => post("/approvals", {
      targetKind: "migration", sqlHash: input.sqlHash, expectedRevision: input.expectedRevision, previewPosition: input.previewPosition, expiresInSeconds,
    }, actor);
    const decide = (id: string) => post(`/approvals/${id}/decision`, { decision: "approve", reason: "reviewed" }, user);
    const approved = async (input: ApplyInput, expiresInSeconds = 3600) => {
      const approval = await body<{ id: string }>(await request(input, expiresInSeconds), 201);
      expect(await body(await decide(approval.id))).toEqual({ id: approval.id, decision: "approve", releasedDeliveryId: null });
      return { ...input, approvalId: approval.id };
    };
    const audit = async () => (await body<AuditPage>(await f.app.handle(new Request(`${base}/audit?limit=500`, { headers })))).events;
    return { ...f, headers, user, post, gate, previewed, request, decide, approved, audit };
  } catch (error) { await f.pool.close(); throw error; }
}

test("Migration Approval accepts a substituted hash, moved revision, expired grant or rotated gate", async () => {
  const f = await fixture();
  try {
    await body(await f.gate());
    const input = await f.previewed("UPDATE items SET value = 2 WHERE id = 1"), approved = await f.approved(input);
    const repeatedPreview = await f.previewed(input.sql);
    expect(repeatedPreview.previewPosition).not.toBe(input.previewPosition);
    expect(await body(await f.apply({ ...approved, previewPosition: repeatedPreview.previewPosition }), 409)).toEqual({ error: "approval_mismatch" });
    const other = await f.previewed("UPDATE items SET value = 3 WHERE id = 1");
    expect(await body(await f.apply({ ...other, approvalId: approved.approvalId }), 409)).toEqual({ error: "approval_mismatch" });
    expect(await body(await f.request({ ...input, sqlHash: other.sqlHash }), 409)).toEqual({ error: "approval_mismatch" });
    const expired = await f.approved(input, 1);
    await f.pool`SELECT pg_sleep(1.05)`;
    expect(await body(await f.apply(expired), 409)).toEqual({ error: "approval_expired" });
    const pending = await body<{ id: string }>(await f.request(input), 201);
    await body(await f.gate(false));
    await body(await f.gate());
    expect(await body(await f.apply(approved), 409)).toEqual({ error: "approval_stale" });
    expect(await body(await f.decide(pending.id), 409)).toEqual({ error: "approval_stale" });
    const stale = await f.approved(input), undecided = await body<{ id: string }>(await f.request(input), 201);
    await body(await f.apply(await f.approved(other)), 201);
    expect(await body(await f.apply(stale), 409)).toEqual({ error: "revision_stale" });
    const later = await f.previewed(input.sql, 2);
    expect(await body(await f.apply({ ...later, approvalId: stale.approvalId }), 409)).toEqual({ error: "approval_stale" });
    expect(await body(await f.request({ ...input, expectedRevision: 2 }), 409)).toEqual({ error: "approval_mismatch" });
    expect(await body(await f.decide(undecided.id), 409)).toEqual({ error: "approval_stale" });
  } finally { await f.pool.close(); }
});

test("Migration apply bypasses a User gate or a Migration Approval overrides a row gate", async () => {
  const f = await fixture();
  try {
    const ungated = await f.previewed("UPDATE items SET value = 2 WHERE id = 1");
    await body(await f.apply(ungated), 201);
    expect(await body(await f.gate(true, f.headers), 403)).toEqual({ error: "approval_forbidden" });
    expect(await body(await f.gate(true, undefined, "migration", "items"), 422)).toEqual({ error: "invalid_input" });
    const gate = await body(await f.gate());
    expect(gate).toMatchObject({ targetKind: "migration", selector: "migration", mutations: ["apply"] });
    expect(await body(await f.gate())).toEqual(gate);
    const input = await f.previewed("UPDATE items SET value = 3 WHERE id = 1", 2);
    expect(await body(await f.sql("SELECT value FROM items"))).toMatchObject({ rows: [{ value: 2 }] });
    expect(await body(await f.apply(input), 422)).toEqual({ error: "approval_required",
      target: { targetKind: "migration", targetId: input.sqlHash, targetVersion: "2" } });
    const principal = await body<{ id: string }>(await f.post("/principals", { name: "Other Principal" }, f.user), 201);
    const key = await issueKey(f.app, f.cookie, f.workspaceId, principal.id), runId = await createRun(f.app, key, f.workspaceId);
    const foreign = { ...f.headers, authorization: `Bearer ${key}`, "x-backplane-run": runId };
    expect(await body(await f.request(input, 3600, foreign), 409)).toEqual({ error: "approval_mismatch" });
    const approved = await f.approved(input);
    expect(await body(await f.apply(approved, { key, runId }), 409)).toEqual({ error: "preview_mismatch" });
    const ownPreview = await body<{ sqlHash: string; previewPosition: string }>(await f.post("/migrations/preview", {
      name: input.name, sql: input.sql, destructive: true, expectedRevision: 2,
    }, foreign));
    expect(await body(await f.apply({ ...approved, previewPosition: ownPreview.previewPosition }, { key, runId }), 409)).toEqual({ error: "approval_mismatch" });
    await body(await f.gate(true, undefined, "row", "items"));
    expect(await body(await f.apply(approved), 422)).toEqual({ error: "approval_gate_conflict" });
    expect(await body(await f.post("/transactions", { idempotencyKey: "migration-cannot-update-row", operations: [
      { sql: { statement: input.sql, params: [], expectRows: 1, approvalId: approved.approvalId } },
    ] }), 409)).toEqual({ error: "approval_mismatch", operationIndex: 0 });
    expect(await body(await f.sql("SELECT value FROM items"))).toMatchObject({ rows: [{ value: 2 }] });
    expect((await f.audit()).filter((event) => event.kind === "approval.consume")).toHaveLength(0);
  } finally { await f.pool.close(); }
});

test("failed Migration consumes its Approval or commits a ledger row, and retry consumes twice", async () => {
  const f = await fixture();
  try {
    await body(await f.gate());
    const input = await f.approved(await f.previewed(
      "CREATE TABLE checked (id int CHECK (id > 0)); INSERT INTO checked (id) SELECT value FROM items"));
    await body(await f.sql("UPDATE items SET value = -1 WHERE id = 1"));
    expect(await body(await f.apply(input), 422)).toEqual({ error: "migration_error", sqlstate: "23514" });
    expect(await f.pool<{ revision: number }[]>`SELECT revision FROM control.workspace_migrations WHERE workspace_id=${f.workspaceId}`).toEqual([{ revision: 1 }]);
    expect(await f.pool<{ consumed_position: string | null }[]>`SELECT consumed_position FROM control.approvals WHERE id=${input.approvalId}`).toEqual([{ consumed_position: null }]);
    expect((await f.audit()).filter((event) => event.kind === "approval.consume")).toHaveLength(0);
    await body(await f.sql("UPDATE items SET value = 1 WHERE id = 1"));
    const runId = await createRun(f.app, f.key, f.workspaceId);
    expect(await body(await f.apply(input, { key: f.key, runId }), 201)).toMatchObject({ revision: 2 });
    expect(await body(await f.sql("SELECT id FROM checked"))).toMatchObject({ rows: [{ id: 1 }] });
    expect(await body(await f.apply(input), 409)).toEqual({ error: "revision_stale" });
    const consumed = (await f.audit()).filter((event) => event.kind === "approval.consume");
    expect(consumed).toHaveLength(1);
    expect(consumed[0]).toMatchObject({ principal_id: f.principalId, run_id: runId, objects: [input.approvalId],
      metadata: { targetKind: "migration", targetId: input.sqlHash, targetVersion: "1", actionHash: input.sqlHash, previewPosition: input.previewPosition } });
    expect(await f.pool<{ revision: number }[]>`SELECT revision FROM control.workspace_migrations
      WHERE workspace_id=${f.workspaceId} ORDER BY revision`).toEqual([{ revision: 1 }, { revision: 2 }]);
    const repeatable = await f.approved(await f.previewed("UPDATE items SET value = value WHERE id = 1", 2));
    await body(await f.apply(repeatable), 201);
    const next = await f.previewed(repeatable.sql, 3);
    expect(await body(await f.apply({ ...next, approvalId: repeatable.approvalId }), 409)).toEqual({ error: "approval_consumed" });
  } finally { await f.pool.close(); }
});
