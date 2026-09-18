// Importable CLI boundary; tests inject environment, streams and time while exercising real HTTP.
import { writeOutput } from "./write-output.ts";
import commands from "../generated/commands.json";
import schemas from "../generated/schemas.json";
import { object } from "../../../tooling/codegen/commands.ts";
import { argumentsFor } from "./arguments.ts";
import { CliError, credentials, redact, type Environment } from "./credentials.ts";
import { request, json, failure, record } from "./http.ts";
import { runCache } from "./run-cache.ts";
import { push, pushHelp } from "./push.ts";
import { login, sessionHeaders } from "./login.ts";
import { restoreDrill, restoreDrillHelp } from "./restore-drill.ts";
import { bootstrap, bootstrapHelp } from "./bootstrap.ts";
import { credentialEnvironment, credentialValue, privateWrite } from "./credential-file.ts";
import { events } from "./events.ts";
export type Execution = { password?: () => Promise<string>; stdinBytes?: () => Promise<Uint8Array>; binary?: (bytes: Uint8Array) => void; env: Environment; stdin: () => Promise<string>; stdout: (text: string) => void; stderr: (text: string) => void; now?: () => number; signal?: AbortSignal; transport?: typeof fetch };
export async function execute(argv: string[], io: Execution): Promise<number> {
  const secrets: string[] = [];
  const output = (text: string) => io.stdout(redact(text, io.env, secrets));
  try {
    io = { ...io, env: await credentialEnvironment(io.env) };
    if (argv[0] === "bootstrap") {
      if (argv.length === 2 && argv[1] === "--help") { output(`${bootstrapHelp}\n`); return 0; }
      const value = await bootstrap(argv.slice(1), io, async (id, flags, body) => {
        if (record(body)) for (const key of ["password", "capability"]) if (typeof body[key] === "string") secrets.push(body[key]);
        const command = commands.find(c => c.operationId === id);
        if (!command) throw new CliError("operation_unavailable", 1);
        const args = await argumentsFor([...command.command, ...flags, ...(body === undefined ? [] : ["--body", "-"])], commands, io.env, async () => JSON.stringify(body));
        return operation(args, io, output, false, secrets);
      });
      output(`${JSON.stringify(value)}\n`); return 0;
    }
    if (!argv.length || argv[0] === "--help") {
      output(`${JSON.stringify({ bootstrap: bootstrapHelp, login: "bp login|logout (BP_URL, BP_AUTH_URL, BP_USER_EMAIL, BP_USER_PASSWORD)", restoreDrill: restoreDrillHelp, push: pushHelp, commands: commands.map((c) => ({ command: c.command, aliases: c.aliases })), session: "BP_SESSION defaults to default; Runs expire locally after 24 hours idle" })}\n`); return 0;
    }
    if (["login", "logout"].includes(argv[0] ?? "")) {
      if (argv.length !== 1) throw new CliError("invalid_arguments");
      output(`${JSON.stringify(await login(io, argv[0] === "logout"))}\n`); return 0;
    }
    if (argv[0] === "restore-drill") {
      if (argv.includes("--help")) { output(`${restoreDrillHelp}\n`); return 0; }
      const report = await restoreDrill(argv.slice(1), io.env);
      output(`${JSON.stringify(report)}\n`); return report.success ? 0 : 1;
    }
    if (argv[0] === "push") {
      if (argv.includes("--help")) { output(`${pushHelp}\n`); return 0; }
      const value = await push(argv.slice(1), io, (args) => operation(args, io, output, false));
      output(`${JSON.stringify(value)}\n`); return 0;
    }
    const args = await argumentsFor(argv, commands, io.env, io.stdin, io.stdinBytes).catch(error => {
      if (argv.some(arg => arg === "--credential-out" || arg.startsWith("--credential-out=")) && error instanceof CliError) throw new CliError(error.error, 1);
      throw error;
    }), { command } = args;
    if (args.help) {
      const request = command.body ? object(object(schemas)[command.body.schemaRef]) : undefined;
      output(`${JSON.stringify({ ...command, ...(command.operationId === "releaseRestore" ? { usage: "bp restore release --workspace-id UUID --epoch UUID --source-fenced" } : {}),
        ...(command.operationId === "issuePrincipalKey" ? { credentialOutput: "--credential-out NEW_PRIVATE_FILE (exclusive 0600 JSON; stdout remains redacted)" } : {}),
        ...(command.binary ? { output: "--out <path> [--force]; existing files are preserved unless forced; symlinks are rejected" } : {}),
        ...(command.body?.contentType === "application/octet-stream" ? { input: "--file <path>; - reads stdin" } : {}), ...(request ? {
        requestSchema: object(object(request.content)[command.body?.contentType ?? "application/json"]).schema, components: schemas.components,
      } : {}) })}\n`); return 0;
    }
    if (command.binary && !args.out && !io.binary) throw new CliError("required_flag:out");
    const value = await operation(args, io, output, true, secrets);
    if (value !== undefined) output(`${JSON.stringify(value)}\n`);
    return 0;
  } catch (error) {
    const failure = error instanceof CliError ? error : new CliError("cli_failed", 1);
    io.stderr(redact(`${JSON.stringify({ error: failure.error, ...(failure.status === undefined ? {} : { status: failure.status }), ...(failure.details === undefined ? {} : { details: failure.details }) })}\n`, io.env, secrets));
    return argv[0] === "bootstrap" && failure.exit !== 3 && failure.exit !== 2 ? 1 : failure.exit;
  }
}

async function operation(args: Awaited<ReturnType<typeof argumentsFor>>, io: Execution, output: (text: string) => void, recoverRun = true, secrets: string[] = []): Promise<unknown> {
  const { command } = args;
  const config = credentials(io.env, command.auth, args.workspaceId), cache = runCache(config, io.now ?? Date.now);
  if (command.auth === "user") {
    const headers = await sessionHeaders(config, io.env);
    secrets.push(headers.get("cookie") ?? "", (headers.get("cookie") ?? "").split("=").slice(1).join("="));
    if (args.credentialOut) await privateWrite(args.credentialOut, "");
    try {
      const response = await request(config, args.path, command.method, args.body, headers, undefined, io.signal, io.transport);
      const value = await json(response); failure(response, value);
      if (args.credentialOut) {
        const credential = credentialValue({ url: config.url, workspaceId: config.workspaceId, principalId: args.principalId, key: record(value) ? value.key : undefined });
        await privateWrite(args.credentialOut, JSON.stringify(credential), true);
      }
      return value;
    } catch (error) {
      if (!args.credentialOut) throw error;
      if (error instanceof CliError && (error.error === "transport_unsent" || error.error !== "invalid_response" && error.status && error.status >= 400 && error.status < 500)) {
        throw new CliError(error.error, error.error === "transport_unsent" || [401, 403, 404].includes(error.status ?? 0) ? 2 : 1, error.status);
      }
      throw new CliError("key_ambiguous", 3, undefined, { credentialFile: args.credentialOut, workspaceId: config.workspaceId, principalId: args.principalId });
    }
  }
  let created: unknown;
  const create = async () => {
    const descriptor = commands.find((c) => c.operationId === "createRun");
    if (!descriptor) throw new CliError("create_run_unavailable");
    const metadata = Object.fromEntries([["harness", io.env.BP_HARNESS], ["model", io.env.BP_MODEL], ["label", io.env.BP_RUN_LABEL]].filter(([, value]) => value !== undefined));
    const response = await request(config, descriptor.path.replace("{workspaceId}", encodeURIComponent(config.workspaceId)), descriptor.method,
      command.operationId === "createRun" ? args.body : JSON.stringify(metadata), new Headers({ "content-type": "application/json" }), undefined, io.signal, io.transport);
    created = await json(response); failure(response, created); return created;
  };
  if (command.operationId === "createRun") { await cache.select(create, undefined, true); return created; }
  let runId = command.run === "required" ? await cache.select(create) : undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await request(config, args.path, command.method, args.body, args.headers, runId, io.signal, io.transport);
    if (response.ok && response.headers.get("content-type")?.split(";")[0] === "text/event-stream") {
      if (runId) await cache.touch(runId);
      await events(response, output, io.signal); return undefined;
    }
    if (response.ok && command.binary) {
      const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let size = 0;
      try {
        while (reader) { const part = await reader.read(); if (part.done) break; size += part.value.length;
          if (size > 4194304) throw new CliError("blob_too_large"); chunks.push(part.value); }
        const bytes = Buffer.concat(chunks, size);
        if (io.binary) io.binary(bytes); else if (args.out) await writeOutput(args.out, bytes, args.force);
      } finally { await reader?.cancel(); }
      return undefined;
    }
    if (response.status === 204) { if (runId) await cache.touch(runId); return undefined; }
    const value = await json(response);
    if (recoverRun && attempt === 0 && runId && response.status === 403 && record(value) && value.error === "run_forbidden") { runId = await cache.select(create, runId); continue; }
    failure(response, value);
    if (runId) await cache.touch(runId);
    return value;
  }
  throw new CliError("run_forbidden", 1, 403);
}
