// Cookie-bearing requests and bounded lifetimes for the Principal screen's production actions.
import { createApi } from "./api.ts";
import { initialPrincipals, reducePrincipals, type Principal, type PrincipalsAction } from "./principals-state.ts";
import type { PrincipalsPage } from "../../server/auth/list-principals-input.ts";

function isPrincipal(value: unknown): value is Principal {
  if (typeof value !== "object" || value === null || !("id" in value) || typeof value.id !== "string"
    || !("workspaceId" in value) || typeof value.workspaceId !== "string" || !("name" in value) || typeof value.name !== "string"
    || !("status" in value) || (value.status !== "active" && value.status !== "revoked") || !("credential" in value)) return false;
  const key = value.credential;
  const date = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v));
  return key === null || (typeof key === "object" && "prefix" in key && typeof key.prefix === "string"
    && "createdAt" in key && date(key.createdAt) && "lastUsedAt" in key && (key.lastUsedAt === null || date(key.lastUsedAt))
    && "rotatedAt" in key && (key.rotatedAt === null || date(key.rotatedAt))
    && "revokedAt" in key && (key.revokedAt === null || date(key.revokedAt)));
}

function isPage(value: unknown, workspaceId: string): value is PrincipalsPage {
  return typeof value === "object" && value !== null && "items" in value && Array.isArray(value.items)
    && value.items.every((item: unknown) => isPrincipal(item) && item.workspaceId === workspaceId)
    && "nextCursor" in value && (value.nextCursor === null || typeof value.nextCursor === "string");
}

function errorMessage(value: unknown): string | null {
  return typeof value === "object" && value !== null && "error" in value && typeof value.error === "string" ? value.error : null;
}

export function createPrincipals(origin: string, workspaceId: string, fetcher: typeof fetch = fetch, limit = 50) {
  const api = createApi(origin, fetcher).api.v1.workspaces({ workspaceId }).principals;
  let state = initialPrincipals(workspaceId);
  let requestId = 0;
  let disposed = false;
  let listController: AbortController | undefined;
  let revokeController: AbortController | undefined;
  const listeners = new Set<() => void>();
  const dispatch = (action: PrincipalsAction) => {
    if (disposed) return;
    state = reducePrincipals(state, action);
    for (const listener of listeners) listener();
  };
  async function load(cursors: (string | undefined)[], page: number) {
    if (disposed || state.revocation?.phase === "pending") return;
    listController?.abort();
    const controller = new AbortController();
    listController = controller;
    const id = ++requestId;
    const generation = state.generation;
    dispatch({ type: "list-start", generation, requestId: id, cursors, page });
    const timeout = setTimeout(() => {
      controller.abort();
      dispatch({ type: "list-result", generation, requestId: id, result: "principal_list_failed" });
    }, 15000);
    try {
      const after = cursors[page];
      const response = await api.get({ query: { ...(after === undefined ? {} : { after }), limit }, fetch: { signal: controller.signal } });
      dispatch({ type: "list-result", generation, requestId: id,
        result: response.status === 200 && isPage(response.data, workspaceId) ? response.data
          : errorMessage(response.error?.value) ?? "principal_list_failed" });
    } catch {
      dispatch({ type: "list-result", generation, requestId: id, result: "principal_list_failed" });
    } finally { clearTimeout(timeout); }
  }
  async function confirm() {
    const selected = state.revocation;
    if (disposed || selected?.phase !== "confirming") return;
    const id = ++requestId;
    const generation = state.generation;
    const principalId = selected.principal.id;
    dispatch({ type: "revoke-start", generation, requestId: id });
    listController?.abort();
    const controller = new AbortController();
    revokeController = controller;
    const unknown = () => dispatch({ type: "revoke-result", generation, requestId: id, principalId,
      result: { phase: "outcome-unknown", error: "Revocation outcome unknown" } });
    const timeout = setTimeout(() => { controller.abort(); unknown(); }, 15000);
    try {
      const response = await api({ principalId }).revoke.post(undefined, {
        headers: { "content-type": "application/json" }, fetch: { signal: controller.signal },
      });
      const data = response.data;
      if (response.status === 200 && data?.workspaceId === workspaceId && data.principalId === principalId
        && data.status === "revoked" && Number.isInteger(data.effectsPausedThisRequest) && data.effectsPausedThisRequest >= 0) {
        dispatch({ type: "revoke-result", generation, requestId: id, principalId,
          result: { phase: "confirmed", count: data.effectsPausedThisRequest } });
        if (state.revocation?.phase === "confirmed") await load(state.cursors, state.page);
      } else {
        const error = errorMessage(response.error?.value);
        if (response.status !== 200 && error) dispatch({ type: "revoke-result", generation, requestId: id, principalId,
          result: { phase: "failed", error } });
        else unknown();
      }
    } catch { unknown(); }
    finally { clearTimeout(timeout); }
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh: () => load([undefined], 0),
    next: () => state.nextCursor === null ? Promise.resolve() : load([...state.cursors.slice(0, state.page + 1), state.nextCursor], state.page + 1),
    previous: () => state.page === 0 ? Promise.resolve() : load(state.cursors, state.page - 1),
    select: (principal: Principal) => dispatch({ type: "select", generation: state.generation, principal }),
    cancel: () => dispatch({ type: "cancel", generation: state.generation }),
    confirm,
    dispose() { disposed = true; listController?.abort(); revokeController?.abort(); listeners.clear(); },
  };
}
export type PrincipalsClient = ReturnType<typeof createPrincipals>;
