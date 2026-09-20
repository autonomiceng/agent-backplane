// Local installation entrypoint; the injected runner lets tests exercise custody without Docker.
import { persistWorkerdEvidence, verifyWorkerdImage } from "./workerd-image.ts";
import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isIP } from "node:net";
import { normalizeOrigin } from "../../apps/server/platform/config.ts";
import { privateRead, privateWrite, privateLock } from "../../packages/cli/runtime/credential-file.ts";
import { CliError, type Environment } from "../../packages/cli/runtime/credentials.ts";
import { resolveAccess } from "../compose/validate-edge.ts";
export type Runner = (args: string[], env: Environment) => Promise<string>;
const core = ["BP_AUTH_SECRET", "BP_POSTGRES_ADMIN_PASSWORD", "BP_POSTGRES_PASSWORD", "BP_OPERATIONS_TOKEN"];
const blobs = ["BP_RUSTFS_ROOT_USER", "BP_RUSTFS_ROOT_PASSWORD", "BP_BLOB_S3_ACCESS_KEY", "BP_BLOB_S3_SECRET_KEY"];
// These values enter Caddy tokens and expressions. Accept literals, never Caddy syntax.
export function resolveRustfsConsole(env: Environment, profiles: string[], access: ReturnType<typeof resolveAccess>) {
  const enabled = env.BP_RUSTFS_CONSOLE ?? "false";
  if (enabled !== "true" && enabled !== "false") throw new CliError("rustfs_console_invalid", 1);
  if (enabled === "true" && (!profiles.includes("blobs") || !profiles.some(p => p === "edge" || p === "gateway")))
    throw new CliError("rustfs_console_requires_blobs_and_ingress", 1);
  if (enabled === "true" && env.BP_BLOB_BACKEND && env.BP_BLOB_BACKEND !== "s3") throw new CliError("rustfs_console_storage_conflict", 1);
  const dns = (host: string) => host.length <= 253 && host.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
  const host = (env.BP_RUSTFS_HOST ?? `rustfs.${env.BP_PUBLIC_DOMAIN || "localhost"}`).toLowerCase();
  if (!dns(host) || isIP(host)) throw new CliError("rustfs_host_invalid", 1);
  if (access.mode === "public" && (!host.includes(".") || host.endsWith(".localhost"))) throw new CliError("rustfs_host_invalid", 1);
  if (enabled === "true" && access.mode === "proxy" && !env.BP_RUSTFS_URL) throw new CliError("rustfs_url_required", 1);
  let origin: string;
  try { origin = normalizeOrigin(env.BP_RUSTFS_URL ?? `https://${host}:${env.BP_HTTPS_PORT || "443"}`); }
  catch { throw new CliError("rustfs_url_invalid", 1); }
  const url = new URL(origin), browser = new URL(access.origin);
  if ((!dns(url.hostname) && !isIP(url.hostname.replace(/^\[|\]$/g, ""))) || url.port === "0"
    || (access.mode !== "local" && url.protocol !== "https:")) throw new CliError("rustfs_url_invalid", 1);
  if (profiles.includes("edge")) {
    const port = url.protocol === "https:" ? env.BP_HTTPS_PORT || "443" : env.BP_HTTP_PORT || "80";
    if (url.hostname !== host || Number(url.port || (url.protocol === "https:" ? "443" : "80")) !== Number(port))
      throw new CliError("rustfs_url_listener_conflict", 1);
  }
  // Gateway routing sees authority, not scheme. Native aliases must not capture Backplane.
  if (url.host === browser.host || host === browser.hostname || host === access.host
    || ["localhost", "127.0.0.1"].includes(host))
    throw new CliError("rustfs_origin_conflict", 1);
  const allow = env.BP_RUSTFS_CONSOLE_ALLOW ?? "127.0.0.1/8 ::1", peers = env.BP_TRUSTED_PROXIES ?? "";
  for (const [value, exact] of [[allow, false], [peers, true]] as const) {
    if ((!value.trim() && !exact) || /[^a-fA-F0-9:./ ]/.test(value)) throw new CliError(exact ? "trusted_proxies_invalid" : "operator_allow_invalid", 1);
    for (const literal of value.split(" ").filter(Boolean)) {
      const [ip = "", mask, extra] = literal.split("/"), family = isIP(ip), bits = family === 4 ? 32 : 128;
      if (!family || extra !== undefined || (mask !== undefined && (!/^(0|[1-9][0-9]*)$/.test(mask) || Number(mask) > bits || (!exact && Number(mask) === 0) || (exact && Number(mask) !== bits))))
        throw new CliError(exact ? "trusted_proxies_invalid" : "operator_allow_invalid", 1);
    }
  }
  if (enabled === "true" && access.mode === "proxy" && !peers.trim()) throw new CliError("trusted_proxies_required", 1);
  return { enabled, host, origin, authority: url.host, urlHost: url.hostname.replace(/^\[|\]$/g, "") };
}

export async function prepare(argv: string[], env: Environment, run: Runner = docker): Promise<string> {
  const { values } = parseArgs({ args: argv, allowPositionals: false, options: {
    "access-mode": { type: "string" }, "public-url": { type: "string" }, "backup-dir": { type: "string" }, "env-file": { type: "string" },
    "capability-file": { type: "string" }, "compose-project": { type: "string" }, profile: { type: "string", multiple: true },
  } });
  const profiles = [...new Set(values.profile ?? [])];
  if (profiles.some(p => !["blobs", "compute", "edge", "gateway"].includes(p)) || !values["capability-file"]) throw new CliError("invalid_arguments", 1);
  if (profiles.includes("edge") && profiles.includes("gateway")) throw new CliError("choose_one_gateway", 1);
  const project = values["compose-project"] ?? "agent-backplane";
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(project)) throw new CliError("invalid_compose_project", 1);
  const path = resolve(values["env-file"] ?? resolve(import.meta.dir, "../../.env"));
  const unlock = await privateLock(`${path}.lock`);
  try {
    const source = await privateRead(path, true), entries: Record<string, string> = {};
    const managed = new Set([...core, ...blobs, "BP_COMPUTE_TOKEN", "BP_PUBLIC_URL", "BP_PUBLIC_DOMAIN", "BP_SCHEME", "BP_TLS_ISSUER", "BP_EDGE_CA", "BP_PUBLIC_HOST", "BP_EDGE_BIND_HOST", "BP_ACCESS_MODE", "BP_AUTH_URL", "BP_PORT", "BP_BIND_HOST", "BP_HTTP_PORT", "BP_HTTPS_PORT", "BP_BACKUP_DIR", "BP_POSTGRES_IMAGE", "BP_SERVER_IMAGE", "BP_CADDY_IMAGE", "BP_RUSTFS_IMAGE", "BP_BLOB_BOOTSTRAP_IMAGE", "BP_WORKERD_REPOSITORY", "BP_WORKERD_DIGEST", "BP_WORKERD_IMAGE", "BP_WORKERD_BINARY_SHA256", "BP_DATA_DIR", "BP_PLATFORM_NETWORK", "BP_VOLUME_PREFIX", "BP_BACKUP_KEEP", "BP_BLOB_BACKEND", "BP_RUSTFS_CONSOLE", "BP_RUSTFS_HOST", "BP_RUSTFS_URL", "BP_RUSTFS_URL_HOST", "BP_RUSTFS_AUTHORITY", "BP_RUSTFS_CONSOLE_ALLOW", "BP_TRUSTED_PROXIES"]);
    for (const line of (source ?? "").split("\n")) {
      if (!line.trim() || line.trimStart().startsWith("#")) continue;
      const name = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)/.exec(line)?.[1];
      if (name === "BP_WORKERD_EFFECTIVE_IMAGE") throw new CliError("workerd_effective_image_persisted", 1);
      if (!name || !managed.has(name)) continue;
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
      if (match?.[1] && match[2] === "" && entries[match[1]] === undefined) continue;
      if (!match?.[1] || !match[2] || entries[match[1]] !== undefined || /[$`\r]/.test(match[2])) throw new CliError("env_repair_required", 1);
      let value = match[2];
      if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
      else if (/[\s#]/.test(value)) throw new CliError("env_repair_required", 1);
      if (!value || /['"\\\n]/.test(value)) throw new CliError("env_repair_required", 1);
      entries[match[1]] = value;
    }
    const keys = [...core, ...(profiles.includes("blobs") ? blobs : []), ...(profiles.includes("compute") ? ["BP_COMPUTE_TOKEN"] : [])];
    const additions: string[] = [];
    for (const [key, value] of [["BP_ACCESS_MODE", values["access-mode"]], ["BP_PUBLIC_URL", values["public-url"]], ["BP_BACKUP_DIR", values["backup-dir"]]]) {
      if (!key || value === undefined) continue;
      if (/[\n\r$`'"\\]/.test(value) || entries[key] !== undefined && entries[key] !== value) throw new CliError("env_conflict", 1);
      if (entries[key] === undefined) { entries[key] = value; additions.push(`${key}='${value}'`); }
    }
    const access = resolveAccess(entries, profiles.includes("edge")), url = access.origin;
    if (profiles.includes("gateway") && access.mode !== "proxy") throw new CliError("gateway_requires_proxy_mode", 1);
    for (const [key, value] of [["BP_ACCESS_MODE", access.mode], ["BP_PUBLIC_URL", url]]) {
      if (key && value && entries[key] === undefined) { entries[key] = value; additions.push(`${key}='${value}'`); }
    }
    const console = resolveRustfsConsole(entries, profiles, access);
    // Refresh derived routing fields when the selected URL changes; never replace user settings.
    let output = source ?? "";
    for (const [key, value] of [["BP_RUSTFS_URL_HOST", console.urlHost], ["BP_RUSTFS_AUTHORITY", console.authority]]) {
      if (!key || !value || entries[key] === value) continue;
      if (entries[key] !== undefined) output = output.replace(new RegExp(`^${key}=.*$`, "m"), `${key}='${value}'`);
      else additions.push(`${key}='${value}'`);
    }
    if (!entries.BP_BACKUP_DIR || !(await stat(entries.BP_BACKUP_DIR).catch(() => undefined))?.isDirectory()) throw new CliError("backup_directory_required", 1);
    const child = Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith("BP_") && !["COMPOSE_FILE", "COMPOSE_PROFILES", "COMPOSE_PROJECT_NAME", "COMPOSE_ENV_FILES"].includes(k)));
    if (env.DOCKER_HOST && !env.DOCKER_HOST.startsWith("unix://")) throw new CliError("remote_docker_unsupported", 1);
    const endpoint = (await run(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], child)).trim();
    if (!endpoint.startsWith("unix://")) throw new CliError("remote_docker_unsupported", 1);
    const network = entries.BP_PLATFORM_NETWORK ?? "platform", prefix = entries.BP_VOLUME_PREFIX ?? "agent-backplane";
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(network)) throw new CliError("invalid_platform_network", 1);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(prefix)) throw new CliError("invalid_volume_prefix", 1);
    try { await run(["network", "inspect", network], child); }
    catch { await run(["network", "create", network], child); }
    const volumes = await run(["volume", "ls", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.Name}}"], child);
    const existingVolumes = await run(["volume", "ls", "--format", "{{.Name}}"], child);
    if ((volumes.trim() || existingVolumes.split("\n").some(v => v.startsWith(`${prefix}_`))) && keys.some(k => entries[k] === undefined)) throw new CliError("existing_volume_missing_secrets", 2);
    if (profiles.includes("compute")) {
      const identity = await verifyWorkerdImage(entries, child, run);
      await persistWorkerdEvidence(resolve(dirname(path), entries.BP_DATA_DIR ?? "data"), identity);
      child.BP_WORKERD_EFFECTIVE_IMAGE = identity.imageId;
      child.BP_WORKERD_HOST_IMAGE_ID = identity.imageId;
    }
    for (const key of keys) if (entries[key] === undefined) {
      // RustFS service-account creation accepts at most 40 characters.
      const bytes = key === "BP_RUSTFS_ROOT_USER" || key === "BP_BLOB_S3_ACCESS_KEY" ? 10 : key === "BP_BLOB_S3_SECRET_KEY" ? 20 : 32;
      entries[key] = randomBytes(bytes).toString("hex");
      additions.push(`${key}=${entries[key]}`);
    }
    if (source === undefined || output !== source || additions.length) await privateWrite(path, output + (output && !output.endsWith("\n") ? "\n" : "") + (additions.length ? additions.join("\n") + "\n" : ""), source !== undefined);
    const root = resolve(import.meta.dir, "../..");
    const compose = ["compose", "--project-name", project, "--project-directory", root, "--env-file", path, "-f", resolve(root, "compose.yaml"),
      ...profiles.flatMap(p => ["-f", resolve(root, `compose.${p}.yaml`)]), ...profiles.flatMap(p => ["--profile", p])];
    for (const volume of ["postgres-data", "server-data", "edge-data", "edge-config", ...(profiles.includes("blobs") ? ["rustfs-data"] : [])]) {
      await run(["volume", "create", "--label", `com.docker.compose.project=${project}`, `${prefix}_${volume}`], child);
    }
    await run([...compose, "up", ...(entries.BP_SERVER_IMAGE ? ["--no-build"] : []), "--wait"], child);
    const readiness: unknown = JSON.parse(await run([...compose, "exec", "-T", "server", "sh", "-ec", 'exec curl -fsS -H "Authorization: Bearer $BP_OPERATIONS_TOKEN" http://localhost:3000/health/ready'], child));
    if (typeof readiness !== "object" || readiness === null || !("enrollment" in readiness) || typeof readiness.enrollment !== "object" || readiness.enrollment === null || !("state" in readiness.enrollment)) throw new CliError("invalid_readiness", 2);
    const capabilityPath = resolve(values["capability-file"]);
    if (readiness.enrollment.state === "pending") {
      const capability = await run([...compose, "exec", "-T", "server", "cat", "/data/enrollment/capability"], child);
      if (!/^[a-f0-9]{64}\n?$/.test(capability)) throw new CliError("invalid_capability", 2);
      const existing = await privateRead(capabilityPath);
      if (existing !== undefined && existing !== capability) throw new CliError("capability_recovery_required", 2);
      if (existing === undefined) await privateWrite(capabilityPath, capability);
    } else if (readiness.enrollment.state !== "claimed") throw new CliError("enrollment_recovery_required", 2);
    return (console.enabled === "true" ? `RustFS console: ${console.origin}/rustfs/console/\n` : "") + `bp bootstrap --url '${url}' --email USER_EMAIL --capability-file '${capabilityPath.replaceAll("'", "'\\''")}'\n`;
  } finally { await unlock(); }
}
async function docker(args: string[], env: Environment): Promise<string> {
  const child = Bun.spawn(["docker", ...args], { env, stdout: "pipe", stderr: "pipe" });
  const [stdout] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (await child.exited !== 0) throw new CliError("compose_command_failed", 2);
  return stdout;
}
if (import.meta.main) try { process.stdout.write(await prepare(process.argv.slice(2), process.env)); }
catch (e) { process.stderr.write(`${JSON.stringify({ error: e instanceof CliError ? e.error : "prepare_failed" })}\n`); process.exitCode = e instanceof CliError ? e.exit : 1; }
