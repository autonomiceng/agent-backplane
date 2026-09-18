// Converts generated tool arguments to the unchanged CLI execution boundary.
import generated from "../generated/tools.json";
import type { Command } from "../../../tooling/codegen/commands.ts";
import { record } from "../../cli/runtime/http.ts";
import { execute, type Execution } from "../../cli/runtime/execute.ts";
export const catalog = generated;
export function argumentsForTool(command: Command, input: unknown): { argv: string[]; body: string } {
  if (!record(input)) throw new Error("Expected arguments object");
  const argv = [...command.command];
  for (const [name, value] of Object.entries(input)) {
    if (name === "body" && command.body?.contentType === "application/json") continue;
    if (name === "file" && command.body?.contentType === "application/octet-stream" && typeof value === "string" && value !== "-") { argv.push("--file", value); continue; }
    const parameter = command.parameters.find((p) => p.name === name);
    if (!parameter || !["string", "number", "boolean"].includes(typeof value)) throw new Error("Invalid tool argument");
    argv.push(`--${parameter.flag}=${String(value)}`);
  }
  if (Object.hasOwn(input, "body")) argv.push("--body", "-");
  return { argv, body: Object.hasOwn(input, "body") ? JSON.stringify(input.body) : "" };
}
export async function callTool(command: Command, input: unknown, io: Omit<Execution, "stdin" | "stdout" | "stderr">) {
  const { argv, body } = argumentsForTool(command, input), controller = new AbortController();
  const signal = io.signal ? AbortSignal.any([io.signal, controller.signal]) : controller.signal;
  let stdout = "", stderr = "";
  const frames: unknown[] = [];
  const stop = () => controller.abort();
  const timer = command.stream ? setTimeout(stop, 1000) : undefined;
  try {
    const code = await execute(argv, { ...io, signal, ...(command.binary ? { binary: (bytes: Uint8Array) => { stdout = JSON.stringify({ encoding: "base64", content: Buffer.from(bytes).toString("base64"), size: bytes.length }); } } : {}), stdin: async () => body,
      stdout: (text) => {
        if (!command.stream) { stdout += text; return; }
        for (const line of text.trim().split("\n")) if (line && frames.length < 100) frames.push(JSON.parse(line));
        if (frames.length >= 100) stop();
      }, stderr: (text) => { stderr += text; } });
    const success = code === 0;
    return { content: [{ type: "text", text: success ? command.stream ? JSON.stringify(frames) : stdout.trim() : stderr.trim() }], isError: !success };
  } finally { clearTimeout(timer); controller.abort(); }
}
