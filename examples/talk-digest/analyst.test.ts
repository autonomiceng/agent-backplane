import { expect, test } from "bun:test";
import { auditProofEvent, completionDecision, completionKeys, escapeHtml, findInvocationEvent, renderPage, safeUrl } from "./analyst.ts";
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

test("completion retry distinguishes pending work from the identical completed digest", () => {
  const expected = { sourceFileId: "00000000-0000-0000-0000-000000000001", sourceSha256: "a".repeat(64), sourceBytes: 42,
    digest: "A bounded digest.", points: ["One", "Two"], metadata: { collectionDate: "2026-09-20", claimsVerified: false },
    principalId: "00000000-0000-0000-0000-000000000002", runId: "00000000-0000-0000-0000-000000000003" };
  const source = { transcript_file_id: expected.sourceFileId, transcript_sha256: expected.sourceSha256, transcript_bytes: "42" };
  expect(completionDecision({ ...source, analysis_state: "pending", digest_count: 0 }, expected)).toBe("pending");
  const completed = { ...source, analysis_state: "complete", digest_count: 1, digest_text: expected.digest,
    key_points: JSON.stringify(expected.points), analysis_metadata: expected.metadata,
    digest_principal_id: expected.principalId, digest_run_id: expected.runId };
  expect(completionDecision(completed, expected)).toBe("completed");
  expect(() => completionDecision({ ...completed, digest_text: "different" }, expected)).toThrow("completed_result_mismatch");
  expect(() => completionDecision({ ...completed, digest_run_id: "00000000-0000-0000-0000-000000000099" }, expected))
    .toThrow("completed_result_mismatch");
  expect(() => completionDecision({ ...completed, transcript_sha256: "b".repeat(64) }, expected)).toThrow("source_row_mismatch");
});

test("invocation audit search crosses full pages, terminates, and proof events exclude metadata", async () => {
  const calls: string[] = [], runId = "00000000-0000-0000-0000-000000000004";
  const ordinary = Array.from({ length: 500 }, (_, index) => ({ position: String(index + 1), kind: "sql.execute", metadata: {} }));
  const invoked = { position: "501", kind: "function.invoke", objects: ["talk-digest-review"], principal_id: "caller", run_id: "caller-run",
    occurred_at: "private", metadata: { runId, private: "exclude" } };
  const found = await findInvocationEvent("0", runId, async after => {
    calls.push(after);
    return after === "0" ? { events: ordinary, nextAfter: "500" } : { events: [invoked], nextAfter: "501" };
  });
  expect(calls).toEqual(["0", "500"]);
  expect(found).toEqual(invoked);
  expect(auditProofEvent(invoked)).toEqual({ position: "501", kind: "function.invoke", objects: ["talk-digest-review"],
    principal_id: "caller", run_id: "caller-run" });
  expect(JSON.stringify(auditProofEvent(invoked))).not.toContain("private");
  expect(await findInvocationEvent("501", runId, async () => ({ events: [], nextAfter: "501" }))).toBeUndefined();
});

test("completion transaction identities distinguish tuple boundaries, stay stable, and fit the API limit", () => {
  const first = completionKeys("a:b", "c"), second = completionKeys("a", "b:c");
  expect(first.failureKey).not.toBe(second.failureKey);
  expect(first.digestKey).not.toBe(second.digestKey);
  expect(first).toEqual(completionKeys("a:b", "c"));
  expect(first.failureKey).not.toBe(first.digestKey);
  expect(first.failureKey.endsWith(":expected-failure:v1")).toBeTrue();
  expect(first.digestKey.endsWith(":digest:v1")).toBeTrue();
  for (const key of Object.values(completionKeys("demo:".repeat(1000), "source:".repeat(1000)))) {
    expect(Buffer.byteLength(key)).toBeLessThanOrEqual(256);
  }
});
