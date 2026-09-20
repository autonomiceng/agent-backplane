import { expect, test } from "bun:test";
import { createPool } from "../../server/platform/pool.ts";
import { adminUrl, migratedDatabase } from "../../server/testing/postgres.ts";
import { principalFixture, signUp, testApp } from "../../server/testing/session.ts";
import { createDashboardHome } from "./dashboard-home.ts";
import { renderDashboardHome } from "../testing/render-dashboard-home.tsx";
import { Routes } from "../routes.tsx";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

test("home omits accessible Workspaces or sends Principals and Approvals links to the wrong Workspace", async () => {
  const pool = createPool(await migratedDatabase());
  let client: ReturnType<typeof createDashboardHome> | undefined;
  try {
    const f = await principalFixture(pool);
    const response = await f.app.handle(new Request("http://localhost/api/v1/workspaces", {
      method: "POST", headers: { cookie: f.cookie, origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({ name: "Support" }),
    }));
    expect(response.status).toBe(201);
    const other = await response.json() as { id: string; name: string };
    const fetcher: typeof fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      request.headers.set("cookie", f.cookie);
      return f.app.handle(request);
    }, { preconnect: fetch.preconnect });
    client = createDashboardHome("http://localhost", fetcher, 1);
    expect(renderDashboardHome(client)).toContain('role="status">Loading Workspaces');
    await client.refresh();
    const first = renderDashboardHome(client);
    await client.next();
    const second = renderDashboardHome(client);
    const combined = first + second;
    for (const workspace of [{ id: f.workspaceId, name: "Research" }, other]) {
      expect(combined).toContain(`<h3>${workspace.name}</h3>`);
      for (const screen of ["principals", "approvals"]) {
        const path = `/dashboard/workspaces/${workspace.id}/${screen}`;
        expect(combined).toContain(`href="${path}"`);
        const html = renderToStaticMarkup(createElement(Routes, { url: new URL(path, "http://localhost") }));
        expect(html).toContain(screen === "principals" ? "Loading Principals" : "Approvals");
      }
    }
    expect(second).not.toBe(first);
    await client.previous();
    expect(renderDashboardHome(client)).toBe(first);
    expect(first).toContain("BP_CREDENTIALS_FILE");
    expect(first).toContain("bp mcp");
    expect(first).toContain("/skills/backplane/SKILL.md");
  } finally { client?.dispose(); await pool.close(); }
});

test("signed-out home hides the sign-in path or keeps Workspace links after session expiry", async () => {
  const pool = createPool(await migratedDatabase());
  let client: ReturnType<typeof createDashboardHome> | undefined;
  try {
    const f = await principalFixture(pool);
    let cookie = "";
    const fetcher: typeof fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (cookie) request.headers.set("cookie", cookie);
      return f.app.handle(request);
    }, { preconnect: fetch.preconnect });
    client = createDashboardHome("http://localhost", fetcher);
    await client.refresh();
    expect(renderDashboardHome(client)).toContain('href="/dashboard/sign-in?returnTo=%2Fdashboard%2F">Sign in</a>');
    expect(renderDashboardHome(client)).not.toContain("No Workspaces");
    cookie = f.cookie;
    await client.refresh();
    expect(renderDashboardHome(client)).toContain(f.workspaceId);
    cookie = "";
    await client.refresh();
    expect(renderDashboardHome(client)).not.toContain(f.workspaceId);
    expect(renderDashboardHome(client)).toContain(">Sign in</a>");
  } finally { client?.dispose(); await pool.close(); }
});

test("empty or failed home misleadingly shows Workspaces and cannot recover on retry", async () => {
  const url = await migratedDatabase();
  const pool = createPool(url);
  const admin = createPool(adminUrl(url));
  let client: ReturnType<typeof createDashboardHome> | undefined;
  try {
    const app = await testApp(pool);
    const cookie = await signUp(app, "empty@example.com");
    const fetcher: typeof fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      request.headers.set("cookie", cookie);
      return app.handle(request);
    }, { preconnect: fetch.preconnect });
    client = createDashboardHome("http://localhost", fetcher);
    await client.refresh();
    expect(renderDashboardHome(client)).toContain("No Workspaces are available to your account.");
    expect(renderDashboardHome(client)).toContain("check your Organization access and Workspace setup");
    const active = client;
    await admin.begin(async tx => {
      await tx`LOCK TABLE control.workspaces IN ACCESS EXCLUSIVE MODE`;
      const pending = active.refresh();
      expect(renderDashboardHome(active)).toContain('role="status">Loading Workspaces');
      expect(renderDashboardHome(active)).not.toContain("No Workspaces");
      await pending;
      const html = renderDashboardHome(active);
      expect(html).toContain('role="alert">Workspaces could not be loaded.');
      expect(html).toContain(">Try again</button>");
      expect(html).not.toContain("No Workspaces");
    });
    await client.refresh();
    expect(renderDashboardHome(client)).not.toContain('role="alert"');
    expect(renderDashboardHome(client)).toContain("No Workspaces are available");
  } finally { client?.dispose(); await Promise.all([pool.close(), admin.close()]); }
});
