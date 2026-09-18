import { afterEach, expect, test } from "bun:test";
import { SQL } from "bun";
import { createPool, type Pool } from "../platform/pool.ts";
import { adminUrl, migratedDatabase } from "../testing/postgres.ts";
import { withRunContext } from "./with-run-context.ts";

const pools: Pool[] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.close({ timeout: 1 })));
});

test("emit without a bound transaction raises context_missing and cannot insert an event", async () => {
  const pool = createPool(await migratedDatabase());
  pools.push(pool);
  await expect(pool`SELECT audit.emit('forged-token', 'write', '{}', 0, '{}')`.then()).rejects.toMatchObject({ message: "context_missing" });
  const [count] = await pool`SELECT count(*)::int AS n FROM audit.events`;
  expect(count?.n).toBe(0);
});

test("rebinding cannot spoof the actor and bp_server cannot forge audit rows", async () => {
  const pool = createPool(await migratedDatabase());
  pools.push(pool);
  const context = { workspaceId: crypto.randomUUID(), userId: "user-1" };
  await withRunContext(pool, context, async (tx, emit) => {
    await tx`RESET ROLE`;
    await expect(tx.savepoint(async (sp) => {
      await sp`SELECT audit.bind_context(${crypto.randomUUID()}, NULL, NULL, 'forged', 'forged-token')`;
    })).rejects.toMatchObject({ message: "context_already_bound" });
    await expect(tx.savepoint(async (sp) => {
      await sp`INSERT INTO audit.events (workspace_id, position, user_id, kind)
        VALUES (${context.workspaceId}, 99, 'forged', 'write')`;
    })).rejects.toMatchObject({ errno: "42501" });
    await expect(tx.savepoint(async (sp) => {
      await sp`SELECT audit.emit('forged-token', 'write', '{}', 0, '{}')`;
    })).rejects.toMatchObject({ message: "context_missing" });
    await emit("write", [], 0, {});
  });
  const events = await pool`SELECT workspace_id, principal_id, run_id, user_id, position::int FROM audit.events`;
  expect(events).toEqual([{
    workspace_id: context.workspaceId, principal_id: null, run_id: null, user_id: context.userId, position: 1,
  }]);
});

test("pooled context cannot leak after either commit or rollback", async () => {
  const pool = new SQL({ url: await migratedDatabase(), max: 1 });
  pools.push(pool);
  const context = { workspaceId: crypto.randomUUID(), userId: "user-1" };
  const firstPid = await withRunContext(pool, context, async (tx, emit) => {
    const [backend] = await tx`SELECT pg_backend_pid() AS pid`;
    await emit("write", [], 0, {});
    return backend?.pid;
  });
  await expect(pool.begin(async (tx) => {
    await tx`SELECT audit.emit('forged-token', 'write', '{}', 0, '{}')`;
  })).rejects.toMatchObject({ message: "context_missing" });
  await expect(withRunContext(pool, context, async (_tx, emit) => {
    await emit("write", [], 0, {});
    throw new Error("rollback");
  })).rejects.toThrow("rollback");
  await expect(pool.begin(async (tx) => {
    const [backend] = await tx`SELECT pg_backend_pid() AS pid`;
    expect(backend?.pid).toBe(firstPid);
    await tx`SELECT audit.emit('forged-token', 'write', '{}', 0, '{}')`;
  })).rejects.toMatchObject({ message: "context_missing" });
  await withRunContext(pool, context, async (_tx, emit) => {
    await emit("write", [], 0, {});
  });
  const events = await pool`SELECT position::int, user_id FROM audit.events ORDER BY position`;
  expect(events).toEqual([{ position: 1, user_id: "user-1" }, { position: 2, user_id: "user-1" }]);
});

test("a concurrent Workspace bind waits through commit without blocking another Workspace or skipping positions", async () => {
  const url = await migratedDatabase();
  const a = new SQL({ url, max: 1 });
  const b = new SQL({ url, max: 2 });
  const admin = createPool(adminUrl(url));
  pools.push(a, b, admin);
  const context = { workspaceId: crypto.randomUUID(), userId: "user-1" };
  const emitted = Promise.withResolvers<number>();
  const commit = Promise.withResolvers<void>();
  const first = withRunContext(a, context, async (tx, emit) => {
    const [backend] = await tx`SELECT pg_backend_pid() AS pid`;
    const position = await emit("first", [], 0, {});
    emitted.resolve(backend?.pid);
    await commit.promise;
    return position;
  });
  let second: Promise<bigint> | undefined;
  try {
    const firstPid = await emitted.promise;
    second = withRunContext(b, context, async (_tx, emit) => emit("second", [], 0, {}));
    const deadline = Date.now() + 5000;
    let waitingPid: number | undefined;
    while (Date.now() < deadline) {
      const [waiter] = await admin`SELECT pid FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> ${firstPid}
          AND wait_event_type = 'Lock' AND query LIKE '%bind_context%' LIMIT 1`;
      if (waiter) {
        waitingPid = waiter.pid;
        break;
      }
      await Bun.sleep(20);
    }
    expect(waitingPid).toBeDefined();
    const independent = withRunContext(b, { ...context, workspaceId: crypto.randomUUID() }, async (_tx, emit) => {
      return emit("independent", [], 0, {});
    });
    expect(await Promise.race([independent, Bun.sleep(1000).then(() => "blocked")])).toBe(1n);
    const [waiting] = await admin`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${waitingPid}`;
    expect(waiting?.wait_event_type).toBe("Lock");
    commit.resolve();
    expect(await first).toBe(1n);
    expect(await second).toBe(2n);
    const events = await a`SELECT position::int, kind FROM audit.events
      WHERE workspace_id = ${context.workspaceId} ORDER BY position`;
    expect(events).toEqual([{ position: 1, kind: "first" }, { position: 2, kind: "second" }]);
  } finally {
    commit.resolve();
    await Promise.allSettled([first, second]);
  }
}, 10000);
