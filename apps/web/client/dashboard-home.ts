import { createApi } from "./api.ts";
import type { WorkspacesPage } from "../../server/auth/list-workspaces-input.ts";

export type DashboardHomeState =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "error" }
  | { status: "ready"; page: number; workspaces: WorkspacesPage["items"]; nextCursor: string | null };

function isPage(value: unknown): value is WorkspacesPage {
  return typeof value === "object" && value !== null && "items" in value && Array.isArray(value.items)
    && value.items.every((item: unknown) => typeof item === "object" && item !== null
      && "id" in item && typeof item.id === "string" && "name" in item && typeof item.name === "string"
      && "organizationId" in item && typeof item.organizationId === "string"
      && "createdAt" in item && typeof item.createdAt === "string")
    && "nextCursor" in value && (value.nextCursor === null || typeof value.nextCursor === "string");
}

export function createDashboardHome(origin: string, fetcher: typeof fetch = fetch, limit = 50) {
  const api = createApi(origin, fetcher).api.v1.workspaces;
  let state: DashboardHomeState = { status: "loading" };
  let cursors: (string | undefined)[] = [undefined];
  let controller: AbortController | undefined;
  let disposed = false;
  const listeners = new Set<() => void>();
  const publish = (next: DashboardHomeState) => {
    if (disposed) return;
    state = next;
    for (const listener of listeners) listener();
  };
  async function load(nextCursors: (string | undefined)[], page: number) {
    if (disposed) return;
    controller?.abort();
    const request = new AbortController();
    controller = request;
    publish({ status: "loading" });
    const timeout = setTimeout(() => {
      if (controller !== request || request.signal.aborted) return;
      request.abort();
      publish({ status: "error" });
    }, 15000);
    try {
      const after = nextCursors[page];
      const response = await api.get({ query: { limit, ...(after === undefined ? {} : { after }) }, fetch: { signal: request.signal } });
      if (request.signal.aborted) return;
      if (response.status === 401) publish({ status: "signed-out" });
      else if (response.status === 200 && isPage(response.data)) {
        cursors = nextCursors;
        publish({ status: "ready", page, workspaces: response.data.items, nextCursor: response.data.nextCursor });
      } else publish({ status: "error" });
    } catch {
      if (!request.signal.aborted) publish({ status: "error" });
    } finally { clearTimeout(timeout); }
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh: () => load([undefined], 0),
    next: () => state.status === "ready" && state.nextCursor !== null
      ? load([...cursors.slice(0, state.page + 1), state.nextCursor], state.page + 1) : Promise.resolve(),
    previous: () => state.status === "ready" && state.page > 0 ? load(cursors, state.page - 1) : Promise.resolve(),
    dispose() { disposed = true; controller?.abort(); listeners.clear(); },
  };
}
export type DashboardHomeClient = ReturnType<typeof createDashboardHome>;
