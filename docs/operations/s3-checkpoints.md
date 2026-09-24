# Local RustFS checkpoints

`scripts/checkpoint.py` coordinates PostgreSQL, server data and the shipped
RustFS 1.0.0 single-node `/data` volume. The accepted RustFS digest is
`sha256:8cc9801755448b71a786705ce76692c77e14936cccd87cf2fc31842e58f4d1ff`.
Remote S3, custom launch settings, multiple volumes, versioned buckets and other
RustFS versions are unsupported. This implementation still requires the real
Docker drills below before release qualification. No filesystem-to-S3 migration
is performed.

Keep the original environment secrets separately in protected recovery custody.
Retain the recorded upstream immutable images in a registry or tested off-host
image archive. The checkpoint saves the server image. A bootstrap or image-check
helper with identical content is covered by that archive; independent helper
content requires its own verified immutable recovery reference.

## Fence and capture

Hold exclusive operator control throughout the command. Exclude external API
clients, other servers, direct database/object-store writers and mutating helpers.
`--fenced` attests that exclusion; a Compose stop or a short inspection lease
cannot enforce it against another operator. The command checks for active
`bp_server` sessions and running mutating helpers before and after physical
capture. It stops only application services that were running on entry.

Select the same Compose files, profiles and environment used by the deployment:

```sh
export COMPOSE_FILE=compose.yaml:compose.blobs.yaml
export COMPOSE_PROFILES=blobs
python3 -B scripts/checkpoint.py backup --env-file /private/source.env --fenced
```

For `--offline`, PostgreSQL and RustFS must still be running; server, edge and
mutating helpers must already be stopped. RustFS is inspected, stopped with a
required clean exit code of zero, physically archived, restarted, and inspected
again under the fence. Normal capture resumes the server after RustFS is ready.
Offline capture leaves server and edge stopped. Failure paths attempt the same
ordered resumption and preserve the original capture error and completed artifact.
Uncatchable process termination requires manual inspection and resumption.

Every durable volume must already exist and match the actual container mount
before any helper mounts it. The selected PostgreSQL image must pass a GNU tar
round trip preserving a user xattr and numeric ownership. Archives use xattrs and
numeric ownership and the same regular-file/directory validator on capture and
restore. Unsupported members cause refusal before manifest publication.

The manifest is mode 0600 inside a mode 0700 checkpoint directory. It records
binding identity, inventory digest/count, private bucket selection, mount evidence,
image custody and clean RustFS exit. A checkpoint-specific credential commitment
also detects changed root credentials even if RustFS would accept them at process
startup. It contains no plaintext credentials. Keep its enclosing repository
private. The atomically published `backups/health.json` is a mode `0644` summary
containing only version, system ID, completion time and restore point name/LSN/timeline.
The server reads this receipt across UIDs; detailed manifests stay private. Capture
and retention use one operator UID; a second capture UID needs explicitly managed
permissions. See the [receipt and inspection contract](../../infra/backup/README.md).
Both source inspections hash all object bytes within the fence. Budget downtime for
two full passes plus physical capture; each pass uses `BP_STARTUP_VERIFY_TIMEOUT`
and terminates its own helper on expiry with `blob_binding_inspection_timeout`.

The private credential commitment uses a fresh 32-byte random salt and
PBKDF2-HMAC-SHA256 with 600,000 iterations over the checkpoint name and exact root
and scoped values. This format accepts only that fixed cost; a future cost change
requires an explicitly supported format. Arbitrary recorded costs are refused to
bound work on untrusted manifests. Pre-fix S3 checkpoints with `credentialsSha256`
or a commitment without the checkpoint name require recapture; their restore refusal
uses the same captured-credentials diagnostic.
Use generated credentials and retain their originals in protected recovery custody.
The drill generates 32-character hexadecimal values accepted by the shipped RustFS
runtime. Choose generated values within that runtime's accepted credential lengths;
checkpoint capture adds no credential-length restriction.

S3 inspection failure refuses capture, including offline capture. Filesystem
offline forensic capture remains available and records failed inspection explicitly;
it provides no source storage equality claim and restore must still pass inspection.

## Restore

Keep the source fenced. Use fresh empty PostgreSQL, server and RustFS target
volumes, a separate empty archive directory and the captured environment secrets.
Copy the complete checkpoint into the target repository's `backups/` directory.

```sh
python3 -B scripts/checkpoint.py restore /private/recovery/backups/CHECKPOINT \
  --env-file /private/recovery.env --fenced --retain-unreferenced
```

Use `--retain-unreferenced` only when deliberately preserving captured upload
leftovers. Before any reconciliation, restore requires the source binding and
complete inventory digest/count to match, including those extras. Classification
changes from unreferenced to retained do not change the digest. Missing markers,
changed bodies, wrong identity and credential failures keep bootstrap and server
stopped. The PostgreSQL identity, versions and entire audit-head set must match;
recovery explicitly selects the captured timeline and promotion creates a new one.

PostgreSQL and RustFS start with `--no-deps`. Before authentication, restore checks
the actual RustFS image content, command, entrypoint and single `/data` mount against
the captured evidence and fresh target volume. Source volume names are not reused.
A bounded 30-second `/health/ready` wait precedes the signed proof; proof failures
expose only stable `checkpoint_proof_configuration`, `_readiness`, `_authentication`,
`_account` or `_versioning` tokens. The proof helper has a 60-second total deadline.
Fixture diagnostics similarly use `checkpoint_fixture_` with a fixed identity,
configuration, create or read step. A read-only signed root request proves
access to the restored service account and unversioned bucket; scoped inspection
then verifies the binding and every object body. Only after equality and explicit
leftover retention does normal Compose startup run IAM convergence. That bootstrap
may update the service-account secret/policy using the proven original credentials.
Workspaces stay gated until the existing User recovery API releases them.

Failed restores retain the partial targets for diagnosis. Retry with fresh targets;
the tool refuses nonempty targets. It does not merge, overwrite or repair them.

## Release drills

Run from the candidate checkout with Docker available:

```sh
python3 -B scripts/backup-drill.py --s3
python3 -B scripts/backup-drill.py
python3 -B scripts/backup-drill.py --offline
```

Each drill owns a unique disposable Compose project and repository. The S3 drill
creates SQL data and an uploaded blob through the API with Run provenance, injects
an archive failure, checks read-only credential rejection, and performs two fresh
PostgreSQL/RustFS restores across timelines. It verifies login, SQL, blob identity,
metadata, Audit Events, and direct S3 byte hashes, including an unknown extra object
retained explicitly on restore. Cleanup is limited to its project and volumes with
matching ownership labels; failed runs keep the repository evidence. Successful
command/file-boundary tests are not runtime recovery proof.

Checkpoint resumption starts only the verified existing container IDs, without
pulling images or recreating containers. RustFS must become healthy before the
server and edge resume. Each service receives `BP_STARTUP_VERIFY_TIMEOUT`
seconds, including Docker calls; the total is bounded by the number of services
times that budget. A failure names the affected service and retains completed
checkpoints and the original capture error.
