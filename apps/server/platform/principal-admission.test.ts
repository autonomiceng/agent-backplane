import { expect, test } from "bun:test";
import { Elysia } from "elysia";
import { PrincipalAdmission, principalAdmission } from "./principal-admission.ts";

// Budget overage: one pure, millisecond-scale sibling test covers permit lifecycle failures.
test("Thrown handlers, active aborts, queued aborts and timeouts do not leak admission permits", async () => {
  const gate = new PrincipalAdmission(2, 20);
  const request = (signal?: AbortSignal) => new Request("http://localhost/work", { method: "POST", signal: signal ?? null });
  const app = new Elysia().use(principalAdmission(gate)).onBeforeHandle(async ({ request, admission }) => {
    if (!await admission.acquire(request)) return new Response(null, { status: 503 });
  }).post("/work", () => { throw new Error("handler failed"); });
  expect((await app.handle(request())).status).toBe(500);
  const active = new AbortController();
  const first = request(active.signal);
  expect(await gate.acquire(first)).toBe(true);
  const queued = new AbortController();
  const cancelled = gate.acquire(request(queued.signal));
  queued.abort();
  expect(await cancelled).toBe(false);
  const second = request();
  const waiting = gate.acquire(second);
  active.abort();
  expect(await waiting).toBe(true);
  gate.release(first);
  expect(await gate.acquire(request())).toBe(false);
  const third = request();
  const next = gate.acquire(third);
  gate.release(second);
  expect(await next).toBe(true);
  gate.release(third);
  const final = request();
  expect(await gate.acquire(final)).toBe(true);
  gate.release(final);
});
