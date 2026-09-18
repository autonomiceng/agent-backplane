// One release scenario against an already-running core + edge overlay with its internal CA explicitly trusted.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { validateEdge } from "../../infra/compose/validate-edge.ts";
import { record } from "../../packages/cli/runtime/http.ts";

function required(name: string): string { const value = Bun.env[name]; assert(value, `${name} is required; ingress acceptance never skips`); return value; }
async function command(args: string[]): Promise<string> {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 30_000);
  try {
    const [out, , code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    assert.equal(code, 0, `${args[0]} ${args[1]} failed; output withheld to protect credentials`); return out;
  } finally { clearTimeout(timer); }
}
async function text(response: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of response) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
}
async function scenario() {
  assert(Bun.which("docker"), "docker is required; ingress acceptance never skips");
  const edge = validateEdge(Bun.env); assert.equal(edge.ca, "internal", "acceptance requires BP_EDGE_CA=internal");
  const ca = await readFile(required("BP_EDGE_CA_CERT")), token = required("BP_OPERATIONS_TOKEN");
  const email = required("BP_USER_EMAIL"), password = required("BP_USER_PASSWORD");
  const root = resolve(import.meta.dir, "../..");
  const base = ["docker", "compose", "--project-directory", root, "-f", `${root}/compose.yaml`,
    "-f", `${root}/compose.edge.yaml`, "--profile", "edge"];
  const compose = (...args: string[]) => command([...base, ...args]);
  const config = JSON.parse(await compose("config", "--no-env-resolution", "--format", "json"));
  assert(!config.services.server.env_file, "server env_file exposes host secrets");
  const serverEnv = config.services.server.environment;
  assert.equal(new URL(serverEnv.BP_PUBLIC_URL).origin, edge.origin);
  const allowed = new Set(["BP_DATABASE_URL", "BP_PORT", "BP_DATA_DIR", "BP_OPERATIONS_TOKEN",
    "NODE_ENV", "BP_RETENTION_PURGE_INTERVAL", "BP_BACKUP_KEEP",
    "BP_BACKUP_DIR", "BP_AUTH_SECRET", "BP_PUBLIC_URL", "BP_AUTH_URL", "BP_SIGNUP"]);
  assert(Object.keys(serverEnv).every(key => allowed.has(key)), "unexpected core server environment key");
  const ids = (await compose("ps", "-q", "server", "postgres", "edge")).trim().split(/\s+/);
  assert.equal(ids.length, 3, "server, postgres and edge must be running");
  const containers = JSON.parse(await command(["docker", "inspect", ...ids]));
  let direct = "";
  for (const service of ["server", "postgres"]) {
    const container = containers.find((value: { Config: { Labels: Record<string, string> } }) => value.Config.Labels["com.docker.compose.service"] === service);
    assert(container?.State.Running, `${service} is not running`);
    if (service === "postgres") {
      assert(Object.values(container.NetworkSettings.Ports).every(value => value === null), "core Postgres must remain unpublished");
      continue;
    }
    const target = "3000/tcp";
    const ports: { HostIp: string; HostPort: string }[] = container.NetworkSettings.Ports[target];
    assert(ports?.length, `${service} must publish its loopback port`);
    for (const port of ports) {
      assert(port.HostIp === "::1" || isIP(port.HostIp) === 4 && port.HostIp.startsWith("127."), `${service} port is publicly bound`);
      if (service === "server") direct = `http://${port.HostIp === "::1" ? "[::1]" : port.HostIp}:${port.HostPort}`;
    }
    assert(Object.entries(container.NetworkSettings.Ports).every(([key, value]) => key === target || value === null), `${service} has extra published ports`);
    if (service === "server") {
      const runtime = new Map<string, string>(container.Config.Env.map((entry: string) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]));
      assert.equal(runtime.get("BP_PUBLIC_URL"), serverEnv.BP_PUBLIC_URL);
      assert([...runtime.keys()].filter(key => key.startsWith("BP_")).every(key => allowed.has(key)), "unexpected runtime server key");
    }
  }
  const send = (origin: string, path: string, headers: Record<string, string> = {}, body?: unknown, signal = AbortSignal.timeout(10_000)) => {
    const url = new URL(origin), bytes = body === undefined ? undefined : JSON.stringify(body);
    return new Promise<IncomingMessage>((accept, reject) => {
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)({ protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ""), port: url.port || (url.protocol === "https:" ? 443 : 80),
        path, method: bytes === undefined ? "GET" : "POST", ca, rejectUnauthorized: true, agent: false, signal,
        headers: { ...headers, ...(bytes === undefined ? {} : { "content-type": "application/json", "content-length": String(Buffer.byteLength(bytes)) }) },
      }, accept);
      request.on("error", reject); request.end(bytes);
    });
  };
  const httpPort = Bun.env.BP_HTTP_PORT || "80";
  const httpOrigin = `http://${edge.host}${httpPort === "80" ? "" : `:${httpPort}`}`;
  const redirect = await send(httpOrigin, "/health/ready?probe=ingress");
  assert.equal(redirect.statusCode, 308); assert.equal(redirect.headers.location, `${edge.origin}/health/ready?probe=ingress`);
  assert.equal(redirect.headers["strict-transport-security"], undefined); await text(redirect);
  const ready = await send(edge.origin, "/health/ready");
  assert.equal(ready.statusCode, 200); assert.equal(ready.headers["strict-transport-security"], "max-age=31536000");
  assert.equal(JSON.parse(await text(ready)).enrollment.state, "claimed", "enroll a User before acceptance");
  // Pass raw paths to node:http so the client cannot erase traversal before Caddy receives it.
  for (const path of ["/health/operations", "/metrics", "//health//operations/", "/METRICS/", "/health/%6fperations",
    "/health%2foperations", "/health/./operations", "/x/../metrics", "/x/%2e%2e/metrics", "/%6detrics?probe=1",
    "/health/operations.", "/health/operations%2e", "/metrics..", "/metrics%2e%2e/"]) {
    for (const origin of [httpOrigin, edge.origin]) {
      const response = await send(origin, path, { authorization: `Bearer ${token}` });
      assert.equal(response.statusCode, 404, `operator path exposed: ${path}`);
      assert.equal(response.headers["strict-transport-security"], origin === edge.origin ? "max-age=31536000" : undefined);
      await text(response);
    }
  }
  const login = await send(edge.origin, "/api/auth/sign-in/email", { origin: edge.origin }, { email, password });
  assert.equal(login.statusCode, 200, "enrolled credentials must sign in over TLS"); await text(login);
  const cookies = login.headers["set-cookie"] ?? [];
  assert(cookies.some(cookie => cookie.startsWith("__Secure-better-auth.session_token=") && cookie.includes("; Secure")));
  const user = { cookie: cookies.map(cookie => cookie.split(";")[0]).join("; "), origin: edge.origin };
  const post = async (path: string, body: unknown) => {
    const response = await send(edge.origin, path, user, body);
    assert.equal(response.statusCode, 201, `API fixture failed: ${path}`);
    const value: unknown = JSON.parse(await text(response)); assert(record(value) && typeof value.id === "string"); return value.id;
  };
  const workspace = await post("/api/v1/workspaces", { name: `Ingress ${crypto.randomUUID()}` });
  const workspacePath = `/api/v1/workspaces/${workspace}`;
  const streamCount = async () => {
    const response = await send(direct, "/metrics", { authorization: `Bearer ${token}` });
    assert.equal(response.statusCode, 200, "loopback operator token must work");
    const metrics = await text(response), match = new RegExp(`^bp_streams_open\\{workspace_id="${workspace}"\\} (\\d+)$`, "m").exec(metrics);
    assert(match, "Workspace stream metric missing"); return Number(match[1]);
  };
  const baseline = await streamCount(); assert.equal(baseline, 0);
  const released = async () => {
    const end = performance.now() + 10_000;
    while (await streamCount() !== baseline) { assert(performance.now() < end, "disconnect leaked stream admission"); await Bun.sleep(200); }
  };
  const open = async (lastId?: string) => {
    const abort = new AbortController(), lifetime = setTimeout(() => abort.abort(), 45_000), started = performance.now();
    try {
      const response = await send(edge.origin, `${workspacePath}/events`, { ...user, ...(lastId ? { "last-event-id": lastId } : {}) }, undefined, abort.signal);
      assert.equal(response.statusCode, 200, "stream admission unavailable");
      assert(response.headers["content-type"]?.startsWith("text/event-stream"));
      const iterator = response[Symbol.asyncIterator](); let buffer = "";
      const frame = async (milliseconds: number) => {
        const timer = setTimeout(() => abort.abort(), milliseconds);
        try {
          while (!buffer.includes("\n\n")) { const chunk = await iterator.next(); assert(!chunk.done, "SSE ended before frame"); buffer += Buffer.from(chunk.value).toString(); }
          const boundary = buffer.indexOf("\n\n"), value = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2); return value;
        } finally { clearTimeout(timer); }
      };
      const first = await frame(5000); assert(first.startsWith("event: ready\n"));
      assert(performance.now() - started < 5000, "Caddy buffered ready");
      return { first, frame, close() { clearTimeout(lifetime); abort.abort(); response.destroy(); } };
    } catch (error) { clearTimeout(lifetime); abort.abort(); throw error; }
  };
  const initial = await open(); let cursor = "";
  try {
    const readyData = JSON.parse(initial.first.split("data: ")[1] ?? "");
    cursor = `v1:${workspace}:${readyData.generation}:${readyData.head}`;
    const end = performance.now() + 20_000;
    for (;;) { const frame = await initial.frame(Math.max(1, end - performance.now())); if (frame === ": heartbeat") break; assert(!frame.startsWith("event: error")); }
    assert(performance.now() <= end, "Caddy buffered heartbeat");
    assert.equal(await streamCount(), baseline + 1);
  } finally { initial.close(); }
  await released();
  const firstPrincipal = await post(`${workspacePath}/principals`, { name: "Resume first" });
  const secondPrincipal = await post(`${workspacePath}/principals`, { name: "Resume second" });
  const resumed = await open(cursor);
  try {
    assert(resumed.first.includes(`id: ${cursor}\n`));
    const events = [await resumed.frame(5000), await resumed.frame(5000)];
    const positions = events.map(frame => {
      assert(frame.startsWith("event: audit\n"));
      const id = frame.match(/^id: (.+)$/m)?.[1]; assert(id && id.startsWith(cursor.slice(0, cursor.lastIndexOf(":") + 1)));
      return BigInt(id.split(":")[3] ?? "");
    });
    const after = BigInt(cursor.split(":")[3] ?? "");
    assert.deepEqual(positions, [after + 1n, after + 2n], "Last-Event-ID must resume exclusively and in order");
    assert(events[0]?.includes(firstPrincipal)); assert(events[1]?.includes(secondPrincipal));
    assert.equal(await streamCount(), baseline + 1);
  } finally { resumed.close(); }
  await released();
}

try { await scenario(); console.log("PASS 1: Caddy fails secure ingress or SSE lifetime"); }
catch (error) {
  console.error(error instanceof Error ? error.message : "ingress acceptance failed");
  process.exitCode = 1;
}
