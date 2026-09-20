# Filesystem to local RustFS migration

This command performs one fenced migration into a fresh, tool-owned local RustFS
volume. It preserves the complete origin filesystem, retained staging objects,
blob IDs, metadata and Run attribution. It never deletes source or target storage.
Remote S3, existing target volumes, merging stores and credential rotation are
unsupported. Aborted intents remain immutable history. A new attempt requires a
new state directory, fresh valid filesystem checkpoint and fresh target volume;
the command records a new migration ID. Reusing the old state never retries an abort.

Merge and qualify the coordinated-checkpoint implementation and migration 35
before using this command. Build the server image from that merged checkout. The
filesystem checkpoint must be captured with this same schema and image. An old
checkpoint's label does not establish custody: the command verifies its manifest,
every artifact hash, the exact source binding and inventory, PostgreSQL system ID,
timeline, schema, extension version and Workspace audit heads.

## Operator sequence

Hold the external writer fence for the entire operation, including retries. Stop
server and edge, exclude every other server connection and mutating helper, and
retain exclusive operator control over the selected volumes and private env files.
Do not run bootstrap separately against the migration target. Unset exported
`BP_*` and `COMPOSE_*` variables; they must not override either private env file.
No installation operation is authorized until the checkpoint changes are merged.

Prepare two owned `0600` files: the installation env and a target env. Both must
contain exactly one `COMPOSE_FILE` value listing absolute paths. The source selects
core and its existing overlays; the target additionally selects `compose.blobs.yaml`
and enables `blobs` in `COMPOSE_PROFILES` alongside any existing profiles.
Keep PostgreSQL, server-data, repository, application image and all non-storage
settings identical. Supply the scoped S3 credentials and RustFS root credentials
through the target env, using the qualified bootstrap generator and its strong
random secrets. The credential commitment uses PBKDF2-HMAC-SHA256 with 600,000
iterations and a per-intent salt derived from the randomly generated migration UUID.
It records credential equality; it cannot make a weak supplied password strong. The existing
RustFS volume name must be absent. The tool creates and labels that local volume
only after committing the migration intent.

Choose `BP_STARTUP_VERIFY_TIMEOUT` with ample margin in both env files before
capture. Before binding changes, a complete actual RustFS inventory must finish
within half that budget. The remaining half is headroom for startup setup and
variability. Failure reports `blob_binding_migration_startup_budget` and keeps the
intent `copying`, binding on filesystem, and all copied bytes retained. This is a
bounded measured qualification, not a wall-clock guarantee: later disk, network or
host slowdown can still exceed the budget. Restore adequate capacity and retry
under the fence. This command does not relax pinned env equality to increase the
budget after intent creation. Before cutover, an operator can abort, choose a larger
budget in both configs, capture again, and explicitly start a new migration with
fresh state and target. Persistent post-cutover slowdown remains gated and requires
restoring adequate performance or a separately reviewed recovery decision.

Files created by the tool use `0600`
and its private state directory uses `0700`. Commands below contain paths only.

Capture the stopped filesystem installation with the existing checkpoint tool:

```sh
python3 scripts/checkpoint.py backup --offline --fenced --env-file /private/install.env
python3 scripts/storage-migrate.py migrate --fenced \
  --env-file /private/install.env --target-env /private/rustfs.env \
  --checkpoint /repository/backups/UTC_CAPTURE_NAME --state /private/migration-state
```

The existing checkpoint command also requires the matching explicit Compose
selection; pass its source `COMPOSE_FILE` environment for that capture, then unset
it before migration. Retain the env files and state directory throughout recovery.
The tool replaces the installation env atomically after comparing its exact saved
source bytes under the installation lock. It leaves the server stopped. A successful
result is `{"phase":"complete",...}`. Start the selected server explicitly with
`docker compose --env-file /private/install.env up -d --no-deps server` after
checking the recorded result. Keep other writers fenced until startup verification
passes. The normal startup path never migrates or falls back to filesystem.

For a retry, run the same migration command with the same paths. The immutable
intent rejects another checkpoint, changed credentials or another target. Copying
and repairs that create bytes require the exact retained source. An intact pending
target can proceed without reading the filesystem source; checkpoint custody remains
fixed. Every existing target object must match exactly. Conditional PUTs and
marker publication never overwrite divergent bytes. A process deadline, failure
or lost lease leaves the durable gate in place and all partial target bytes intact.
An interrupted env lock may remain; confirm that its operator process and helper
container have stopped before explicitly removing that lock and retrying. Never
kill processes by pattern.

## Recovery boundaries

1. **Before binding cutover:** `abort --fenced --env-file ... --target-env ...
   --state ...` verifies the exact unchanged filesystem source and marks the intent
   aborted. The old backend can serve again. Every copied target object and volume
   remains retained. No source checkpoint is restored automatically. After serving
   healthy filesystem storage again, stop and fence it and capture a fresh offline
   checkpoint. Explicitly start another `migrate` command with a new state directory
   and target env selecting a different, absent RustFS volume. An additional Compose
   overlay may set only `volumes.rustfs-data.name`; keep the PostgreSQL and server-data
   selections unchanged. The new ID can complete while the aborted row, its pins and
   partial target remain intact. Repeating `abort` for the old ID is a read-only result
   and cannot release a newer intent's gate.
2. **After binding cutover, before serving:** `committed_pending_checkpoint` blocks
   startup, initialize, adoption and reconciliation. Inspection and migration repair
   remain available under the fence.
   Retry completes the explicit env switch, verifies the existing labeled volume,
   image and container metadata, and starts that exact RustFS container if stopped.
   It never recreates or pulls a pending target. Missing, foreign or changed
   containers remain a refusal. Live credential proof follows the verified restart.
   Under the storage lease, retry verifies the live target binding, original checkpoint
   custody, database/audit snapshot and fence against the same intent. If the target
   marker and full inventory match, repair returns pending without accessing the
   filesystem source. Otherwise repair also verifies the retained filesystem marker
   and complete source inventory before creating any bytes. It refuses any
   divergent object, unexpected key or foreign marker before writing. It restores
   only absent objects and an absent expected marker using conditional create-only
   writes, then rechecks complete inventory before capture. Pending repair uses the
   migration process deadline; the half-startup-budget qualification applies only
   before binding cutover. Capture and startup retain their full startup budget.
   Repair is idempotent,
   keeps the same binding/generation and is forbidden after `complete`.
   Retry takes a coordinated offline S3 checkpoint, verifies custody and records
   completion atomically. It never flips the binding or either marker back. The recovery tool can finalize an intent
   captured in that precise pending state only after verifying the captured target
   binding/inventory and checkpoint, and arming its existing restore gate.
3. **After serving:** restoring either older checkpoint loses writes made since
   capture. That is a separate destructive recovery decision. This migration gives
   no authorization to perform it.

If finalizing a **fresh restore** fails, retain that failed restore's volumes and
its source checkpoint. Existing restore supports another data-preserving attempt:
stop and fence the failed recovery services, choose a new Compose project and fresh
volume names for every durable store, and use a new repository with an empty
archive directory. Copy the complete unchanged checkpoint directory to
`NEW_REPOSITORY/backups/ORIGINAL_CAPTURE_NAME`; keep its manifest and artifact hashes,
image references and captured credentials unchanged. Point the new private recovery
env at that repository/project/volume prefix and call the existing fenced restore
command with the matching Compose overlays. The normal custody checks, restore gate
and exact captured-intent finalization run again. The failed partial restore and
original checkpoint remain intact; no wiping is required. Ports and networks must
avoid the retained failed project. Restore still refuses existing containers and
nonempty target volumes in the newly selected project. No in-place restore-resume
command is provided, and an older restore point after serving requires the separate
data-loss decision described above.

Helper failures expose only a stable `blob_binding_*` JSON error token. Raw Compose
stderr and credentials are never printed. Keep the fence, state files and all bytes
when diagnosing a refusal.

Source and post-cutover checkpoints are pinned in private `backups/.pins` metadata,
outside the immutable artifact inventories. A reservation protects post-cutover
captures even if the operator dies before saving its local result. Pruning validates
pinned custody and includes their WAL boundaries. Pins are never removed by this
command. A later operator decision must explicitly identify the recovery boundaries
being relinquished before removing the corresponding pin records and reservation.
Keep the full origin filesystem and partial targets regardless of pin decisions.

## Qualification

Root runs these serially after applying migration 35 and integrating the checkpoint
parent. They own new disposable resources; they do not target the installation:

```sh
bun tests/acceptance/storage-migration.ts
python3 scripts/storage-migration-drill.py
```

The five engine cases include slow-target prebinding refusal, intact-target repair
with the source unavailable and no half-budget gate, and missing-object/marker
repair with unchanged binding and divergent-byte refusal. They use `migratedDatabase`,
real PostgreSQL and one fresh RustFS
container. Small artifact fixtures exercise hash custody in those cases; they are
not recovery backups. The sixth case injects a stopped RustFS after binding and a failed capture, retries
the normal operator path with the same container ID and binding, captures real physical PostgreSQL/filesystem
and S3 archives, restores fresh volumes, and verifies SQL, two Principals' Files,
metadata, provenance and retained inventory through the existing recovery flow.
Failed drills retain their disposable resources for diagnosis. Root must review
these commands and their evidence before scheduling any host migration.
