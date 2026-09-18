// Static connection status derived from timeline state.
import type { ReactNode } from "react";
import type { TimelineState } from "../client/audit-state.ts";

export function LiveIndicator({ phase }: { phase: TimelineState["phase"] }): ReactNode {
  const labels = { connecting: "Connecting", live: "Live", reconnecting: "Reconnecting", resync: "Resyncing history" };
  return <p role="status">{labels[phase]}</p>;
}
