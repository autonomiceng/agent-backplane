# Public status observations

`scripts/status_observer.py` assembles the Backplane version 1 public status
allowlist from bounded host observations. It writes `status.json`; this change does
not mount or serve that file, install a timer, or invoke the observer from
preparation. Those publication and lifecycle steps require separate integration.

Run the observer as the installation owner, with Python 3.11+, Docker CLI with
Compose, and access to the selected local Docker daemon. It uses only the Python
standard library and existing container tools. Docker access remains host-root
equivalent authority.

## Select one installation

Selection includes the canonical checkout, env file, Compose project, ordered
Compose files, and active profiles. For a core-only installation:

```sh
python3 scripts/status_observer.py \
  --checkout "$PWD" \
  --env-file "$PWD/.env" \
  --project-name agent-backplane \
  --compose-file compose.yaml \
  --state-dir "$PWD/data"
```

Repeat `--compose-file` and `--profile` for every installed overlay. For example,
an internal gateway with Files on RustFS and Functions enabled adds:

```sh
  --compose-file compose.blobs.yaml --profile blobs \
  --compose-file compose.compute.yaml --profile compute \
  --compose-file compose.gateway.yaml --profile gateway
```

Use `compose.edge.yaml` with `--profile edge` for standalone Caddy. Never select
both edge and gateway. Relative Compose files resolve from the selected checkout.
If omitted, the env file defaults to `<checkout>/.env`, the project to
`agent-backplane`, the Compose selection to `compose.yaml`, and the state directory
to `<checkout>/data`. These defaults select core only. The observer never discovers
optional overlays from repository presence. `infra/bootstrap/prepare.ts` currently
does not persist its Compose file/profile selection, so an installed optional stack
must repeat the exact preparation selection here. Every active profile must be passed
with `--profile`; an env-only `COMPOSE_PROFILES` selection does not establish observer
custody and leaves the affected mode unknown.

Native Compose resolves variables from the selected env file. The observer removes
inherited `BP_*`, `COMPOSE_*`, and unrelated shell variables before invoking Compose;
only a small process environment and `DOCKER_*` connection settings remain. A project
name mismatch or malformed effective configuration publishes current unknown facts.
An unavailable checkout, env file, or explicitly selected Compose file refuses before
publication. Diagnose complete Compose output only through a protected operator shell;
it can contain credentials.

The public file is `<state-dir>/console/status.json`. The lock and future bootstrap
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
| `bootstrap` | Private execution record bound to the canonical checkout and env-file paths | Omitted |

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

The Python tests use fake Docker boundaries and real local process/filesystem failure
tests. They do not qualify PostgreSQL, Caddy, RustFS, workerd, the Bun operations helper,
or a complete effective Compose installation. Before publication integration is released,
run the observer against core, blobs, compute, standalone edge, and internal gateway
selections. Verify every shipped runtime version parser, disabled and absent states,
operations-token privacy, task timestamps, frozen-file expiry, rootless/remote refusal,
and atomic publication. The later gateway route must independently prove unauthenticated
GET/HEAD behavior, credential stripping, JSON/no-store headers, method rejection, and
missing-file behavior.

The pinned workerd binary was checked directly and prints `workerd 2026-09-18`.
The observer must still be exercised against the selected running container during
installation acceptance; a direct binary check does not prove the whole collector.
