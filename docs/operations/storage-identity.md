# Blob storage identity

Startup verifies the selected store before enrollment, requests, sampling or purge.
It writes no binding, marker or blob bytes. A separate operator command initializes,
inspects or reconciles storage. The shared-image initialization service precedes server startup.

## New installation

Bootstrap runs the shared-image `storage-init` after migrations and
data-directory setup, before `server`. It automatically initializes only an empty
installation. The explicit operator command below also supports fenced inspection
and reconciliation. With PostgreSQL running, migrations applied, the data
directory initialized, and all writers stopped,
use the deployment Compose selection described below. Place the matching
PostgreSQL admin URL in a private owner-only file readable by the container's `bun`
user. The URL must address PostgreSQL on the deployment's private network. Keep its
contents out of command arguments and shell history. Set
`STORAGE_ADMIN_CREDENTIAL_FILE` to its absolute host path, then define:

```sh
storage_operator() {
  deployment_compose run --rm --no-deps -T \
    -v "$STORAGE_ADMIN_CREDENTIAL_FILE:/run/storage-admin-url:ro" \
    -e BP_STORAGE_ADMIN_URL_FILE=/run/storage-admin-url \
    server bun apps/server/blobs/storage-admin.ts "$@"
}
storage_operator initialize
```

The command inherits the server's selected backend settings and data mount. It proves
there are no Users, Workspaces, referenced bytes, retained bytes, or conflicting
marker. It commits a `verifying` intent, conditionally publishes the marker,
rechecks the complete inventory, then commits `ready`. A repeated bootstrap with a
ready binding only checks backend/marker identity and performs no writes. Full
content verification still belongs to server startup. Data without a binding makes
initialization exit with `blob_binding_unbound_data_unsupported`; an unbound store is
never bound after the fact.

## Existing installation and crash recovery

Use the [deployment Compose function](health.md) matching the running project's
image, env file, overlays and profiles. Do not change the backend or attach a fresh
volume. Stop the server, edge ingress if present, other server processes, storage
writers and cleanup. Keep them stopped throughout capture and reconciliation.

For filesystem storage, capture while stopped:

```sh
deployment_compose stop server
# Also stop edge if that service is configured.
bash scripts/backup.sh --offline --fenced --env-file .env
```

Use the same env file and `COMPOSE_FILE`/`COMPOSE_PROFILES` for capture as the
running deployment. `--offline` requires PostgreSQL running and server, edge and
storage-init stopped; it does not restart them. This supports a server whose
startup already fails on crash leftovers. Normal backup resumes only the services it stopped and waits for their health.
A source that cannot restart after capture makes the command fail with a recovery
diagnostic; any completed Checkpoint remains available. Keep ingress fenced and use
the capture to reconcile leftovers before resuming traffic.
For local S3, follow the [RustFS checkpoint procedure](s3-checkpoints.md) with
writers and deletion fenced. Unsupported S3 layouts refuse before capture.

With the matching image available, apply the repository migrations
without starting the server, then inspect the store:

```sh
storage_tasks_ok() {
  deployment_compose up -d --no-deps --no-build migrate || return 1
  container=$(deployment_compose ps -aq migrate) || return 1
  # Exactly one container ID is required for the one-shot service.
  case "$container" in ''|*[!a-f0-9]*) return 1 ;; esac
  test "$(docker wait "$container")" = 0 || return 1
  # storage-init's entrypoint assigns /data to bun; `true` replaces initialization.
  deployment_compose run --rm --no-deps -T storage-init true
}
storage_tasks_ok && storage_operator inspect --fenced
```

PostgreSQL must already be healthy. The migration finishes and exits; `up --wait`
can reject its successful completion because it expects running or healthy
containers. Wait for its container and require exit code zero, then repair data
ownership, before inspection. Keep the server and ingress stopped if either step fails.

`--fenced` and, for reconciliation, `--checkpoint` are explicit operator attestations. Inspection requires fencing but no checkpoint reference. The checkpoint ID
is a non-secret recovery reference recorded durably, not an automatically validated
archive. Keep the completed capture and its integrity evidence. The command also
refuses any observed `bp_server` database sessions, acquires the same advisory
lock as startup, and locks the protected blob tables while verifying. Old binaries
and external object writers must be stopped; database checks cannot fence them.

Inspection outputs object IDs, physical staging status, size, SHA-256 and one of
`referenced`, `retained`, or `unreferenced`. It does not print blob bodies, application
keys, credentials, endpoints or signed URLs. For a bound installation with normal
crash leftovers, reconcile after a new fenced capture; unreferenced or staging bytes
need the explicit retention flag:

```sh
storage_operator reconcile --fenced --checkpoint CAPTURE_ID \
  --retain-unreferenced
deployment_compose up -d --wait server
```

Retention records each extra object's exact physical address, size and SHA-256 in
`control.blob_storage_retained`. Bytes remain at their original keys, including
staging files. Startup hashes them, ordinary orphan cleanup skips them, and backup
includes them. `inspect` lists them again. Physical addresses are `blobs/WORKSPACE/ID` or
`blobs/WORKSPACE/ID.stage` on filesystem, and `WORKSPACE/ID` or
`WORKSPACE/staging/ID` on S3. Operators can retrieve those bytes at their existing
addresses without SQL changes. They consume storage indefinitely; no
retained-byte disposal is implemented. No blob ID, key, hash, metadata, or Run
attribution is rewritten. A staged object sharing a live blob's ID is retained
independently. Unknown names, unsafe file types, missing referenced/retained bytes
and corrupt content still refuse admission; retention cannot certify bad content.
Restore missing/corrupt content from the matching recovery set while preserving
the current source. Do not invent metadata or remove offending files to pass.

Outside Compose, invoke the same module with `BP_DATA_DIR`, existing `BP_BLOB_*`
configuration and `BP_STORAGE_ADMIN_URL_FILE`, a private owned mode-0600 file
containing the administrator database URL. The isolated shared-image one-shot uses
`BP_ADMIN_DATABASE_URL`, like the migration service. Never put credentials in argv.
The operator command exits nonzero with a sanitized `blob_binding_*` diagnostic.

## Interrupted operations

Rerun the exact command with the same backend, checkpoint reference and retention
flag. `inspect` reports the saved intent phase, operation, checkpoint reference and
retention flag. Reuse that original reference even if you take an additional capture;
a newer checkpoint ID is not a replacement for the durable in-progress intent. A `verifying` intent contains database/store/generation UUIDs, operation kind,
checkpoint reference, retention decision and complete inventory digest. Retry must
match all evidence and every byte. If marker publication succeeded but the final
commit is unknown, retry validates the marker and content before completing.
It never overwrites a foreign or corrupt marker. An intent/inventory mismatch
requires investigation against the retained capture, not a force flag or SQL edit.

Filesystem publication writes/fsyncs an exclusive candidate under
`$BP_DATA_DIR/.blob-binding-intents/`, fsyncs that directory, then hard-links the
candidate to `blobs/.backplane-store` exclusively and fsyncs the store directory.
A crash can leave an incomplete candidate, but cannot publish partial marker bytes.
Candidates remain as operator evidence; retry creates a fresh candidate without
truncating old files. The marker is a private regular file with one or two links.
Blob payloads still require exactly one link. Failed/losing candidates contain only
identity bytes and are never considered blob objects or cleanup targets.

S3 uses `PUT .backplane-store` with `If-None-Match: *`; a conflict must match the
persisted intent exactly. This follows the [S3 conditional-write contract](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html).
Timeouts and conflicting publication fail closed and leave the intent retryable.
The conditional-publication guarantee is qualified for the shipped pinned RustFS
image. A different S3 endpoint or image must pass the competing-database publication
gate and prove that conditional overwrites return 412 before initialization. A losing
fresh database remains verifying; recreate that disposable database or restore its
pre-operation capture. Never reset its binding with SQL.

## Identity, restore, and server ownership

The singleton protected binding and private root marker contain logical database,
store and generation UUIDs plus the backend. Credentials, endpoint spelling and
filesystem paths are not identity. Rotation or an equivalent endpoint continues to
work; there is no backend switch for an existing installation. A copied marker alone
cannot authorize content: startup checks the complete inventory and hashes every
reference and retained object. A complete matching database/store clone is legitimate
fenced restore. Keep its source server stopped.

Filesystem Checkpoints include the hidden marker, publication evidence and retained
bytes through all of `server-data`; physical PostgreSQL backup includes binding and
retention records. Store archives use `tar --hard-dereference` so marker links become
regular file entries accepted by the existing safe restore validator. Restore both
stores from one capture before the existing User restore-release flow. Captures can
contain ordinary cleanup leftovers. Restore inspects the recovered inventory while fenced before starting the server.
Use `bash scripts/restore.sh CHECKPOINT --fenced --env-file .env --retain-unreferenced` to
explicitly preserve such leftovers. Without that flag, unreferenced bytes stop
recovery before server startup; the restored stores remain available for inspection.
Already retained bytes need no new opt-in. An unfinished intent still requires its
original exact retry: `inspect` reports its saved operation, checkpoint reference and
retention flag. Rerun `storage_operator initialize` for an initialization intent, or
`reconcile --fenced` with the saved checkpoint reference and retention flag for a
reconciliation intent. If a ready restored store refuses on leftovers instead, leave the
source fenced, keep the restored server stopped, and use the restored capture's ID with the
`reconcile --fenced --checkpoint CAPTURE_ID --retain-unreferenced` command above.
Only start the restored server after reconciliation succeeds. The legacy
PostgreSQL-only helper does not recover blob bytes.

Normal same-database starts exclude one another using a dedicated advisory-lock
session. Runtime checks ownership every second with a five-second deadline. The
server exits the process on a failed query, changed backend PID,
lost lock, or deadline. This is bounded failure detection, with a maximum nominal
six-second detection window, not a distributed fencing lease. A process stall can
delay detection. Stop/fence the old process before replacing it after session loss;
rolling upgrades and active-active remain unsupported. Startup verification and
operator mutation also check ownership before completing.

Even a transient database stall exceeding that deadline causes an outage, a restart
and complete storage verification; interrupted cleanup can also require reconciliation.
The deadline stays fixed to preserve the stated exclusion-detection bound.

An abrupt stop, a cleanup deadline, a transient delete failure or the active restore
gate can leave unreferenced upload, delete or purge bytes, even after graceful
shutdown. A restart after deletion or purge may need reconciliation. Startup then
refuses until the operator captures and reconciles the store. This deliberately
trades automatic crash recovery for preserving ambiguous bytes. Choosing
`--retain-unreferenced` keeps those bytes indefinitely, including previously deleted
or expired payloads; it does not extend their API visibility. Normal referenced
payload retention remains unchanged. Ownership loss exits immediately to stop
writes after loss of exclusion; graceful draining cannot certify storage while
PostgreSQL is unavailable.

Verification is O(all object bytes), with memory proportional to object count.
Startup retains one read-only database snapshot throughout hashing, which can delay
vacuum cleanup. Schedule a maintenance window proportional to the stored bytes.
Set `BP_STARTUP_VERIFY_TIMEOUT` in the deployment env file to the required startup
budget in seconds (default 120, range 1..86400). It controls the server healthcheck
start period and checkpoint resume/restore readiness waits. Raise it before large
store operations. Expiry is not evidence of corruption: inspect logs and service
state before deciding whether verification is slow or an operator action is needed.
Initialization and reconciliation perform three complete reads around durable publication
to detect changed bytes before certifying the binding; budget that offline I/O as well.
The command refuses backend or foreign-store replacement.
