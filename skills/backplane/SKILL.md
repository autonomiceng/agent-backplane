---
name: backplane
description: Connect an agent to an existing Backplane, use Files and Functions, share Workspace state, consume Queues, complete atomic handoffs, and recover unresolved Effects.
---

Configure BP_URL, BP_KEY and BP_WORKSPACE_ID in the environment. Keep credentials out of command bodies. Use a stable BP_SESSION per Harness invocation; the CLI defaults to "default", while bp mcp defaults to its process PID. BP_DATA_DIR controls local Run cache storage. BP_HARNESS, BP_MODEL and BP_RUN_LABEL describe lazily created Runs.

Commands return JSON; failures write an error envelope to stderr and exit nonzero. Read command schemas with --help. bp mcp serves the same agent operations over stdio. streamAudit collects for at most one second or 100 frames, aborts the request, and returns an array; use readAudit for polling.

When asked to connect this repository to an existing Backplane, read [agent client setup](references/client-setup.md). That path attaches one supplied Principal credential and exercises Files and Functions. It does not install or enroll a server.

## First installation

When preparing a local installation, read [bootstrap prerequisites and recovery](../../infra/bootstrap/README.md), then run as the User:

```sh
bun infra/bootstrap/prepare.ts --public-url http://localhost:3000 \
  --backup-dir /mnt/backplane-backups --capability-file "$HOME/.bp-enrollment"
bp bootstrap --url http://localhost:3000 --email user@example.com \
  --capability-file "$HOME/.bp-enrollment"
```

Enter the password at the terminal or set BP_BOOTSTRAP_PASSWORD. Install the emitted MCP configuration, which references a private BP_CREDENTIALS_FILE. CLI commands accept the same file. Reruns validate saved credentials. Exit 0 means done; exit 1 means usage or invalid input; exit 2 requires readiness, adoption, capability or identity recovery; exit 3 requires explicit key recovery. Investigate uncertain creation before adopting an ID. Keep checkpoint and credential files private.

## Dogfood workflow

The capture markers name fields from the preceding response for use in subsequent commands. Bind those values in your shell. Use fresh idempotency keys for new logical work and reuse the original key and body when retrying.

```bash
# bp-example workflow.run
bp run new --body - <<'JSON'
{"label":"dogfood"}
JSON
```

```bash
# bp-example workflow.setup
bp queue create-queue --body - <<'JSON'
{"name":"intake"}
JSON
bp queue create-queue --body - <<'JSON'
{"name":"review"}
JSON
bp queue send-message --queue intake --body - <<'JSON'
{"idempotencyKey":"application-1","payload":{"applicationId":1}}
JSON
```

```bash
# bp-example workflow.claim capture=DELIVERY_ID:/deliveryId,RECEIPT:/receipt
bp queue claim-message --queue intake
```

```bash
# bp-example workflow.effect
bp queue begin-effect --delivery-id "$DELIVERY_ID" --body - <<JSON
{"receipt":"$RECEIPT","action":"submit-application","destination":"example-employer"}
JSON
```

Renew a live Receipt before leaseExpiresAt using bp queue renew-delivery with the delivery-id and a body containing receipt. If renewal fails, stop acting under that Receipt. Begin the Effect before external action. Use the returned Effect Key as the destination's idempotency key when supported. Without destination idempotency support, the Effect Key is only a correlation identifier.

After confirming external completion, atomically send the next Message and ack the current Delivery:

```bash
# bp-example workflow.transaction
bp transaction --body - <<JSON
{"idempotencyKey":"handoff-1","operations":[{"send":{"queue":"review","idempotencyKey":"review-1","payload":{"applicationId":1}}},{"ack":{"deliveryId":"$DELIVERY_ID","receipt":"$RECEIPT"}}]}
JSON
```

A `sql` operation in the same transaction updates a row of a Workspace table you created with `bp push`; it needs `expectRows` and a statement that names that table, for example `{"sql":{"statement":"UPDATE leads SET stage = $1 WHERE id = $2","params":["reviewed",1],"expectRows":1}}`.


```bash
# bp-example workflow.review capture=REVIEW_ID:/deliveryId,REVIEW_RECEIPT:/receipt
bp queue claim-message --queue review
```

```bash
# bp-example workflow.ack
bp queue ack-delivery --delivery-id "$REVIEW_ID" --body - <<JSON
{"receipt":"$REVIEW_RECEIPT"}
JSON
```

## Recovery

Use this branch only for an ambiguous Delivery. Bind AMBIGUOUS_ID to that Delivery. A User must grant reconciliation delegation to the Principal; ordinary consumer credentials do not authorize reconciliation.

```bash
# bp-example workflow.reconcile fixture=ambiguous
bp queue reconcile-effect --body - <<JSON
{"deliveryId":"$AMBIGUOUS_ID","outcome":"unknown","evidence":"Destination outcome remains unverified"}
JSON
```

Record evidence: applied completes the Delivery, not_applied permits a successor with the same Effect Key, and unknown keeps work blocked. Investigate the destination before deciding. Never infer failure solely from a timeout.

An expired or revoked Receipt cannot ack, nack, renew or hold. Inspect current state and obtain a fresh claim only when dispatch permits it. A lost transaction response is retried with the identical idempotency key and body. On assertion_failed, inspect the failing operation and state before submitting corrected work with a new key. On unauthorized, obtain a valid credential from the User; on reconciliation_forbidden, obtain delegation. The CLI recovers run_forbidden once automatically. Preserve other error envelopes for diagnosis.
