// Workspace Approvals display authoritative descriptors and separate local submission outcomes.
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { createApprovalInbox, type ApprovalInboxClient } from "../client/approval-inbox.ts";
import { approvalReasons, reasonPermitsDecision } from "../client/approval-reasons.ts";
import { inboxItems, type ApprovalState } from "../client/approval-state.ts";
export function ApprovalInbox({ workspaceId }: { workspaceId: string }): ReactNode {
  const [client, setClient] = useState<ApprovalInboxClient | null>(null);
  useEffect(() => {
    const next = createApprovalInbox(window.location.origin, workspaceId);
    setClient(next); next.start(document);
    return () => next.dispose();
  }, [workspaceId]);
  return client ? <SubscribedInbox client={client} /> : <p>Loading Approvals</p>;
}
function SubscribedInbox({ client }: { client: ApprovalInboxClient }): ReactNode {
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot);
  return <ApprovalInboxView state={state} actions={client} />;
}
export function ApprovalInboxView({ state, actions }: { state: ApprovalState; actions: ApprovalInboxClient }): ReactNode {
  const items = inboxItems(state), loading = state.listId !== null;
  const deciding = Object.values(state.submissions).some((s) => s.phase === "deciding");
  return <section><h1>Approval inbox</h1><p>Workspace: {state.workspaceId}</p>
    <button disabled={loading || deciding} onClick={() => { void actions.refresh(); }}>Refresh</button>
    {loading && <p role="status">Refreshing</p>}
    {state.observedAt && <p>Last checked {state.observedAt}</p>}
    {state.error && <p role="alert">{state.error}</p>}
    {state.observedAt && !loading && !state.error && items.length === 0 && <p>No pending Approvals.</p>}
    {items.map((item) => {
      const submission = state.submissions[item.id], reason = state.reasons[item.id] ?? "";
      const disabled = !!submission || item.decision !== null || item.expired;
      return <article key={item.id} aria-label={`Approval ${item.id}`} data-approval-id={item.id}>
        <h2>Approval {item.id}</h2><p>Requested by {item.requestedBy}</p>
        <a href={`/dashboard/workspaces/${state.workspaceId}/runs/${item.requestedRunId}`}>Run {item.requestedRunId}</a>
        <p>Created {item.createdAt}. Expires {item.expiresAt}. {item.expired ? "Expired" : "Unexpired at last check"}</p>
        <p>Target {item.targetId}. Version {item.targetVersion}</p>
        <pre>{JSON.stringify(item.target, null, 2)}</pre>
        {item.decision !== null && <p>Server decision: {item.decision}. Reason: {item.reason}. Position: {item.decisionPosition}.</p>}
        <label>Reason <select required value={reason} disabled={disabled} onChange={(event) => actions.reason(item.id, event.target.value)}>
          <option value="">Select a reason</option>
          {approvalReasons.map((entry) => <option key={entry.code} value={entry.code}>{entry.label}</option>)}
        </select></label>
        <button disabled={disabled || !reasonPermitsDecision(reason, "approve")} onClick={() => { void actions.decide(item.id, "approve"); }}>Approve</button>
        <button disabled={disabled || !reasonPermitsDecision(reason, "reject")} onClick={() => { void actions.decide(item.id, "reject"); }}>Reject</button>
        {submission?.phase === "deciding" && <p role="status">Deciding</p>}
        {submission?.error && <p role="alert">{submission.phase}: {submission.status} {submission.error}</p>}
        {submission?.phase === "confirmed" && <div role="status"><p>200: {submission.result?.decision}</p>
          <p>Released Delivery: {submission.result?.releasedDeliveryId ?? "none"}</p></div>}
        {submission && ["failed", "unknown"].includes(submission.phase) && <button onClick={() => actions.dismiss(item.id)}>Dismiss submission</button>}
      </article>;
    })}
    <nav aria-label="Approval pages">
      <button disabled={loading || deciding || state.pagination.page === 0} onClick={() => { void actions.previous(); }}>Previous</button>
      <span> Page {state.pagination.page + 1} </span>
      <button disabled={loading || deciding || state.nextCursor === null} onClick={() => { void actions.next(); }}>Next</button>
    </nav>
  </section>;
}
