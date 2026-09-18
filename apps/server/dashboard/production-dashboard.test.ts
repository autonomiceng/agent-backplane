// The production process must fail early without the build and serve Vite's actual entry and assets.
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { dashboardRoutes } from "./dashboard-routes.ts";
test("production startup refuses a missing dashboard and serves the built Vite asset", async () => {
  const empty=await mkdtemp(join(tmpdir(),"bp-dashboard-production-"));
  try {
    expect(()=>dashboardRoutes(pathToFileURL(`${empty}/`),true)).toThrow("Dashboard build unavailable");
    const build=Bun.spawn(["bun","run","build:web"],{cwd:new URL("../../../",import.meta.url).pathname,stdout:"pipe",stderr:"pipe"});
    await Promise.all([new Response(build.stdout).text(),new Response(build.stderr).text()]);
    expect(await build.exited).toBe(0);
    const app=dashboardRoutes(new URL("../../web/dist/",import.meta.url),true);
    const index=await app.handle(new Request("http://localhost/dashboard"));
    expect(index.status).toBe(200);
    const html=await index.text(), path=/src="(\/dashboard\/assets\/[^"]+\.js)"/.exec(html)?.[1];
    expect(path).toBeString();
    const asset=await app.handle(new Request(`http://localhost${path}`));
    expect(asset.status).toBe(200); expect((await asset.text()).length).toBeGreaterThan(100);
  } finally { await rm(empty,{recursive:true,force:true}); }
},15000);
