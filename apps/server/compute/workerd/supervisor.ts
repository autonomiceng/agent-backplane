import { createHash, timingSafeEqual } from "node:crypto";
import { controlUnchanged, killAndReap, preferChildOom, readPort } from "./child-process.ts";

const bodyLimit = 6 * 4194304 + 1048576 + 65536;
export const supervisorTransportLimit = bodyLimit + 1048576;
const responseLimit = 1048576;
const digest = (value: string) => createHash("sha256").update(value).digest();
const failure = (reason: string) => new Response(null, { status: reason === "function_timeout" ? 504 : reason === "function_failed" ? 502 : 503,
  headers: { "x-backplane-error": reason } });

async function boundedBytes(body: ReadableStream<Uint8Array> | null, limit: number, signal: AbortSignal) {
  const reader = body?.getReader(), chunks: Uint8Array[] = [];
  const abort = () => { void reader?.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  let size = 0;
  try {
    signal.throwIfAborted();
    while (reader) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.length;
      if (size > limit) throw Error("function_failed");
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally { signal.removeEventListener("abort", abort); abort(); }
}

export function createSupervisor(options: { binary: string; config: string; token: string; timeoutMs: number;
  env: Record<string, string | undefined>; args?: string[] }) {
  const children = new Set<Bun.Subprocess<"ignore", "pipe", "ignore">>();
  const controllers = new Set<AbortController>();
  let active = false, closing = false;
  let identity: Promise<Response> | undefined;
  const fatal = (): never => { process.exit(1); };
  async function operation(request: Request, probe: boolean, budget: number) {
    let child: Bun.Subprocess<"ignore", "pipe", "ignore"> | undefined;
    let reaping: Promise<void> | undefined;
    const stopChild = () => { if (child) reaping ??= killAndReap(child, fatal); };
    const controller = new AbortController();
    controller.signal.addEventListener("abort", stopChild, { once: true });
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(Error("function_timeout")), budget);
    const abort = () => controller.abort(Error("function_failed"));
    if (!probe) request.signal.addEventListener("abort", abort, { once: true });
    let forwarded = false;
    try {
      if (!probe && request.signal.aborted) abort();
      const body = probe ? undefined : await boundedBytes(request.body, bodyLimit, controller.signal);
      controller.signal.throwIfAborted();
      if (!await controlUnchanged(options.config, options.env.BP_WORKERD_CONTROL_SHA256)) throw Error("compute_unavailable");
      controller.signal.throwIfAborted();
      child = Bun.spawn([options.binary, "serve", options.config, "--experimental", ...(options.args ?? []),
        "--socket-addr=control=127.0.0.1:0", "--control-fd=1"], {
        env: options.env, stdin: "ignore", stdout: "pipe", stderr: "ignore",
      });
      children.add(child);
      // Child exit also interrupts a response body that would otherwise wait for the deadline.
      void child.exited.then(() => controller.abort(Error(forwarded ? "function_failed" : "compute_unavailable")));
      await preferChildOom(child.pid);
      const port = await readPort(child.stdout, controller.signal);
      controller.signal.throwIfAborted();
      forwarded = true;
      const response = await fetch(`http://127.0.0.1:${port}${probe ? "/identity" : new URL(request.url).pathname}`, {
        method: probe ? "GET" : "POST", headers: request.headers, ...(body === undefined ? {} : { body }),
        signal: controller.signal, redirect: "manual",
      });
      const bytes = await boundedBytes(response.body, responseLimit, controller.signal);
      controller.signal.throwIfAborted();
      const headers = new Headers(response.headers);
      headers.set("x-backplane-response", "proxied");
      headers.delete("transfer-encoding"); headers.delete("content-length"); headers.delete("content-encoding");
      return new Response([204, 205, 304].includes(response.status) ? null : bytes, { status: response.status, headers });
    } catch (error) {
      const reason = controller.signal.aborted ? controller.signal.reason : error;
      if (child && !forwarded && reason instanceof Error && reason.message === "function_timeout") return failure("compute_unavailable");
      return failure(reason instanceof Error && ["function_timeout", "function_failed", "compute_unavailable"].includes(reason.message)
        ? reason.message : forwarded ? "function_failed" : "compute_unavailable");
    } finally {
      controllers.delete(controller);
      clearTimeout(timer); request.signal.removeEventListener("abort", abort);
      stopChild(); await reaping;
      controller.signal.removeEventListener("abort", stopChild);
      if (child) children.delete(child);
    }
  }
  return {
    async fetch(request: Request, server?: Pick<Bun.Server<undefined>, "timeout">) {
      if (!options.token || !timingSafeEqual(digest(request.headers.get("authorization") ?? ""), digest(`Bearer ${options.token}`))) return new Response(null, { status: 401 });
      const path = new URL(request.url).pathname;
      const probe = path === "/identity" && request.method === "GET";
      if (!probe && (request.method !== "POST" || !["/prepare", "/invoke"].includes(path))) return new Response(null, { status: 404 });
      if (closing) return failure("compute_unavailable");
      if (probe) {
        identity ??= operation(request, true, 2000).finally(() => { identity = undefined; });
        return (await identity).clone();
      }
      const supplied = request.headers.get("x-backplane-budget-ms");
      const budget = supplied === null ? options.timeoutMs : Number(supplied);
      if (!Number.isSafeInteger(budget) || budget <= 0) return failure("compute_unavailable");
      if (active) return failure("compute_unavailable");
      active = true;
      // The operation deadline covers intake through reaping, even above Bun's 255-second idle ceiling.
      server?.timeout(request, 0);
      try { return await operation(request, false, Math.min(path === "/prepare" ? 2000 : options.timeoutMs, budget)); }
      finally { active = false; server?.timeout(request, 10); }
    },
    async close() {
      closing = true;
      for (const controller of controllers) controller.abort(Error("compute_unavailable"));
      await Promise.all([...children].map(child => killAndReap(child, fatal)));
    },
  };
}

if (import.meta.main) {
  const timeoutMs = Number(Bun.env.BP_COMPUTE_TIMEOUT_MS ?? 10000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) throw Error("invalid compute timeout");
  const supervisor = createSupervisor({ binary: "/usr/bin/workerd", config: "/compute/config.capnp",
    token: Bun.env.BP_COMPUTE_TOKEN ?? "", timeoutMs, env: Bun.env, args: Bun.argv.slice(2) });
  const server = Bun.serve({ hostname: "0.0.0.0", port: 8080, maxRequestBodySize: supervisorTransportLimit, fetch: supervisor.fetch });
  const shutdown = async () => { await supervisor.close(); await server.stop(true); process.exit(0); };
  process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
}
