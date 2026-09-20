import { expect, test } from "bun:test";
import { createSupervisor } from "./supervisor.ts";

test("an admitted slow body expires and releases capacity while oversized intake returns a typed failure", async () => {
  const supervisor = createSupervisor({ binary: "/unreachable-before-body-validation", config: "/unreachable-before-body-validation", token: "private", timeoutMs: 30, env: {} });
  const headers = { authorization: "Bearer private" };
  try {
    expect((await supervisor.fetch(new Request("http://runtime/invoke", { method: "POST", body: "x" }))).status).toBe(401);
    const pending = supervisor.fetch(new Request("http://runtime/invoke", { method: "POST", headers, body: new ReadableStream() }));
    const busy = await supervisor.fetch(new Request("http://runtime/invoke", { method: "POST", headers, body: "x" }));
    expect(busy.headers.get("x-backplane-error")).toBe("compute_unavailable");
    const expired = await pending;
    expect(expired.status).toBe(504); expect(expired.headers.get("x-backplane-error")).toBe("function_timeout");
    const oversized = await supervisor.fetch(new Request("http://runtime/invoke", { method: "POST", headers, body: new Uint8Array(26 * 1048576) }));
    expect(oversized.status).toBe(502); expect(oversized.headers.get("x-backplane-error")).toBe("function_failed");
  } finally { await supervisor.close(); }
});
