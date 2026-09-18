import { expect, test } from "bun:test";
import { issueKey, createRun } from "../testing/session.ts";
import { withRunContext, type RunTransaction } from "../runs/with-run-context.ts";
import { blobHash } from "./blob-store.ts";
import { fixture, uploaded } from "./testing/blob-fixture.ts";

test("missing provenance permits unbound uploads or supplied attribution overrides the authenticated actor", async () => {
  const f = await fixture();
  try {
    const { "x-backplane-run": _run, ...missing } = f.headers;
    expect((await f.put("missing", "bytes", missing as typeof f.headers)).status).toBe(400);
    const other = await (await f.json("/principals", { name: "Other" })).json() as { id: string };
    const otherKey = await issueKey(f.app, f.cookie, f.workspaceId, other.id), foreignRun = await createRun(f.app, otherKey, f.workspaceId);
    expect((await f.put("foreign", "bytes", { ...f.headers, "x-backplane-run": foreignRun })).status).toBe(403);
    const blob = await uploaded(await f.put("attributed"));
    expect(blob).toMatchObject({ principal_id: f.principalId, run_id: f.runId });
    expect((await f.audit()).find((e) => e.kind === "blob.put")).toMatchObject({ principal_id: f.principalId, run_id: f.runId, user_id: null, objects: [blob.id] });
    const insert = (tx: RunTransaction) => tx`INSERT INTO control.blobs(workspace_id,id,key,size,sha256,content_type,principal_id,run_id,created_at,expires_at)
      VALUES(${f.workspaceId},${crypto.randomUUID()},'forged',0,${Buffer.from(blobHash(new Uint8Array()), "hex")},'application/octet-stream',
      ${other.id},${foreignRun},'2000-01-01','2000-01-02') RETURNING principal_id,run_id,created_at`;
    await expect(f.pool.begin(async (tx) => { await insert(tx); })).rejects.toThrow("context_missing");
    await expect(withRunContext(f.pool, f, async (tx) => {
      const [row] = await insert(tx); expect(row).toMatchObject({ principal_id: f.principalId, run_id: f.runId });
      expect(row.created_at.getUTCFullYear()).toBeGreaterThan(2000); throw new Error("rollback_probe");
    })).rejects.toThrow("rollback_probe");
    expect((await f.del(blob.id, { ...f.userHeaders, origin: "https://foreign.example" })).status).toBe(403);
    f.deleteFault("rollback"); expect((await f.del(blob.id, f.userHeaders)).status).toBe(503);
    expect((await f.get(blob.id)).status).toBe(200); expect(await f.disk.open(f.workspaceId, blob.id)).toEqual(Buffer.from("private bytes"));
    f.deleteFault("committed"); expect((await f.del(blob.id, f.userHeaders)).status).toBe(204);
    await expect(f.disk.open(f.workspaceId, blob.id)).rejects.toThrow();
    const deleted = (await f.audit()).find((e) => e.kind === "blob.delete");
    expect(deleted).toMatchObject({ principal_id: null, run_id: null, objects: [blob.id] }); const [user] = await f.pool`SELECT id FROM control."user" WHERE email='credentials@example.com'`; expect(deleted?.user_id).toBe(user.id);
    expect((await f.get(blob.id)).status).toBe(404);
  } finally { await f.close(); }
});
