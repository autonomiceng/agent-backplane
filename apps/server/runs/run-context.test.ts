import { expect, test } from "bun:test";
import { parseRunContext } from "./run-context.ts";

test("malformed UUIDs, mixed actors and empty Users cannot become Run context", () => {
  const agent = { workspaceId: crypto.randomUUID(), principalId: crypto.randomUUID(), runId: crypto.randomUUID() };
  const user = { workspaceId: agent.workspaceId, userId: "user-1" };
  expect(parseRunContext(agent)).toEqual({ ok: true, context: agent });
  expect(parseRunContext(user)).toEqual({ ok: true, context: user });
  expect(parseRunContext({ ...agent, workspaceId: "broken" })).toEqual({ ok: false, reason: "context_invalid" });
  expect(parseRunContext({ ...agent, principalId: "broken" })).toEqual({ ok: false, reason: "context_invalid" });
  expect(parseRunContext({ ...agent, runId: "broken" })).toEqual({ ok: false, reason: "context_invalid" });
  expect(parseRunContext({ ...agent, userId: "user-1" })).toEqual({ ok: false, reason: "context_invalid" });
  expect(parseRunContext({ ...user, userId: "" })).toEqual({ ok: false, reason: "context_invalid" });
});
