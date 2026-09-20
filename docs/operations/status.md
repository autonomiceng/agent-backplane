# Public status observations

`scripts/status_observer.py` assembles the Backplane version 1 public status
allowlist from bounded host observations. It atomically writes the public file at
`<BP_STATUS_DIR>/console/status.json`. Standalone edge and internal gateway
deployments mount only that `console` leaf at `/srv/status`, read-only. The private
task directory is not mounted, and the edge receives no Docker socket.

The edge serves unauthenticated `GET` and `HEAD /status.json` with
`Content-Type: application/json` and `Cache-Control: no-store`. It strips
authorization, proxy authorization, cookies, validators, and range headers before
file handling. Other methods return an empty 405 with `Allow: GET, HEAD`; a missing
or empty public directory returns an empty 404. The existing application routes and
authentication policy remain unchanged.

Preparation and observation require Python 3.11+. Run the observer as the
installation owner, with Docker CLI and Compose access to the selected local Docker
daemon. It uses only the Python standard library and existing container tools.
Docker access remains host-root equivalent authority.

## Select one installation

Selection includes the canonical checkout, env file, Compose project, ordered
Compose files, and active profiles. Preparation persists the native
`COMPOSE_PROJECT_NAME`, `COMPOSE_FILE`, and `COMPOSE_PROFILES` keys in the selected
env file. A manual observation can reuse that selection and `BP_STATUS_DIR`:

```sh
python3 scripts/status_observer.py --checkout "$PWD" --env-file "$PWD/.env"
```

For an explicitly selected core-only installation:

```sh
python3 scripts/status_observer.py \
  --checkout "$PWD" \
  --env-file "$PWD/.env" \
  --project-name agent-backplane \
  --compose-file compose.yaml \
  --profile '' \
  --state-dir "$PWD/data"
```

Repeat `--compose-file` and `--profile` for every installed overlay. For example,
an internal gateway with Files on RustFS and Functions enabled replaces
`--profile ''` with:

```sh
  --compose-file compose.blobs.yaml --profile blobs \
  --compose-file compose.compute.yaml --profile compute \
  --compose-file compose.gateway.yaml --profile gateway
```

Use `compose.edge.yaml` with `--profile edge` for standalone Caddy. Never select
both edge and gateway. Relative Compose files resolve from the selected checkout.
Saved relative Compose paths resolve beside the env file. Preparation requires the
checkout's root `compose.yaml` first, followed by the ordered overlays. Explicit
selectors must agree with recorded values. A saved empty `COMPOSE_PROFILES` selects
no optional profiles; `--profile ''` makes that selection explicit. Omitted profiles
inherit the recorded selection even when files are explicit.
Older explicit matching timer units remain valid, including profile order from
the recorded selection or repeated original arguments. Saved empty profiles still
produce the same units without profile flags.

The env file defaults to `<checkout>/.env`. With no recorded settings or explicit
selectors, the project defaults to `agent-backplane`, the Compose selection to
`compose.yaml` with no optional profiles, and the state directory to `<checkout>/data`.
The observer never discovers optional overlays from repository presence.

`BP_STATUS_DIR` is host state and is independent of the server's container
`BP_DATA_DIR=/data`. Preparation defaults it to `./data`, resolves relative values
beside the selected env file, persists the absolute value without replacing other
settings, and creates a private status parent plus a mode `0755` public `console`
leaf. It records bootstrap unavailable before deployment mutation and changes that
task to healthy only after `up --wait`, authenticated readiness, and enrollment
capability custody all succeed. Environment generation alone never records success.
Changing `BP_STATUS_DIR` requires re-running preparation before Compose so Docker
cannot create the bind source as root. Timer installation requires an existing
owner-controlled `status` directory with no group/world write and an owned mode
`0755` `console` leaf; it never changes ownership or repairs modes.

## Install periodic observation

Timer installation is an explicit, separate opt-in. Supply the project and every
Compose file used for the deployment. Omitted `--profile` flags reuse the saved
profiles; explicit flags select the complete set and must agree with the env file.
Without saved profiles, omission selects none. For example:

```sh
python3 scripts/install_status_timer.py --install \
  --checkout "$PWD" \
  --env-file "$PWD/.env" \
  --compose-project agent-backplane \
  --compose-file compose.yaml \
  --compose-file compose.blobs.yaml --profile blobs \
  --compose-file compose.compute.yaml --profile compute \
  --compose-file compose.edge.yaml --profile edge
```

Use `compose.gateway.yaml --profile gateway` instead of the edge pair for an
internal gateway. The installer evaluates that exact selection with a bounded
Compose configuration command in a closed environment. For edge or gateway
selections, it requires exactly one read-only bind at `/srv/status`, requires its
source leaf to be `console`, derives the state directory from its parent, and refuses
a conflicting `--state-dir`. Core-only selection requires an explicit `--state-dir`.

The generated user service freezes canonical checkout, env-file, project, Compose
files, profiles, state directory, rootful local Docker endpoint, Docker configuration
directory, and Docker executable search directory. It explicitly removes inherited
Docker context and TLS selectors. It has a 120-second start limit for the observer's
90-second collection and cleanup budget. If the user manager has already passed its
10-second startup point, enabling the timer starts the first observation immediately;
a newly started manager waits until that point. Later runs start 30 seconds after each
completion, so observations do not overlap. Unit arguments escape systemd specifier
and environment expansion.

Replace `--install` with `--check` for a read-only preflight. It checks the user
manager and accepts an absent pair or the exact generated pair for the same
selection. It creates no directories, units, env files or private copies. A fresh
check permits an env file that the owning bootstrap has not created yet.
Existing units require the original env file.

Unit enumeration can exit nonzero for an absent name. The installer then requires
`show` to confirm `LoadState=not-found` with empty fragment and drop-in paths.
An unavailable manager or inconclusive response still refuses before writing.

Both check and install refuse foreign loaded or installed unit fragments, drop-ins,
partial or malformed pairs, symlinks, hard links, non-private unit files, and unsafe
unit destinations. Install checks the manager **before** creating a user override.
Unit names alone never establish ownership. New units are private, and both the
files and containing directory are fsynced. Existing directory permissions and
systemd argument quoting are preserved.

Unit-directory ancestors must be owned by root or the installation user and must
not be group- or other-writable, except trusted sticky directories with existing
trusted children. Every new component requires a parent owned by the installation
user with no group/other write permission; the final unit directory has the same
strict rule. Symlink ancestors are refused. These checks apply only to timer units,
not general status publication. Inspect unsafe ancestors with the host administrator;
the installer never changes existing directory permissions.

Repeat the same `--install` command after an interrupted activation. An exact
pair is not rewritten. After reload, the installer verifies both loaded fragments
and absence of drop-ins, then enables the timer and verifies enabled and active
state. Activation failure retains the pair. A partial pair or different selection
requires inspection through the owning recovery procedure; the installer never
disables, deletes or overwrites installed units. Do not change the selection or
unit files concurrently. Host and disposable acceptance remain separate from these checks.

For an absent unit pair, check validates the native project, ordered files and
profiles plus any existing status directories, without rendering Compose. Missing
env/status directories are left for the owning bootstrap. A matching installed pair
requires complete installation evidence. Actual install always verifies the rootful
local Docker endpoint, effective read-only status mount and prepared status/public
directories through the existing owning installation checks. Preflight never relaxes
those requirements or changes native selection. Enable lingering separately if
observation must continue after logout.

Native Compose resolves variables from the selected env file. The observer removes
inherited `BP_*`, `COMPOSE_*`, and unrelated shell variables before invoking Compose;
only a small process environment and `DOCKER_*` connection settings remain. A project
name mismatch or malformed effective configuration publishes current unknown facts.
An unavailable checkout, env file, or explicitly selected Compose file refuses before
publication. Diagnose complete Compose output only through a protected operator shell;
it can contain credentials.

The public file is `<state-dir>/console/status.json`. The lock and bootstrap
execution record live under `<state-dir>/status`, outside the public directory.
Destination directories and existing destination files must be owned by the observer uid. Group-
or world-writable destination directories, destination symlinks, hard-linked output
files, and non-regular inputs are refused. Publication is a same-directory, bounded atomic replacement with
file and directory `fsync`. The public file is mode `0644`; private records and locks
are mode `0600` under a private directory.

## Evidence

The document has eleven fixed components and is capped at 64 KiB, below the shared
32-component limit. `edge` is the Compose service name for public component `caddy`.
The `backup-init`, `storage-init`, and `blob-image-check` helpers are intentionally
omitted because they are not stable Backplane task IDs in the v1 public contract.

| Component | Current-state evidence | Runtime version evidence |
| --- | --- | --- |
| `server` | Public `GET /health/ready` on the verified local bridge; JSON status must be `ready` | Omitted. Bun, an image tag, and the package manifest do not establish a Backplane release. |
| `postgres` | Bounded local-socket, read-only `SHOW server_version` against the running `backplane` database | The same server response, never the `psql` client version |
| `caddy` | `GET /health` on the verified local bridge | `caddy version` inside the inspected container |
| `rustfs` | When S3 Files is selected, `GET /health` on the verified local bridge | `rustfs --version` inside the inspected container |
| `workerd` | Container state; running alone remains `unknown` | Compatibility date from bounded `workerd --version` inside the inspected container |
| `files` | The original `capabilities.files` state and `observedAt` from the private operations response | Omitted |
| `functions` | The original `capabilities.functions` identity-probe state and `observedAt`; independent of workerd process state | Omitted |
| `migrate`, `data-init`, `blob-bootstrap` | Compose container start/finish/exit record | Omitted |
| `bootstrap` | Private execution record bound to the canonical checkout, env file, project, ordered Compose files and profile set; mismatched or older records without selection remain unknown | Omitted |

The operations request runs inside the inspected server container. Its bearer token is
read from that container's environment and is never placed in a host subprocess argument,
public file, or log. The helper emits only the `files` and `functions` capability object;
aggregate operations status, backup age, queue names, Workspace IDs, and diagnostics are
discarded. A degraded aggregate operations response can still carry a current healthy
capability. Old, null, invalid, mismatched-backend, or failed capability evidence becomes
unknown and never inherits an earlier success. Healthy capability evidence must name the
selected backend. Unavailable evidence must carry `backend: null`, matching the server's
failure projection, and retains its original observation time.

Core configuration explicitly disables `rustfs`, `workerd`, `blob-bootstrap`, and the
Functions capability. Files remains configured with the filesystem backend. The blobs
overlay/profile selects S3 Files and enables RustFS and blob bootstrap. The compute
overlay/profile enables workerd and requires the server's effective compute URL. Overlay,
profile, and effective service mismatches remain unknown instead of being inferred from
files on disk.

An inspected stopped, dead, or paused service is unavailable; restarting is starting.
A running service is healthy only after its documented probe passes. Unsupported probe
evidence stays unknown, while a supported probe that runs and fails is unavailable.
A failed or unrecognized version command does not turn a running component into an outage.
An unrecognized PostgreSQL server-version response proves neither a supported version nor
unavailability, even though the read-only query completed.
A nonempty selected-project inventory with no resource for a configured service proves
absent. Empty or failed inventory, duplicate containers, unexpected labels, and malformed
inspection prove neither absence nor readiness. Runtime probes are bracketed by inspection
of the same container image, start time, state, and pause flag.

Task success records only the latest historical execution. `observedAt` is the current
record-inspection time and `lastExecutionAt` is the actual container or bootstrap start.
No container or private record means unknown and supplies no invented execution time.

Configured versions use strict per-service release patterns. Arbitrary tags become
`custom`; the server tag is never treated as a version. `configuredDigest` is a complete
registry manifest digest from effective Compose configuration. `observedImageId` is the
inspected local Docker image content ID. They identify different objects. Raw image tags,
container IDs and names, labels, addresses, commands, environments, URLs, paths, errors,
probe bodies, credential values, and Workspace IDs are excluded from public JSON.

Telemetry is `unknown`. The Backplane can prove that its operator metrics route is
configured, but it cannot prove that a separately installed Alloy selected this target or
delivered samples. Backup age and other operations signals do not determine Functions or
telemetry state.

## Bounds and freshness

The complete observation has one shared 90-second monotonic budget. Every subprocess
receives the smaller of its own deadline and the remaining shared budget, and no new
subprocess starts after that deadline. Configuration has a ten-second, 1 MiB command bound. Container inspection has a
four-second, 1 MiB bound. Inventory, Docker context checks, bridge checks, HTTP, and
container commands have four-second deadlines. Ordinary combined stdout and stderr is
capped at 64 KiB. HTTP bodies are capped at 64 KiB. At most four components are observed
concurrently. Container commands also run under an in-container three-second kill timeout.
HTTP uses fixed paths and inspected IP addresses without redirects, proxies, cookies, or
request credentials.

Before any host-to-container request, the observer requires the selected Docker context
to report a local Unix endpoint, rejects conflicting `DOCKER_HOST` and rootless mode, and
verifies the container's selected network as a local bridge. Remote, rootless, or unknown
network topology leaves HTTP readiness unknown. Docker endpoint agreement is byte-exact.
Network names use Docker's bounded name alphabet. At most four effective networks are
checked independently, so one missing external network does not erase valid local-bridge
evidence for another component.

Configuration and explicitly disabled states remain valid for 300 seconds, leaving
room for the 90-second collection budget. Observed service and capability validity
remains 120 seconds. Configuration time dates the start
of effective Compose inspection. Each service time dates the start of its bounded
inspection/probe transaction. Capability time remains the server's original probe time.
Task observation time dates record inspection. `generatedAt` dates assembly and never
renews older evidence. Failed configuration produces a fresh unknown document; failed
component probes produce their current outcome. No prior healthy result is cached.

## Verification limits

The publication acceptance gate renders six effective Compose selections: core,
blobs, compute, standalone edge, internal gateway, and blobs plus compute plus
gateway. It verifies generated-unit syntax and exercises one actual unprivileged
Caddy with GET, HEAD, 405, missing-file, credential/validator/range stripping,
JSON/no-store response policy, bounded publication, and atomic replacement.

The Python suites cover fake Docker boundaries plus real local process and filesystem
failure paths. Actual-host qualification remains pending for the server, PostgreSQL,
RustFS, and workerd version/probe parsers, capability projection and token privacy,
task timestamps, frozen-file expiry, and rootless/remote refusal. The pinned workerd
binary was checked directly and prints `workerd 2026-09-18`; that does not qualify
the selected running container or the complete collector.

Timer installation requires a rootful local Unix Docker daemon and refuses rootless
Docker. The timer retains the search path used during installation so Docker
credential helpers remain available. Before any unit is written, a failed install
reports that no units were written; after a partial activation it gives cleanup
instructions for the retained units.
