// Static connection status derived from timeline state, shown as a platform-ui badge.
import type { ReactNode } from "react";
import type { TimelineState } from "../client/audit-state.ts";

export function LiveIndicator({ phase }: { phase: TimelineState["phase"] }): ReactNode {
  const badges = { connecting: ["starting", "Connecting"], live: ["ok", "Live"], reconnecting: ["warn", "Reconnecting"], resync: ["info", "Resyncing history"] } as const;
  const [state, label] = badges[phase];
  return <span className="pk-badge" data-state={state} role="status">{label}</span>;
}
