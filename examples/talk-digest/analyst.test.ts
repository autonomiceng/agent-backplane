import { expect, test } from "bun:test";
import { escapeHtml, renderPage, safeUrl } from "./analyst.ts";
import handler from "./function.js";

const source = {
  sourceId: "source-1", title: "Agents < Reliability", speakers: ["A & B"], fictional: false,
  videoUrl: "https://video.example/watch?v=1&part=2", transcriptUrl: "https://author.example/transcript",
};

test("standalone page escapes authored and source text while retaining validated source links", () => {
  const page = renderPage(source, { digest: "A <script> is text & only.", points: ["One > zero", "Quoted \"claim\""] }, "2026-09-20");
  expect(page).toContain("Agents &lt; Reliability");
  expect(page).toContain("A &lt;script&gt; is text &amp; only.");
  expect(page).toContain("https://video.example/watch?v=1&amp;part=2");
  expect(page).not.toContain("<script>");
  expect(escapeHtml("'\"&<>")).toBe("&#39;&quot;&amp;&lt;&gt;");
  expect(() => safeUrl("javascript:alert(1)")).toThrow("source_url_invalid");
});

test("Function uses invocation authority for one Workspace SQL read and returns escaped HTML metadata", async () => {
  const original = globalThis.fetch;
  let callback: { url: string; authorization: string | null; run: string | null; body: unknown } | undefined;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    callback = { url: request.url, authorization: request.headers.get("authorization"), run: request.headers.get("x-backplane-run"), body: await request.json() };
    return Response.json({ rows: [{ source_id: "source-1", title: "Title <unsafe>", speakers: ["Speaker & Co"], video_url: "https://video.example/1",
      transcript_url: "https://author.example/1", fictional: false, digest_text: "Claim < unverified", key_points: ["Point & detail"],
      analysis_metadata: { collectionDate: "2026-09-20", attribution: "Analyst <one>" }, completed_at: "2026-09-20T00:00:00Z" }] });
  }) as unknown as typeof fetch;
  try {
    const response = await handler.fetch(new Request("https://function.invalid/invoke", { method: "POST", body: '{"sourceId":"source-1"}' }),
      { token: "temporary", runId: "run-1", workspaceId: "workspace-1" });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(callback).toEqual({ url: "http://server:3000/api/v1/workspaces/workspace-1/sql", authorization: "Bearer temporary", run: "run-1",
      body: { statement: expect.stringContaining("JOIN talk_digests"), params: ["source-1"] } });
    expect(body.metadata).toEqual({ sourceId: "source-1", completedAt: "2026-09-20T00:00:00Z", invocationRunId: "run-1" });
    expect(body.html).toContain("Title &lt;unsafe&gt;");
    expect(body.html).not.toContain("<unsafe>");
  } finally { globalThis.fetch = original; }
});
