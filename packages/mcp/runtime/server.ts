// Newline JSON-RPC dispatcher keeps reading cancellation while tool executions serialize.
import { record } from "../../cli/runtime/http.ts";
import type { Execution } from "../../cli/runtime/execute.ts";
import { argumentsForTool, callTool, catalog } from "./tools.ts";
export function server(io: Omit<Execution, "stdin" | "stdout" | "stderr">, write: (text: string) => Promise<void>) {
  let state = "new", pending = Buffer.alloc(0), closed = false;
  let executions = Promise.resolve(), writes = Promise.resolve();
  const active = new Map<string | number, AbortController>();
  const send = (value: unknown) => { writes = writes.then(() => write(`${JSON.stringify(value)}\n`)); };
  const error = (id: string | number | null, code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });
  const frame = (line: Buffer) => {
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)); }
    catch { error(null, -32700, "Parse error"); return; }
    if (!record(value) || value.jsonrpc !== "2.0" || typeof value.method !== "string"
      || ("id" in value && typeof value.id !== "string" && (typeof value.id !== "number" || !Number.isSafeInteger(value.id)))) {
      error(null, -32600, "Invalid Request"); return;
    }
    const id = value.id, params = value.params;
    if (id === undefined) {
      if (value.method === "notifications/initialized" && state === "initializing") state = "ready";
      if (value.method === "notifications/cancelled" && record(params)
        && (typeof params.requestId === "string" || typeof params.requestId === "number")) active.get(params.requestId)?.abort();
      return;
    }
    if (typeof id !== "string" && typeof id !== "number") return;
    const result = (result: unknown) => send({ jsonrpc: "2.0", id, result });
    if (params !== undefined && !record(params)) { error(id, -32602, "Invalid params"); return; }
    if (value.method === "ping") { result({}); return; }
    if (value.method === "initialize") {
      if (state !== "new" || !record(params) || typeof params.protocolVersion !== "string" || !record(params.capabilities)
        || !record(params.clientInfo) || typeof params.clientInfo.name !== "string" || typeof params.clientInfo.version !== "string") {
        error(id, -32602, "Invalid initialize params"); return;
      }
      state = "initializing";
      result({ protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "backplane", version: "0.0.0" } }); return;
    }
    if (state !== "ready") { error(id, -32600, "Server is not initialized"); return; }
    if (value.method === "tools/list") {
      if (params && "cursor" in params) { error(id, -32602, "Pagination is unsupported"); return; }
      result({ tools: catalog.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }); return;
    }
    if (value.method !== "tools/call") { error(id, -32601, "Method not found"); return; }
    const tool = catalog.find((tool) => tool.name === params?.name);
    if (!tool || active.has(id)) { error(id, -32602, "Unknown tool or duplicate request ID"); return; }
    const input = params?.arguments === undefined ? {} : params.arguments;
    try { argumentsForTool(tool.command, input); } catch { result({ content: [{ type: "text", text: '{"error":"invalid_arguments"}' }], isError: true }); return; }
    const controller = new AbortController();
    active.set(id, controller);
    executions = executions.then(async () => {
      try {
        if (controller.signal.aborted) return;
        const output = await callTool(tool.command, input, { ...io, signal: io.signal
          ? AbortSignal.any([io.signal, controller.signal]) : controller.signal });
        if (!controller.signal.aborted) result(output);
      } catch { if (!controller.signal.aborted) error(id, -32603, "Internal error"); }
      finally { active.delete(id); }
    });
  };
  return {
    feed(chunk: Uint8Array) {
      if (closed) return;
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(10, start), end = newline < 0 ? chunk.length : newline;
        if (pending.length + end - start > 16 * 1024 * 1024) {
          error(null, -32600, "Input exceeds 16 MiB"); closed = true; pending = Buffer.alloc(0);
          for (const controller of active.values()) controller.abort();
          return;
        }
        pending = Buffer.concat([pending, chunk.subarray(start, end)]);
        if (newline < 0) break;
        frame(pending); pending = Buffer.alloc(0); start = newline + 1;
      }
    },
    async drain() { await executions; await writes; },
    async close() {
      closed = true;
      for (const controller of active.values()) controller.abort();
      if (pending.length) error(null, -32700, "Incomplete frame");
      pending = Buffer.alloc(0); await executions; await writes;
    },
  };
}
