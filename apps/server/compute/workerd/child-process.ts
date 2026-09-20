import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { writeFile } from "node:fs/promises";

export async function readPort(stream: ReadableStream<Uint8Array>, signal: AbortSignal) {
  const reader = stream.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  let line = "", size = 0;
  try {
    signal.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) throw Error("compute_unavailable");
      const end = value.indexOf(10);
      const part = value.subarray(0, end < 0 ? value.length : end);
      size += part.length + (end < 0 ? 0 : 1);
      if (size > 256) throw Error("compute_unavailable");
      line += new TextDecoder().decode(part);
      if (end < 0) continue;
      const event = JSON.parse(line);
      if (event.event !== "listen" || event.socket !== "control" || !Number.isInteger(event.port) || event.port < 1 || event.port > 65535) throw Error("compute_unavailable");
      // stdout is the control fd; later user output must never be parsed or retained.
      void (async () => { try { while (!(await reader.read()).done) { /* discard */ } } catch { /* exit closes pipe */ } })();
      return event.port as number;
    }
  } finally { signal.removeEventListener("abort", abort); }
}

export async function preferChildOom(pid: number) {
  try { await writeFile(`/proc/${pid}/oom_score_adj`, "1000"); }
  catch { /* Aggregate container OOM remains the fallback when the host refuses. */ }
}

export async function killAndReap(child: { kill(signal: "SIGKILL"): void; exited: Promise<number> }, fatal: () => never) {
  try { child.kill("SIGKILL"); } catch { /* Already exited. */ }
  const timer = setTimeout(fatal, 1000);
  try { await child.exited; } finally { clearTimeout(timer); }
}

// New children read mounted files on each spawn. Refuse drift until start.sh measures a restart.
export async function controlUnchanged(config: string, expected: string | undefined) {
  const hash = createHash("sha256");
  for (const name of ["loader.js", "config.capnp", "start.sh", "supervisor.ts", "child-process.ts"]) {
    const bytes = await Bun.file(join(dirname(config), name)).bytes();
    hash.update(`${createHash("sha256").update(bytes).digest("hex")}  ${name}\n`);
  }
  return hash.digest("hex") === expected;
}
