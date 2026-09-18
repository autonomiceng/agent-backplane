import { expect, test } from "bun:test";
import { applyMigration } from "../testing/session.ts";
import { withRunContext } from "../runs/with-run-context.ts";
import { fixture, uploaded } from "./testing/blob-fixture.ts";

test("failed upload leaves committed metadata, or cleanup destroys an uncertain commit and strands expired bytes", async () => {
  const f = await fixture();
  try {
    expect((await f.put("oversized", Buffer.alloc(4194305))).status).toBe(413);
    expect((await f.put("hash", "bytes", { ...f.headers, "x-backplane-sha256": "0".repeat(64) } as typeof f.headers)).status).toBe(422);
    f.faults("stage"); expect((await f.put("stage")).status).toBe(503);
    f.faults("promotion"); expect((await f.put("promotion")).status).toBe(503);
    expect(await f.pool`SELECT id FROM control.blobs WHERE workspace_id=${f.workspaceId}`).toHaveLength(0);
    expect((await f.audit()).filter((e) => e.kind === "blob.put")).toHaveLength(0);
    expect(await f.objects()).toHaveLength(0);
    f.faults("commit"); const committed = await uploaded(await f.put("committed", "private bytes", { ...f.headers, "content-type": "Application/Octet-Stream; charset=binary" }));
    expect(await (await f.get(committed.id)).text()).toBe("private bytes");
    const stageId = crypto.randomUUID(), finalId = crypto.randomUUID();
    await withRunContext(f.pool, f, async () => {
      await f.store.stage(f.workspaceId, stageId, Buffer.from("orphan"));
      await f.store.stage(f.workspaceId, finalId, Buffer.from("orphan"));
      await f.store.promote(f.workspaceId, finalId, Buffer.from("orphan"));
    });
    await uploaded(await f.put("sweeps"));
    expect(await f.objects()).not.toContain(`${stageId}.stage`);
    expect(await f.objects()).not.toContain(finalId);
    f.faults("remove"); expect((await f.del(committed.id)).status).toBe(204);
    expect((await f.get(committed.id)).status).toBe(404); expect(await f.disk.open(f.workspaceId, committed.id)).toEqual(Buffer.from("private bytes"));
    f.faults(""); await uploaded(await f.put("retry"));
    await expect(f.disk.open(f.workspaceId, committed.id)).rejects.toThrow();
    expect((await f.json("/retention", { seconds: 1 }, "PUT")).status).toBe(200);
    await applyMigration(f.app, f.key, f.runId, f.workspaceId, "CREATE TABLE retained_blob (id integer PRIMARY KEY)");
    const expiring = await uploaded(await f.put("expired"));
    await f.pool`SELECT pg_sleep(greatest(0,extract(epoch FROM expires_at-clock_timestamp()))+0.02) FROM control.blobs WHERE workspace_id=${f.workspaceId} AND id=${expiring.id}`;
    expect((await f.get(expiring.id)).status).toBe(410);
    const first = await f.json("/retention/purge", { limit: 1 }); expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ counts: { migrationSql: 1, blobs: 0 }, hasMore: true });
    f.faults("remove"); const second = await f.json("/retention/purge", { limit: 1 }); expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ counts: { blobs: 1 }, hasMore: false, cleanupPending: true });
    expect((await f.get(expiring.id)).status).toBe(404);
    expect((await f.audit()).find((e) => e.kind === "blob.delete" && e.objects.includes(expiring.id))).toMatchObject({ metadata: { reason: "expired" }, principal_id: null, run_id: null });
    f.faults(""); expect(await (await f.json("/retention/purge", { limit: 1 })).json()).toMatchObject({ cleanupPending: false });
    await expect(f.disk.open(f.workspaceId, expiring.id)).rejects.toThrow();
  } finally { await f.close(); }
}, 30000);

test("stalled storage upload expires its transaction without committing blob metadata", async () => {
  const f = await fixture();
  const stage = f.store.stage;
  try {
    f.store.stage = async (...args) => {
      await stage(...args);
      await Bun.sleep(10_100);
    };
    const response = await f.put("stalled");
    expect(response.status).toBe(503);
    expect(await f.pool`SELECT id FROM control.blobs WHERE workspace_id=${f.workspaceId}`).toHaveLength(0);
    expect((await f.audit()).filter((event) => event.kind === "blob.put")).toHaveLength(0);
    f.store.stage = stage;
    const next = await uploaded(await f.put("after-stall"));
    expect(await (await f.get(next.id)).text()).toBe("private bytes");
  } finally { f.store.stage = stage; await f.close(); }
}, 20_000);
