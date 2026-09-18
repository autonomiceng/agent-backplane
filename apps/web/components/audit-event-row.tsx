// Displays permanent Audit Event envelopes with metadata collapsed by default.
import type { ReactNode } from "react";
import type { AuditEvent } from "../client/audit-state.ts";

export function AuditEventRow({ event }: { event: AuditEvent }): ReactNode {
  return <li data-position={event.position}>
    <div><strong>{event.kind}</strong> <time dateTime={event.occurred_at}>{event.occurred_at}</time></div>
    <p>Objects: {event.objects.join(", ") || "None"} · Rows: {event.row_count ?? "Unknown"}</p>
    <p>Principal: {event.principal_id ?? "None"} · User: {event.user_id ?? "None"}</p>
    <details><summary>Metadata</summary><pre>{JSON.stringify(event.metadata, null, 2)}</pre></details>
  </li>;
}
