import { expect, test } from "bun:test";
import { withRunContext } from "../runs/with-run-context.ts";
import { fixture, uploaded } from "./testing/blob-fixture.ts";

test("failed upload leaves committed metadata or cleanup destroys an uncertain commit", async () => {
  const f = await fixture();
  try {
    expect((await f.put("oversized", Buffer.alloc(4194305))).status).toBe(413);
    expect((await f.put("hash", "bytes", { ...f.headers, "x-backplane-sha256": "0".repeat(64) } as typeof f.headers)).status).toBe(422);
    f.faults("stage"); expect((await f.put("stage")).status).toBe(503);
    f.faults("promotion"); expect((await f.put("promotion")).status).toBe(503);
    expect(await f.pool`SELECT id FROM control.blobs WHERE workspace_id=${f.workspaceId}`).toHaveLength(0);
    expect((await f.audit()).filter((e) => e.kind === "blob.put")).toHaveLength(0);
    expect(await f.objects()).toHaveLength(0);
    f.faults("commit"); const committed = await uploaded(await f.put("committed"));
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
  } finally { await f.close(); }
}, 30000);
