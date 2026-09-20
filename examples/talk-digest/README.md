# Talk digest collector

This example prepares one normalized transcript, stores it in Files, then atomically inserts its source row and sends a Message to `platform-talks-v1`. The committed fixture is original and fictional. Real transcripts remain private Backplane Files and must never be committed or treated as openly licensed merely because they are publicly readable.

## Contract

`talk_sources` is keyed by `source_id`. The collector inserts it with `analysis_state = 'pending'`, full JSON source metadata, and the immutable `transcript_file_id`, SHA-256, and byte count. Its Queue payload is schema version 1 and contains the same source identity, attribution, access and license facts, collector Principal/Run, preserved starting Audit Event cursor, and File reference. It contains no transcript text, credential, Delivery, or Receipt.

The analyst claims the Message, verifies the File bytes, and produces a bounded summary. It completes work with one idempotent transaction containing these two ordered SQL operations followed by the Delivery ack:

```sql
UPDATE talk_sources SET analysis_state = 'complete'
WHERE source_id = $1 AND analysis_state = 'pending';

INSERT INTO talk_digests
  (source_id, digest_text, key_points, analysis_metadata, completed_at)
VALUES ($1, $2, $3::jsonb, $4::jsonb, CURRENT_TIMESTAMP);
```

Both SQL operations use `expectRows: 1`; the following operation acknowledges the Delivery with its live Receipt. Any failure rolls back all three operations. The analyst's stable transaction key is `talk:<demoRun>:<sourceId>:digest:v1`. `talk_digests` gains server-stamped analyst Principal and Run columns through the Workspace contract.

## Collector procedure

Use a dedicated Workspace and the collector Principal's private credential file. The variables below make a unique private CLI cache for the actual Harness run.

```bash
export BACKPLANE_REPO=/absolute/path/to/agent-backplane
export BP_CREDENTIALS_FILE=/absolute/private/collector.credentials.json
export DEMO_WORKSPACE_ID=YOUR_WORKSPACE_UUID DEMO_PRINCIPAL_ID=YOUR_COLLECTOR_PRINCIPAL_UUID
export DEMO_TOKEN="$(bun -e 'console.log(crypto.randomUUID())')"
export BP_SESSION="collector-$DEMO_TOKEN"
export BP_DATA_DIR="$BACKPLANE_REPO/.scratch/private/collector/$DEMO_TOKEN"
export BP_HARNESS=codex BP_MODEL=gpt-5.6-sol BP_RUN_LABEL=platform-talk-collector
mkdir -p "$BP_DATA_DIR" && chmod 700 "$BP_DATA_DIR"
bp() { bun "$BACKPLANE_REPO/packages/cli/runtime/main.ts" "$@"; }
bp auth whoami
```

Set the expected Workspace and collector Principal IDs supplied by the operator; require the `whoami` result to match them. Verify MCP initialization and `tools/list` with the same environment:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"talk-collector","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | bp mcp
```

Apply the native Migration and create the Queue once. The collector records the current Audit Event cursor immediately before it creates its Run or writes a File.

```bash
bp push "$BACKPLANE_REPO/examples/talk-digest/schema.sql" --name talk-digest-v1
bp queue create-queue --body - <<'JSON'
{"name":"platform-talks-v1"}
JSON
```

Run the fixture first. The prepared manifest is private runtime state and records the returned File ID. Re-running `prepare` with that output path verifies and reuses the exact File and refuses changed source metadata. If the prepared manifest is lost, its upload key is already taken: set `existingFileId` in the source metadata to reuse the stored File. The collector accepts it only after downloading it and matching the local byte count and SHA-256. The `handoff` command never uploads and submits the exact transaction body twice.

```bash
bun "$BACKPLANE_REPO/examples/talk-digest/collector.ts" prepare \
  "$BACKPLANE_REPO/examples/talk-digest/fixtures/fictional-reliable-agents-v1.txt" \
  "$BACKPLANE_REPO/examples/talk-digest/fixtures/fictional-reliable-agents-v1.json" \
  "$BP_DATA_DIR/fictional-reliable-agents-v1.prepared.json"
bun "$BACKPLANE_REPO/examples/talk-digest/collector.ts" handoff \
  "$BACKPLANE_REPO/examples/talk-digest/fixtures/fictional-reliable-agents-v1.txt" \
  "$BP_DATA_DIR/fictional-reliable-agents-v1.prepared.json"
```

For each real catalog entry, fetch its direct author or event transcript page without login, bypass, or YouTube extraction. Normalize the transcript to a private local text file and create metadata with the same fields as the fixture. Preserve the catalog's exact source URLs, speakers, dates, access check, and license status. Do not silently store HTML as transcript text. Run the same `prepare` then `handoff` commands with those two files. The collector deliberately performs no general HTML scraping.
