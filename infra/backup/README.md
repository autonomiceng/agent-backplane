# Backup and recovery

Use the Compose-aware scripts at the repository root. They require Docker Compose,
Python 3 and the checked-out repository; PostgreSQL binaries run inside the pinned
PostgreSQL container. `infra/backup/archive.sh` remains the continuous WAL archive
command. The older `infra/backup/backup.sh` and `restore.sh` wrappers remain for
operator-managed host clusters, not the Compose recovery flow.

Set `BP_BACKUP_DIR` to a mounted repository encrypted at rest and replicated off-host
with encrypted transport. Checkpoints contain credentials, enrollment state,
Workspace data, filesystem blobs, and possibly Caddy CA private keys. Encryption
and off-host replication remain operator responsibilities. Retain the protected
`.env` separately: manifests contain image pins, database identity, audit heads,
target LSN, checksums and completion time, never resolved environment values.
Restore needs the original database passwords and `BP_AUTH_SECRET`.

```sh
scripts/backup.sh --env-file .env
# Reports $BP_BACKUP_DIR/backups/YYYYMMDDTHHMMSSffffffZ
```

Export `COMPOSE_FILE=compose.yaml:compose.edge.yaml` and `COMPOSE_PROFILES=edge`
when the edge overlay is enabled; use the same overlay/profile settings for
backup and restore. `COMPOSE_PROJECT_NAME` selects the project. Every active
durable service must be running. Optional compute holds no durable local state.
The scripts reject the S3 backend; coordinate RustFS snapshots separately using
the procedure below.

The checkpoint fences writes by stopping edge (when present) and server, including
its retention and blob cleanup workers. It takes a PostgreSQL base backup and
copies archived WAL through a named restore point. It saves `server-data` as a tar,
including enrollment files, Migration git projections and filesystem blobs under
`blobs/`; edge adds both `edge-data` and `edge-config`. It verifies database identity
and unchanged audit heads across the fenced backup, hashes all artifacts, writes
the manifest last and resumes the services that it stopped. Incomplete checkpoints
have no manifest and cannot be restored. Archive and filesystem errors fail closed.

## Restore into empty volumes

Fence the original project and its consumers first. Keep its volumes until the
recovery is verified. `docker compose down -v` preserves the external durable volumes. Preparation creates
them under `BP_VOLUME_PREFIX` (default `agent-backplane`). To deliberately delete
them, run `scripts/destroy.sh PROJECT --env-file .env` and type that project name.
Pass the same overlays and profiles as the deployment (`COMPOSE_FILE`, `COMPOSE_PROFILES`):
the script removes only the volumes in the rendered configuration, so a `blobs`
deployment destroyed without its profile keeps `rustfs-data`.
Use a new project, a new `BP_VOLUME_PREFIX` and alternate ports for recovery. Restore refuses existing containers
and every non-empty target volume, including hidden files.

1. Provision a new encrypted repository mount and a protected env file containing
   the original secrets. Set `BP_BACKUP_DIR` to the new repository. Its `archive`
   directory must be empty; a recovered timeline must not archive into the source
   incarnation's repository.
2. Copy the selected complete checkpoint directory into the new repository under
   `backups/`. Restore verifies and loads the saved server image automatically, then
   pulls the recorded upstream pins. Keep `BP_SERVER_IMAGE` at the recorded
   reference (default `agent-backplane-server:local`); no locally cached server
   image is required.
3. Set `COMPOSE_PROJECT_NAME`, a distinct `BP_VOLUME_PREFIX`, and alternate `BP_PORT`, `BP_HTTP_PORT` and
   `BP_HTTPS_PORT` as appropriate, then run:

   ```sh
   scripts/restore.sh /new/repository/backups/YYYYMMDDTHHMMSSffffffZ --env-file recovery.env
   ```

Restore verifies hashes and archive paths before writing, checks every target for
emptiness, extracts the stores with original ownership, and runs `pg_verifybackup`.
PostgreSQL recovers in an isolated container with no network to the named point.
The script verifies the database identity, replay LSN and audit heads, then arms
the existing restore gate before starting the server. It leaves the gate active; readiness stays 503 until
release, and edge stays stopped.
If restore fails after extraction, preserve the evidence and retry with new empty
volumes; never start a partially restored server manually.

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

The optional overlay pins RustFS in `compose.blobs.yaml`. Set
`BP_BLOB_BOOTSTRAP_IMAGE` to a digest-pinned server image built from this checkout.
Bootstrap validates the server image digest format before RustFS starts. Release
validation must associate the exact RustFS digest with all three passing scenarios in
`mise exec -- bun tests/acceptance/rustfs.ts`; a digest alone proves no compatibility.
Set separate root credentials (`BP_RUSTFS_ROOT_USER`, `BP_RUSTFS_ROOT_PASSWORD`)
and bucket-scoped credentials (`BP_BLOB_S3_ACCESS_KEY`, `BP_BLOB_S3_SECRET_KEY`).
The bucket defaults to `backplane`. Root credentials belong only to RustFS and
its isolated bootstrap. Never enable bucket versioning: both enabled and suspended
versioning stop bootstrap, and deleting current objects would leave old bytes.

For a manual MinIO-to-RustFS migration:

1. Fence all writers and stop the server and cleanup workers. Take coordinated
   PostgreSQL and MinIO backups and retain the original MinIO volume untouched.
2. Start RustFS with the fresh `rustfs-data` volume and run bootstrap. Never attach
   a MinIO volume to RustFS. Keep the server stopped during the copy.
3. Using an operator S3 transfer tool with separate source and destination
   credentials, copy objects explicitly, preserving each complete object key,
   including Workspace prefixes. Copy current objects into the unversioned bucket.
4. Verify object sizes and SHA-256 hashes against every live `control.blobs`
   reference through a read-only database connection. Download objects to compute
   hashes; multipart ETags are not content hashes. Resolve missing or mismatched
   bytes before proceeding.
5. Select the RustFS endpoint and scoped credentials, then start the server and
   resume writers. Keep the source volume and matching backup until the migration
   is verified and the retention window has passed. Rollback after new writes
   requires another coordinated migration.

Pause deletion as well as writes for every coordinated backup. Record matching
PostgreSQL and RustFS snapshot identifiers. During recovery, restore both stores,
keep cleanup gated through reference/hash verification, and release every Workspace
through the User restore API only after source fencing. PostgreSQL WAL cannot
recover deleted object bytes.

## Upgrades

When a migration takes exclusive locks, including 000028, 000030 and 000031, run
`docker compose stop server` before `docker compose up -d --wait` with the same
project, env file and overlays. The one-shot migration must finish before traffic
resumes. Rolling upgrades are unsupported.

Existing project-managed volumes need an explicit cutover: set `BP_VOLUME_PREFIX`
to their existing Compose prefix before preparing or upgrading. Confirm the rendered
volume names with `docker compose --env-file .env config -q`; never substitute fresh
volumes for an existing installation. Keep pre-image Checkpoints and their original
server image separately; the new automatic image recovery requires a new Checkpoint.

The legacy wrappers require `BP_BACKUP_ADMIN_URL` in the process environment and
accept `DATA_DIR BACKUP_DIR ARCHIVE_DIR PG_BIN_DIR` as positional arguments. Load
the credential through the operator’s secret mechanism; keep it out of argv and
shell history. Untrusted processes sharing the operator UID can read environment
credentials; isolate those workloads under a separate UID or equivalent boundary.
