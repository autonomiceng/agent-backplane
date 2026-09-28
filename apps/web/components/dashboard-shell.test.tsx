import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DashboardShell } from "./dashboard-shell.tsx";

test("the kit header links to the Platform only when a valid origin is configured", () => {
  const standalone = renderToStaticMarkup(<DashboardShell><p>Body</p></DashboardShell>);
  expect(standalone).toContain('class="pk-header"');
  expect(standalone).toContain("Agent Backplane</a>");
  expect(standalone).toContain('href="https://github.com/autonomiceng/agent-backplane"');
  expect(standalone).not.toContain(">Platform</a>");
  const bundled = renderToStaticMarkup(<DashboardShell platformUrl="https://platform.example.test"><p>Body</p></DashboardShell>);
  expect(bundled).toContain('aria-label="Links"><a href="https://platform.example.test/">Platform</a>');
  expect(renderToStaticMarkup(<DashboardShell platformUrl="javascript:alert(1)"><p>Body</p></DashboardShell>)).not.toContain(">Platform</a>");
});
