// Disposable Caddy probes, no application database or installed volumes.
// Block public certificate requests through a closed loopback proxy.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:https";
import { checkServerIdentity } from "node:tls";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../.."), directory = await mkdtemp(join(tmpdir(), "bp-access-"));
const project = `bp-access-${crypto.randomUUID()}`;
const imageConfig = await command(["docker", "compose", "--env-file", "/dev/null", "-f", join(root, "compose.edge.yaml"),
  "--profile", "edge", "config", "--no-consistency", "--format", "json"]);
const image: string = JSON.parse(imageConfig).services.edge.image;
assert(image);
const base = ["docker", "compose", "--project-name", project, "--project-directory", directory,
  "--env-file", "/dev/null", "-f", join(directory, "compose.json")];
async function command(args: string[]) {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe",
    env: { ...Object.fromEntries(Object.entries(Bun.env).filter(([key]) => !key.startsWith("BP_") && !key.startsWith("COMPOSE_"))),
      BP_PUBLIC_URL: "http://localhost:3000" } });
  const timer = setTimeout(() => child.kill(), 30_000);
  try {
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    assert.equal(code, 0, `${args.slice(0, 2).join(" ")}: ${err}`);
    return out.trim();
  } finally { clearTimeout(timer); }
}
async function start(mode: "local" | "public") {
  await Bun.write(join(directory, "upstream"), ':3000 {\n respond "backplane-fixture" 200\n}\n');
  const logging = { driver: "journald", options: { "cache-disabled": "true" } };
  await Bun.write(join(directory, "compose.json"), JSON.stringify({
    services: {
      server: { image, pull_policy: "never", logging, tmpfs: ["/data", "/config"],
        command: ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"],
        volumes: [`${join(directory, "upstream")}:/etc/caddy/Caddyfile:ro`] },
      edge: { image, pull_policy: "never", logging, tmpfs: ["/data", "/config"],
        environment: { BP_ACCESS_MODE: mode, BP_EDGE_HOST: "backplane.example.com", BP_PUBLIC_URL: "https://backplane.example.com",
          HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", NO_PROXY: "server,localhost,127.0.0.1" },
        ports: ["127.0.0.1::80", "127.0.0.1::443"],
        volumes: [`${join(root, "infra/compose/Caddyfile")}:/etc/caddy/Caddyfile:ro`] },
    }, networks: { default: {} },
  }));
  await command([...base, "up", "-d", "--pull", "never"]);
  const http = `http://${await command([...base, "port", "edge", "80"])}`;
  const tlsPort = Number((await command([...base, "port", "edge", "443"])).split(":").at(-1));
  const end = performance.now() + 15_000;
  while (true) {
    try { if ((await fetch(`${http}/health`, { signal: AbortSignal.timeout(1000) })).status === 200) break; } catch {}
    if (performance.now() >= end) throw new Error(`Caddy HTTP listener did not become ready: ${http}\n${await command([...base, "logs", "--no-log-prefix", "edge"])}`);
    await Bun.sleep(100);
  }
  return { http, tlsPort };
}
function tls(hostname: string, port: number, ca: Buffer) {
  return new Promise<{ status: number | undefined; headers: import("node:http").IncomingHttpHeaders; body: string }>((accept, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path: "/probe", ca, rejectUnauthorized: true,
      servername: hostname === "127.0.0.1" ? undefined : hostname, headers: { host: hostname },
      checkServerIdentity: (_host, certificate) => checkServerIdentity(hostname, certificate),
      signal: AbortSignal.timeout(5000), agent: false }, response => {
      let body = "";
      response.setEncoding("utf8"); response.on("data", chunk => { body += chunk; });
      response.on("end", () => accept({ status: response.statusCode, headers: response.headers, body }));
      response.on("error", reject);
    });
    req.on("error", reject); req.end();
  });
}
try {
  await command(["docker", "image", "inspect", image]);
  const local = await start("local");
  const ca = Buffer.from(await command([...base, "exec", "-T", "edge", "cat", "/data/caddy/pki/authorities/local/root.crt"]));
  const http = await fetch(`${local.http}/probe`, { redirect: "manual" });
  assert.equal(http.status, 200); assert.equal(await http.text(), "backplane-fixture");
  assert.equal(http.headers.get("location"), null); assert.equal(http.headers.get("strict-transport-security"), null);
  const https = await tls("backplane.example.com", local.tlsPort, ca);
  assert.equal(https.status, 200); assert.equal(https.body, "backplane-fixture");
  assert.equal(https.headers.location, undefined); assert.equal(https.headers["strict-transport-security"], undefined);
  await fetch(`${local.http}/probe?token=backplane-secret-query`, { headers: { "X-Api-Key": "backplane-secret-header" } });
  const logs = await command([...base, "logs", "--no-log-prefix", "edge"]);
  assert(logs.includes("http.log.access")); assert(logs.includes("/probe?REDACTED"));
  assert(!logs.includes("backplane-secret-query")); assert(!logs.includes("backplane-secret-header"));
  console.log("PASS 2: local HTTP and HTTPS without redirects/HSTS; journal access logs redact credentials");
  for (const host of ["localhost", "127.0.0.1"]) {
    const response = await tls(host, local.tlsPort, ca);
    assert.equal(response.status, 200); assert.equal(response.body, "backplane-fixture");
  }
  console.log("PASS 3: localhost and IP certificates verify against the exported public CA");
  await command([...base, "down", "--volumes"]);
  const publicEdge = await start("public");
  const redirect = await fetch(`${publicEdge.http}/probe?query=1`, { redirect: "manual" });
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get("location"), "https://backplane.example.com/probe?query=1");
  assert.equal(redirect.headers.get("strict-transport-security"), null);
  assert.equal((await fetch(`${publicEdge.http}/health`, { redirect: "manual" })).status, 200);
  console.log("PASS 4: public HTTP redirects to the canonical HTTPS origin except health");
} finally {
  try { if (await Bun.file(join(directory, "compose.json")).exists()) await command([...base, "down", "--volumes"]); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
