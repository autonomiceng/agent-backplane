# Operational health

`GET /health/ready` is the container readiness probe. `ready` (200) means the
runtime role, PostgreSQL/PGMQ versions, schema and enrollment state allow the
process to serve. `not_ready` (503) returns problem codes in `problems`. Public responses contain
only `status` and `problems`; the detailed readiness document requires
`Authorization: Bearer $BP_OPERATIONS_TOKEN` on the same endpoint. To recover: restore
database connectivity, apply pending migrations with the one-shot `migrate`
service, repair enrollment, or restore the required pinned versions. An active restore gate reports `not_ready`; the server still accepts User
recovery requests on its operator address. An insecure-origin diagnostic requires review of ingress configuration.

`GET /health/operations` requires `Authorization: Bearer $BP_OPERATIONS_TOKEN`.
`ok` (200) means every sampled signal is observable and within its threshold.
`degraded` (503) means at least one signal needs attention; `codes` names the
problems. Overall status is never `unknown`. `/metrics` uses the same token and
observations and returns Prometheus gauges even while operational health is
degraded. Keep these operator routes off public ingress.

Each signal carries its value, observation time and status. `ok` is within the
threshold; `warn` is a threshold breach; `stale` is old data or an elapsed deadline;
`unknown` means the observation failed and makes overall health `degraded`.
`degraded` is also used for an overall failure. A null metric is emitted as `NaN`,
so missing measurements cannot masquerade as zero. With no token these routes
return `operations_disabled` (503); a missing or incorrect bearer token returns
`operations_unauthorized` (401). Configure the token or correct the operator client.

| Codes | Operator action |
| --- | --- |
| `pool_saturated`, `pool_waiters`, `database_saturated`, `database_capacity_invalid` | Inspect long transactions and connection usage. Reduce concurrency or resolve blocked queries before increasing the fixed pool/cluster capacity. |
| `transaction_old` | Inspect `pg_stat_activity` and locks; identify the owning request and resolve it. |
| `queue_ready_old`, `queue_expiry_stale` | Check consumers, Run credentials and failed claim/recovery requests. |
| `queue_ambiguous`, `queue_effect_paused` | Reconcile the Effect before releasing or replaying its Delivery. |
| `queue_dead_lettered` | Inspect the failure and payload expiry before deciding whether replay is valid. |
| `quota_exhausted`, `admission_saturated`, `admission_waiters`, `admission_rejected`, `streams_saturated` | Reduce load, close unused streams, or deliberately revise Workspace quotas. |
| `backup_unavailable`, `backup_stale` | Run `scripts/backup.sh`; verify `/backups` contains completed checkpoints for this database identity. Check repository permissions and the backup schedule. |
| `archive_unavailable`, `archive_stale` | Check `pg_stat_archiver`, the backup mount, free space and archive-command errors. |
| `disk_unavailable`, `disk_sample_unavailable`, `disk_growth_warming_up`, `disk_sample_stale` | Check database access, blob-directory permissions and `operations.disk_sample_failed` logs. Growth needs two samples, about two minutes after startup; a fresh installation treats initial growth as known-empty. |
| `disk_growth_high` | Inspect database/table and filesystem-blob growth, retention backlog and remaining host volume capacity. |
| `audit_event_old` | Check whether producers are idle; if activity is expected, inspect failed writes and SSE polling. Age alone does not prove delivery delay. |
| `retention_unavailable` | Check database access and scheduled-purge logs; inspect the most recent `retention.purged` Audit Event. |
| `restore_gated` | Keep the source fenced, reconcile uncertain Effects, then use the User restore release API for each Workspace. |
| `enrollment_unknown`, `enrollment_recovery_required` | Repair enrollment using the persisted capability and enrollment recovery runbook. |
| `signup_open_public_origin` | Confirm that open signup is intentional on this public origin. |
| `sample_stale`, `snapshot_unavailable`, `observation_unavailable`, `observation_invalid` | Check database availability, locks, probe timeouts and clock consistency. Retry after correcting the underlying failed signal. |

Pool gauges (`bp_pool_in_use`, `bp_pool_waiting`, `bp_pool_limit`) count actual
Bun SQL reservations, including ordinary queries and transactions. They are
separate from HTTP admission counters. The pool has ten connections. Database
observations have a three-second deadline and are cached for five seconds.

`bp_disk_database_bytes` uses `pg_database_size(current_database())`. It measures
the backplane database, excluding WAL, other databases and filesystem free space.
`bp_disk_blob_bytes` adds regular file sizes under `$BP_DATA_DIR/blobs` for the
filesystem backend, including staging bytes. With S3 this gauge is zero; monitor
RustFS storage separately. `bp_disk_growth_bytes_per_second` is the signed change
in database plus filesystem bytes over up to sixty minute-spaced samples. The
server stores those sixty global samples in `control.disk_samples`, each with its
own `run_id` identifying the sampling invocation. They have no Workspace or
Workspace Run row and emit no Audit Event. Sampling starts on a fresh installation.
System Principal authority is bounded by the mutation guards; unused per-Workspace
maintenance roles have been removed. Neither built-in Principal can receive an API key.

`bp_event_newest_age_seconds` is database time minus the newest Audit Event,
including maintenance events; an empty audit log reports zero. Connected SSE
cursor positions are not exported by the stream implementation, so this gauge
measures audit activity age, not client acknowledgement or end-to-end lag.

Thresholds are positive numbers in `BP_OPERATIONS_*`: `BACKUP_MAX_AGE_SECONDS`
86400, `EXPIRED_LEASE_MAX_AGE_SECONDS` 300, `ARCHIVE_MAX_LAG_SECONDS` 300,
`READY_WARN_SECONDS` 300, `TRANSACTION_WARN_SECONDS` 30,
`UTILIZATION_WARN_RATIO` 0.8, `SAMPLE_MAX_AGE_SECONDS` 15,
`DISK_SAMPLE_MAX_AGE_SECONDS` 180, `DISK_GROWTH_MAX_BYTES_PER_SECOND` 1048576,
and `EVENT_MAX_AGE_SECONDS` 300. Exporters also expose the queue, admission,
quota, backup and restore gauges, plus `bp_signal_status` and
`bp_operations_status` for status-aware alerts.

## Scheduled retention

The Owner's 2026-09-17 decision extends the User-triggered purge described in
ADR-0013 with a scheduled purge. The server runs it every
`BP_RETENTION_PURGE_INTERVAL` (default `1h`; positive integer plus `ms`, `s`, `m`
or `h`). A PostgreSQL advisory lease fences overlapping workers. Migration 28 creates the built-in `retention` identity and its memberships in
existing Workspaces; the Workspace creation trigger adds future memberships. Every batch has a Run and `retention.purged` Audit Event; blob
cleanup retains the same attribution. No User credential or admin URL is needed.
The restore gate prevents scheduled mutations and deletion until release.

Each pass processes at most 100 batches of 100 captures per Workspace; larger
backlogs continue on the next interval. A JSON `retention.purge` summary records
batches, removals and failures. Inspect failures or pending blob cleanup and retry
the existing User purge endpoint if immediate completion is required.
`bp_retention_last_purge_timestamp_seconds` is the newest successfully committed
purge batch in the database, including User-triggered purges. Zero means none has
completed. Alert when this timestamp is older than two configured intervals in an
active deployment, and inspect summary failures even if other Workspaces succeed.

Expiry prevents payload reads immediately; physical removal waits for a successful
purge and blob cleanup. Permanent audit envelopes remain. Backups and exports
taken before a purge still contain those bytes. See
[backup retention and recovery](../../infra/backup/README.md) for mount retention.

`bp_checkpoint_timestamp_seconds` exposes the completion timestamp from the last
valid Checkpoint manifest for this database identity. A missing manifest yields
`NaN`, matching the other backup signals.

Before upgrades whose migrations take exclusive locks (including 000028 and
000030), run `docker compose stop server`, then `docker compose up -d --wait`
with the same env file, project and overlays. This lets the migration one-shot
finish before the server resumes traffic.
