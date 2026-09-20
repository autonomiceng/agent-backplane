import { renderToStaticMarkup } from "react-dom/server";
import type { DashboardHomeClient } from "../client/dashboard-home.ts";
import { DashboardHomeView } from "../screens/dashboard-home.tsx";

export function renderDashboardHome(client: DashboardHomeClient): string {
  return renderToStaticMarkup(<DashboardHomeView state={client.getSnapshot()} actions={client} />);
}
