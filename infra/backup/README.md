# Backup and recovery

Fenced Checkpoints of PostgreSQL, WAL, server data and the optional stores; restore into
empty volumes; the drill, retention and upgrade notes.

- [Restore into empty volumes](#restore-into-empty-volumes)
- [Drill and retention](#drill-and-retention)
- [RustFS S3 overlay](#rustfs-s3-overlay)
- [Upgrades](#upgrades)

Use the Compose-aware scripts at the repository root. They require Docker Compose,
Python 3 and the checked-out repository; PostgreSQL binaries run inside the verified
PostgreSQL container. `infra/backup/archive.sh` remains the continuous WAL archive
command. The older `infra/backup/backup.sh` and `restore.sh` wrappers remain for
operator-managed host clusters, not the Compose recovery flow.

Set `BP_BACKUP_DIR` to a mounted repository encrypted at rest and replicated off-host
with encrypted transport. Checkpoints contain credentials, enrollment state,
Workspace data, filesystem blobs, and possibly Caddy CA private keys. Encryption
and off-host replication remain operator responsibilities. Retain the protected
`.env` separately: manifests contain image pins, database identity, audit heads,
target LSN, checksums and completion time. S3 manifests also contain private bucket
selection, inventory evidence and a salted credential commitment; they contain no
plaintext credentials.
Restore needs the original database passwords and `BP_AUTH_SECRET`.
Each time the `postgres` service starts, before PostgreSQL runs, it creates the
repository's `archive` directory and assigns it to the PostgreSQL container user, and
creates `backups` for that user when absent. A fresh or replaced mount needs no
separate preparation; an existing `backups` directory keeps the owner capture set.

Checkpoint directories stay mode `0700` and their manifests mode `0600`. Capture
and retention have one operator UID. Capture assigns the `backups` directory to
that UID and grants read/traverse access on that parent with `chmod a+rx` so it can
atomically publish a receipt readable by the server. The `0700` checkpoint
subdirectories remain private. Capture by a second UID is
unsupported unless the operator explicitly manages permissions. After durable completion, capture
atomically replaces `backups/health.json` at mode `0644`. This public summary contains
only version, PostgreSQL system ID, actual capture completion time and restore point
name, LSN and timeline. A failed capture retains the previous receipt. Mount the
`backups` directory so the server can traverse it and read this receipt; private
checkpoint directories need no server access. The operations probe validates the
receipt against its database identity and refuses malformed receipts. Only an absent
receipt enables the historical manifest fallback, which requires readable manifests.
The receipt must name an existing real checkpoint directory, never a symlink.
After restored storage is verified, the restore gate is armed and the recovery API
is available, restore publishes the receipt with the original capture completion
time. It does not reset backup age. Preserve the checkpoint directory name when
copying it into the recovery repository.

Both filesystem and S3 capture perform two full object-byte SHA-256 inspections
inside the writer fence, before and after physical capture. Plan downtime for both
passes plus archiving. Each fenced `inspect` and `reconcile` command uses a total
`BP_STARTUP_VERIFY_TIMEOUT` budget (default 120 seconds). PostgreSQL timeouts run
on the reserved lease session and leave up to five seconds for cleanup before the
process deadline. Both PostgreSQL expiry and the process deadline report
`blob_binding_inspection_timeout`; the process deadline terminates the lease-owning
helper even if cleanup blocks. Invalid configuration and deadlines refuse offline
filesystem capture; genuine storage corruption still permits forensic capture. Increase that budget
for the store size and measured throughput. This bounds inspection, not all Docker
control-plane operations or the entire capture window.

```sh
scripts/backup.sh --fenced --env-file .env
# Reports $BP_BACKUP_DIR/backups/YYYYMMDDTHHMMSSffffffZ
```

Export `COMPOSE_FILE=compose.yaml:compose.edge.yaml` and `COMPOSE_PROFILES=edge`
when the edge overlay is enabled; use the same overlay/profile settings for
backup and restore. `COMPOSE_PROJECT_NAME` selects the project. Every active
durable service must be running. Optional compute holds no durable local state.
The shipped local single-volume RustFS layout is also supported with `COMPOSE_FILE=compose.yaml:compose.blobs.yaml` and `COMPOSE_PROFILES=blobs`; use the same selection during capture and restore. Other S3 layouts refuse. `--fenced` is your statement that external writers and mutating helpers stay excluded for the entire command.

The checkpoint fences writes by stopping edge (when present) and server, including
its retention and blob cleanup workers. It takes a PostgreSQL base backup and
copies archived WAL through a named restore point. It saves `server-data` as a tar,
including enrollment files, Migration git projections and filesystem blobs under
`blobs/`; edge adds both `edge-data` and `edge-config`. It verifies database identity
and unchanged audit heads across the fenced backup, hashes all artifacts, writes
the manifest last and resumes the services that it stopped. Incomplete checkpoints
have no manifest and cannot be restored. Archive and filesystem errors fail closed.

Capture compares configured image references with container content IDs, including migration and initialization helpers. PostgreSQL and Caddy need locally verified immutable references; an override without one is refused before fencing. Publish and pull that exact image, or select a reproducible image and reconcile the running deployment before retrying. PostgreSQL recovery requires version 18 and its existing data layout. The manifest keeps configured references, observed IDs and immutable recovery references separately; resolved environments remain private. The server archive is saved by content ID. Restore verifies recovered IDs before writing target volumes and starts with builds and pulls disabled. A mutable tag alone never establishes recovery identity. A manifest from an earlier format, without recorded helper images, storage binding or upstream recovery references, is refused with `unsupported_checkpoint_version` before any image or volume is touched; restore it with the checkout that captured it.

Docker can attach RepoDigests to unpublished local builds and aliases. This proves local
immutable identity, not publication or continued registry availability. Keeping the upstream
images available is separate from this data Checkpoint: retain the recorded references in a registry
or a protected archive tested on the recovery host's Docker store type and platform.
An archive loaded as tags without the recorded immutable references is unsupported;
verify those references and content IDs before relying on the archive. Cross-store-type
or cross-architecture recovery is not established by a same-host roundtrip. The server
image is included in the Checkpoint; upstream PostgreSQL/Caddy images are not. Capture
reports that obligation for mutable upstream configurations.

## Restore into empty volumes

Fence the original project and its consumers first. Keep its volumes until the
recovery is verified. `docker compose down -v` preserves the external durable volumes. Preparation creates
them under `BP_VOLUME_PREFIX` (default `agent-backplane`). To deliberately delete
them, run `scripts/destroy.sh PROJECT --env-file .env` and type that project name.
Pass the same overlays and profiles as the deployment (`COMPOSE_FILE`, `COMPOSE_PROFILES`):
the script removes only the volumes in the rendered configuration, so a `blobs`
deployment destroyed without its profile keeps `rustfs-data`.
Use a new project, a new `BP_VOLUME_PREFIX` and alternate ports for recovery. Restore refuses existing containers
and every non-empty target volume, including hidden files. Image settings follow native
Compose precedence: exported `BP_*` values override `.env`; clear conflicting exports
when restoring recorded references.

1. Provision a new encrypted repository mount and a protected env file containing
   the original secrets. Set `BP_BACKUP_DIR` to the new repository. Its `archive`
   directory must be empty; a recovered timeline must not archive into the source
   incarnation's repository.
2. Copy the selected complete checkpoint directory into the new repository under
   `backups/`, preserving the manifest's checkpoint name. Misplaced or renamed inputs
   are refused before target writes. Restore verifies and loads the saved server image automatically, then
   verifies locally loaded upstream recovery references, pulling only missing references,
   and checks their content IDs before target writes. Keep
   image settings at their recorded references. Local server tags are restored from
   the archive; a server digest reference must also be available in the local Docker
   store (pull that exact reference before restore). Restore rebinds tag references
   to the recorded content, displacing an existing image tag of the same name on this host.
   Use a dedicated recovery host or distinct tags; running containers retain their content.
3. Set `COMPOSE_PROJECT_NAME`, a distinct `BP_VOLUME_PREFIX`, and alternate `BP_PORT`, `BP_HTTP_PORT` and
   `BP_HTTPS_PORT` as appropriate, then run:

   ```sh
   scripts/restore.sh /new/repository/backups/YYYYMMDDTHHMMSSffffffZ --fenced --env-file recovery.env
   ```

   A capture containing cleanup leftovers needs the explicit
   `--retain-unreferenced` flag. Without it, restore stops before server startup and
   leaves the restored stores available for inspection. Follow the
   [fenced storage recovery procedure](../../docs/operations/storage-identity.md)
   to inspect and reconcile those stores; retrying the same capture into empty
   volumes without the flag will refuse again. Raise `BP_STARTUP_VERIFY_TIMEOUT`
   for the full-store verification time before starting a large recovery.

Restore verifies hashes and archive paths before writing, checks every target for
emptiness, extracts the stores with original ownership, and runs `pg_verifybackup`.
PostgreSQL recovers in an isolated container with no network to the named point.
The script verifies the database identity, replay LSN and audit heads, then arms
the existing restore gate before starting the server. It leaves the gate active; readiness stays 503 until
release, and edge stays stopped.
For extraction or replay failures, preserve the evidence and retry with new empty
volumes; never start a partially restored server manually. A storage-gate refusal
instead follows the inspection/reconciliation procedure above.

Sign in with the restored User account (`bp login`). For every Workspace read
`bp restore restore-status --workspace-id UUID` and run
`bp restore release --workspace-id UUID --epoch UUID --source-fenced` until done.
Only assert source fencing after stopping the original primary and consumers.
Reconcile uncertain Effects; lost WAL can hide outside actions. Verify restored
blob references before releasing consumer traffic. After release, run
`docker compose up -d --wait` with the same project and overlays to start ingress. Public-origin changes may
require new login sessions and ingress/certificate configuration.

## Drill and retention

Run `scripts/backup-drill.sh` monthly and for release validation. The drill builds
a disposable project, uses loopback port `18300` (`BP_DRILL_PORT` overrides it),
enrolls through `bp bootstrap`, writes a row and filesystem blob through the API,
checkpoints, destroys only that project's volumes, restores and proves a fresh
User login plus exact row/blob contents. It uses a private bridge, private secrets
and temporary repositories. The orchestrator runs it on the Docker host. Edge
state is included in checkpoints whenever its overlay is active; this automated
drill exercises core, not external TLS issuance or manual browser trust.

`BP_BACKUP_KEEP` (default `7`, positive integer) keeps the newest complete
Checkpoints after a successful capture. Incomplete sets are retained for inspection.
WAL pruning uses each retained PostgreSQL `backup_manifest` start LSN and timeline;
it preserves history files and segments required by the oldest retained base backup
on each timeline. Coordinate off-host replica retention separately.

Capture refuses free space below twice the current durable-store and server-image
size plus 1 GiB. The server image is saved with `docker save` and included in the
manifest checksums. Sets use UTC timestamp names. Backup and prepare share the
exclusive `.env.lock`; Checkpoint operations also hold a repository lock.

A live-data purge cannot erase bytes in an earlier checkpoint, WAL archive, export
or off-host replica. Those copies expire under their own retention policy. Restoring
an older checkpoint can reintroduce expired captures; keep ingress fenced while
reviewing the restore and running the User purge after gate release. Audit envelopes
are permanent. Include retired server-data projections and exports in deletion
procedures when they contain expired Migration SQL.

The coordinated recovery point is the last completed checkpoint, including all
filesystem state. Set the checkpoint schedule to the required RPO, for example
hourly for a one-hour target. Continuous database WAL alone does not establish a
five-minute recovery point for filesystem blobs. Measure service RTO in the drill;
Effect reconciliation and manual ingress trust remain separate recovery work.

## RustFS S3 overlay

The optional overlay defaults to pinned RustFS in `compose.blobs.yaml`.
`BP_RUSTFS_IMAGE` selects an experimental complete image reference. Blob helpers
use the effective server image; `BP_BLOB_BOOTSTRAP_IMAGE` explicitly selects a
different helper-code experiment. Release
validation must associate the exact RustFS digest with all three passing scenarios in
`mise exec -- bun tests/acceptance/rustfs.ts`; a digest alone proves no compatibility.
Set separate root credentials (`BP_RUSTFS_ROOT_USER`, `BP_RUSTFS_ROOT_PASSWORD`)
and bucket-scoped credentials (`BP_BLOB_S3_ACCESS_KEY`, `BP_BLOB_S3_SECRET_KEY`).
The bucket defaults to `backplane`. Root credentials belong only to RustFS and
its isolated bootstrap. Never enable bucket versioning: both enabled and suspended
versioning stop bootstrap, and deleting current objects would leave old bytes.

The Files backend of an installation never changes in place, and a store without a
binding is refused rather than adopted. A different backend means a new installation.

Pause deletion as well as writes for every coordinated backup. Record matching
PostgreSQL and RustFS snapshot identifiers. During recovery, restore both stores,
keep cleanup gated through reference/hash verification, and release every Workspace
through the User restore API only after source fencing. PostgreSQL WAL cannot
recover deleted object bytes.

## Upgrades

When a migration takes exclusive locks, including 000028, 000030 and 000031, use the
[reusable deployment Compose invocation](../../docs/operations/health.md) with the
running deployment's project, env file, Compose files and profiles. Export
`COMPOSE_PROJECT_NAME` for a custom project and follow the documented running-server
guard before `deployment_compose stop server`, then run
`deployment_compose up -d --wait`, which pulls the pinned server image (or uses
`BP_SERVER_IMAGE`).
The one-shot migration must finish before traffic resumes. Rolling upgrades are unsupported.

Migration 000031 interprets existing timestamps without time zone as UTC; operators
of independently managed clusters must verify that historical values, including
those written by `DEFAULT now()`, used UTC before upgrading.

Existing project-managed volumes need an explicit cutover: set `BP_VOLUME_PREFIX`
to their existing Compose prefix before preparing or upgrading. Confirm the rendered
volume names using the same `deployment_compose` function:

```sh
deployment_compose config --format json | python3 -c 'import json, sys; print("\n".join(v["name"] for v in json.load(sys.stdin)["volumes"].values()))'
```

This prints only the resolved volume names. Never substitute fresh volumes for an
existing installation. An earlier-format Checkpoint restores only with the checkout
that captured it (`unsupported_checkpoint_version`).

The legacy wrappers and `bp restore-drill` require `BP_BACKUP_ADMIN_URL_FILE`, the
path to an operator-owned regular file with no group or other permissions containing
the administrator URL. The wrappers accept `DATA_DIR BACKUP_DIR ARCHIVE_DIR PG_BIN_DIR`
as positional arguments; `bp restore-drill` uses the corresponding named path flags.
Provision the file through the operator's secret manager, use mode `0600`, and
remove it after the command finishes. Keep the URL out of argv, environment and
shell history. Only the file path is inherited by Bun; recovery helpers receive
an environment containing only `PATH` and `LANG`. Untrusted processes sharing the
operator UID can still read its files, so isolate them under a separate UID.

PostgreSQL uses its default `archive_timeout=0`; completed segments archive normally,
and Checkpoint capture explicitly switches WAL through the named restore point.
There is no timed database-only archival bound between Checkpoints. A one-minute
forced switch can archive about 22.5 GiB/day of mostly empty 16 MiB segments under
light activity. Configure a timed override only with an explicit recovery target
and archive capacity budget. Use durable mounted backup storage, monitor archiver
failures and free space, and repair retention causes through PostgreSQL. Never
manually delete live `pg_wal` or acknowledge an archive copy that was not saved.

The legacy physical helpers require a TCP administrator URL with an explicit username,
and canonical `postgresql.conf`, `pg_hba.conf` and `pg_ident.conf` files directly in the
data directory. Socket-only URLs and relocated or symlinked configuration are refused
before capture. These constraints do not alter the core Compose Checkpoint interface.

For storage recovery when startup is blocked, stop server and edge
writers, then use `bash scripts/backup.sh --offline --fenced --env-file PATH` with the same
Compose configuration. Offline capture requires PostgreSQL running and leaves the
application stopped. It preserves hidden storage markers, publication candidates,
and retained staging/orphan bytes. Store archives dereference hard links into
regular entries for safe restore. Follow the [storage recovery procedure](../../docs/operations/storage-identity.md)
before resuming the server. Offline S3 capture additionally requires RustFS running on entry, and always restores its running state after the physical capture.

Compose Checkpoints require `--fenced`, your statement that external writers and mutating helpers stay stopped for the entire command. Local S3 capture and fresh-store restore use the [qualified RustFS procedure](../../docs/operations/s3-checkpoints.md); unsupported S3 layouts refuse before capture.

If recovery completes but cannot publish its health receipt, the tool reports that
separately and leaves restored Workspaces gated. Repair repository permissions or
free space and take a new fenced Checkpoint. Do not repeat restore into the now
non-empty target volumes. Invalid completion timestamps are refused before writes.
