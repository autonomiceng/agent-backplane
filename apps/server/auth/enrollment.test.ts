// Three real-Postgres release scenarios for initial authority, crash recovery, and closed sign-up.
import { expect, spyOn, test } from "bun:test";
import * as filesystem from "node:fs/promises";
import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../app.ts";
import { createPool } from "../platform/pool.ts";
import { readConfig } from "../platform/config.ts";
import { readOperationsConfig } from "../platform/operations.ts";
import { adminUrl, latestMigrationVersion, migratedDatabase } from "../testing/postgres.ts";
import { loadMigrations, migrate } from "../../../db/migrations.ts";
import { sqlMigrationRunner } from "../../../db/sql-migration-runner.ts";
import { createAuth } from "./auth.ts";
import { createEnrollment } from "./enrollment.ts";
import { capabilityPath } from "./enrollment-file.ts";
import type { EnrollmentBarrier } from "./enroll-first-user.ts";
const password = "enrollment-test-password";
const config = { publicOrigin: "http://localhost", authSecret: "enrollment-tests-secret-longer-than-thirty-two", signup: "closed" } as const;
const input = (capability: string, email = "first@example.com") => ({ capability, email, password });
const request = (path: string, body?: unknown, headers: Record<string, string> = {}) => new Request(`http://localhost${path}`, {
  // Browsers and the CLI send Origin on every request; cookie-bearing mutations without one are refused.
  ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }), headers: { "content-type": "application/json", origin: "http://localhost", ...headers },
});
const cookie = (response: Response) => response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
async function fixture() {
  const url = await migratedDatabase(), pool = createPool(url), dataDir = await mkdtemp(join(tmpdir(), "bp-enroll-"));
  try {
    const enrollment = createEnrollment(pool, { ...config, dataDir }); await enrollment.prepare();
    const app = createApp({ pool, enrollment, auth: createAuth(pool, config), authUrl: config.publicOrigin,
      expectedSchemaVersion: await latestMigrationVersion(), operations: readOperationsConfig({ BP_OPERATIONS_TOKEN: "enrollment-operations" }) });
    return { url, pool, dataDir, enrollment, app, capability: await readFile(capabilityPath(dataDir), "utf8"),
      async close() { try { await pool.close(); } finally { await rm(dataDir, { recursive: true, force: true }); } } };
  } catch (error) {
    try { await pool.close(); } finally { await rm(dataDir, { recursive: true, force: true }); }
    throw error;
  }
}

// The schema version the server expects: the newest migration on disk.
const latestSchemaVersion = (await loadMigrations(new URL("../../../db/migrations", import.meta.url).pathname)).at(-1)!.version;

test("unauthorized or concurrent enrollment grants additional membership", async () => {
  const f = await fixture();
  try {
    const ready = await f.app.handle(request("/health/ready")); expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ enrollment: { state: "pending" }, status: "ready", problems: [] });
    const [clockBefore] = await f.pool<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    const operations = await (await f.app.handle(request("/health/operations", undefined, { authorization: "Bearer enrollment-operations" }))).json();
    expect(operations.enrollment).toMatchObject({ state: "pending", capabilityFile: capabilityPath(f.dataDir) });
    const [clockAfter] = await f.pool<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    expect(Date.parse(operations.enrollment.observedAt)).toBeGreaterThanOrEqual(clockBefore!.now.getTime());
    expect(Date.parse(operations.enrollment.observedAt)).toBeLessThanOrEqual(clockAfter!.now.getTime());
    expect(JSON.stringify(operations)).not.toContain(f.capability);
    expect((await stat(dirname(capabilityPath(f.dataDir)))).mode & 0o777).toBe(0o700);
    const file = await stat(capabilityPath(f.dataDir)); expect(file.mode & 0o777).toBe(0o600); expect(file.nlink).toBe(1);
    const denied = await f.app.handle(request("/api/v1/enrollment", input("0".repeat(64))));
    expect(denied.status).toBe(403); expect(await denied.json()).toEqual({ error: "enrollment_forbidden" });
    const missing = await f.app.handle(request("/api/v1/enrollment", { email: "missing@example.com", password }));
    expect(missing.status).toBe(400); expect(missing.headers.get("cache-control")).toBe("no-store");
    const hostile = await f.app.handle(request("/api/v1/enrollment", input(f.capability), { origin: "https://hostile.example" }));
    expect(hostile.status).toBe(403); expect(await hostile.json()).toEqual({ error: "origin_forbidden" });
    const large = await f.app.handle(request("/api/v1/enrollment", { ...input(f.capability), password: "x".repeat(4096) }));
    expect(large.status).toBe(413); expect(await large.json()).toEqual({ error: "enrollment_body_too_large" });
    expect((await f.app.handle(request("/api/v1/enrollment", { ...input(f.capability), extra: true }))).status).toBe(400);
    expect(await f.pool`SELECT id FROM control."user"`).toHaveLength(0);
    // Ownership is fault-injected only for the foreign ancestor: unprivileged runners cannot chown to another UID.
    for (const fault of ["symlink", "foreign-ancestor", "mode", "hard-link", "malformed", "partial", "publication-race"]) {
      const dataDir = await mkdtemp(join(f.dataDir, "unsafe-")), path = capabilityPath(dataDir);
      try {
        await mkdir(dirname(path), { mode: 0o700 });
        const value = "a".repeat(64), target = join(dataDir, "target");
        if (fault === "symlink") { await writeFile(target, value, { mode: 0o600 }); await symlink(target, path); }
        else if (fault !== "publication-race" && fault !== "foreign-ancestor") {
          await writeFile(path, fault === "malformed" ? "g".repeat(64) : fault === "partial" ? "a".repeat(16) : value, { mode: 0o600 });
          if (fault === "mode") await chmod(path, 0o644);
          if (fault === "hard-link") await link(path, target);
        }
        if (fault === "foreign-ancestor") await chmod(dataDir, 0o755);
        const originalLstat = filesystem.lstat;
        const owner = fault === "foreign-ancestor" ? spyOn(filesystem, "lstat").mockImplementation((async (...args: Parameters<typeof originalLstat>) => {
          const entry = await originalLstat(...args);
          return String(args[0]) === dataDir ? Object.assign(entry, { uid: (process.getuid?.() ?? 1000) + 1 }) : entry;
        }) as typeof originalLstat) : undefined;
        const enrollment = createEnrollment(f.pool, { ...config, dataDir }, async point => {
          if (fault === "publication-race" && point === "publication") await chmod(dataDir, 0o777);
        });
        try { await enrollment.prepare(); } finally { owner?.mockRestore(); await chmod(dataDir, 0o700); }
        const unsafe = createApp({ pool: f.pool, enrollment, auth: createAuth(f.pool, config), authUrl: config.publicOrigin, expectedSchemaVersion: latestSchemaVersion });
        expect(await enrollment.observe()).toMatchObject({ state: "recovery_required", capabilityFile: null });
        const rejected = await unsafe.handle(request("/api/v1/enrollment", input(value)));
        expect(rejected.status).toBe(503); expect(await rejected.json()).toEqual({ error: "enrollment_recovery_required" });
        if (fault === "foreign-ancestor") expect(await Bun.file(path).exists()).toBe(false);
        else if (fault === "publication-race") expect(await readFile(path, "utf8")).toBe("");
        else expect(await readFile(path, "utf8")).toBe(fault === "malformed" ? "g".repeat(64) : fault === "partial" ? "a".repeat(16) : value);
        expect(await f.pool`SELECT id FROM control."user"`).toHaveLength(0);
      } finally { await rm(dataDir, { recursive: true, force: true }); }
    }
    const admin = createPool(adminUrl(f.url));
    try {
      // Restore bootstrap is administrative global state, outside Workspace ledgers.
      await admin`UPDATE control.restore_gate SET active = true, epoch = ${crypto.randomUUID()} WHERE singleton`;
      const gated = await f.app.handle(request("/api/v1/enrollment", input(f.capability)));
      expect(gated.status).toBe(503); expect(await gated.json()).toEqual({ error: "restore_gate_active" });
      await admin`UPDATE control.restore_gate SET active = false WHERE singleton`;
      await admin`REVOKE EXECUTE ON FUNCTION control.assert_restore_open() FROM bp_server`;
      const unavailable = await f.app.handle(request("/api/v1/enrollment", input(f.capability)));
      expect(unavailable.status).toBe(503); expect(await unavailable.json()).toEqual({ error: "enrollment_unavailable" });
      expect(await f.pool`SELECT id FROM control."user"`).toHaveLength(0);
      expect(await f.pool`SELECT singleton FROM control.enrollment`).toHaveLength(0);
    } finally {
      await admin`UPDATE control.restore_gate SET active = false WHERE singleton`;
      await admin`GRANT EXECUTE ON FUNCTION control.assert_restore_open() TO bp_server`;
      await admin.close();
    }
    const emails = ["winner-a@example.com", "winner-b@example.com", "winner-c@example.com"];
    const responses = await Promise.all(emails.map(email => f.app.handle(request("/api/v1/enrollment", input(f.capability, email)))));
    expect(responses.filter(r => r.status === 201)).toHaveLength(1);
    expect(await f.pool`SELECT id FROM control.session`).toHaveLength(0);
    for (const [i, response] of responses.entries()) {
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const email = emails[i]!;
      const signIn = await f.app.handle(request("/api/auth/sign-in/email", { email, password }));
      if (response.status === 201) {
        expect(signIn.status).toBe(200);
        expect((await f.app.handle(request("/api/v1/workspaces", { name: "Enrolled" }, { cookie: cookie(signIn) }))).status).toBe(201);
      } else { expect([409, 503]).toContain(response.status); expect(signIn.status).toBe(401); }
      const retry = await f.app.handle(request("/api/v1/enrollment", input(f.capability, email)));
      expect(retry.status).toBe(409); expect(await retry.json()).toEqual({ error: "enrollment_claimed" });
    }
    expect(await f.pool`SELECT id FROM control."user"`).toHaveLength(1);
    expect(await f.pool`SELECT id FROM control.account`).toHaveLength(1);
    expect(await f.pool`SELECT id FROM control.member`).toHaveLength(1);
    expect(await f.pool`SELECT user_id FROM control.enrollment`).toHaveLength(1);
    expect(await f.enrollment.observe()).toMatchObject({ state: "claimed", capabilityFile: null });
    expect(await Bun.file(capabilityPath(f.dataDir)).exists()).toBe(false);
  } finally { await f.close(); }
}, 30_000);

function child(url: string, dataDir: string, boundary = "") {
  const ready = Promise.withResolvers<number>(), blocked = Promise.withResolvers<void>();
  const process = Bun.spawn([Bun.which("bun")!, new URL("../testing/enrollment-child.ts", import.meta.url).pathname, url, dataDir, boundary], {
    stdout: "ignore", stderr: "inherit", ipc(message) {
      if (typeof message !== "object" || message === null) return;
      if ("port" in message && typeof message.port === "number") ready.resolve(message.port);
      if ("boundary" in message) blocked.resolve();
    },
  });
  let killed = false;
  const timeout = setTimeout(() => { ready.reject(new Error("child startup deadline")); blocked.reject(new Error("child barrier deadline")); }, 15_000);
  // Both promises can reject before their boundary is awaited.
  void ready.promise.catch(() => {}); void blocked.promise.catch(() => {});
  return { ready: ready.promise, blocked: blocked.promise,
    async kill() { if (killed) return; killed = true; clearTimeout(timeout); process.kill("SIGKILL"); await process.exited; } };
}
async function overSocket(port: number, path: string, body?: unknown): Promise<Response> {
  const original = request(path, body);
  return fetch(new Request(`http://127.0.0.1:${port}${path}`, original));
}

test("crash or restart loses the enrollment seal", async () => {
  const boundaries: Parameters<EnrollmentBarrier>[0][] = ["publication", "before_user", "after_user", "before_claim", "after_claim", "after_commit"];
  for (const boundary of boundaries) {
    const url = await migratedDatabase(), dataDir = await mkdtemp(join(tmpdir(), "bp-enroll-crash-"));
    let server: ReturnType<typeof child> | undefined;
    try {
      server = child(url, dataDir, boundary);
      let capability = "0".repeat(64), pending: Promise<Response | null> | undefined;
      if (boundary !== "publication") {
        const port = await server.ready;
        capability = await readFile(capabilityPath(dataDir), "utf8");
        pending = overSocket(port, "/api/v1/enrollment", input(capability)).catch(() => null);
      }
      await server.blocked; await server.kill(); await pending;
      server = child(url, dataDir);
      const port = await server.ready, ready = await overSocket(port, "/health/ready");
      if (boundary === "publication") {
        expect(ready.status).toBe(503); expect(await ready.json()).toMatchObject({ status: "not_ready", problems: ["enrollment_recovery_required"] });
        const rejected = await overSocket(port, "/api/v1/enrollment", input(capability));
        expect(rejected.status).toBe(503); expect(await rejected.json()).toEqual({ error: "enrollment_recovery_required" });
        expect(await readFile(capabilityPath(dataDir), "utf8")).toBe("");
      } else {
        expect(ready.status).toBe(200);
        expect(await ready.json()).toEqual({ enrollment: { state: boundary === "after_commit" ? "claimed" : "pending" }, status: "ready", problems: [] });
        expect(await readFile(capabilityPath(dataDir), "utf8")).toBe(capability);
        const login = await overSocket(port, "/api/auth/sign-in/email", { email: "first@example.com", password });
        expect(login.status).toBe(boundary === "after_commit" ? 200 : 401);
        const retry = await overSocket(port, "/api/v1/enrollment", input(capability));
        expect(retry.status).toBe(boundary === "after_commit" ? 409 : 201);
        await server.kill(); await rm(capabilityPath(dataDir), { force: true }); server = child(url, dataDir);
        const finalPort = await server.ready;
        expect((await overSocket(finalPort, "/api/v1/enrollment", input(capability, "stranger@example.com"))).status).toBe(409);
        expect((await overSocket(finalPort, "/api/auth/sign-in/email", { email: "first@example.com", password })).status).toBe(200);
        expect(await Bun.file(capabilityPath(dataDir)).exists()).toBe(false);
      }
    } finally { try { await server?.kill(); } finally { await rm(dataDir, { recursive: true, force: true }); } }
  }
  const url = await migratedDatabase(undefined, 26), pool = createPool(url), admin = createPool(adminUrl(url));
  const dataDir = await mkdtemp(join(tmpdir(), "bp-enroll-upgrade-"));
  try {
    const auth = createAuth(pool, { ...config, signup: "open" });
    for (const email of ["oldest@example.com", "existing@example.com"]) {
      expect((await auth.handler(request("/api/auth/sign-up/email", { email, password, name: email }))).status).toBe(200);
    }
    const members = await pool`SELECT id, "userId" FROM control.member ORDER BY id`;
    await migrate(sqlMigrationRunner(admin), await loadMigrations(new URL("../../../db/migrations", import.meta.url).pathname));
    const enrollment = createEnrollment(pool, { ...config, dataDir }); await enrollment.prepare();
    expect(await enrollment.observe()).toMatchObject({ state: "claimed", capabilityFile: null });
    expect(await pool`SELECT id, "userId" FROM control.member ORDER BY id`).toEqual(members);
    expect(await pool<{ email: string; capability_hash: null }[]>`SELECT u.email, e.capability_hash FROM control.enrollment e JOIN control."user" u ON u.id = e.user_id`)
      .toEqual([{ email: "oldest@example.com", capability_hash: null }]);
    expect(await Bun.file(capabilityPath(dataDir)).exists()).toBe(false);
    const sealed = createApp({ pool, enrollment, auth: createAuth(pool, config), authUrl: config.publicOrigin, expectedSchemaVersion: latestSchemaVersion });
    expect((await sealed.handle(request("/health/ready"))).status).toBe(200);
    expect((await sealed.handle(request("/api/v1/enrollment", input("0".repeat(64))))).status).toBe(409);
  } finally { try { await pool.close(); await admin.close(); } finally { await rm(dataDir, { recursive: true, force: true }); } }
}, 180_000);

test("closed sign-up admits strangers or breaks sign-in", async () => {
  const f = await fixture();
  try {
    expect(readConfig({ BP_DATABASE_URL: "unused", BP_AUTH_SECRET: config.authSecret }).signup).toBe("closed");
    expect(() => readConfig({ BP_DATABASE_URL: "unused", BP_AUTH_SECRET: config.authSecret, BP_SIGNUP: "invalid" })).toThrow("BP_SIGNUP");
    const signup = { email: "stranger@example.com", password, name: "Stranger" };
    expect((await f.app.handle(request("/api/auth/sign-up/email", signup))).status).toBe(404);
    expect((await f.app.handle(request("/api/v1/enrollment", input(f.capability)))).status).toBe(201);
    for (const path of ["/sign-up/email", "/sign-up/email/", "/sign-up/%65mail", "//sign-up/email"]) {
      expect((await f.app.handle(request(`/api/auth${path}`, signup))).status).toBe(404);
    }
    const login = await f.app.handle(request("/api/auth/sign-in/email", { email: "FIRST@example.com", password }));
    expect(login.status).toBe(200); const headers = { cookie: cookie(login) };
    expect((await f.app.handle(request("/api/v1/workspaces", { name: "Private" }, headers))).status).toBe(201);
    const organizations = await f.app.handle(request("/api/auth/organization/list", undefined, headers));
    expect(organizations.status).toBe(200); expect(await organizations.json()).toHaveLength(1);
    for (const path of ["invite-member", "accept-invitation", "reject-invitation", "cancel-invitation"]) {
      expect((await f.app.handle(request(`/api/auth/organization/${path}`, {}, headers))).status).toBe(404);
    }
    const openConfig = { ...config, dataDir: f.dataDir, signup: "open" } as const;
    const enrollment = createEnrollment(f.pool, openConfig); await enrollment.prepare();
    const open = createApp({ pool: f.pool, enrollment, auth: createAuth(f.pool, openConfig), authUrl: config.publicOrigin, expectedSchemaVersion: latestSchemaVersion });
    const outsider = await open.handle(request("/api/auth/sign-up/email", signup)); expect(outsider.status).toBe(200);
    expect((await open.handle(request("/api/v1/workspaces", { name: "Intrusion" }, { cookie: cookie(outsider) }))).status).toBe(403);
    expect(await f.pool`SELECT id FROM control.member`).toHaveLength(1);
    expect((await open.handle(request("/health/ready"))).status).toBe(200);
    const publicConfig = { ...openConfig, publicOrigin: "https://backplane.example" };
    const publicEnrollment = createEnrollment(f.pool, publicConfig); await publicEnrollment.prepare();
    const publicApp = createApp({ pool: f.pool, enrollment: publicEnrollment, auth: createAuth(f.pool, publicConfig), authUrl: publicConfig.publicOrigin, expectedSchemaVersion: latestSchemaVersion, operations: readOperationsConfig({ BP_OPERATIONS_TOKEN: "test-operations-token" }) });
    const publicReady = await publicApp.handle(request("/health/ready")); expect(publicReady.status).toBe(503);
    // The public form carries only status and problem codes; sign-up details need the operations token.
    expect(await publicReady.json()).toEqual({ enrollment: { state: "claimed" }, status: "not_ready", problems: ["signup_open_public_origin"] });
    const detailed = await publicApp.handle(new Request("http://localhost/health/ready", { headers: { authorization: "Bearer test-operations-token" } }));
    expect(detailed.status).toBe(503);
    expect(await detailed.json()).toMatchObject({ problems: ["signup_open_public_origin"], signup: { configured: "open", effective: "closed" } });
    expect((await publicApp.handle(request("/api/auth/sign-up/email", { ...signup, email: "public@example.com" }))).status).toBe(404);
    expect(await f.pool`SELECT id FROM control.member`).toHaveLength(1);
    // An explicit-open identity created before enrollment requires recovery, including after a restart.
    const unclaimed = createPool(await migratedDatabase()), dir = await mkdtemp(join(tmpdir(), "bp-enroll-recovery-"));
    try {
      expect((await createAuth(unclaimed, { ...config, signup: "open" }).handler(request("/api/auth/sign-up/email", signup))).status).toBe(200);
      const recovery = createEnrollment(unclaimed, { ...config, dataDir: dir }); await recovery.prepare();
      expect(await recovery.observe()).toMatchObject({ state: "recovery_required", capabilityFile: null });
      expect(await Bun.file(capabilityPath(dir)).exists()).toBe(false);
      expect(await unclaimed`SELECT id FROM control.member`).toHaveLength(0);
      expect((await recovery.enroll(input("0".repeat(64)))).status).toBe(503);
    } finally { try { await unclaimed.close(); } finally { await rm(dir, { recursive: true, force: true }); } }
  } finally { await f.close(); }
}, 30_000);
