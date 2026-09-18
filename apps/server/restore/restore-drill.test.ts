// Two serial physical drills own a dedicated source cluster and fresh recovery directories.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { cp, mkdir, mkdtemp, readFile, rename, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPool } from "../platform/pool.ts";
import { adminUrl, migratedDatabase, startCluster, type TestCluster } from "../testing/postgres.ts";
import { advanceDeliveryClock, applyMigration, recoveryFixture, testApp } from "../testing/session.ts";
import type { App } from "../app.ts";
import type { Claim } from "../queue/claim-input.ts";
import { backup, restore } from "./backup-restore.ts";

let source: TestCluster;
let root: string;
let archiveDir: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "bp-drill-"));
  archiveDir = join(root, "archive");
  await mkdir(archiveDir);
  const archive = new URL("../../../infra/backup/archive.sh", import.meta.url).pathname;
  source = await startCluster(["archive_mode=on", `archive_command='"${archive}" "%p" "%f" "${archiveDir}"'`]);
}, 30_000);
afterAll(async () => {
  try { await source?.stop(); } finally {
    if (root) await rm(root, { recursive: true, force: true });
  }
});
function post(app: App, url: string, headers: Record<string, string>, body: unknown = {}) {
  return app.handle(new Request(url, { method: "POST", headers, body: JSON.stringify(body) }));
}
async function startRestored(dataDir: string, url: string) {
  const socket = await mkdtemp(join(root, "socket-"));
  const connection = new URL(url);
  const ctl = async (...args: string[]) => {
    const child = Bun.spawn([join(source.binDir, "pg_ctl"), "-D", dataDir, "-w", "-t", "20", ...args], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code) throw new Error(`${stdout}${stderr}`);
  };
  try {
    await ctl("-l", join(dataDir, "test.log"), "-o", `-k ${socket} -p 5432 -c listen_addresses=''`, "start");
    const common = { path: join(socket, ".s.PGSQL.5432"), database: connection.pathname.slice(1), max: 2 };
    const pool = new SQL({ ...common, username: "bp_server", password: "bp_server" });
    const admin = new SQL({ ...common, username: "postgres", password: "postgres" });
    return { pool, admin, async close() {
      try { await pool.close(); await admin.close(); await ctl("-m", "fast", "stop"); }
      finally { await rm(socket, { recursive: true, force: true }); }
    } };
  } catch (error) {
    try { await ctl("-m", "fast", "stop"); } finally { await rm(socket, { recursive: true, force: true }); }
    throw error;
  }
}

describe.serial("physical restore", () => {
  test("WAL restore loses committed state", async () => {
    const started = performance.now();
    const url = await migratedDatabase(source.url);
    const pool = createPool(url);
    let recovered: Awaited<ReturnType<typeof startRestored>> | undefined;
    try {
      const emptyOptions = { adminUrl: adminUrl(url), dataDir: source.dataDir, backupDir: join(root, "empty-backup"), archiveDir, binDir: source.binDir };
      const alias = join(root, "source-alias");
      await symlink(source.dataDir, alias);
      const nested = join(alias, "nested-backup");
      await expect(backup({ ...emptyOptions, backupDir: nested })).rejects.toThrow("backup_paths_overlap");
      expect(await stat(nested).then(() => true, () => false)).toBe(false);
      await expect(restore({ ...emptyOptions, dataDir: join(alias, "nested-restore"), backupDir: source.dataDir }))
        .rejects.toThrow("backup_paths_overlap");
      await backup(emptyOptions);
      const emptyDir = join(root, "empty-restored");
      expect(await restore({ ...emptyOptions, dataDir: emptyDir })).toMatchObject({ active: false });
      recovered = await startRestored(emptyDir, url);
      expect((await recovered.admin`SELECT active FROM control.restore_gate`)[0].active).toBe(false);
      expect((await recovered.admin`SELECT count(*)::int AS n FROM control.restore_workspaces`)[0].n).toBe(0);
      await recovered.close(); recovered = undefined;
      const f = await recoveryFixture(pool);
      const second = await post(f.app, "http://localhost/api/v1/workspaces", f.userHeaders, { name: "second" });
      expect(second.status).toBe(201);
      await applyMigration(f.app, f.key, f.runId, f.workspaceId, "CREATE TABLE sentinel (id int PRIMARY KEY, value text)");
      const write = (id: number) => post(f.app, `${f.baseUrl}/sql`, f.headers,
        { statement: "INSERT INTO sentinel VALUES ($1, $2)", params: [id, `sentinel-${id}`] });
      expect((await write(1)).status).toBe(200);
      const options = { adminUrl: adminUrl(url), dataDir: source.dataDir, backupDir: join(root, "wal-backup"), archiveDir, binDir: source.binDir };
      const manifest = await backup(options, async () => { expect((await write(2)).status).toBe(200); });
      expect(BigInt(manifest.after.heads.find((h) => h.workspaceId === f.workspaceId)!.head))
        .toBeGreaterThan(BigInt(manifest.before.heads.find((h) => h.workspaceId === f.workspaceId)!.head));
      const dataDir = join(root, "wal-restored");
      await restore({ ...options, dataDir });
      recovered = await startRestored(dataDir, url);
      const heads = await recovered.admin`SELECT workspace_id::text AS "workspaceId",last_position::text AS head FROM audit.cursor ORDER BY workspace_id`;
      expect([...heads]).toEqual(manifest.after.heads);
      const schema = `ws_${f.workspaceId.replaceAll("-", "")}`;
      const rows = await recovered.admin`SELECT id,value FROM ${recovered.admin(schema)}.sentinel ORDER BY id`;
      expect([...rows]).toEqual([{ id: 1, value: "sentinel-1" }, { id: 2, value: "sentinel-2" }]);
      expect((await recovered.admin`SELECT active FROM control.restore_gate`)[0].active).toBe(true);
      await recovered.close(); recovered = undefined;
      const incomplete = join(root, "incomplete-archive");
      await cp(archiveDir, incomplete, { recursive: true });
      await rename(join(incomplete, manifest.segment), join(root, "withheld-wal"));
      const failedDir = join(root, "failed-restored");
      const wrapper = new URL("../../../infra/backup/restore.sh", import.meta.url).pathname;
      const child = Bun.spawn([wrapper, options.adminUrl, failedDir, options.backupDir, incomplete, source.binDir], { stdout: "pipe", stderr: "pipe" });
      const [exit] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(exit).not.toBe(0);
      expect(await Bun.file(join(failedDir, "postmaster.pid")).exists()).toBe(false);
      expect(await readFile(join(failedDir, "postgresql.auto.conf"), "utf8")).toContain("listen_addresses=''");
      expect(await readFile(join(failedDir, "restore-hba.conf"), "utf8")).toContain("local all all reject");
      // Repair only the withheld archive input, then inspect privately without the bootstrap phase.
      await rename(join(root, "withheld-wal"), join(incomplete, manifest.segment));
      recovered = await startRestored(failedDir, url);
      expect((await recovered.admin`SELECT active FROM control.restore_gate`)[0].active).toBe(false);
      expect((await recovered.admin`SELECT count(*)::int AS n FROM control.restore_workspaces`)[0].n).toBe(0);
    } finally {
      await recovered?.close(); await pool.close();
      const seconds = (performance.now() - started) / 1000;
      console.log(`WAL restore loses committed state: ${seconds.toFixed(3)}s`);
      expect(seconds).toBeLessThan(120);
    }
  }, 120_000);

  test("Restored queues dispatch before uncertainty is resolved", async () => {
    const started = performance.now();
    const url = await migratedDatabase(source.url);
    const pool = createPool(url);
    let recovered: Awaited<ReturnType<typeof startRestored>> | undefined;
    try {
      const f = await recoveryFixture(pool);
      let second = { id: "" };
      expect((await f.send("begun")).status).toBe(201);
      const begun = await (await f.claim()).json() as Claim;
      expect((await post(f.app, `${f.baseUrl}/deliveries/${begun.deliveryId}/begin-effect`, f.headers,
        { receipt: begun.receipt, action: "submit", destination: "restore-drill" })).status).toBe(200);
      const leased: Claim[] = [];
      for (let i = 0; i < 101; i++) {
        expect((await f.send(`leased-${i}`)).status).toBe(201);
        const response = await f.claim();
        expect(response.status).toBe(200);
        let delivery = await response.json() as Claim;
        if (i === 0) {
          const admin = createPool(adminUrl(url));
          try {
            for (let attempt = 1; attempt < 5; attempt++) {
              expect((await f.receipt(delivery.deliveryId, delivery.receipt, "nack")).status).toBe(200);
              await advanceDeliveryClock(admin, f, delivery.deliveryId, "scheduled");
              const retry = await f.claim(); expect(retry.status).toBe(200);
              delivery = await retry.json() as Claim;
            }
          } finally { await admin.close(); }
          expect(delivery.attempt).toBe(5);
        }
        leased.push(delivery);
      }
      expect((await f.send("ready")).status).toBe(201);
      const before = await pool`SELECT workspace_id,generation,retention_floor::text AS floor FROM audit.cursor ORDER BY workspace_id`;
      const options = { adminUrl: adminUrl(url), dataDir: source.dataDir, backupDir: join(root, "queue-backup"), archiveDir, binDir: source.binDir };
      const manifest = await backup(options, undefined, async () => {
        const response = await post(f.app, "http://localhost/api/v1/workspaces", f.userHeaders, { name: "last-workspace" });
        expect(response.status).toBe(201); second = await response.json() as { id: string };
      });
      expect(manifest.after.heads.some((head) => head.workspaceId === second.id)).toBe(false);
      const dataDir = join(root, "queue-restored");
      const { epoch, active } = await restore({ ...options, dataDir });
      expect(active).toBe(true);
      recovered = await startRestored(dataDir, url);
      expect((await recovered.admin`SELECT minimum_head::text AS head FROM control.restore_workspaces WHERE workspace_id=${second.id}`)[0].head).toBe("0");
      let app = await testApp(recovered.pool);
      const claim = () => post(app, `${f.queueUrl}/claim`, f.headers);
      const gated = await claim();
      expect(gated.status).toBe(503); expect(await gated.json()).toEqual({ error: "restore_gated" });
      const blockedWrite = await post(app, f.messagesUrl, f.headers, { idempotencyKey: "gated", payload: {} });
      expect(blockedWrite.status).toBe(503);
      const stream = await app.handle(new Request(`${f.baseUrl}/events`, { headers: f.userHeaders }));
      expect(stream.status).toBe(409);
      const expired = await stream.json() as { error: string; generation: string; resync: boolean };
      expect(expired).toMatchObject({ error: "cursor_expired", resync: true });
      expect(expired.generation).not.toBe(before.find((r: { workspace_id: string }) => r.workspace_id === f.workspaceId).generation);
      const health = await app.handle(new Request("http://localhost/health/ready"));
      expect(health.status).toBe(503); expect(await health.json()).toMatchObject({ status: "not_ready", problems: ["restore_gated"] });
      expect((await app.handle(new Request(`http://localhost/api/v1/workspaces/${f.workspaceId}/principals`, { headers: f.userHeaders }))).status).toBe(200);
      const statusResponse = await app.handle(new Request(`${f.baseUrl}/restore`, { headers: f.userHeaders }));
      expect(statusResponse.status, await statusResponse.clone().text()).toBe(200);
      const userWrite = await app.handle(new Request(`${f.baseUrl}/quotas`, { method: "PUT", headers: f.userHeaders,
        body: JSON.stringify({ sql_statement_bytes: 1048576, sql_rows: 10000, transaction_operations: 600, queue_sends: 599, open_sse_streams: 16 }) }));
      expect(userWrite.status).toBe(200);
      expect((await post(app, `${f.baseUrl}/restore/release`, f.userHeaders, { epoch: crypto.randomUUID(), sourceFenced: true })).status).toBe(409);
      expect((await post(app, `${f.baseUrl}/restore/release`, f.userHeaders, { epoch, sourceFenced: false })).status).toBe(422);
      const first = await post(app, `${f.baseUrl}/restore/release`, f.userHeaders, { epoch, sourceFenced: true });
      expect(first.status).toBe(202); expect(await first.json()).toMatchObject({ processed: 100, done: false });
      await recovered.close();
      recovered = await startRestored(dataDir, url); app = await testApp(recovered.pool);
      expect((await claim()).status).toBe(503);
      const resumed = await post(app, `${f.baseUrl}/restore/release`, f.userHeaders, { epoch, sourceFenced: true });
      expect(resumed.status).toBe(200); expect(await resumed.json()).toMatchObject({ processed: 2, done: true });
      expect((await claim()).status).toBe(503);
      const repeat = await post(app, `${f.baseUrl}/restore/release`, f.userHeaders, { epoch, sourceFenced: true });
      expect(await repeat.json()).toMatchObject({ processed: 0, done: true });
      const last = await post(app, `http://localhost/api/v1/workspaces/${second.id}/restore/release`, f.userHeaders, { epoch, sourceFenced: true });
      expect(last.status).toBe(200);
      expect((await recovered.admin`SELECT active FROM control.restore_gate`)[0].active).toBe(false);
      const after = await recovered.admin`SELECT workspace_id,generation,retention_floor::text AS floor FROM audit.cursor ORDER BY workspace_id`;
      expect(after.filter((r: { workspace_id: string }) => r.workspace_id !== second.id)
        .map((r: { workspace_id: string; floor: string }) => [r.workspace_id, r.floor]))
        .toEqual(before.map((r: { workspace_id: string; floor: string }) => [r.workspace_id, r.floor]));
      expect(after.find((r: { workspace_id: string }) => r.workspace_id === f.workspaceId).generation).toBe(expired.generation);
      const [user] = await recovered.admin`SELECT released_by FROM control.restore_workspaces WHERE workspace_id=${f.workspaceId}`;
      const events = await recovered.admin`SELECT user_id,principal_id,run_id FROM audit.events WHERE kind IN ('restore.progress','queue.restore','effect.ambiguous')`;
      expect(events.length).toBe(105);
      expect(events.every((e: { user_id: string; principal_id: null; run_id: null }) => e.user_id === user.released_by && e.principal_id === null && e.run_id === null)).toBe(true);
      const [uncertain] = await recovered.admin`SELECT state,receipt_token_hash,next_attempt_at FROM queue.deliveries WHERE id=${begun.deliveryId}`;
      expect(uncertain).toMatchObject({ state: "ambiguous", receipt_token_hash: null, next_attempt_at: null });
      expect((await recovered.admin`SELECT reset FROM queue.effects WHERE message_id=${begun.messageId}`)[0].reset).toBe(false);
      expect((await recovered.admin`SELECT count(*)::int AS n FROM queue.deliveries WHERE current AND state='scheduled' AND receipt_token_hash IS NULL`)[0].n).toBe(101);
      const lastAttempt = leased[0]!;
      expect((await recovered.admin`SELECT state,attempt,max_attempts,completed_at FROM queue.deliveries WHERE id=${lastAttempt.deliveryId}`)[0])
        .toMatchObject({ state: "scheduled", attempt: 5, max_attempts: 5, completed_at: null });
      for (const old of [begun, ...leased]) {
        const response = await post(app, `${f.baseUrl}/deliveries/${old.deliveryId}/ack`, f.headers, { receipt: old.receipt });
        expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: "receipt_stale" });
      }
      const visibility = await recovered.admin`SELECT bool_and(next_attempt_at<=clock_timestamp()) AS ready FROM queue.deliveries WHERE current AND state='scheduled'`;
      if (!visibility[0].ready) {
        const deadline = Date.now() + 6000;
        while (!(await recovered.admin`SELECT bool_and(next_attempt_at<=clock_timestamp()) AS ready FROM queue.deliveries WHERE current AND state='scheduled'`)[0].ready) {
          if (Date.now() > deadline) throw new Error("restored retry did not become visible");
          await Bun.sleep(50);
        }
      }
      const dispatched = new Set<string>();
      for (let i = 0; i < 103; i++) {
        const response = await claim(); expect(response.status).toBe(200);
        const delivery = await response.json() as Claim | null;
        if (delivery) {
          expect(delivery.messageId).not.toBe(begun.messageId); dispatched.add(delivery.messageId);
          expect((await post(app, `${f.baseUrl}/deliveries/${delivery.deliveryId}/ack`, f.headers, { receipt: delivery.receipt })).status).toBe(200);
        }
      }
      expect(dispatched.size).toBe(102);
      expect(dispatched.has(lastAttempt.messageId)).toBe(true);
      expect((await app.handle(new Request("http://localhost/health/ready"))).status).toBe(200);
    } finally {
      await recovered?.close(); await pool.close();
      const seconds = (performance.now() - started) / 1000;
      console.log(`Restored queues dispatch before uncertainty is resolved: ${seconds.toFixed(3)}s`);
      expect(seconds).toBeLessThan(120);
    }
  }, 120_000);
});
