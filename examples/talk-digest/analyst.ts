#!/usr/bin/env bun
import { createHash, randomUUID } from "node:crypto";
import { chmod, open, readFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { keySegment } from "./key-segment.ts";

const QUEUE = "platform-talks-v1", FUNCTION = "talk-digest-review";
const CLI = resolve(import.meta.dir, "../../packages/cli/runtime/main.ts");
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = { [key: string]: Json };

export function object(value: unknown, name: string): Obj {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name}_invalid`);
  return value as Obj;
}
function text(value: Json | undefined, name: string) {
  if (typeof value !== "string" || !value) throw new Error(`${name}_invalid`);
  return value;
}
function list(value: Json | undefined, name: string) {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item)) throw new Error(`${name}_invalid`);
  return value as string[];
}
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const canonical = (value: Json): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : typeof value === "object" && value !== null ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(",")}}`
  : JSON.stringify(value);
const same = (left: Json, right: Json) => canonical(left) === canonical(right);
function json(value: Json | undefined, name: string): Json {
  if (typeof value !== "string") return value ?? null;
  try { return JSON.parse(value) as Json; } catch { throw new Error(`${name}_invalid`); }
}

type CompletionExpected = { sourceFileId: string; sourceSha256: string; sourceBytes: number; digest: string; points: string[];
  metadata: Obj; principalId: string; runId: string };
export function completionDecision(row: Obj, expected: CompletionExpected) {
  const sourceMatches = row.transcript_file_id === expected.sourceFileId && row.transcript_sha256 === expected.sourceSha256
    && row.transcript_bytes === String(expected.sourceBytes);
  if (!sourceMatches) throw new Error("source_row_mismatch");
  if (row.analysis_state === "pending" && row.digest_count === 0) return "pending" as const;
  const contentMatches = row.analysis_state === "complete" && row.digest_count === 1 && row.digest_text === expected.digest
    && same(json(row.key_points, "key_points"), expected.points) && same(json(row.analysis_metadata, "analysis_metadata"), expected.metadata)
    && row.digest_principal_id === expected.principalId && row.digest_run_id === expected.runId;
  if (!contentMatches) throw new Error("completed_result_mismatch");
  return "completed" as const;
}

export function auditProofEvent(value: unknown): Obj {
  const event = object(value, "event"), objects = event.objects;
  if (!Array.isArray(objects) || objects.some(value => typeof value !== "string")) throw new Error("event_objects_invalid");
  const principal = event.principal_id, run = event.run_id;
  if (principal !== null && typeof principal !== "string" || run !== null && typeof run !== "string") throw new Error("event_actor_invalid");
  return { position: text(event.position, "event_position"), kind: text(event.kind, "event_kind"), objects,
    principal_id: principal ?? null, run_id: run ?? null };
}

export async function findInvocationEvent(after: string, invocationRunId: string, readPage: (after: string) => Promise<Obj>) {
  while (true) {
    const page = await readPage(after), raw = page.events;
    const events = Array.isArray(raw) ? raw.map(event => object(event, "event")) : [];
    const found = events.find(event => event.kind === "function.invoke"
      && object(event.metadata, "event_metadata").runId === invocationRunId);
    if (found) return found;
    const next = text(page.nextAfter, "event_cursor");
    if (events.length < 500) return;
    if (next === after) throw new Error("audit_cursor_stalled");
    after = next;
  }
}

async function bpResult(args: string[], body?: Json) {
  const child = Bun.spawn(["bun", CLI, ...args], { env: process.env,
    stdin: body === undefined ? "ignore" : new Blob([JSON.stringify(body)]), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const parse = (value: string) => { try { return JSON.parse(value) as Json; } catch { return null; } };
  return { code, value: parse(stdout.trim()), failure: parse(stderr.trim()) };
}
async function bp(args: string[], body?: Json) {
  const result = await bpResult(args, body);
  if (result.code !== 0) throw new Error(`bp_failed:${text(object(result.failure, "bp_failure").error, "bp_error")}`);
  return result.value;
}
async function identity() {
  for (const name of ["DEMO_WORKSPACE_ID", "DEMO_PRINCIPAL_ID", "BP_CREDENTIALS_FILE", "BP_SESSION", "BP_DATA_DIR", "BP_HARNESS", "BP_MODEL", "BP_RUN_LABEL"])
    if (!process.env[name]) throw new Error(`${name}_required`);
  if (process.env.BP_KEY || process.env.BP_USER_EMAIL || process.env.BP_USER_PASSWORD) throw new Error("file_principal_credentials_required");
  const who = object(await bp(["auth", "whoami"]), "whoami");
  if (who.workspaceId !== process.env.DEMO_WORKSPACE_ID || who.principalId !== process.env.DEMO_PRINCIPAL_ID) throw new Error("analyst_identity_mismatch");
  return who;
}
async function writePrivate(path: string, value: Json, replace = false) {
  if (!replace) {
    const file = await open(path, "wx", 0o600);
    try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); } finally { await file.close(); }
    return;
  }
  const temporary = `${path}.${randomUUID()}`;
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); } finally { await file.close(); }
  await rename(temporary, path);
  await chmod(path, 0o600);
}
async function readObject(path: string, name: string) { return object(JSON.parse(await readFile(path, "utf8")) as Json, name); }

function sourcePayload(value: unknown) {
  const source = object(value, "queue_payload"), file = object(source.transcriptFile, "transcript_file");
  if (source.schemaVersion !== 1 || typeof source.fictional !== "boolean") throw new Error("queue_payload_version_invalid");
  for (const field of ["sourceId", "title"] as const) text(source[field], field);
  list(source.speakers, "speakers");
  for (const field of ["videoUrl", "transcriptUrl"] as const) if (source[field] !== null) safeUrl(text(source[field], field));
  text(file.id, "file_id"); text(file.sha256, "file_sha256");
  if (!Number.isSafeInteger(file.byteLength) || Number(file.byteLength) < 0) throw new Error("file_byte_length_invalid");
  return source;
}
export function safeUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("source_url_invalid");
  return url.href;
}
export const escapeHtml = (value: unknown) => String(value).replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]!);
function summary(value: Json, sourceId: string) {
  const authored = object(value, "summary"), digest = text(authored.digestText, "digest_text"), points = list(authored.keyPoints, "key_points");
  if (authored.sourceId !== sourceId || points.length < 2 || points.length > 6) throw new Error("summary_source_or_points_invalid");
  const words = `${digest} ${points.join(" ")}`.trim().split(/\s+/).length;
  if (words > 150) throw new Error("summary_over_150_words");
  return { digest, points, words };
}
export function renderPage(source: Obj, authored: { digest: string; points: string[] }, collectionDate: string) {
  const link = (value: Json | undefined, label: string) => value === null ? "" : `<a href="${escapeHtml(safeUrl(text(value, label)))}" rel="noreferrer">${label}</a>`;
  const links = [link(source.videoUrl, "Video"), link(source.transcriptUrl, "Transcript")].filter(Boolean).join(" · ");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(source.title)}</title><style>body{font:16px/1.55 system-ui,sans-serif;max-width:48rem;margin:3rem auto;padding:0 1rem;color:#17202a}header{border-bottom:1px solid #ccd1d1}small{color:#566573}li{margin:.45rem 0}a{color:#145a9c}</style></head><body><header><small>${source.fictional ? "Fixture" : "Real source"} · collected ${escapeHtml(collectionDate)}</small><h1>${escapeHtml(source.title)}</h1><p>${escapeHtml(list(source.speakers, "speakers").join(", "))}</p><p>${links}</p></header><main><h2>Digest</h2><p>${escapeHtml(authored.digest)}</p><h2>Main points</h2><ul>${authored.points.map(point => `<li>${escapeHtml(point)}</li>`).join("")}</ul></main><footer><small>Digest by Backplane analyst Principal. Vendor and speaker claims are summarized, not independently verified.</small></footer></body></html>`;
}

async function discover() {
  const who = await identity();
  const frames = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "talk-analyst", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ].map(frame => JSON.stringify(frame)).join("\n") + "\n";
  const child = Bun.spawn(["bun", CLI, "mcp"], { env: process.env, stdin: new Blob([frames]), stdout: "pipe", stderr: "pipe" });
  const [stdout, , code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error("mcp_discovery_failed");
  const tools = stdout.trim().split("\n").map(line => object(JSON.parse(line) as Json, "mcp_frame")).find(frame => frame.id === 2)?.result;
  if (!object(tools, "mcp_result").tools || !JSON.stringify(tools).includes("execute-transaction")) throw new Error("mcp_tools_missing");
  console.log(JSON.stringify({ workspaceId: who.workspaceId, principalId: who.principalId, mcpToolsDiscovered: true }));
}
async function claim(transcriptPath: string, statePath: string) {
  const who = await identity(), run = object(await bp(["run", "new", "--body", "-"],
    { harness: process.env.BP_HARNESS!, model: process.env.BP_MODEL!, label: process.env.BP_RUN_LABEL! }), "run");
  const claimed = object(await bp(["queue", "claim-message", "--queue", QUEUE, "--body", "-"], {}), "claim");
  const source = sourcePayload(claimed.payload), file = object(source.transcriptFile, "transcript_file");
  await bp(["blobs", "get-blob", "--id", text(file.id, "file_id"), "--out", transcriptPath]);
  const bytes = await readFile(transcriptPath);
  if (bytes.length !== file.byteLength || sha256(bytes) !== file.sha256) throw new Error("transcript_file_mismatch");
  await writePrivate(statePath, { version: 1, analyst: { principalId: who.principalId!, runId: run.id! }, queue: QUEUE,
    deliveryId: claimed.deliveryId!, messageId: claimed.messageId!, receipt: claimed.receipt!, leaseExpiresAt: claimed.leaseExpiresAt!, payload: source });
  console.log(JSON.stringify({ sourceId: source.sourceId, fileId: file.id, sha256: file.sha256, byteLength: file.byteLength,
    deliveryId: claimed.deliveryId, messageId: claimed.messageId, runId: run.id, privateState: statePath, privateTranscript: transcriptPath }));
}
async function liveReceipt(statePath: string, state: Obj) {
  let expiry = Date.parse(text(state.leaseExpiresAt, "lease_expiry"));
  if (!Number.isFinite(expiry) || expiry <= Date.now()) throw new Error("receipt_expired_refused");
  if (expiry - Date.now() < 120_000) {
    const renewed = object(await bp(["queue", "renew-delivery", "--delivery-id", text(state.deliveryId, "delivery_id"), "--body", "-"],
      { receipt: text(state.receipt, "receipt") }), "renewal");
    expiry = Date.parse(text(renewed.leaseExpiresAt, "lease_expiry"));
    state.leaseExpiresAt = new Date(expiry).toISOString(); await writePrivate(statePath, state, true);
  }
  return state;
}
async function renew(statePath: string) { await identity(); const state = await liveReceipt(statePath, await readObject(statePath, "claim_state")); console.log(JSON.stringify({ deliveryId: state.deliveryId, leaseExpiresAt: state.leaseExpiresAt })); }

async function complete(transcriptPath: string, statePath: string, summaryPath: string, htmlPath: string, proofPath: string) {
  const who = await identity(), state = await readObject(statePath, "claim_state");
  const source = sourcePayload(state.payload), file = object(source.transcriptFile, "transcript_file"), bytes = await readFile(transcriptPath);
  if (bytes.length !== file.byteLength || sha256(bytes) !== file.sha256) throw new Error("transcript_file_mismatch");
  const authored = summary(JSON.parse(await readFile(summaryPath, "utf8")) as Json, text(source.sourceId, "source_id"));
  const access = object(source.transcriptAccess, "transcript_access"), collectionDate = text(access.checkedAt, "collection_date");
  const metadata: Obj = { collectionDate, attribution: "Backplane analyst Principal", summaryWords: authored.words,
    sourceType: source.fictional ? "fixture" : "real", claimsVerified: false };
  const sourceId = text(source.sourceId, "source_id"), demoRun = text(source.demoRun, "demo_run");
  const analyst = object(state.analyst, "analyst"), expected: CompletionExpected = { sourceFileId: text(file.id, "file_id"),
    sourceSha256: text(file.sha256, "file_sha256"), sourceBytes: Number(file.byteLength), digest: authored.digest, points: authored.points,
    metadata, principalId: text(analyst.principalId, "analyst_principal_id"), runId: text(analyst.runId, "analyst_run_id") };
  if (expected.principalId !== who.principalId) throw new Error("claim_identity_mismatch");
  const inspect = async () => {
    const response = object(await bp(["sql", "execute-sql", "--body", "-"], { statement: "SELECT s.analysis_state,s.transcript_file_id::text AS transcript_file_id,s.transcript_sha256,s.transcript_bytes::text AS transcript_bytes,d.digest_text,d.key_points,d.analysis_metadata,d.principal_id::text AS digest_principal_id,d.run_id::text AS digest_run_id,(SELECT count(*)::int FROM talk_digests c WHERE c.source_id=s.source_id) AS digest_count FROM talk_sources s LEFT JOIN talk_digests d USING(source_id) WHERE s.source_id=$1", params: [sourceId] }), "completion_check");
    return object((response.rows as Json[])?.[0], "completion_row");
  };
  if (completionDecision(await inspect(), expected) === "completed") {
    let proof: Obj | undefined;
    try { proof = await readObject(proofPath, "proof"); }
    catch (error) { if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error; }
    if (!proof) throw new Error("completed_proof_unavailable");
    const transaction = object(proof.transaction, "proof_transaction");
    if (proof.sourceId !== sourceId || proof.sourceFileId !== file.id || proof.analystPrincipalId !== expected.principalId
      || proof.analystRunId !== expected.runId || transaction.expectedFailure !== "assertion_failed" || transaction.rollbackState !== "pending"
      || transaction.rollbackDigestCount !== 0 || transaction.ackUncommitted !== true || transaction.identicalRetry !== true
      || transaction.resultCount !== 1 || typeof transaction.committedPosition !== "string" || typeof proof.outputFileId !== "string")
      throw new Error("completed_proof_mismatch");
    console.log(JSON.stringify({ sourceId, alreadyCompleted: true, reused: true, proof: proofPath, outputFileId: proof.outputFileId }));
    return;
  }
  await liveReceipt(statePath, state);
  const update = "UPDATE talk_sources SET analysis_state='complete' WHERE source_id=$1 AND analysis_state='pending'";
  const insert = "INSERT INTO talk_digests (source_id,digest_text,key_points,analysis_metadata,completed_at) VALUES ($1,$2,$3::jsonb,$4::jsonb,CURRENT_TIMESTAMP)";
  const operations = (expectRows: number): Json[] => [
    { sql: { statement: update, params: [sourceId], expectRows } },
    { sql: { statement: insert, params: [sourceId, authored.digest, JSON.stringify(authored.points), JSON.stringify(metadata)], expectRows: 1 } },
    { ack: { deliveryId: text(state.deliveryId, "delivery_id"), receipt: text(state.receipt, "receipt") } },
  ];
  const failed = await bpResult(["transaction", "--body", "-"], { idempotencyKey: `talk:${demoRun}:${sourceId}:expected-failure:v1`, operations: operations(2) });
  const failure = object(failed.failure, "expected_failure");
  const failureDetails = object(failure.details, "expected_failure_details");
  if (failed.code === 0 || failure.error !== "assertion_failed" || failureDetails.operationIndex !== 0) throw new Error("expected_assertion_failure_missing");
  const rollbackRow = await inspect();
  const deliveries = object(await bp(["queue", "list-deliveries", "--queue", QUEUE, "--state", "leased", "--limit", "100"]), "deliveries");
  const ackUncommitted = Array.isArray(deliveries.items) && deliveries.items.some(item => object(item, "delivery").id === state.deliveryId);
  if (rollbackRow.analysis_state !== "pending" || rollbackRow.digest_count !== 0 || !ackUncommitted) throw new Error("failure_did_not_roll_back");
  const successBody: Obj = { idempotencyKey: `talk:${demoRun}:${sourceId}:digest:v1`, operations: operations(1) };
  const first = await bp(["transaction", "--body", "-"], successBody), retry = await bp(["transaction", "--body", "-"], successBody);
  if (!same(first, retry)) throw new Error("successful_retry_response_mismatch");
  const committed = object(first, "transaction");
  if (committed.committed !== true || !Array.isArray(committed.results) || committed.results.length !== 3) throw new Error("transaction_not_committed");
  if (completionDecision(await inspect(), expected) !== "completed") throw new Error("result_count_mismatch");
  const html = renderPage(source, authored, collectionDate); await Bun.write(htmlPath, html);
  const upload = object(await bp(["blobs", "put-blob", "--key", `talk-digest/${keySegment(demoRun)}/${keySegment(sourceId, ".html")}`, "--x-backplane-sha256", sha256(html), "--file", htmlPath]), "output_file");
  const audit = object(await bp(["events", "read-audit", "--run-id", text(object(state.analyst, "analyst").runId, "run_id"), "--after", "0", "--limit", "500"]), "audit");
  const events = Array.isArray(audit.events) ? audit.events.map(auditProofEvent) : [];
  const proof: Obj = { sourceId, sourceFileId: file.id!, outputFileId: upload.id!, analystPrincipalId: who.principalId!, analystRunId: object(state.analyst, "analyst").runId!,
    collectorPrincipalId: object(source.collector, "collector").principalId!, collectorRunId: object(source.collector, "collector").runId!, deliveryId: state.deliveryId!, messageId: state.messageId!,
    collectorEventCursor: text(object(source.provenance, "provenance").eventCursor, "event_cursor"),
    transaction: { expectedFailure: failure.error!, failedOperationIndex: failureDetails.operationIndex!, rollbackState: rollbackRow.analysis_state!, rollbackDigestCount: rollbackRow.digest_count!, ackUncommitted,
      committedPosition: committed.position!, identicalRetry: true, resultCount: 1 }, events };
  await writePrivate(proofPath, proof);
  console.log(JSON.stringify({ sourceId, html: htmlPath, outputFileId: upload.id, proof: proofPath, identicalRetry: true, resultCount: 1 }));
}

async function deploy(proofPath: string, expectedActiveId?: string) {
  const who = await identity(), proof = await readObject(proofPath, "proof"), bundle = await readFile(resolve(import.meta.dir, "function.js"), "utf8"), id = randomUUID();
  const deployed = object(await bp(["functions", "deploy-function", "--name", FUNCTION, "--body", "-"], { id, bundle, entryPoint: "default", outboundUrls: [] }), "deployment");
  const active = object(await bp(["functions", "activate-function", "--name", FUNCTION, "--id", id, "--body", "-"], { expectedActiveId: expectedActiveId ?? null }), "activation");
  proof.function = { name: FUNCTION, deploymentId: id, ownerPrincipalId: who.principalId!, deployRunId: deployed.runId!, active: active.status === "active" };
  await writePrivate(proofPath, proof, true);
  console.log(JSON.stringify({ functionName: FUNCTION, deploymentId: id, principalId: who.principalId, runId: deployed.runId, active: active.status === "active", proof: proofPath }));
}
async function publish(proofPath: string, invocationPath: string) {
  const who = await identity(), proof = await readObject(proofPath, "proof"), invocation = await readObject(invocationPath, "invocation");
  const deployed = object(proof.function, "function"), result = object(invocation.result, "invocation_result"), metadata = object(result.metadata, "invocation_metadata");
  const invocationRunId = text(invocation.runId, "invocation_run_id");
  if (invocation.deploymentId !== deployed.deploymentId || invocation.status !== 200 || metadata.invocationRunId !== invocationRunId
    || metadata.sourceId !== proof.sourceId || typeof result.html !== "string") throw new Error("invocation_proof_mismatch");
  const audit = object(await bp(["events", "read-audit", "--run-id", invocationRunId, "--after", "0", "--limit", "500"]), "invocation_audit");
  const rawEvents = Array.isArray(audit.events) ? audit.events.map(event => object(event, "event")) : [];
  if (!rawEvents.some(event => event.kind === "sql.execute" && event.principal_id === who.principalId && event.run_id === invocationRunId)
    || !rawEvents.some(event => event.kind === "function.complete" && event.principal_id === who.principalId && event.run_id === invocationRunId))
    throw new Error("invocation_attribution_missing");
  const invoked = await findInvocationEvent(text(proof.collectorEventCursor, "event_cursor"), invocationRunId, async after =>
    object(await bp(["events", "read-audit", "--after", after, "--limit", "500"]), "workspace_audit"));
  if (!invoked || invoked.principal_id === who.principalId || typeof invoked.principal_id !== "string" || typeof invoked.run_id !== "string")
    throw new Error("cross_principal_invocation_missing");
  proof.invocation = { deploymentId: invocation.deploymentId!, runId: invocationRunId, status: 200, sourceId: metadata.sourceId!,
    callerPrincipalId: invoked.principal_id, callerRunId: invoked.run_id, invokePosition: invoked.position!, events: rawEvents.map(auditProofEvent) };
  await writePrivate(proofPath, proof, true);
  const sourceId = text(proof.sourceId, "source_id"), hash = sha256(await readFile(proofPath));
  const uploaded = object(await bp(["blobs", "put-blob", "--key", `talk-digest/proof/${keySegment(sourceId, ".json")}`,
    "--x-backplane-sha256", hash, "--file", proofPath]), "proof_file");
  console.log(JSON.stringify({ sourceId, proofFileId: uploaded.id, sha256: hash, invocationRunId, deploymentId: invocation.deploymentId }));
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "discover" && args.length === 0) await discover();
  else if (command === "claim" && args.length === 2) await claim(args[0]!, args[1]!);
  else if (command === "renew" && args.length === 1) await renew(args[0]!);
  else if (command === "complete" && args.length === 5) await complete(args[0]!, args[1]!, args[2]!, args[3]!, args[4]!);
  else if (command === "deploy" && (args.length === 1 || args.length === 2)) await deploy(args[0]!, args[1]);
  else if (command === "publish" && args.length === 2) await publish(args[0]!, args[1]!);
  else throw new Error("usage: analyst.ts discover | claim TRANSCRIPT CLAIM | renew CLAIM | complete TRANSCRIPT CLAIM SUMMARY HTML PROOF | deploy PROOF [EXPECTED_ACTIVE_ID] | publish PROOF INVOCATION");
}
