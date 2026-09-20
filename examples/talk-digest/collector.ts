#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const WORKSPACE = "fdb8bb55-8e32-4d41-aab9-7ce3d8de7fd7";
const PRINCIPAL = "3cd028ae-b84a-440a-a6a6-f4a5077a4181";
const QUEUE = "platform-talks-v1";
const CLI = resolve(import.meta.dir, "../../packages/cli/runtime/main.ts");
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = { [key: string]: Json };

function object(value: unknown, name: string): Obj {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name}_invalid`);
  return value as Obj;
}
function text(value: Json | undefined, name: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${name}_invalid`);
  return value;
}
function strings(value: Json | undefined, name: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) throw new Error(`${name}_invalid`);
  return value as string[];
}
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function canonical(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(",")}}`;
  return JSON.stringify(value);
}
const equal = (a: Json, b: Json) => canonical(a) === canonical(b);

async function bp(args: string[], body?: Json): Promise<Json> {
  const child = Bun.spawn(["bun", CLI, ...args], {
    env: process.env, stdin: body === undefined ? "ignore" : new Blob([JSON.stringify(body)]), stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (status !== 0) throw new Error(`bp_failed:${stderr.trim() || status}`);
  return stdout.trim() ? JSON.parse(stdout) as Json : null;
}
async function identity() {
  for (const name of ["BP_CREDENTIALS_FILE", "BP_SESSION", "BP_DATA_DIR", "BP_HARNESS", "BP_MODEL", "BP_RUN_LABEL"])
    if (!process.env[name]) throw new Error(`${name}_required`);
  if (process.env.BP_KEY || process.env.BP_USER_EMAIL || process.env.BP_USER_PASSWORD) throw new Error("file_principal_credentials_required");
  const who = object(await bp(["auth", "whoami"]), "whoami");
  if (who.workspaceId !== WORKSPACE || who.principalId !== PRINCIPAL) throw new Error("collector_identity_mismatch");
  return who;
}
async function cursor() {
  let after = "0";
  while (true) {
    const page = object(await bp(["events", "read-audit", "--after", after, "--limit", "500"]), "audit");
    const events = page.events;
    after = text(page.nextAfter, "audit_cursor");
    if (!Array.isArray(events) || events.length < 500) return after;
  }
}
async function verifyFile(id: string, expected: Uint8Array) {
  const dir = await mkdtemp(`${tmpdir()}/talk-digest-`), output = resolve(dir, "transcript");
  try {
    await bp(["blobs", "get-blob", "--id", id, "--out", output]);
    const actual = await readFile(output);
    if (actual.length !== expected.length || sha256(actual) !== sha256(expected)) throw new Error("stored_file_mismatch");
  } finally { await rm(dir, { recursive: true, force: true }); }
}
function metadata(value: Json) {
  const m = object(value, "metadata");
  if (m.schemaVersion !== 1 || typeof m.fictional !== "boolean") throw new Error("metadata_version_invalid");
  for (const field of ["demoRun", "sourceId", "title", "mediaType"] as const) text(m[field], field);
  strings(m.speakers, "speakers"); strings(m.topicTags, "topicTags");
  for (const field of ["talkDate", "videoUrl", "transcriptUrl"] as const)
    if (m[field] !== null && typeof m[field] !== "string") throw new Error(`${field}_invalid`);
  object(m.transcriptAccess, "transcriptAccess"); object(m.license, "license");
  return m;
}
async function prepare(transcriptPath: string, metadataPath: string, outputPath: string) {
  const who = await identity(), source = metadata(JSON.parse(await readFile(metadataPath, "utf8")) as Json);
  const bytes = await readFile(transcriptPath), hash = sha256(bytes);
  try {
    const saved = object(JSON.parse(await readFile(outputPath, "utf8")) as Json, "prepared");
    const file = object(saved.transcriptFile, "transcriptFile"), collector = object(saved.collector, "collector");
    if (saved.sourceId !== source.sourceId || saved.demoRun !== source.demoRun || file.sha256 !== hash || file.byteLength !== bytes.length
      || collector.principalId !== who.principalId) throw new Error("prepared_manifest_mismatch");
    const id = text(file.id, "file_id"); await verifyFile(id, bytes);
    console.log(JSON.stringify({ prepared: outputPath, sourceId: source.sourceId, fileId: id, sha256: hash,
      byteLength: bytes.length, runId: collector.runId, eventCursor: object(saved.provenance, "provenance").eventCursor, reused: true }));
    return;
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
  }
  const startCursor = await cursor();
  const run = object(await bp(["run", "new", "--body", "-"], {
    harness: process.env.BP_HARNESS!, model: process.env.BP_MODEL!, label: process.env.BP_RUN_LABEL!,
  }), "run");
  const keyPart = (value: string) => value.replaceAll(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
  let id: string;
  if (source.existingFileId !== undefined) {
    id = text(source.existingFileId, "existingFileId");
  } else {
    const upload = object(await bp(["blobs", "put-blob", "--key", `talk-digest/${keyPart(text(source.demoRun, "demoRun"))}/${keyPart(text(source.sourceId, "sourceId"))}.txt`,
      "--x-backplane-sha256", hash, "--file", transcriptPath]), "upload");
    id = text(upload.id, "file_id");
    if (upload.sha256 !== hash || upload.size !== bytes.length) throw new Error("upload_metadata_mismatch");
  }
  await verifyFile(id, bytes);
  const prepared: Obj = { ...source, transcriptFile: { id, sha256: hash, byteLength: bytes.length, mediaType: text(source.mediaType, "mediaType") },
    collector: { principalId: who.principalId!, runId: text(run.id, "run_id") },
    provenance: { eventCursor: startCursor, fileUploadedInRun: source.existingFileId === undefined } };
  const file = await open(outputPath, "wx", 0o600);
  try { await file.writeFile(`${JSON.stringify(prepared, null, 2)}\n`); } finally { await file.close(); }
  console.log(JSON.stringify({ prepared: outputPath, sourceId: source.sourceId, fileId: id, sha256: hash, byteLength: bytes.length, runId: run.id, eventCursor: startCursor }));
}
async function handoff(transcriptPath: string, preparedPath: string) {
  const who = await identity(), source = metadata(JSON.parse(await readFile(preparedPath, "utf8")) as Json);
  const prepared = object(JSON.parse(await readFile(preparedPath, "utf8")) as Json, "prepared");
  const file = object(prepared.transcriptFile, "transcriptFile"), collector = object(prepared.collector, "collector");
  if (collector.principalId !== who.principalId) throw new Error("prepared_principal_mismatch");
  const bytes = await readFile(transcriptPath), hash = sha256(bytes), fileId = text(file.id, "file_id");
  if (file.sha256 !== hash || file.byteLength !== bytes.length) throw new Error("local_transcript_mismatch");
  await verifyFile(fileId, bytes);
  const sourceId = text(source.sourceId, "sourceId"), demoRun = text(source.demoRun, "demoRun");
  const handoffKey = `talk:${demoRun}:${sourceId}:handoff:v1`, messageKey = `talk:${demoRun}:${sourceId}:message:v1`;
  const payload: Obj = { schemaVersion: 1, sourceId, title: source.title!, speakers: source.speakers!, talkDate: source.talkDate!,
    topicTags: source.topicTags!, videoUrl: source.videoUrl!, transcriptUrl: source.transcriptUrl!, fictional: source.fictional!,
    transcriptFile: file, transcriptAccess: source.transcriptAccess!, license: source.license!, collector,
    provenance: prepared.provenance!, handoffIdempotencyKey: handoffKey };
  const statement = `INSERT INTO talk_sources (source_id,demo_run,title,speakers,talk_date,topic_tags,video_url,transcript_url,fictional,source_metadata,transcript_file_id,transcript_sha256,transcript_bytes,analysis_state) VALUES ($1,$2,$3,$4::jsonb,$5::date,$6::jsonb,$7,$8,$9,$10::jsonb,$11::uuid,$12,$13,'pending')`;
  const transaction: Obj = { idempotencyKey: handoffKey, operations: [
    { sql: { statement, params: [sourceId, demoRun, source.title!, JSON.stringify(source.speakers), source.talkDate!, JSON.stringify(source.topicTags), source.videoUrl!, source.transcriptUrl!, source.fictional!, JSON.stringify(source), fileId, hash, bytes.length], expectRows: 1 } },
    { send: { queue: QUEUE, idempotencyKey: messageKey, payload } },
  ] };
  const first = await bp(["transaction", "--body", "-"], transaction), retry = await bp(["transaction", "--body", "-"], transaction);
  if (!equal(first, retry)) throw new Error("idempotent_response_mismatch");
  const committed = object(first, "transaction"), results = committed.results;
  if (committed.committed !== true) throw new Error("transaction_not_committed");
  if (!Array.isArray(results)) throw new Error("transaction_results_invalid");
  if (object(object(results[0], "sql_result").sql, "sql_result").rowCount !== "1") throw new Error("source_insert_mismatch");
  const send = object(object(results[1], "send_result").send, "send_result"), messageId = text(send.messageId, "message_id");
  if (send.inserted !== true) throw new Error("message_not_inserted");
  const row = object(await bp(["sql", "execute-sql", "--body", "-"], { statement: "SELECT count(*)::int AS source_count FROM talk_sources WHERE source_id = $1", params: [sourceId] }), "source_check");
  const rows = row.rows; if (!Array.isArray(rows) || object(rows[0], "source_count").source_count !== 1) throw new Error("source_count_mismatch");
  const message = object(await bp(["queue", "get-message", "--queue", QUEUE, "--message-id", messageId]), "message");
  if (message.id !== messageId || message.producerPrincipalId !== PRINCIPAL || !equal(object(message.payload, "payload"), payload)) throw new Error("message_verification_failed");
  const provenance = object(prepared.provenance, "provenance");
  const audit = object(await bp(["events", "read-audit", "--run-id", text(collector.runId, "run_id"), "--after", text(provenance.eventCursor, "event_cursor"), "--limit", "500"]), "audit");
  const events = Array.isArray(audit.events) ? audit.events.map(event => { const e = object(event, "event"); return { position: e.position!, kind: e.kind!, objects: e.objects! }; }) : [];
  const once = [...(provenance.fileUploadedInRun === false ? [] : ["blob.put"]), "queue.send", "transaction.committed"];
  for (const kind of ["sql.execute", ...once]) if (!events.some(event => event.kind === kind)) throw new Error(`audit_event_missing:${kind}`);
  for (const kind of once) if (events.filter(event => event.kind === kind).length !== 1) throw new Error(`audit_event_count:${kind}`);
  console.log(JSON.stringify({ sourceId, fileId, sha256: hash, byteLength: bytes.length, queue: QUEUE, messageId, runId: collector.runId,
    transactionPosition: committed.position, retryResponseIdentical: true, sourceRows: 1, messageRows: 1, events, nextEventCursor: audit.nextAfter }));
}

const [command, transcript, input, output] = process.argv.slice(2);
if (command === "prepare" && transcript && input && output) await prepare(transcript, input, output);
else if (command === "handoff" && transcript && input && !output) await handoff(transcript, input);
else throw new Error("usage: collector.ts prepare TRANSCRIPT METADATA PREPARED | handoff TRANSCRIPT PREPARED");
