// Subscribes to one Run timeline; the view also supports server-rendered integration assertions.
import { useEffect, useState, type ReactNode } from "react";
import { initialTimeline, timelineEvents, type TimelineState } from "../client/audit-state.ts";
import { subscribeAudit } from "../client/audit-stream.ts";
import { AuditEventRow } from "../components/audit-event-row.tsx";
import { LiveIndicator } from "../components/live-indicator.tsx";

export function RunTimeline({ workspaceId, runId }: { workspaceId: string; runId: string }): ReactNode {
  const [state, setState] = useState(() => initialTimeline(workspaceId, runId));
  useEffect(() => subscribeAudit(window.location.origin, workspaceId, runId, setState), [workspaceId, runId]);
  useEffect(() => {
    if (state.error === "unauthorized") {
      window.location.assign(`/dashboard/sign-in?returnTo=${encodeURIComponent(window.location.pathname)}`);
    }
  }, [state.error]);
  return <TimelineView key={state.epoch} state={state} />;
}

export function TimelineView({ state }: { state: TimelineState }): ReactNode {
  const [page, setPage] = useState(0);
  const events = timelineEvents(state);
  return <section className="screen">
    <a href={`/dashboard/workspaces/${state.workspaceId}/principals`}>Principals</a>
    <div className="toolbar"><h1>Run timeline</h1>{!state.error && <LiveIndicator phase={state.phase} />}</div>
    <div className="pk-endpoints run-ids">
      <div className="pk-endpoint"><span>Workspace</span><code>{state.workspaceId}</code></div>
      <div className="pk-endpoint"><span>Run</span><code>{state.runId}</code></div>
    </div>
    {state.error && <p className="pk-notice" data-state="danger" role="alert">Timeline unavailable: {state.error}</p>}
    {state.phase === "live" && events.length === 0 && <p className="pk-notice">No Audit Events for this Run.</p>}
    <ol className="timeline">{events.slice(page * 100, (page + 1) * 100).map(([id, event]) => <AuditEventRow key={id} event={event} />)}</ol>
    {events.length > 100 && <nav className="pager" aria-label="Timeline pages">
      <button className="pk-button" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
      <span> Page {page + 1} </span>
      <button className="pk-button" disabled={(page + 1) * 100 >= events.length} onClick={() => setPage(page + 1)}>Next</button>
    </nav>}
  </section>;
}
