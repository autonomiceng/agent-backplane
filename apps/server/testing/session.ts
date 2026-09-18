// Integration fixtures enroll the first User through HTTP and sign up identity-only outsiders explicitly.
import { afterAll } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEnrollment } from "../auth/enrollment.ts";
import { capabilityPath } from "../auth/enrollment-file.ts";
import { createApp, type App, type AppDeps } from "../app.ts";
import { createAuth } from "../auth/auth.ts";
import type { Pool } from "../platform/pool.ts";
import { latestMigrationVersion } from "./postgres.ts";

const enrollmentDirs = new Map<App, string>();
export async function signUp(app: App, email: string): Promise<string> {
  const dir = enrollmentDirs.get(app);
  const capability = dir ? await readFile(capabilityPath(dir), "utf8").catch(() => null) : null;
  if (capability) {
    const response = await app.handle(new Request("http://localhost/api/v1/enrollment", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ capability, email, password: "test-password-for-tenancy" }),
    }));
    if (response.status !== 201) throw new Error(`enrollment failed (${response.status}): ${await response.text()}`);
    return signIn(app, email);
  }
  return session(app, email, "sign-up");
}
export async function signIn(app: App, email = "credentials@example.com"): Promise<string> { return session(app, email, "sign-in"); }
async function session(app: App, email: string, verb: string): Promise<string> {
  const response = await app.handle(new Request(`http://localhost/api/auth/${verb}/email`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "test-password-for-tenancy", name: "Test User" }),
  }));
  if (!response.ok) throw new Error(`${verb} failed (${response.status}): ${await response.text()}`);
  const cookie = response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  if (!cookie) throw new Error(`${verb} returned no session cookie`);
  return cookie;
}

// Shared app wiring explicitly permits identity-only outsiders after first-User enrollment.
export async function testApp(pool: Pool, deps: Pick<AppDeps, "operations"> = {}): Promise<App> {
  const dataDir = await mkdtemp(join(tmpdir(), "bp-enrollment-fixture-"));
  // Register in the calling test file: imported module hooks only run for their first file.
  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
    for (const [app, dir] of enrollmentDirs) if (dir === dataDir) enrollmentDirs.delete(app);
  });
  const config = { publicOrigin: "http://localhost", authSecret: "tenancy-tests-use-a-secret-longer-than-32-characters", dataDir, signup: "open" } as const;
  const enrollment = createEnrollment(pool, config);
  await enrollment.prepare();
  const app = createApp({ pool, ...deps, authUrl: config.publicOrigin, expectedSchemaVersion: await latestMigrationVersion(),
    auth: createAuth(pool, config), enrollment });
  enrollmentDirs.set(app, dataDir);
  return app;
}

// Credential scenarios provision their Workspace and Principal through authenticated HTTP routes.
export async function principalFixture(pool: Pool) {
  const app = await testApp(pool);
  const cookie = await signUp(app, "credentials@example.com");
  const workspaceResponse = await app.handle(new Request("http://localhost/api/v1/workspaces", {
    method: "POST", headers: { cookie, origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify({ name: "Research" }),
  }));
  if (workspaceResponse.status !== 201) throw new Error(`workspace creation failed (${workspaceResponse.status})`);
  const workspace = await workspaceResponse.json();
  if (typeof workspace !== "object" || workspace === null || !("id" in workspace) || typeof workspace.id !== "string") {
    throw new Error("workspace response missing id");
  }
  const principalResponse = await app.handle(new Request(`http://localhost/api/v1/workspaces/${workspace.id}/principals`, {
    method: "POST", headers: { cookie, origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify({ name: "Researcher" }),
  }));
  if (principalResponse.status !== 201) throw new Error(`principal creation failed (${principalResponse.status})`);
  const principal = await principalResponse.json();
  if (typeof principal !== "object" || principal === null || !("id" in principal) || typeof principal.id !== "string") {
    throw new Error("principal response missing id");
  }
  return { app, cookie, workspaceId: workspace.id, principalId: principal.id };
}

export async function issueKey(app: App, cookie: string, workspaceId: string, principalId: string): Promise<string> {
  const response = await app.handle(new Request(`http://localhost/api/v1/workspaces/${workspaceId}/principals/${principalId}/keys`, {
    method: "POST", headers: { cookie, origin: "http://localhost", "content-type": "application/json" },
  }));
  if (response.status !== 201) throw new Error(`key issuance failed (${response.status})`);
  const credential = await response.json();
  if (typeof credential !== "object" || credential === null || !("key" in credential) || typeof credential.key !== "string") {
    throw new Error("credential response missing key");
  }
  return credential.key;
}

// Run-bound scenarios mint their Run through the same authenticated route as agents.
export async function createRun(app: App, key: string, workspaceId: string): Promise<string> {
  const response = await app.handle(new Request(`http://localhost/api/v1/workspaces/${workspaceId}/runs`, {
    method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: "{}",
  }));
  if (response.status !== 201) throw new Error(`Run creation failed (${response.status}): ${await response.text()}`);
  const run = await response.json();
  if (typeof run !== "object" || run === null || !("id" in run) || typeof run.id !== "string") {
    throw new Error("Run response missing id");
  }
  return run.id;
}

