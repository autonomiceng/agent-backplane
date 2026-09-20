// Local installation entrypoint; the injected runner lets tests exercise custody without Docker.
import { persistWorkerdEvidence, verifyWorkerdImage } from "./workerd-image.ts";
import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { privateRead, privateWrite, privateLock } from "../../packages/cli/runtime/credential-file.ts";
import { CliError, type Environment } from "../../packages/cli/runtime/credentials.ts";
import { resolveAccess } from "../compose/validate-edge.ts";
export type Runner = (args: string[], env: Environment) => Promise<string>;
export type StatusRecorder = (args: string[]) => Promise<void>;
const core = ["BP_AUTH_SECRET", "BP_POSTGRES_ADMIN_PASSWORD", "BP_POSTGRES_PASSWORD", "BP_OPERATIONS_TOKEN"];
const blobs = ["BP_RUSTFS_ROOT_USER", "BP_RUSTFS_ROOT_PASSWORD", "BP_BLOB_S3_ACCESS_KEY", "BP_BLOB_S3_SECRET_KEY"];
export async function prepare(argv: string[], env: Environment, run: Runner = docker, recordStatus: StatusRecorder = statusRecorder): Promise<string> {
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
  const root = resolve(import.meta.dir, "../..");
  const unlock = await privateLock(`${path}.lock`);
  try {
    let source = await privateRead(path, true);
    const originalSource = source, entries: Record<string, string> = {}, lines = (source ?? "").split("\n");
    const managed = new Set([...core, ...blobs, "BP_COMPUTE_TOKEN", "BP_PUBLIC_URL", "BP_PUBLIC_DOMAIN", "BP_SCHEME", "BP_TLS_ISSUER", "BP_EDGE_CA", "BP_PUBLIC_HOST", "BP_EDGE_BIND_HOST", "BP_ACCESS_MODE", "BP_AUTH_URL", "BP_PORT", "BP_BIND_HOST", "BP_HTTP_PORT", "BP_HTTPS_PORT", "BP_BACKUP_DIR", "BP_POSTGRES_IMAGE", "BP_SERVER_IMAGE", "BP_CADDY_IMAGE", "BP_RUSTFS_IMAGE", "BP_BLOB_BOOTSTRAP_IMAGE", "BP_WORKERD_REPOSITORY", "BP_WORKERD_DIGEST", "BP_WORKERD_IMAGE", "BP_WORKERD_BINARY_SHA256", "BP_DATA_DIR", "BP_STATUS_DIR", "BP_PLATFORM_NETWORK", "BP_VOLUME_PREFIX", "BP_BACKUP_KEEP"]);
    let statusLine: number | undefined;
    for (const [index, line] of lines.entries()) {
      if (!line.trim() || line.trimStart().startsWith("#")) continue;
      const name = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)/.exec(line)?.[1];
      if (name === "BP_WORKERD_EFFECTIVE_IMAGE") throw new CliError("workerd_effective_image_persisted", 1);
      if (!name || !managed.has(name)) continue;
      if (name === "BP_STATUS_DIR") {
        if (statusLine !== undefined) throw new CliError("env_repair_required", 1);
        statusLine = index;
      }
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
    const statusDir = resolve(dirname(path), entries.BP_STATUS_DIR ?? "data");
    if (statusDir === "/" || /[\n\r$`'"\\]/.test(statusDir)) throw new CliError("unsafe_status_directory", 1);
    entries.BP_STATUS_DIR = statusDir;
    const statusAssignment = `BP_STATUS_DIR='${statusDir}'`;
    if (statusLine === undefined) additions.push(statusAssignment);
    else { lines[statusLine] = statusAssignment; source = lines.join("\n"); }
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
    if (!entries.BP_BACKUP_DIR || !(await stat(entries.BP_BACKUP_DIR).catch(() => undefined))?.isDirectory()) throw new CliError("backup_directory_required", 1);
    await recordStatus(["--state-dir", statusDir, "--prepare"]);
    const child = Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith("BP_") && !["COMPOSE_FILE", "COMPOSE_PROFILES", "COMPOSE_PROJECT_NAME", "COMPOSE_ENV_FILES"].includes(k)));
    if (env.DOCKER_HOST && !env.DOCKER_HOST.startsWith("unix://")) throw new CliError("remote_docker_unsupported", 1);
    const endpoint = (await run(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], child)).trim();
    if (!endpoint.startsWith("unix://")) throw new CliError("remote_docker_unsupported", 1);
    const started = new Date().toISOString();
    const statusRecord = ["--state-dir", statusDir, "--checkout", root, "--env-file", path, "--started", started];
    await recordStatus([...statusRecord, "--state", "unavailable"]);
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
    if (source === undefined || source !== originalSource || additions.length) await privateWrite(path, (source ?? "") + (source && !source.endsWith("\n") ? "\n" : "") + additions.join("\n") + "\n", source !== undefined);
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
    await recordStatus([...statusRecord, "--state", "healthy"]);
    return `bp bootstrap --url '${url}' --email USER_EMAIL --capability-file '${capabilityPath.replaceAll("'", "'\\''")}'\n`;
  } finally { await unlock(); }
}
async function docker(args: string[], env: Environment): Promise<string> {
  const child = Bun.spawn(["docker", ...args], { env, stdout: "pipe", stderr: "pipe" });
  const [stdout] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (await child.exited !== 0) throw new CliError("compose_command_failed", 2);
  return stdout;
}
async function statusRecorder(args: string[]): Promise<void> {
  const child = Bun.spawn(["python3", resolve(import.meta.dir, "../../scripts/record_status.py"), ...args], { stdout: "ignore", stderr: "ignore" });
  const timeout = setTimeout(() => child.kill(), 10_000);
  try { if (await child.exited !== 0) throw new CliError("status_record_failed", 2); }
  finally { clearTimeout(timeout); }
}
if (import.meta.main) try { process.stdout.write(await prepare(process.argv.slice(2), process.env)); }
catch (e) { process.stderr.write(`${JSON.stringify({ error: e instanceof CliError ? e.error : "prepare_failed" })}\n`); process.exitCode = e instanceof CliError ? e.exit : 1; }
