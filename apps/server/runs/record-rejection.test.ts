import { expect, test } from "bun:test";
import { createPool } from "../platform/pool.ts";
import { migratedDatabase } from "../testing/postgres.ts";
import { recordRejection } from "./record-rejection.ts";
import { withRunContext } from "./with-run-context.ts";

test("rollback removes events while the rejection retains its reason and claimed actor", async () => {
  const pool = createPool(await migratedDatabase());
  const context = { workspaceId: crypto.randomUUID(), userId: "user-1" };
  const rejection = { context, kind: "write", objects: ["example"], reason: "context_missing", sqlstate: "P0001" };
  try {
    await expect(withRunContext(pool, context, async (_tx, emit) => {
      await emit("write", [], 0, {});
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect(await recordRejection(pool, rejection)).toEqual({ recorded: true });
    const [count] = await pool`SELECT count(*)::int AS n FROM audit.events`;
    expect(count?.n).toBe(0);
    expect(await recordRejection(pool, { ...rejection, reason: "error: secret row" })).toEqual({ recorded: false });
    const rows = await pool`SELECT workspace_id, principal_id, run_id, user_id, kind, objects, reason, sqlstate FROM audit.rejections`;
    expect(rows).toEqual([{
      workspace_id: context.workspaceId, principal_id: null, run_id: null, user_id: context.userId,
      kind: "write", objects: ["example"], reason: "context_missing", sqlstate: "P0001",
    }]);
  } finally {
    await pool.close();
  }
});
