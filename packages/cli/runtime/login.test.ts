// Real Better Auth and HTTP exercise session persistence, isolation and generated User commands.
import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPool } from "../../../apps/server/platform/pool.ts";
import { latestMigrationVersion, migratedDatabase } from "../../../apps/server/testing/postgres.ts";
import { createApp } from "../../../apps/server/app.ts";
import { createAuth } from "../../../apps/server/auth/auth.ts";
import { createEnrollment } from "../../../apps/server/auth/enrollment.ts";
import { capabilityPath } from "../../../apps/server/auth/enrollment-file.ts";
import { execute } from "./execute.ts";
import type { Environment } from "./credentials.ts";

test("CLI User sessions leak secrets, lose authentication or attach Principal credentials", async () => {
  const started = performance.now(), pool = createPool(await migratedDatabase());
  const directory = await mkdtemp(join(tmpdir(), "bp-login-"));
  let app: ReturnType<typeof createApp>, requestOrigin: string | undefined;
  const email = "cli-user@example.com", password = "test-password-for-tenancy";
  const output: string[] = [], requests: Headers[] = [];
  try {
    // The real application handles each request on an ephemeral HTTP server.
    const server = Bun.serve({ hostname: "localhost", port: 0, fetch(request) {
      requests.push(new Headers(request.headers));
      if (requestOrigin) request.headers.set("origin", requestOrigin);
      return app.handle(request);
    } });
    try {
      const publicOrigin = `http://localhost:${server.port}`;
      const config = { publicOrigin, dataDir: directory, authSecret: "tenancy-tests-use-a-secret-longer-than-32-characters", signup: "closed" } as const;
      const enrollment = createEnrollment(pool, config);
      await enrollment.prepare();
      app = createApp({ pool, auth: createAuth(pool, config), enrollment, authUrl: publicOrigin, expectedSchemaVersion: await latestMigrationVersion() });
      const enrolled = await app.handle(new Request(`${publicOrigin}/api/v1/enrollment`, { method: "POST",
        headers: { "content-type": "application/json", origin: publicOrigin },
        body: JSON.stringify({ capability: await readFile(capabilityPath(directory), "utf8"), email, password }) }));
      if (enrolled.status !== 201) throw new Error(`enrollment failed (${enrolled.status}): ${await enrolled.text()}`);
      const env = { BP_URL: publicOrigin, BP_USER_EMAIL: email,
        BP_USER_PASSWORD: password, BP_KEY: `bp_${"a".repeat(24)}_${"b".repeat(64)}`, BP_DATA_DIR: directory };
      const run = async (argv: string[], input = "", overrides: Environment = {}) => {
        let stdout = "", stderr = "";
        const code = await execute(argv, { env: { ...env, ...overrides }, stdin: async () => input,
          stdout: (s) => { stdout += s; }, stderr: (s) => { stderr += s; } });
        output.push(stdout, stderr); return { code, stdout, stderr };
      };
      const command = ["auth", "create-workspace", "--body", "-"];
      expect((await run(command, '{"name":"missing-session"}')).stderr).toContain("user_session_required");
      expect(await run(["login"])).toEqual({ code: 0, stdout: '{"authenticated":true}\n', stderr: "" });
      const folder = join(directory, "cli/sessions"), names = await readdir(folder);
      expect(names).toHaveLength(1); expect(names[0]).toMatch(/^[0-9a-f]{64}\.cookie$/);
      const file = join(folder, names[0]!), cookie = await readFile(file, "utf8");
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect(cookie).toContain("better-auth.session_token=");
      const created = await run(command, '{"name":"CLI Workspace"}');
      expect(created).toMatchObject({ code: 0, stderr: "" });
      const workspaceId = (JSON.parse(created.stdout) as { id: string }).id;
      expect((await run(["restore", "release", "--workspace-id", workspaceId, "--epoch", crypto.randomUUID()])).stderr)
        .toContain("required_flag:source-fenced");
      const release = await run(["restore", "release", "--workspace-id", workspaceId, "--epoch", crypto.randomUUID(), "--source-fenced"]);
      expect(release.stderr).toContain('"status":409');
      expect(await pool`SELECT id FROM control.runs`).toHaveLength(0);
      requestOrigin = "http://wrong.example";
      expect((await run(command, '{"name":"wrong-origin"}')).stderr).toContain("origin_forbidden");
      requestOrigin = undefined;
      expect((await run(command, '{"name":"other-user"}', { BP_USER_EMAIL: "other@example.com" })).stderr).toContain("user_session_required");
      expect((await run(command, '{"name":"other-server"}', { BP_URL: `http://127.0.0.1:${server.port}` })).stderr).toContain("user_session_required");
      for (const headers of requests) {
        expect(headers.has("authorization")).toBe(false); expect(headers.has("x-backplane-run")).toBe(false);
        expect(headers.get("content-type")).toBe("application/json");
        expect(headers.get("origin")).toBe(publicOrigin);
      }
      expect(requests[0]!.get("origin")).toBe(publicOrigin);
      expect(requests[1]!.get("cookie")).toBe(cookie);
      for (const secret of [email, password, env.BP_KEY]) expect(names.join("") + cookie + output.join("")).not.toContain(secret);
      expect(output.join("")).not.toContain(cookie.split("=").slice(1).join("="));
      expect((await run(["logout"])).code).toBe(0);
      expect(await readdir(folder)).toEqual([]);
      expect((await run(command, '{"name":"logged-out"}')).stderr).toContain("user_session_required");
    } finally { await server.stop(true); }
  } finally {
    try { await pool.close(); } finally { await rm(directory, { recursive: true, force: true }); }
    console.log(`CLI login: ${((performance.now() - started) / 1000).toFixed(3)}s`);
  }
});
