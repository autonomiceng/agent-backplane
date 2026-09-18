// A closed client output must end the owned process without an unhandled rejection.
import { expect, test } from "bun:test";
import { open } from "node:fs/promises";
import { join } from "node:path";

test("failed stdout is reported as an owned shutdown", async () => {
  const output = await open("/dev/full", "w");
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const launched = Bun.spawn([process.execPath, join(import.meta.dir, "main.ts")], {
      env: { PATH: process.env.PATH }, stdin: "pipe", stdout: output.fd, stderr: "pipe",
    });
    child = launched;
    launched.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "shutdown-test", version: "1" },
    } }) + "\n");
    launched.stdin.end();
    const timer = setTimeout(() => child?.kill(), 5000);
    try {
      const stderr = await new Response(launched.stderr).text();
      expect(await child.exited).toBe(1);
      expect(stderr).toBe("");
    } finally { clearTimeout(timer); }
  } finally {
    if (child && child.exitCode === null) { child.kill(); await child.exited; }
    await output.close();
  }
});
