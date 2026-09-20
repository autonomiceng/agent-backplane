// Local installation entrypoint; the injected runner lets tests exercise custody without Docker.
import { persistWorkerdEvidence, verifyWorkerdImage } from "./workerd-image.ts";
import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import { lstat, open, rename, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { privateRead, privateWrite, privateLock } from "../../packages/cli/runtime/credential-file.ts";
import { CliError, type Environment } from "../../packages/cli/runtime/credentials.ts";
import { resolveAccess } from "../compose/validate-edge.ts";
import { record } from "../../packages/cli/runtime/http.ts";
export type Runner = (args: string[], env: Environment) => Promise<string>;
export type StatusRecorder = (args: string[]) => Promise<void>;
const core = ["BP_AUTH_SECRET", "BP_POSTGRES_ADMIN_PASSWORD", "BP_POSTGRES_PASSWORD", "BP_OPERATIONS_TOKEN"];
const blobs = ["BP_RUSTFS_ROOT_USER", "BP_RUSTFS_ROOT_PASSWORD", "BP_BLOB_S3_ACCESS_KEY", "BP_BLOB_S3_SECRET_KEY"];
const selectors = ["COMPOSE_PROJECT_NAME", "COMPOSE_FILE", "COMPOSE_PROFILES"];
const help = `Usage: bun infra/bootstrap/prepare.ts --capability-file PATH [options]
  --env-file PATH                 Environment file (default: checkout .env)
  --compose-project NAME         Select the original Compose project
  --profile NAME                 Repeat for blobs, compute, edge or gateway; '' selects none
  --confirm-existing-selection   Confirm original selection for an incomplete existing installation
                                 Requires --compose-project and --profile (use '' for none).
                                 Set COMPOSE_FILE in the env file for original custom overlays.
  --access-mode local|public|proxy  --public-url URL  --backup-dir PATH
Omitted selectors reuse recorded COMPOSE_PROJECT_NAME, COMPOSE_FILE and COMPOSE_PROFILES.
Fresh installations default to core only. Existing selections and backends cannot be changed here.
`;
export async function prepare(argv: string[], env: Environment, run: Runner = docker, recordStatus: StatusRecorder = statusRecorder): Promise<string> {
  const { values } = parseArgs({ args: argv, allowPositionals: false, options: {
    "access-mode": { type: "string" }, "public-url": { type: "string" }, "backup-dir": { type: "string" }, "env-file": { type: "string" },
    "capability-file": { type: "string" }, "compose-project": { type: "string" }, profile: { type: "string", multiple: true },
    "confirm-existing-selection": { type: "boolean" }, help: { type: "boolean" },
  } });
  if (values.help) return help;
  if (!values["capability-file"] || values["confirm-existing-selection"] && (!values["compose-project"] || !values.profile)) throw new CliError("invalid_arguments", 1);
  const path = resolve(values["env-file"] ?? resolve(import.meta.dir, "../../.env"));
  const root = resolve(import.meta.dir, "../..");
  const unlock = await privateLock(`${path}.lock`);
  try {
    let source = await privateRead(path, true);
    const originalSource = source, entries: Record<string, string> = {}, lines = (source ?? "").split("\n");
    const managed = new Set([...core, ...blobs, "BP_COMPUTE_TOKEN", "BP_PUBLIC_URL", "BP_PUBLIC_DOMAIN", "BP_SCHEME", "BP_TLS_ISSUER", "BP_EDGE_CA", "BP_PUBLIC_HOST", "BP_EDGE_BIND_HOST", "BP_ACCESS_MODE", "BP_AUTH_URL", "BP_PORT", "BP_BIND_HOST", "BP_HTTP_PORT", "BP_HTTPS_PORT", "BP_BACKUP_DIR", "BP_POSTGRES_IMAGE", "BP_SERVER_IMAGE", "BP_CADDY_IMAGE", "BP_RUSTFS_IMAGE", "BP_BLOB_BOOTSTRAP_IMAGE", "BP_WORKERD_REPOSITORY", "BP_WORKERD_DIGEST", "BP_WORKERD_IMAGE", "BP_WORKERD_BINARY_SHA256", "BP_DATA_DIR", "BP_STATUS_DIR", "BP_PLATFORM_NETWORK", "BP_VOLUME_PREFIX", "BP_BACKUP_KEEP"]);
    for (const key of [...selectors, "COMPOSE_PATH_SEPARATOR", "COMPOSE_ENV_FILES", "BP_BLOB_BACKEND"]) managed.add(key);
    const assignments = new Map<string, number>();
    for (const [index, line] of lines.entries()) {
      if (!line.trim() || line.trimStart().startsWith("#")) continue;
      const name = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)/.exec(line)?.[1];
      if (name === "BP_WORKERD_EFFECTIVE_IMAGE") throw new CliError("workerd_effective_image_persisted", 1);
      if (!name || !managed.has(name)) continue;
      if (assignments.has(name)) throw new CliError("env_repair_required", 1);
      assignments.set(name, index);
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
      if (!match?.[1] || match[2] === undefined || /[$`\r]/.test(match[2])) throw new CliError("env_repair_required", 1);
      let value = match[2];
      if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
      else if (/[\s#]/.test(value)) throw new CliError("env_repair_required", 1);
      if (/['"\\\n]/.test(value)) throw new CliError("env_repair_required", 1);
      if (value || name === "COMPOSE_PROFILES") entries[name] = value;
    }
    const select = (key: string, explicit: string | undefined, fallback: string) => {
      const normalize = (value: string) => key === "COMPOSE_PROFILES" ? [...new Set(value.split(","))].sort().join(",")
        : key === "COMPOSE_FILE" ? value.split(":").map(file => file ? resolve(dirname(path), file) : "").join(":") : value;
      const selected = entries[key] ?? explicit ?? fallback;
      if ([explicit, env[key]].some(value => value !== undefined && normalize(value) !== normalize(selected))) throw new CliError("selection_conflict", 1);
      return selected;
    };
    const project = select("COMPOSE_PROJECT_NAME", values["compose-project"], "agent-backplane");
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(project)) throw new CliError("invalid_compose_project", 1);
    const profileSelection = select("COMPOSE_PROFILES", values.profile?.join(","), "");
    const profiles = profileSelection === "" ? [] : [...new Set(profileSelection.split(","))];
    if (profiles.some(p => !["blobs", "compute", "edge", "gateway"].includes(p)) || values.profile?.includes("") && values.profile.length !== 1) throw new CliError("invalid_arguments", 1);
    if (profiles.includes("edge") && profiles.includes("gateway")) throw new CliError("choose_one_gateway", 1);
    if ([entries.COMPOSE_PATH_SEPARATOR, env.COMPOSE_PATH_SEPARATOR].some(value => value !== undefined && value !== ":")
      || entries.COMPOSE_ENV_FILES || env.COMPOSE_ENV_FILES) throw new CliError("selection_conflict", 1);
    const files = select("COMPOSE_FILE", undefined, [resolve(root, "compose.yaml"), ...profiles.map(p => resolve(root, `compose.${p}.yaml`))].join(":"))
      .split(":").map(file => file ? resolve(dirname(path), file) : "");
    for (const file of files) if (!file || /[\n\r$`'"\\:]/.test(file) || !(await lstat(file).catch(() => undefined))?.isFile()) throw new CliError("invalid_compose_file", 1);
    const completeSelection = selectors.every(key => entries[key] !== undefined) && entries.BP_BLOB_BACKEND !== undefined;
    const keys = [...core, ...(profiles.includes("blobs") ? blobs : []), ...(profiles.includes("compute") ? ["BP_COMPUTE_TOKEN"] : [])];
    const save = (key: string, value: string) => {
      entries[key] = value;
      const assignment = `${key}='${value}'`, index = assignments.get(key);
      if (index === undefined) { assignments.set(key, lines.length); lines.push(assignment); }
      else lines[index] = assignment;
    };
    const statusDir = resolve(dirname(path), entries.BP_STATUS_DIR ?? "data");
    if (statusDir === "/" || /[\n\r$`'"\\]/.test(statusDir)) throw new CliError("unsafe_status_directory", 1);
    save("BP_STATUS_DIR", statusDir);
    for (const [key, value] of [["BP_ACCESS_MODE", values["access-mode"]], ["BP_PUBLIC_URL", values["public-url"]], ["BP_BACKUP_DIR", values["backup-dir"]]]) {
      if (!key || value === undefined) continue;
      if (/[\n\r$`'"\\]/.test(value) || entries[key] !== undefined && entries[key] !== value) throw new CliError("env_conflict", 1);
      if (entries[key] === undefined) save(key, value);
    }
    const access = resolveAccess(entries, profiles.includes("edge")), url = access.origin;
    if (profiles.includes("gateway") && access.mode !== "proxy") throw new CliError("gateway_requires_proxy_mode", 1);
    for (const [key, value] of [["BP_ACCESS_MODE", access.mode], ["BP_PUBLIC_URL", url]]) {
      if (key && value && entries[key] === undefined) save(key, value);
    }
    if (!entries.BP_BACKUP_DIR || !(await stat(entries.BP_BACKUP_DIR).catch(() => undefined))?.isDirectory()) throw new CliError("backup_directory_required", 1);
    const child = Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith("BP_") && !k.startsWith("COMPOSE_")));
    if (env.DOCKER_HOST && !env.DOCKER_HOST.startsWith("unix://")) throw new CliError("remote_docker_unsupported", 1);
    const endpoint = (await run(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], child)).trim();
    if (!endpoint.startsWith("unix://")) throw new CliError("remote_docker_unsupported", 1);
    const network = entries.BP_PLATFORM_NETWORK ?? "platform", prefix = entries.BP_VOLUME_PREFIX ?? "agent-backplane";
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(network)) throw new CliError("invalid_platform_network", 1);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(prefix)) throw new CliError("invalid_volume_prefix", 1);
    const volumes = await run(["volume", "ls", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.Name}}"], child);
    const existingVolumes = await run(["volume", "ls", "--format", "{{.Name}}"], child);
    const containers = await run(["ps", "--all", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.ID}}"], child);
    const networks = await run(["network", "ls", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.Name}}"], child);
    const resources = Boolean(volumes.trim() || containers.trim() || networks.trim() || existingVolumes.split("\n").some(v => v.startsWith(`${prefix}_`)));
    const existing = resources || [...core, ...blobs, "BP_COMPUTE_TOKEN"].some(key => entries[key] !== undefined);
    if (existing && !completeSelection && !values["confirm-existing-selection"]) throw new CliError("existing_selection_confirmation_required", 2);
    if (resources && keys.some(k => entries[k] === undefined)) throw new CliError("existing_volume_missing_secrets", 2);
    for (const key of keys) if (entries[key] === undefined) {
      // RustFS service-account creation accepts at most 40 characters.
      const bytes = key === "BP_RUSTFS_ROOT_USER" || key === "BP_BLOB_S3_ACCESS_KEY" ? 10 : key === "BP_BLOB_S3_SECRET_KEY" ? 20 : 32;
      save(key, randomBytes(bytes).toString("hex"));
    }
    save("COMPOSE_PROJECT_NAME", project); save("COMPOSE_FILE", files.join(":")); save("COMPOSE_PROFILES", profiles.join(","));
    for (const [key, value] of [["BP_VOLUME_PREFIX", prefix], ["BP_PLATFORM_NETWORK", network]]) if (key && value && entries[key] === undefined) save(key, value);
    Object.assign(child, entries);
    // Interpolate the prospective env in memory; a fresh env file does not exist yet.
    const compose = ["compose", "--project-name", project, "--project-directory", dirname(files[0]!), "--env-file", path,
      ...files.flatMap(file => ["-f", file]), ...profiles.flatMap(p => ["--profile", p])];
    const preflight = [...compose];
    preflight[preflight.indexOf("--env-file") + 1] = originalSource === undefined ? "/dev/null" : path;
    const config: unknown = JSON.parse(await run([...preflight, "config", "--format", "json"], child));
    if (!record(config) || !record(config.services) || !record(config.services.server) || !record(config.services.server.environment)
      || !record(config.services["storage-init"]) || !record(config.services["storage-init"].environment)) throw new CliError("invalid_compose_config", 1);
    const backend = config.services.server.environment.BP_BLOB_BACKEND ?? "filesystem";
    if (backend !== "filesystem" && backend !== "s3" || entries.BP_BLOB_BACKEND !== undefined && entries.BP_BLOB_BACKEND !== backend
      || (config.services["storage-init"].environment.BP_BLOB_BACKEND ?? "filesystem") !== backend) throw new CliError("backend_change_requires_migration", 2);
    save("BP_BLOB_BACKEND", backend);
    await recordStatus(["--state-dir", statusDir, "--prepare"]);
    source = lines.join("\n");
    if (!source.endsWith("\n")) source += "\n";
    if (source !== originalSource) {
      const temporary = `${path}.${crypto.randomUUID()}`;
      try {
        await privateWrite(temporary, source);
        await rename(temporary, path);
        const parent = await open(dirname(path), "r");
        try { await parent.sync(); } finally { await parent.close(); }
      } finally { await rm(temporary, { force: true }); }
    }
    const statusRecord = ["--state-dir", statusDir, "--checkout", root, "--env-file", path, "--started", new Date().toISOString(),
      "--project-name", project, ...files.flatMap(file => ["--compose-file", file]), ...profiles.flatMap(profile => ["--profile", profile])];
    await recordStatus([...statusRecord, "--state", "unavailable"]);
    if (profiles.includes("compute")) {
      const identity = await verifyWorkerdImage(entries, child, run);
      await persistWorkerdEvidence(resolve(dirname(path), entries.BP_DATA_DIR ?? "data"), identity);
      child.BP_WORKERD_EFFECTIVE_IMAGE = identity.imageId;
      child.BP_WORKERD_HOST_IMAGE_ID = identity.imageId;
    }
    try { await run(["network", "inspect", network], child); }
    catch { await run(["network", "create", network], child); }
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
export async function statusRecorder(args: string[], searchPath = process.env.PATH ?? "/usr/bin:/bin"): Promise<void> {
  const python = Bun.which("python3", { PATH: searchPath });
  if (!python) throw new CliError("status_python_required", 1);
  let child;
  try {
    child = Bun.spawn([python, "-E", resolve(import.meta.dir, "../../scripts/record_status.py"), ...args], {
      env: { PATH: searchPath }, stdout: "ignore", stderr: "pipe",
    });
  } catch { throw new CliError("status_python_required", 1); }
  const timeout = setTimeout(() => child.kill(), 10_000);
  try {
    const diagnostic = (async () => {
      const reader = child.stderr.getReader(), chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        size += result.value.length;
        if (size > 128) { child.kill(); return "status_record_failed"; }
        chunks.push(result.value);
      }
      try {
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
        return ["status_path_unsafe", "status_path_unavailable", "status_record_invalid", "status_selection_mismatch"].includes(text)
          ? text : "status_record_failed";
      } catch { return "status_record_failed"; }
    })();
    const code = await child.exited, reason = await diagnostic;
    if (code !== 0) throw new CliError(code === 127 ? "status_python_required" : reason, 2);
  }
  finally { clearTimeout(timeout); }
}
if (import.meta.main) try { process.stdout.write(await prepare(process.argv.slice(2), process.env)); }
catch (e) { process.stderr.write(`${JSON.stringify({ error: e instanceof CliError ? e.error : "prepare_failed" })}\n`); process.exitCode = e instanceof CliError ? e.exit : 1; }
