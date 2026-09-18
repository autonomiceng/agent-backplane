import { expect, test } from "bun:test";
import { lstat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { issueKey, createRun } from "../testing/session.ts";
import { fixture, uploaded } from "./testing/blob-fixture.ts";

test("scope escape exposes foreign bytes or lets a non-owner delete a nested key", async () => {
  const f = await fixture();
  try {
    expect((await f.put("../escape")).status).toBe(422);
    expect((await f.put("notes%2f..%2fescape")).status).toBe(422);
    expect((await f.put("notes%252fescape")).status).toBe(422);
    expect((await f.put("a/b/c/d/e")).status).toBe(422);
    const bytes = Buffer.from([0, 255, 128, 10]), blob = await uploaded(await f.put("notes/a.txt", bytes));
    const read = await f.get(blob.id); expect(read.status).toBe(200); expect(Buffer.from(await read.arrayBuffer())).toEqual(bytes);
    expect(read.headers.get("cache-control")).toBe("no-store"); expect(read.headers.get("content-disposition")).toBe("attachment");
    expect((await lstat(join(f.dataDir, "blobs", f.workspaceId))).mode & 0o777).toBe(0o700);
    expect((await lstat(join(f.dataDir, "blobs", f.workspaceId, blob.id))).mode & 0o777).toBe(0o600);
    expect((await f.put("notes/a.txt")).status).toBe(409);
    const principal = await (await f.json("/principals", { name: "Other" })).json() as { id: string };
    const otherKey = await issueKey(f.app, f.cookie, f.workspaceId, principal.id), otherRun = await createRun(f.app, otherKey, f.workspaceId);
    expect((await f.del(blob.id, { authorization: `Bearer ${otherKey}`, "x-backplane-run": otherRun })).status).toBe(403);
    expect((await f.get(blob.id, { authorization: `Bearer ${otherKey}` })).status).toBe(200);
    const foreign = await (await f.app.handle(new Request("http://localhost/api/v1/workspaces", { method: "POST", headers: f.userHeaders, body: '{"name":"Foreign"}' }))).json() as { id: string };
    expect((await f.app.handle(new Request(`http://localhost/api/v1/workspaces/${foreign.id}/blobs/${blob.id}`, { headers: f.userHeaders }))).status).toBe(404);
    expect((await f.app.handle(new Request(`http://localhost/api/v1/workspaces/${foreign.id}/blobs/${blob.id}`, { headers: f.headers }))).status).toBe(403);
    const linkId = crypto.randomUUID(); await symlink(join(f.dataDir, "blobs", f.workspaceId, blob.id), join(f.dataDir, "blobs", f.workspaceId, linkId));
    await expect(f.disk.open(f.workspaceId, linkId)).rejects.toThrow();
  } finally { await f.close(); }
});
