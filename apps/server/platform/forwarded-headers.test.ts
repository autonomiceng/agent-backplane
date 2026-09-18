// Direct-app ingress scenarios use enrolled Users and real PostgreSQL; TLS itself is the edge acceptance gate.
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../app.ts";
import { createAuth } from "../auth/auth.ts";
import { createEnrollment } from "../auth/enrollment.ts";
import { capabilityPath } from "../auth/enrollment-file.ts";
import { latestMigrationVersion, migratedDatabase } from "../testing/postgres.ts";
import { createPool } from "./pool.ts";
import { readConfig, resolvePublicOrigin } from "./config.ts";
import { originDiagnostic, unavailable } from "./readiness.ts";
import { readOperationsConfig } from "./operations.ts";
import { credentials } from "../../../packages/cli/runtime/credentials.ts";
import { validateEdge } from "../../../infra/compose/validate-edge.ts";

const email = "ingress@example.com", password = "ingress-enrollment-password", operator = "ingress-operator-token";
const spoof = { forwarded: 'for=198.51.100.9;host=evil.example;proto=http', "x-forwarded-host": "evil.example",
  "x-forwarded-proto": "http", "x-forwarded-for": "198.51.100.9", "x-forwarded-port": "80",
  "x-forwarded-arbitrary": "untrusted", "x-real-ip": "198.51.100.9", "cf-connecting-ip": "198.51.100.9", "true-client-ip": "198.51.100.9" };
const upstream = (path: string, body?: unknown, headers: Record<string, string> = {}) => new Request(`http://localhost${path}`, {
  headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
});
const cookieOf = (response: Response) => response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
async function fixture(publicOrigin: string) {
  const pool = createPool(await migratedDatabase()), dataDir = await mkdtemp(join(tmpdir(), "bp-ingress-"));
  try {
    const config = readConfig({ BP_DATABASE_URL: "postgres://unused", BP_AUTH_SECRET: "ingress-test-secret-longer-than-thirty-two",
      BP_PUBLIC_URL: publicOrigin, BP_DATA_DIR: dataDir });
    const auth = createAuth(pool, config), enrollment = createEnrollment(pool, config);
    await enrollment.prepare();
    const app = createApp({ pool, auth, enrollment, authUrl: config.publicOrigin, insecureOrigin: config.insecureOrigin,
      expectedSchemaVersion: await latestMigrationVersion(), operations: readOperationsConfig({ BP_OPERATIONS_TOKEN: operator }) });
    const capability = await readFile(capabilityPath(dataDir), "utf8");
    expect((await app.handle(upstream("/api/v1/enrollment", { capability, email, password }, { origin: publicOrigin, ...spoof }))).status).toBe(201);
    return { app, pool, auth, async close() { try { await pool.close(); } finally { await rm(dataDir, { recursive: true, force: true }); } } };
  } catch (error) { try { await pool.close(); } finally { await rm(dataDir, { recursive: true, force: true }); } throw error; }
}

test("spoofed proxy headers bypass authentication or operator authorization", async () => {
  const origin = (env: Record<string, string | undefined>) => resolvePublicOrigin(env, "http://localhost:3000");
  expect(origin({ BP_PUBLIC_URL: "HTTPS://BÜCHER.example:443/", BP_AUTH_URL: "https://xn--bcher-kva.example" })).toBe("https://xn--bcher-kva.example");
  expect(origin({ BP_PUBLIC_URL: "", BP_AUTH_URL: "https://backplane.example" })).toBe("https://backplane.example");
  expect(origin({ BP_PUBLIC_URL: "http://127.42.0.1" })).toBe("http://127.42.0.1");
  expect(origin({ BP_PUBLIC_URL: "http://[::1]" })).toBe("http://[::1]");
  expect(origin({ BP_PUBLIC_URL: "http://backplane.example", BP_ALLOW_INSECURE_ORIGIN: "true" })).toBe("http://backplane.example");
  for (const value of ["https://a.example/path/..", "https://a.example?", "https://a.example#", "https://@a.example",
    "https://a.example\\", " https://a.example", "https://a.example\n", "https://", "ftp://a.example", "http://localhost.example", "http://[::ffff:127.0.0.1]"]) {
    expect(() => origin({ BP_PUBLIC_URL: value })).toThrow();
  }
  expect(() => origin({ BP_ALLOW_INSECURE_ORIGIN: "1" })).toThrow();
  expect(() => origin({ BP_PUBLIC_URL: "https://a.example", BP_AUTH_URL: "https://b.example" })).toThrow("must match");
  const client = (env: Record<string, string | undefined>) => credentials(env, "none", undefined).url;
  expect(client({ BP_PUBLIC_URL: "HTTPS://BP.EXAMPLE:443/", BP_URL: "https://bp.example", BP_AUTH_URL: "https://bp.example/" })).toBe("https://bp.example");
  expect(client({ BP_URL: "http://127.42.0.1/" })).toBe("http://127.42.0.1");
  expect(client({ BP_AUTH_URL: "https://bp.example" })).toBe("https://bp.example");
  expect(() => credentials({ BP_PUBLIC_URL: "https://a.example", BP_URL: "https://b.example", BP_KEY: "invalid" }, "principal", undefined)).toThrow("BP_URL_conflict");
  expect(() => client({ BP_URL: "https://a.example", BP_AUTH_URL: "https://b.example" })).toThrow("BP_URL_conflict");
  expect(() => client({ BP_PUBLIC_URL: "http://a.example", BP_ALLOW_INSECURE_ORIGIN: "true" })).toThrow("BP_URL_invalid");
  const edge = { BP_PUBLIC_URL: "https://bp.example", BP_PUBLIC_HOST: "bp.example", BP_TLS_ISSUER: "acme", BP_CADDY_DIGEST: "a".repeat(64) };
  expect(validateEdge(edge).origin).toBe(edge.BP_PUBLIC_URL);
  expect(() => validateEdge({ ...edge, BP_BIND_HOST: "0.0.0.0" })).toThrow();
  expect(() => validateEdge({ ...edge, BP_PUBLIC_HOST: "bp.example:443" })).toThrow();
  expect(() => validateEdge({ ...edge, BP_EDGE_CA: "off" })).toThrow();
  expect(() => validateEdge({ ...edge, BP_CADDY_DIGEST: "latest" })).toThrow();
  expect(() => validateEdge({ ...edge, BP_PUBLIC_URL: "https://other.example" })).toThrow();

  const f = await fixture("http://localhost");
  try {
    const ready = await f.app.handle(upstream("/health/ready"));
    expect(ready.status).toBe(200); expect((await ready.json()).problems).toEqual(["insecure_origin"]);
    expect(originDiagnostic(unavailable("offline"), true)).toMatchObject({ status: "not_ready", problems: ["database unavailable: offline", "insecure_origin"] });
    expect((await f.app.handle(upstream("/api/v1/workspaces", { name: "Unauthorized" }, spoof))).status).toBe(401);
    const request = upstream("/api/auth/sign-in/email", { email, password }, { ...spoof, host: "evil.example", origin: "http://localhost" });
    const login = await f.app.handle(request); expect(login.status).toBe(200);
    for (const name of Object.keys(spoof)) expect(request.headers.has(name)).toBe(false);
    expect(login.headers.getSetCookie()[0]).toStartWith("better-auth.session_token=");
    expect(login.headers.getSetCookie()[0]).not.toContain("; Secure");
    const cookie = cookieOf(login);
    const workspaceResponse = await f.app.handle(upstream("/api/v1/workspaces", { name: "Ingress" }, { cookie, origin: "http://localhost" }));
    expect(workspaceResponse.status).toBe(201); const workspace = await workspaceResponse.json();
    const principalResponse = await f.app.handle(upstream(`/api/v1/workspaces/${workspace.id}/principals`, { name: "Ingress" }, { cookie, origin: "http://localhost" }));
    expect(principalResponse.status).toBe(201); const principal = await principalResponse.json();
    const keyResponse = await f.app.handle(upstream(`/api/v1/workspaces/${workspace.id}/principals/${principal.id}/keys`, {}, { cookie, origin: "http://localhost" }));
    expect(keyResponse.status).toBe(201); const { key } = await keyResponse.json();
    for (const path of ["/health/operations", "/metrics"]) {
      for (const actor of [{}, { cookie }, { authorization: `Bearer ${key}` }]) {
        expect((await f.app.handle(upstream(path, undefined, { ...spoof, ...actor }))).status).toBe(401);
      }
    }
    const metrics = await f.app.handle(upstream("/metrics", undefined, { ...spoof, authorization: `Bearer ${operator}` }));
    expect(metrics.status).toBe(200); expect(await metrics.text()).toContain("bp_operations_status");
    const operations = await f.app.handle(upstream("/health/operations", undefined, { ...spoof, authorization: `Bearer ${operator}` }));
    expect((await operations.json()).enrollment.state).toBe("claimed");
    await f.auth.api.signInEmail({ body: { email, password }, headers: new Headers(spoof) });
    const sessions = await f.pool<{ ipAddress: string | null }[]>`SELECT "ipAddress" FROM control.session`;
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    expect(sessions.every(session => session.ipAddress === "127.0.0.1" || !session.ipAddress)).toBe(true);
  } finally { await f.close(); }
});

test("TLS termination breaks secure login cookies or CSRF policy", async () => {
  const origin = "https://backplane.example", f = await fixture(origin);
  try {
    const login = await f.app.handle(upstream("/api/auth/sign-in/email", { email, password }, {
      ...spoof, host: "upstream.internal:3000", origin, "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors",
    }));
    expect(login.status).toBe(200);
    const cookies = login.headers.getSetCookie(); expect(cookies).toHaveLength(1);
    const parts = cookies[0]!.split("; ");
    expect(parts.shift()).toMatch(/^__Secure-better-auth\.session_token=[^;\s]+$/);
    expect(parts.sort()).toEqual(["HttpOnly", "Max-Age=604800", "Path=/", "SameSite=Lax", "Secure"].sort());
    const cookie = cookieOf(login);
    const session = await f.app.handle(upstream("/api/auth/get-session", undefined, { cookie, ...spoof }));
    expect(session.status).toBe(200); expect((await session.json()).user.email).toBe(email);
    const hostile = { cookie, origin: "https://evil.example", ...spoof };
    const rejected = await f.app.handle(upstream("/api/auth/sign-in/email", { email, password }, hostile));
    expect(rejected.status).toBe(403); expect(rejected.headers.getSetCookie()).toEqual([]);
    const mutation = await f.app.handle(upstream("/api/v1/workspaces", { name: "Forbidden" }, hostile));
    expect(mutation.status).toBe(403); expect(await mutation.json()).toEqual({ error: "origin_forbidden" });
    expect((await f.app.handle(upstream("/api/v1/workspaces", { name: "Browser" }, { cookie, origin, ...spoof }))).status).toBe(201);
    const missingOrigin = await f.app.handle(upstream("/api/v1/workspaces", { name: "Missing Origin" }, { cookie }));
    expect(missingOrigin.status).toBe(403); expect(await missingOrigin.json()).toEqual({ error: "origin_forbidden" });
    const form = new Request("http://localhost/api/v1/workspaces", { method: "POST", body: "name=Form",
      headers: { cookie, origin, "content-type": "application/x-www-form-urlencoded" } });
    expect((await f.app.handle(form)).status).toBe(403);
    const crossSite = await f.app.handle(upstream("/api/auth/sign-in/email", { email, password }, { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" }));
    expect(crossSite.status).toBe(403);
    expect((await (await f.app.handle(upstream("/health/ready"))).json()).problems).not.toContain("insecure_origin");
  } finally { await f.close(); }
});
