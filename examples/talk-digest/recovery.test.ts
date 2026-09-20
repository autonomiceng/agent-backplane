import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture } from "../../apps/server/blobs/testing/blob-fixture.ts";
import { applyMigration } from "../../apps/server/testing/session.ts";

test("completed CLI handoffs skip unreadable uploads and recover without repeating SQL, ack or valid upload", async () => {
  const f = await fixture(), directory = await mkdtemp(join(tmpdir(), "bp-talk-recovery-"));
  try {
    f.app.listen({ hostname: "localhost", port: 0 });
    await applyMigration(f.app, f.key, f.runId, f.workspaceId, await Bun.file(join(import.meta.dir, "schema.sql")).text());
    const queue = await f.app.handle(new Request(`${f.base}/queues`, { method: "POST",
      headers: { ...f.headers, "content-type": "application/json" }, body: JSON.stringify({ name: "platform-talks-v1" }) }));
    expect(queue.status).toBe(201);
    const queueHeaders = { ...f.headers, "content-type": "application/json" };
    for (let index = 0; index < 100; index++) {
      const sent = await f.app.handle(new Request(`${f.base}/queues/platform-talks-v1/messages`, { method: "POST", headers: queueHeaders,
        body: JSON.stringify({ idempotencyKey: `pagination-${index}`, payload: { filler: index } }) }));
      expect(sent.status).toBe(201);
      const leased = await f.app.handle(new Request(`${f.base}/queues/platform-talks-v1/claim`,
        { method: "POST", headers: queueHeaders, body: "{}" }));
      expect(leased.status).toBe(200);
      expect(await leased.json()).not.toBeNull();
    }
    const credentials = join(directory, "credentials.json");
    await writeFile(credentials, JSON.stringify({ url: `http://localhost:${f.app.server!.port}`,
      workspaceId: f.workspaceId, principalId: f.principalId, key: f.key }), { mode: 0o600 });
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("BP_"))),
      BP_CREDENTIALS_FILE: credentials, DEMO_WORKSPACE_ID: f.workspaceId, DEMO_PRINCIPAL_ID: f.principalId,
      BP_SESSION: "recovery", BP_DATA_DIR: directory, BP_HARNESS: "test", BP_MODEL: "test", BP_RUN_LABEL: "talk-recovery" };
    const invoke = async (name: string, args: string[]) => {
      const child = Bun.spawn(["bun", join(import.meta.dir, `${name}.ts`), ...args], { env, stdout: "pipe", stderr: "pipe" });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, stdout, stderr };
    };
    const transcript = join(import.meta.dir, "fixtures/fictional-reliable-agents-v1.txt");
    for (const failure of ["html", "proof"]) {
      const sourceId = `recover-${failure}`, metadata = join(directory, `${failure}-metadata.json`);
      const original = await Bun.file(join(import.meta.dir, "fixtures/fictional-reliable-agents-v1.json")).json();
      await writeFile(metadata, JSON.stringify({ ...original, sourceId }), { mode: 0o600 });
      const prepared = join(directory, `${failure}-prepared.json`), state = join(directory, `${failure}-claim.json`);
      const downloaded = join(directory, `${failure}-transcript.txt`), summary = join(directory, `${failure}-summary.json`);
      const html = join(directory, `${failure}-review.html`), proof = join(directory, `${failure}-proof.json`);
      expect(await invoke("collector", ["prepare", transcript, metadata, prepared])).toMatchObject({ code: 0, stderr: "" });
      expect(await invoke("collector", ["handoff", transcript, prepared])).toMatchObject({ code: 0, stderr: "" });
      expect(await invoke("analyst", ["claim", downloaded, state])).toMatchObject({ code: 0, stderr: "" });
      const claimed = JSON.parse(await readFile(state, "utf8")) as { analyst: { runId: string } };
      if (failure === "html") {
        const before = await readFile(state, "utf8"), lock = `${state}.lock`;
        await mkdir(lock, { mode: 0o700 });
        await writeFile(`${lock}/owner.json`, JSON.stringify({ command: "held-by-test", pid: process.pid }), { mode: 0o600 });
        const refused = await invoke("analyst", ["renew", state]);
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain("claim_state_locked");
        expect(await readFile(state, "utf8")).toBe(before);
        await rm(lock, { recursive: true });
      }
      if (failure === "proof") {
        const headers = { authorization: `Bearer ${f.key}`, "x-backplane-run": claimed.analyst.runId,
          "content-type": "application/octet-stream" };
        const uploaded = await f.app.handle(new Request(`${f.base}/blobs?key=recovery-unreadable-${sourceId}`,
          { method: "POST", headers, body: "unreadable earlier upload" }));
        expect(uploaded.status).toBe(201);
        const unavailableId = (await uploaded.json() as { id: string }).id;
        expect((await f.app.handle(new Request(`${f.base}/blobs/${unavailableId}`, { method: "DELETE", headers }))).status).toBe(204);
      }
      await writeFile(summary, JSON.stringify({ sourceId, digestText: "Reliable agents verify their work.",
        keyPoints: ["Use durable handoffs.", "Preserve attribution."] }), { mode: 0o600 });
      const blocked = failure === "html" ? html : proof;
      await mkdir(blocked, { mode: 0o700 });
      const args = ["complete", downloaded, state, summary, html, proof];
      const interrupted = await invoke("analyst", args);
      expect(interrupted.code).not.toBe(0);
      const events = () => f.pool<{ kind: string }[]>`SELECT kind FROM audit.events
        WHERE workspace_id=${f.workspaceId} AND run_id=${claimed.analyst.runId}`;
      expect((await events()).filter(event => event.kind === "transaction.committed"), interrupted.stderr).toHaveLength(1);
      await rm(blocked, { recursive: true });
      await writeFile(state, JSON.stringify({ ...JSON.parse(await readFile(state, "utf8")), leaseExpiresAt: "2000-01-01T00:00:00Z" }), { mode: 0o600 });
      expect(await invoke("analyst", args)).toMatchObject({ code: 0, stderr: "" });
      const saved = await readFile(proof, "utf8");
      expect(await invoke("analyst", args)).toMatchObject({ code: 0, stderr: "" });
      expect(await readFile(proof, "utf8")).toBe(saved);
      expect(await readFile(html, "utf8")).toContain("Reliable agents verify their work.");
      const observed = await events();
      expect(observed.filter(event => event.kind === "transaction.committed")).toHaveLength(1);
      expect(observed.filter(event => event.kind === "queue.ack")).toHaveLength(1);
      expect(observed.filter(event => event.kind === "blob.put")).toHaveLength(failure === "proof" ? 2 : 1);
      expect(JSON.parse(saved).transaction).toMatchObject({ expectedFailure: "assertion_failed",
        rollbackState: "pending", rollbackDigestCount: 0, ackUncommitted: true, identicalRetry: true, resultCount: 1 });
    }
  } finally {
    if (f.app.server) await f.app.stop();
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
