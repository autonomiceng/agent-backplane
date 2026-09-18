// Eden commands and visible-page polling drive the inbox without replaying uncertain decisions.
import { reasonPermitsDecision } from "./approval-reasons.ts";
import { createApi } from "./api.ts";
import { initialApprovals, reduceApprovals, inboxItems, type ApprovalAction, type ApprovalState } from "./approval-state.ts";
function errorCode(value: unknown): string | null {
  return typeof value === "object" && value !== null && "error" in value && typeof value.error === "string" ? value.error : null;
}
export function createApprovalInbox(origin: string, workspaceId: string, fetcher: typeof fetch = fetch, limit = 50) {
  const api = createApi(origin, fetcher).api.v1.workspaces({ workspaceId }).approvals;
  let state = initialApprovals(workspaceId), requestId = 0, disposed = false;
  let listController: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let visibility: Document | undefined;
  const controllers = new Set<AbortController>(), listeners = new Set<() => void>();
  const dispatch = (action: ApprovalAction) => {
    if (disposed) return;
    state = reduceApprovals(state, action);
    for (const listener of listeners) listener();
  };
  const schedule = () => {
    clearTimeout(timer);
    if (!disposed && visibility?.visibilityState === "visible") timer = setTimeout(() => { void load(state.pagination); }, 10000);
  };
  async function load(pagination: ApprovalState["pagination"]) {
    if (disposed || visibility?.visibilityState === "hidden" || Object.values(state.submissions).some((s) => s.phase === "deciding")) return;
    clearTimeout(timer); listController?.abort();
    const controller = new AbortController(); listController = controller;
    const id = ++requestId, epoch = state.epoch;
    dispatch({ type: "list-start", epoch, requestId: id, pagination });
    const failed = () => dispatch({ type: "list-result", epoch, requestId: id, result: "approval_unavailable" });
    const timeout = setTimeout(() => { controller.abort(); failed(); }, 15000);
    try {
      const after = pagination.cursors[pagination.page];
      const response = await api.get({ query: { limit, ...(after === undefined ? {} : { after }) }, fetch: { signal: controller.signal } });
      dispatch({ type: "list-result", epoch, requestId: id, result: response.status === 200 && response.data
        && response.data.items.every((item) => item.workspaceId === workspaceId) ? response.data : errorCode(response.error?.value) ?? "approval_unavailable" });
    } catch { failed(); }
    finally { clearTimeout(timeout); if (listController === controller) schedule(); }
  }
  async function decide(id: string, decision: "approve" | "reject") {
    const item = inboxItems(state).find((entry) => entry.id === id), reason = state.reasons[id];
    if (disposed || !item || !reason || item.decision !== null || item.expired || state.submissions[id]
      || !reasonPermitsDecision(reason, decision)) return;
    const submissionId = ++requestId, epoch = state.epoch;
    dispatch({ type: "decide-start", epoch, requestId: submissionId, item });
    listController?.abort(); clearTimeout(timer);
    const controller = new AbortController(); controllers.add(controller);
    const unknown = () => dispatch({ type: "decide-result", epoch, requestId: submissionId, id,
      outcome: { phase: "unknown", status: null, error: "Outcome unknown", result: null } });
    const timeout = setTimeout(() => { controller.abort(); unknown(); }, 15000);
    try {
      const response = await api({ id }).decision.post({ decision, reason }, {
        headers: { "content-type": "application/json" }, fetch: { signal: controller.signal },
      });
      if (response.status === 200 && response.data?.id === id && response.data.decision === decision
        && (response.data.releasedDeliveryId === null || typeof response.data.releasedDeliveryId === "string")) {
        dispatch({ type: "decide-result", epoch, requestId: submissionId, id,
          outcome: { phase: "confirmed", status: 200, error: null, result: response.data } });
      } else {
        const error = errorCode(response.error?.value);
        if (response.status !== 200 && error) dispatch({ type: "decide-result", epoch, requestId: submissionId, id,
          outcome: { phase: "failed", status: response.status, error, result: null } });
        else unknown();
      }
    } catch { unknown(); }
    finally { clearTimeout(timeout); controllers.delete(controller); await load(state.pagination); }
  }
  const onVisibility = () => {
    clearTimeout(timer);
    if (visibility?.visibilityState === "visible") void load(state.pagination);
    else {
      if (state.listId !== null) dispatch({ type: "list-cancel", epoch: state.epoch, requestId: state.listId });
      listController?.abort(); listController = undefined;
    }
  };
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh: () => load({ cursors: [undefined], page: 0 }),
    previous: () => state.pagination.page === 0 ? Promise.resolve() : load({ ...state.pagination, page: state.pagination.page - 1 }),
    next: () => state.nextCursor === null ? Promise.resolve() : load({ page: state.pagination.page + 1,
      cursors: [...state.pagination.cursors.slice(0, state.pagination.page + 1), state.nextCursor] }),
    reason: (id: string, reason: string) => dispatch({ type: "reason", epoch: state.epoch, id, reason }),
    dismiss: (id: string) => dispatch({ type: "dismiss", epoch: state.epoch, id }),
    decide,
    start(document: Document) { visibility = document; visibility.addEventListener("visibilitychange", onVisibility); onVisibility(); },
    dispose() { disposed = true; clearTimeout(timer); listController?.abort(); for (const controller of controllers) controller.abort();
      visibility?.removeEventListener("visibilitychange", onVisibility); listeners.clear(); },
  };
}
export type ApprovalInboxClient = ReturnType<typeof createApprovalInbox>;
