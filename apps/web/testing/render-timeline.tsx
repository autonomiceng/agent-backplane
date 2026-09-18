// Renders the production timeline for server integration assertions using the web package's React dependencies.
import { renderToStaticMarkup } from "react-dom/server";
import type { TimelineState } from "../client/audit-state.ts";
import { TimelineView } from "../screens/run-timeline.tsx";

export function renderTimeline(state: TimelineState): string {
  return renderToStaticMarkup(<TimelineView state={state} />);
}
