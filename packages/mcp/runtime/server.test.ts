import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPool } from "../../../apps/server/platform/pool.ts";
import { adminUrl, migratedDatabase } from "../../../apps/server/testing/postgres.ts";
import { advanceDeliveryClock, applyMigration, createRun, issueKey, principalFixture } from "../../../apps/server/testing/session.ts";
import { filesystemStore } from "../../../apps/server/blobs/filesystem-store.ts";
import type { ComputeLauncher } from "../../../apps/server/compute/compute-launcher.ts";
import type { AppDeps } from "../../../apps/server/app.ts";
import { execute } from "../../cli/runtime/execute.ts";
import { catalog } from "./tools.ts";
import { server } from "./server.ts";
import { capture, commandsForExample, examples } from "../testing/examples.ts";

test("MCP workflow diverges from executable CLI examples", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bp-mcp-"));
  const runtimeDigest = `workerd-binary-sha256:${"a".repeat(64)}`;
  const evidence = { runtimeDigest, controlHash: "controlled-test-runtime", artifact: {
    source: "host-declared" as const, reference: `example/workerd@sha256:${"b".repeat(64)}`, hostObservedImageId: null,
  } };
  const compute: ComputeLauncher = {
    runtimeDigest, timeoutMs: 5000, verify: async () => evidence,
    prepare: async () => ({ ok: true, value: evidence.artifact }),
    invoke: async ({ manifest, props, input }) => {
      const bundlePath = join(directory, manifest.configHash + ".mjs");
      await writeFile(bundlePath, manifest.bundle);
      // Match compute/workerd/loader.js's three-argument call. Only repository-controlled
      // example bundles may execute here: this import runs unsandboxed under Bun.
      const module: { default: { fetch: (request: Request, context: typeof props, ctx: unknown) => Promise<Response> } } =
        await import(bundlePath);
      return module.default.fetch(new Request("https://function.invalid/invoke", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
      }), props, {});
    },
  };
  const fixtures: (Awaited<ReturnType<typeof principalFixture>> & { pool: ReturnType<typeof createPool>; admin: ReturnType<typeof createPool>;
    env: { BP_URL: string; BP_KEY: string; BP_WORKSPACE_ID: string; BP_DATA_DIR: string; BP_SESSION: string };
    rpc: ReturnType<typeof server>; responses: Record<string, unknown>[]; bindings: Record<string, string>; surface: string; streams: AbortSignal[];
    callerPrincipalId: string })[] = [];
  try {
    for (const surface of ["cli", "mcp"]) {
      const url = await migratedDatabase(), pool = createPool(url), admin = createPool(adminUrl(url));
      const dependencies: Pick<AppDeps, "blobStore" | "compute"> = { blobStore: filesystemStore(join(directory, surface)), compute };
      const f = await principalFixture(pool, dependencies);
      const key = await issueKey(f.app, f.cookie, f.workspaceId, f.principalId);
      const callerResponse = await f.app.handle(new Request(`http://localhost/api/v1/workspaces/${f.workspaceId}/principals`, {
        method: "POST", headers: { cookie: f.cookie, origin: "http://localhost", "content-type": "application/json" },
        body: '{"name":"Onboarding caller"}',
      }));
      expect(callerResponse.status).toBe(201);
      const caller = await callerResponse.json() as { id: string };
      const callerKey = await issueKey(f.app, f.cookie, f.workspaceId, caller.id);
      const env = { BP_URL: "", BP_KEY: key, BP_WORKSPACE_ID: f.workspaceId, BP_DATA_DIR: join(directory, surface), BP_SESSION: "examples" };
      const responses: Record<string, unknown>[] = [];
      const streams: AbortSignal[] = [];
      const transport: typeof fetch = Object.assign((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        if (String(input).endsWith("/events") && init?.signal) streams.push(init.signal);
        return fetch(input, init);
      }, { preconnect: fetch.preconnect });
      const rpc = server({ env, transport }, async (text) => { responses.push(JSON.parse(text)); });
      const onboardingFile = join(directory, `${surface}-onboarding.txt`), onboardingDownload = join(directory, `${surface}-download.txt`);
      await writeFile(onboardingFile, "agent client setup\n");
      const bindings: Record<string, string> = { ONBOARDING_FILE: onboardingFile, ONBOARDING_DOWNLOAD: onboardingDownload,
        DEPLOYMENT_ID: crypto.randomUUID(), OWNER_KEY: key, CALLER_KEY: callerKey };
      const fixture = { ...f, pool, admin, env, rpc, responses, bindings, surface, streams, callerPrincipalId: caller.id };
      fixtures.push(fixture);
      f.app.listen({ hostname: "localhost", port: 0 });
      env.BP_URL = `http://localhost:${f.app.server!.port}`;
      rpc.feed(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } } }) + "\n"));
      rpc.feed(Buffer.from('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'));
      await rpc.drain();
      expect(responses.pop()).toMatchObject({ result: { protocolVersion: "2025-11-25" } });
      rpc.feed(Buffer.from('{"jsonrpc":"2.0","id":-1,"method":"tools/list"}\n'));
      await rpc.drain();
      expect(responses.pop()).toMatchObject({ result: { tools: catalog.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } });
      rpc.feed(Buffer.from('{broken}\n{"jsonrpc":"2.0","id":-2,"method":"unknown"}\n'));
      await rpc.drain();
      expect(responses.splice(0).map((r) => r.error)).toEqual([{ code: -32700, message: "Parse error" }, { code: -32601, message: "Method not found" }]);
      rpc.feed(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: -3, method: "tools/call",
        params: { name: "createQueue", arguments: { body: { name: "cancelled" } } } }) + "\n"
        + '{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":-3}}\n'));
      await rpc.drain();
      expect(responses).toHaveLength(0);
      rpc.feed(Buffer.from('{"jsonrpc":"2.0","id":-4,"method":"tools/call","params":{"name":"createQueue","arguments":{"unexpected":true}}}\n'));
      await rpc.drain();
      expect(responses.pop()).toEqual({ jsonrpc: "2.0", id: -4,
        result: { content: [{ type: "text", text: '{"error":"invalid_arguments"}' }], isError: true } });
      expect(await pool`SELECT id FROM control.runs`).toHaveLength(0);
    }
    let requestId = 1;
    const call = async (f: typeof fixtures[number], argv: string[], body = "") => {
      if (f.surface === "cli") {
        let stdout = "", stderr = "";
        const code = await execute(argv, { env: f.env, stdin: async () => body,
          stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } });
        const output = (code ? stderr : stdout).trim();
        return { isError: code !== 0, value: output ? JSON.parse(output) : undefined };
      }
      // Aliases can be prefixes of full commands (bp events versus bp events stream-audit), so the longest match wins.
      const matches = catalog.flatMap((t) => [t.command.command, ...t.command.aliases]
        .filter((parts) => parts.every((p, i) => p === argv[i])).map((parts) => ({ tool: t, parts })))
        .sort((a, b) => b.parts.length - a.parts.length);
      const { tool, parts } = matches[0]!;
      const args: Record<string, unknown> = {};
      let outputPath: string | undefined;
      for (let i = parts.length; i < argv.length; i += 2) {
        if (argv[i] === "--body") args.body = JSON.parse(body);
        else if (argv[i] === "--file") args.file = argv[i + 1];
        else if (argv[i] === "--out") outputPath = argv[i + 1];
        else args[tool.command.parameters.find((p) => `--${p.flag}` === argv[i])!.name] = argv[i + 1];
      }
      const id = requestId++, frame = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: tool.name, arguments: args } }) + "\n");
      f.rpc.feed(frame.subarray(0, 7)); f.rpc.feed(frame.subarray(7)); await f.rpc.drain();
      const response = f.responses.shift() as { result: { isError: boolean; content: { text: string }[] } };
      expect(response).toHaveProperty("result");
      const value = JSON.parse(response.result.content[0]!.text);
      if (tool.command.binary && !response.result.isError) {
        expect(value).toMatchObject({ encoding: "base64", size: expect.any(Number) });
        if (!outputPath) throw new Error("binary example missing output path");
        await writeFile(outputPath, Buffer.from(value.content, "base64"));
        return { isError: false, value: undefined };
      }
      return { isError: response.result.isError, value };
    };
    const forward = new Map<string, string>(), backward = new Map<string, string>();
    const compare = (a: unknown, b: unknown, key = ""): void => {
      if (typeof a === "string" && typeof b === "string" &&
        (/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(a) || /(?:At|_at)$|[Pp]osition$|^receipt$|^effectKey$|^configHash$/.test(key))) {
        expect(b.length).toBeGreaterThan(0);
        if (/(?:At|_at)$/.test(key)) { expect(Number.isFinite(Date.parse(a))).toBe(true); expect(Number.isFinite(Date.parse(b))).toBe(true); }
        if (forward.has(a)) expect(b).toBe(forward.get(a)!);
        if (backward.has(b)) expect(a).toBe(backward.get(b)!);
        forward.set(a, b); backward.set(b, a); return;
      }
      if (Array.isArray(a)) { expect(Array.isArray(b)).toBe(true); expect(b).toHaveLength(a.length); a.forEach((v, i) => compare(v, (b as unknown[])[i], key)); return; }
      if (a !== null && typeof a === "object") {
        expect(Object.keys(b as object).sort()).toEqual(Object.keys(a).sort());
        for (const [k, value] of Object.entries(a)) compare(value, (b as Record<string, unknown>)[k], k);
      } else expect(b).toEqual(a);
    };
    const both = async (args: (f: typeof fixtures[number]) => { argv: string[]; body?: string }, failure = false) => {
      const outputs = [];
      for (const f of fixtures) { const input = args(f), result = await call(f, input.argv, input.body); expect(result.isError).toBe(failure); outputs.push(result.value); }
      compare(outputs[0], outputs[1]); return outputs;
    };
    const command = (argv: string[], body?: unknown) => ({ argv: [...argv, ...(body === undefined ? [] : ["--body", "-"])], ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const skill = examples(`${await readFile(new URL("../../../skills/backplane/references/client-setup.md", import.meta.url), "utf8")}\n${
      await readFile(new URL("../../../skills/backplane/SKILL.md", import.meta.url), "utf8")}`);
    const transactionBodies: string[] = [], transactionResults: unknown[] = [];
    await both(() => command(["queue", "create-queue"], { name: "lazy-first" }));
    await both(() => command(["queue", "create-queue"], { name: "lazy-reused" }));
    for (const f of fixtures) expect(await f.pool`SELECT id FROM control.runs WHERE principal_id=${f.principalId}`).toHaveLength(1);
    for (const example of skill) {
      if (example.name === "onboarding.functions-invoke") for (const f of fixtures) {
        f.env.BP_KEY = f.bindings.CALLER_KEY!; f.env.BP_SESSION = "onboarding-caller";
      }
      if (example.fixture) {
        await both(() => command(["queue", "send-message", "--queue", "intake"], { idempotencyKey: "uncertain", payload: {} }));
        for (const f of fixtures) {
          const claim = await call(f, ["queue", "claim-message", "--queue", "intake"]);
          f.bindings.AMBIGUOUS_ID = claim.value.deliveryId;
          expect((await call(f, ["queue", "begin-effect", "--delivery-id", claim.value.deliveryId, "--body", "-"],
            JSON.stringify({ receipt: claim.value.receipt, action: "submit-application", destination: "example-employer" }))).isError).toBe(false);
          const [run] = await f.pool<{ id: string }[]>`SELECT id FROM control.runs WHERE principal_id = ${f.principalId} ORDER BY created_at DESC LIMIT 1`;
          await advanceDeliveryClock(f.admin, { ...f, runId: run!.id }, claim.value.deliveryId, "leased");
          expect((await call(f, ["queue", "ack-delivery", "--delivery-id", claim.value.deliveryId, "--body", "-"],
            JSON.stringify({ receipt: claim.value.receipt }))).value.error).toBe("receipt_expired");
          expect((await call(f, ["queue", "claim-message", "--queue", "intake"])).value).toBeNull();
        }
        await both((f) => command(["queue", "reconcile-effect"], { deliveryId: f.bindings.AMBIGUOUS_ID, outcome: "unknown", evidence: "Unverified" }), true);
        for (const f of fixtures) {
          const response = await f.app.handle(new Request(`http://localhost/api/v1/workspaces/${f.workspaceId}/reconciliations/delegations/${f.principalId}`, {
            method: "PUT", headers: { origin: "http://localhost", cookie: f.cookie, "content-type": "application/json" }, body: '{"enabled":true}',
          })); expect(response.status).toBe(200);
        }
      }
      const outputs = [];
      for (const f of fixtures) {
        const results = [];
        for (const c of commandsForExample(example, f.bindings)) {
          const result = await call(f, c.argv, c.body); expect(result.isError, `${example.name} ${c.argv.join(" ")}: ${JSON.stringify(result.value)}`).toBe(false); results.push(result.value);
          if (example.name === "workflow.transaction") { transactionBodies.push(c.body); transactionResults.push(result.value); }
          if (example.name === "workflow.effect") {
            const hash = createHash("sha256").update(Buffer.from(f.workspaceId.replaceAll("-", ""), "hex"));
            for (const text of ["submit-application", "example-employer"]) { const size = Buffer.alloc(4); size.writeInt32BE(Buffer.byteLength(text)); hash.update(size).update(text); }
            expect(result.value.effectKey).toBe(hash.digest("hex")); expect(result.value.state).toBe("begun");
          }
        }
        capture(example, results.at(-1), f.bindings); outputs.push(results);
      }
      compare(outputs[0], outputs[1]);
      if (example.name === "onboarding.functions-invoke") for (const f of fixtures) {
        f.env.BP_KEY = f.bindings.OWNER_KEY!; f.env.BP_SESSION = "examples";
      }
    }
    for (const [i, f] of fixtures.entries()) {
      expect(await readFile(f.bindings.ONBOARDING_DOWNLOAD!, "utf8")).toBe("agent client setup\n");
      const [invocation] = await f.pool<{ caller_principal_id: string; caller_run_id: string; execution_principal_id: string; execution_run_id: string; execution_deployment_id: string | null }[]>`
        SELECT e.principal_id AS caller_principal_id,e.run_id AS caller_run_id,r.principal_id AS execution_principal_id,r.id AS execution_run_id,r.invocation_deployment_id AS execution_deployment_id
        FROM audit.events e JOIN control.runs r ON r.id=(e.metadata->>'runId')::uuid WHERE e.kind='function.invoke'`;
      expect(invocation).toMatchObject({ caller_principal_id: f.callerPrincipalId, execution_principal_id: f.principalId,
        execution_deployment_id: f.bindings.DEPLOYMENT_ID });
      expect(invocation!.caller_run_id).not.toBe(invocation!.execution_run_id);
      expect(await f.pool`SELECT run_id FROM control.invocation_tokens`).toHaveLength(0);
      const before = await f.pool`SELECT position FROM audit.events ORDER BY position`;
      expect(await call(f, ["transaction", "--body", "-"], transactionBodies[i])).toEqual({ isError: false, value: transactionResults[i] });
      expect(await f.pool`SELECT position FROM audit.events ORDER BY position`).toEqual(before);
      expect(await f.pool<{ state: string }[]>`SELECT state FROM queue.delivery_envelopes WHERE id IN (${f.bindings.DELIVERY_ID}, ${f.bindings.REVIEW_ID})`)
        .toEqual([{ state: "succeeded" }, { state: "succeeded" }]);
      const [run] = await f.pool<{ id: string }[]>`SELECT id FROM control.runs WHERE principal_id = ${f.principalId} AND label='dogfood'`;
      expect(await f.pool`SELECT id FROM control.runs WHERE principal_id = ${f.principalId} AND invocation_deployment_id IS NULL`).toHaveLength(2);
      expect(await f.pool<{ producer_principal_id: string; producer_run_id: string }[]>`SELECT producer_principal_id, producer_run_id FROM queue.messages WHERE queue='review'`)
        .toEqual([{ producer_principal_id: f.principalId, producer_run_id: run!.id }]);
      expect(await f.pool<{ run_id: string; principal_id: string }[]>`SELECT DISTINCT run_id,principal_id FROM audit.events WHERE kind IN ('queue.claim','queue.send','queue.ack','effect.begin','transaction.committed','effect.reconciled')`)
        .toEqual([{ run_id: run!.id, principal_id: f.principalId }]);
    }
    // Workspace SQL must name a Workspace table, so the rollback probe gets one through the API first.
    for (const f of fixtures) {
      const runId = await createRun(f.app, f.env.BP_KEY, f.workspaceId);
      await applyMigration(f.app, f.env.BP_KEY, runId, f.workspaceId, "CREATE TABLE rollback_probe (id int PRIMARY KEY)");
    }
    const failed = await both(() => command(["transaction"], { idempotencyKey: "rollback", operations: [
      { send: { queue: "review", idempotencyKey: "rolled-back", payload: {} } },
      { sql: { statement: "UPDATE rollback_probe SET id = 1 WHERE id = 99", params: [], expectRows: 1 } },
    ] }), true);
    expect(failed[0]).toMatchObject({ error: "assertion_failed", status: 422 });
    for (const f of fixtures) {
      expect(await f.pool`SELECT id FROM queue.messages WHERE idempotency_key='rolled-back'`).toHaveLength(0);
      const folder = join(f.env.BP_DATA_DIR, "cli", "runs"), file = join(folder, (await readdir(folder)).find((n) => n.endsWith(".json"))!);
      const cache = JSON.parse(await readFile(file, "utf8"));
      await writeFile(file, JSON.stringify({ ...cache, id: "00000000-0000-4000-8000-000000000001" }));
    }
    await both(() => command(["queue", "create-queue"], { name: "recovered" }));
    const mcp = fixtures[1]!;
    const streamed = await call(mcp, ["events", "stream-audit"]);
    expect(streamed.isError, JSON.stringify(streamed.value)).toBe(false);
    expect(Array.isArray(streamed.value)).toBe(true);
    expect(streamed.value.length).toBeGreaterThan(0);
    expect(streamed.value.length).toBeLessThanOrEqual(100);
    expect(mcp.streams).toHaveLength(1);
    expect(mcp.streams[0]!.aborted).toBe(true);
    for (const f of fixtures) {
      expect(await f.pool<{ state: string }[]>`SELECT state FROM queue.delivery_envelopes WHERE id=${f.bindings.AMBIGUOUS_ID}`).toEqual([{ state: "ambiguous" }]);
      expect(await f.pool`SELECT id FROM control.runs WHERE principal_id=${f.principalId} AND invocation_deployment_id IS NULL`).toHaveLength(4); // examples, poisoned-cache recovery, and the rollback probe migration each created one
      const response = await f.app.handle(new Request(`http://localhost/api/v1/workspaces/${f.workspaceId}/principals/${f.principalId}/revoke`, {
        method: "POST", headers: { origin: "http://localhost", cookie: f.cookie, "content-type": "application/json" }, body: "{}",
      })); expect(response.status).toBe(200);
    }
    const revoked = await both(() => command(["queue", "create-queue"], { name: "revoked" }), true);
    expect(revoked[0]).toMatchObject({ error: "unauthorized", status: 401 });
    for (const f of fixtures) expect(await f.pool`SELECT id FROM control.runs WHERE principal_id=${f.principalId} AND invocation_deployment_id IS NULL`).toHaveLength(4);
    expect(() => commandsForExample({ name: "bad", lines: ["bp ping; touch /tmp/no"], captures: [], fixture: undefined }, {})).toThrow();
  } finally {
    try {
      for (const f of fixtures) { await f.rpc.close(); if (f.app.server) await f.app.stop(); await f.pool.close(); await f.admin.close(); }
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
}, 60_000);
