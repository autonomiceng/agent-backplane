// Push preserves one source snapshot and preview receipt through the authenticated CLI operation boundary.
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import commands from "../generated/commands.json";
import type { Execution } from "./execute.ts";
import type { argumentsFor } from "./arguments.ts";
import { CliError, redact } from "./credentials.ts";
import { record } from "./http.ts";
export const pushHelp = "bp push <file.sql> --name <name> [--expected-revision <n>] [--destructive] [--workspace-id <uuid>]";
export async function push(argv: string[], io: Execution, invoke: (args: Awaited<ReturnType<typeof argumentsFor>>) => Promise<unknown>) {
  let parsed;
  try { parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
    name: { type: "string" }, "expected-revision": { type: "string" }, destructive: { type: "boolean" }, "workspace-id": { type: "string" },
  } }); } catch { throw new CliError("invalid_arguments"); }
  const { values, positionals } = parsed, file = positionals[0], name = values.name;
  if (positionals.length !== 1 || !file || !name?.trim() || name.length > 120) throw new CliError("invalid_arguments");
  const workspaceId = (values["workspace-id"] ?? io.env.BP_WORKSPACE_ID)?.toLowerCase();
  if (!workspaceId || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(workspaceId)) throw new CliError("workspace_id_invalid");
  const revision = values["expected-revision"];
  if (revision !== undefined && (!/^[0-9]+$/.test(revision) || Number(revision) > 2147483646)) throw new CliError("invalid_arguments");
  const source = await readFile(file).catch(() => { throw new CliError("push_source_invalid"); });
  let sql;
  try { sql = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(source); }
  catch { throw new CliError("push_source_invalid"); }
  if (!source.length || source.length > 65536) throw new CliError("push_source_invalid");
  const call = (operationId: string, body?: unknown) => {
    const command = commands.find((entry) => entry.operationId === operationId);
    if (!command) throw new CliError("push_operation_unavailable");
    return invoke({ command, workspaceId, help: false, path: command.path.replace("{workspaceId}", workspaceId) + (operationId === "listMigrations" ? "?limit=1" : ""),
      headers: new Headers({ "content-type": "application/json" }), body: body === undefined ? undefined : JSON.stringify(body) });
  };
  const head = revision === undefined ? await call("listMigrations") : { currentRevision: Number(revision) };
  if (!record(head) || typeof head.currentRevision !== "number" || !Number.isInteger(head.currentRevision)
    || head.currentRevision < 0 || head.currentRevision > 2147483646) throw new CliError("invalid_response", 1);
  const input = { name, sql, expectedRevision: head.currentRevision, destructive: values.destructive ?? false };
  const receipt = await call("previewMigration", input), sqlHash = createHash("sha256").update(source).digest("hex");
  if (!record(receipt) || receipt.revision !== input.expectedRevision || receipt.sqlHash !== sqlHash
    || typeof receipt.previewPosition !== "string" || !/^[0-9]{1,19}$/.test(receipt.previewPosition)
    || BigInt(receipt.previewPosition) > 9223372036854775807n) throw new CliError("preview_mismatch", 1);
  const previewPosition = receipt.previewPosition;
  io.stderr(redact(`${JSON.stringify({ plan: receipt })}\n`, io.env));
  const current = await readFile(file).catch(() => { throw new CliError("push_source_changed", 1); });
  if (!source.equals(current)) throw new CliError("push_source_changed", 1);
  const result = await call("applyMigration", { ...input, sqlHash, previewPosition });
  if (!record(result) || result.revision !== input.expectedRevision + 1 || result.sqlHash !== sqlHash) throw new CliError("invalid_response", 1);
  return result;
}
