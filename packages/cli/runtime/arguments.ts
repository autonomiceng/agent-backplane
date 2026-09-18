// Parses generated flags without interpreting or rewriting JSON request bodies.
import { parseArgs, type ParseArgsConfig } from "node:util";
import { readFile } from "node:fs/promises";
import type { Command } from "../../../tooling/codegen/commands.ts";
import { canonicalUuid } from "./credential-file.ts";
import { CliError, type Environment } from "./credentials.ts";
export async function argumentsFor(argv: string[], commands: Command[], env: Environment, stdin: () => Promise<string>, stdinBytes?: () => Promise<Uint8Array>) {
  const events = argv[0] === "events" && (argv.length === 1 || argv[1]?.startsWith("--"));
  const selected = commands.find((c) => [c.command, ...c.aliases].some((name) => name.every((part, i) => argv[i] === part)
    && (argv.length === name.length || argv[name.length]?.startsWith("--"))));
  const command = events && argv.includes("--follow") ? commands.find((c) => c.stream) : selected;
  if (!command) throw new CliError("unknown_command");
  const name = events ? ["events"] : [command.command, ...command.aliases].find((n) => n.every((part, i) => argv[i] === part));
  const options: ParseArgsConfig["options"] = { help: { type: "boolean" }, ...(command.body ? { [command.body.contentType === "application/octet-stream" ? "file" : "body"]: { type: "string" } } : {}),
    ...(command.binary ? { out: { type: "string" }, force: { type: "boolean" } } : {}),
    ...(events ? { since: { type: "string" }, follow: { type: "boolean" } } : {}) };
  if (command.operationId === "issuePrincipalKey") options["credential-out"] = { type: "string" };
  if (command.operationId === "releaseRestore") Object.assign(options, { epoch: { type: "string" }, "source-fenced": { type: "boolean" } });
  for (const p of command.parameters) options[p.flag] = { type: "string" };
  let values;
  try { values = parseArgs({ args: argv.slice(name?.length ?? 0), options, allowPositionals: false, strict: true }).values; }
  catch { throw new CliError("invalid_arguments"); }
  if (values.help) return { command, help: true, path: "", body: undefined, headers: new Headers(), workspaceId: undefined };
  if (command.operationId === "releaseRestore" && values["source-fenced"] !== true) throw new CliError("required_flag:source-fenced");
  let path = command.path;
  const query = new URLSearchParams(), headers = new Headers();
  let workspaceId: string | undefined;
  for (const p of command.parameters) {
    const cursor = events && ["after", "since", "last-event-id"].includes(p.name.toLowerCase()) ? values.since : undefined;
    let value = values[p.flag] ?? (p.name === "workspaceId" ? env.BP_WORKSPACE_ID : cursor);
    if (value === undefined) { if (p.required) throw new CliError(`required_flag:${p.flag}`); continue; }
    if (typeof value !== "string") throw new CliError("invalid_arguments");
    if (p.in === "path" && p.schema.format === "uuid") { value = canonicalUuid(value); values[p.flag] = value; }
    if (p.name === "workspaceId") workspaceId = canonicalUuid(value);
    if (p.in === "path") path = path.replaceAll(`{${p.name}}`, encodeURIComponent(value));
    else if (p.in === "query") query.set(p.name, value);
    else headers.set(p.name, value);
  }
  if (events && values.since && !command.parameters.some((p) => ["after", "since", "last-event-id"].includes(p.name.toLowerCase()))) throw new CliError("cursor_unsupported");
  if (query.size) path += `?${query}`;
  let body: string | Uint8Array | undefined;
  if (typeof values.file === "string") {
    if (values.file === "-" && !stdinBytes) throw new CliError("binary_stdin_unavailable");
    body = values.file === "-" ? await stdinBytes?.() : await readFile(values.file);
    if (!body || body.length > 4194304) throw new CliError("blob_too_large");
  } else if (command.operationId === "releaseRestore" && values.epoch !== undefined) {
    if (values.body !== undefined || typeof values.epoch !== "string") throw new CliError("invalid_arguments");
    body = JSON.stringify({ epoch: values.epoch, sourceFenced: true });
  } else if (typeof values.body === "string") {
    try {
      if (values.body === "-") body = await stdin();
      else if (values.body.startsWith("@")) body = await readFile(values.body.slice(1), "utf8");
      else throw new Error();
      JSON.parse(body);
    } catch { throw new CliError("body_invalid"); }
  } else if (command.body?.empty) body = "{}";
  else if (command.body?.required) throw new CliError("body_required");
  if (command.body) headers.set("content-type", command.body.contentType);
  return { command, help: false, path, body, headers, workspaceId, ...(typeof values["credential-out"] === "string" ? { credentialOut: values["credential-out"], principalId: values["principal-id"] } : {}), ...(typeof values.out === "string" ? { out: values.out, force: values.force === true } : {}) };
}
