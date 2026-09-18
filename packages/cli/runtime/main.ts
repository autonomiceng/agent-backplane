#!/usr/bin/env bun
// Executable entrypoint owns environment, standard streams and cancellation.
import { execute } from "./execute.ts";
import { createInterface } from "node:readline";
async function password(): Promise<string> {
  if (!process.stdin.isTTY) throw new Error("terminal_required");
  process.stderr.write("Password: ");
  const terminal = createInterface({ input: process.stdin, terminal: false });
  process.stdin.setRawMode(true);
  try { return await new Promise<string>((resolve, reject) => {
    let value = "";
    const read = (chunk: Buffer) => {
      for (const char of chunk.toString()) {
        if (char === "\u0003") { process.stdin.off("data", read); reject(new Error("cancelled")); return; }
        if (char === "\r" || char === "\n") { process.stdin.off("data", read); resolve(value); return; }
        value = char === "\u007f" ? value.slice(0, -1) : value + char;
      }
    };
    process.stdin.on("data", read);
  }); } finally { process.stdin.setRawMode(false); terminal.close(); process.stderr.write("\n"); }
}
const controller = new AbortController();
process.on("SIGINT", () => controller.abort());
process.on("SIGTERM", () => controller.abort());
if (process.argv[2] === "mcp") await (await import("../../mcp/runtime/main.ts")).main(process.argv.slice(3));
else process.exitCode = await execute(process.argv.slice(2), { env: Bun.env, password, stdin: () => Bun.stdin.text(), stdinBytes: () => Bun.stdin.bytes(),
  stdout: (text) => { process.stdout.write(text); }, stderr: (text) => { process.stderr.write(text); }, signal: controller.signal });
