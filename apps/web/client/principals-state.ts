// Pure pagination and revocation transitions shared by the screen and HTTP adapter.
import type { PrincipalsPage } from "../../server/auth/list-principals-input.ts";

export type Principal = PrincipalsPage["items"][number];
export type Revocation = { principal: Principal; phase: "confirming" | "pending" | "confirmed" | "failed" | "outcome-unknown";
  requestId: number | null; error: string | null; effectsPausedThisRequest: number | null };
export type PrincipalsState = {
  workspaceId: string; generation: number; items: Principal[]; nextCursor: string | null;
  cursors: (string | undefined)[]; page: number; listRequestId: number | null;
  pendingPagination: { cursors: (string | undefined)[]; page: number } | null;
  loaded: boolean; error: string | null; revocation: Revocation | null; confirmedIds: string[];
};
export type PrincipalsAction = { type: "reset"; workspaceId: string; generation: number }
  | { type: "list-start"; generation: number; requestId: number; cursors: (string | undefined)[]; page: number }
  | { type: "list-result"; generation: number; requestId: number; result: PrincipalsPage | string }
  | { type: "select"; generation: number; principal: Principal }
  | { type: "cancel"; generation: number }
  | { type: "revoke-start"; generation: number; requestId: number }
  | { type: "revoke-result"; generation: number; requestId: number; principalId: string;
    result: { phase: "confirmed"; count: number } | { phase: "failed" | "outcome-unknown"; error: string } };

export function initialPrincipals(workspaceId: string, generation = 0): PrincipalsState {
  return { workspaceId, generation, items: [], nextCursor: null, cursors: [undefined], page: 0,
    listRequestId: null, pendingPagination: null, loaded: false, error: null, revocation: null, confirmedIds: [] };
}

export function reducePrincipals(state: PrincipalsState, action: PrincipalsAction): PrincipalsState {
  if (action.type === "reset") return action.generation > state.generation ? initialPrincipals(action.workspaceId, action.generation) : state;
  if (action.generation !== state.generation) return state;
  switch (action.type) {
    case "list-start":
      if (state.revocation?.phase === "pending") return state;
      return { ...state, listRequestId: action.requestId, pendingPagination: { cursors: action.cursors, page: action.page }, error: null };
    case "list-result":
      if (state.listRequestId !== action.requestId || state.pendingPagination === null) return state;
      if (typeof action.result === "string") return { ...state, listRequestId: null, pendingPagination: null, error: action.result };
      return { ...state, ...state.pendingPagination, pendingPagination: null, listRequestId: null, loaded: true, error: null, nextCursor: action.result.nextCursor,
        items: action.result.items.map((item) => state.confirmedIds.includes(item.id) ? { ...item, status: "revoked" } : item) };
    case "select":
      if (state.revocation?.phase === "pending" || action.principal.workspaceId !== state.workspaceId) return state;
      return { ...state, revocation: { principal: action.principal, phase: "confirming", requestId: null,
        error: null, effectsPausedThisRequest: null } };
    case "cancel":
      return state.revocation?.phase === "pending" ? state : { ...state, revocation: null };
    case "revoke-start":
      if (state.revocation?.phase !== "confirming") return state;
      return { ...state, listRequestId: null, pendingPagination: null, revocation: { ...state.revocation, phase: "pending", requestId: action.requestId } };
    case "revoke-result": {
      const revocation = state.revocation;
      if (revocation?.phase !== "pending" || revocation.requestId !== action.requestId || revocation.principal.id !== action.principalId) return state;
      if (action.result.phase !== "confirmed") return { ...state, revocation: { ...revocation, ...action.result, requestId: null } };
      return { ...state, confirmedIds: [...state.confirmedIds, action.principalId],
        items: state.items.map((item) => item.id === action.principalId ? { ...item, status: "revoked" } : item),
        revocation: { ...revocation, principal: { ...revocation.principal, status: "revoked" }, phase: "confirmed",
          requestId: null, effectsPausedThisRequest: action.result.count } };
    }
  }
}
