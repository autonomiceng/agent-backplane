import { expect, test } from "bun:test";
import { initialPrincipals, reducePrincipals, type Principal } from "./principals-state.ts";

test("Stale list or revoke responses overwrite the selected Principal's result", () => {
  const principal: Principal = { id: "p", workspaceId: "w", name: "Researcher", status: "active", credential: null };
  const page = { items: [principal], nextCursor: null };
  let state = initialPrincipals("w");
  state = reducePrincipals(state, { type: "list-start", generation: 0, requestId: 1, cursors: [undefined], page: 0 });
  state = reducePrincipals(state, { type: "list-result", generation: 0, requestId: 1, result: page });
  state = reducePrincipals(state, { type: "list-start", generation: 0, requestId: 2, cursors: [undefined], page: 0 });
  state = reducePrincipals(state, { type: "select", generation: 0, principal });
  state = reducePrincipals(state, { type: "revoke-start", generation: 0, requestId: 3 });
  const success = { type: "revoke-result", generation: 0, requestId: 3, principalId: "p", result: { phase: "confirmed", count: 1 } } as const;
  state = reducePrincipals(state, success);
  expect(state.items[0]?.status).toBe("revoked");
  expect(reducePrincipals(state, { type: "list-result", generation: 0, requestId: 2, result: page })).toEqual(state);
  state = reducePrincipals(state, { type: "list-start", generation: 0, requestId: 4, cursors: [undefined], page: 0 });
  state = reducePrincipals(state, { type: "list-result", generation: 0, requestId: 4, result: page });
  expect(state.items[0]?.status).toBe("revoked");
  state = reducePrincipals(state, { type: "select", generation: 0, principal: { ...principal, id: "other" } });
  state = reducePrincipals(state, { type: "revoke-start", generation: 0, requestId: 5 });
  state = reducePrincipals(state, { type: "revoke-result", generation: 0, requestId: 5, principalId: "other",
    result: { phase: "failed", error: "origin_forbidden" } });
  expect(reducePrincipals(state, success)).toEqual(state);
  expect(state.revocation?.error).toBe("origin_forbidden");
  state = reducePrincipals(state, { type: "select", generation: 0, principal });
  state = reducePrincipals(state, { type: "revoke-start", generation: 0, requestId: 6 });
  state = reducePrincipals(state, { type: "revoke-result", generation: 0, requestId: 6, principalId: "p",
    result: { phase: "outcome-unknown", error: "Revocation outcome unknown" } });
  expect(reducePrincipals(state, { ...success, requestId: 6 })).toEqual(state);
  expect(state.revocation?.phase).toBe("outcome-unknown");
  state = reducePrincipals(state, { type: "reset", generation: 1, workspaceId: "new" });
  state = reducePrincipals(state, { type: "list-start", generation: 1, requestId: 7, cursors: [undefined], page: 0 });
  expect(reducePrincipals(state, success)).toEqual(state);
  expect(reducePrincipals(state, { type: "list-result", generation: 0, requestId: 7, result: page })).toEqual(state);
  state = reducePrincipals(state, { type: "list-start", generation: 1, requestId: 8, cursors: [undefined], page: 0 });
  state = reducePrincipals(state, { type: "list-result", generation: 1, requestId: 8, result: "workspace_forbidden" });
  expect(reducePrincipals(state, { type: "list-result", generation: 1, requestId: 7, result: page })).toEqual(state);
  expect(state.workspaceId).toBe("new");
  expect(state.error).toBe("workspace_forbidden");
  expect(state.revocation).toBeNull();

  state = initialPrincipals("w");
  state = reducePrincipals(state, { type: "list-start", generation: 0, requestId: 9, cursors: [undefined], page: 0 });
  state = reducePrincipals(state, { type: "list-result", generation: 0, requestId: 9, result: { ...page, nextCursor: "next" } });
  const firstPage = { page: 0, cursors: [undefined], items: [principal], nextCursor: "next" };
  state = reducePrincipals(state, { type: "list-start", generation: 0, requestId: 10, cursors: [undefined, "next"], page: 1 });
  expect(state).toMatchObject(firstPage);
  state = reducePrincipals(state, { type: "list-result", generation: 0, requestId: 10, result: "principal_list_failed" });
  expect(state).toMatchObject({ ...firstPage, error: "principal_list_failed", listRequestId: null, pendingPagination: null });
  state = reducePrincipals(state, { type: "list-start", generation: 0, requestId: 11, cursors: [undefined, "next"], page: 1 });
  const nextPrincipal = { ...principal, id: "next-principal" };
  state = reducePrincipals(state, { type: "list-result", generation: 0, requestId: 11, result: { items: [nextPrincipal], nextCursor: null } });
  expect(state).toMatchObject({ page: 1, cursors: [undefined, "next"], items: [nextPrincipal], nextCursor: null,
    error: null, listRequestId: null, pendingPagination: null });
});
