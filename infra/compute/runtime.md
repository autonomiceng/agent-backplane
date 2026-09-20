# Compute Runtime Identity and release gate

No workerd artifact has completed full runtime qualification. **Default promotion remains gated on H-PROOF/F-GATE and B-DEFAULT approval.** The [project image](image/README.md) packages a verified official binary under ADR-0009. No registry artifact has been published. ADR-0018 defines Runtime Identity and its separate artifact evidence.

## Configuration

When compute is selected, bootstrap builds `infra/compute/image/Dockerfile` as
`agent-backplane-workerd:1.20260918.1` if `BP_WORKERD_IMAGE` is missing or blank. Cached
rebuilds are allowed. The build requires an amd64 Docker host and compatible BuildKit with
network access to pinned inputs. Arm64 is refused for this default even with an explicit
binary pin; its recipe inputs do not establish architecture qualification. Fresh minimal
selection remains unchanged and leaves `BP_COMPUTE_URL` unset.

An explicit `BP_WORKERD_IMAGE` accepts full local tags, registry digest references and
local `sha256:<image-config-id>` references. It must already exist locally: bootstrap
never builds over or implicitly pulls an explicit override. Server and other image
overrides remain independent. The resolved image ID is used for verification and the
subsequent Compose launch. The overlay has no build stanza, so `up` cannot rebuild workerd.
After H-PROOF/F-GATE and B-DEFAULT approval, this qualified local recipe is the supported
delivery method; ADR-0009/0018 now make registry publication optional. Preparatory code
and a successful build establish neither those gates nor a registry release.

`BP_WORKERD_BINARY_SHA256` is the expected SHA-256 of `/usr/bin/workerd`. Empty uses the known packaged amd64 binary, `f31da6d248028d698806aa93d1b3aec28bbd4b4b7ddc31e967408ab6406fa5aa`. Another executable requires an explicit verified hash. Other architectures require an explicit pin and their own runtime gate. The supervisor protocol requires images to provide `/bin/sh`, `sha256sum`, `/usr/bin/bun` and `/usr/bin/workerd` and run with the overlay restrictions. Bootstrap also requires the recipe's architecture-specific Bun 1.4.2 executable hash and version. Both executables must run `--version` under the overlay restrictions; custom workerd bytes still require their own runtime gate. Settings and host declarations are documented in `.env.example`.

`BP_COMPUTE_URL` is a secret-bearing destination: verification sends the control token before checking identity, so every HTTPS override must point to an operator-owned runtime. It accepts HTTPS authorities, the private Compose authority `http://workerd:8080`, and explicit loopback HTTP (`localhost`, IPv4 `127.0.0.0/8`, or IPv6 `[::1]`, with any port). Other cleartext authorities, including private LAN addresses, are refused before any token is sent. Loopback is for an operator-owned local runtime; the Compose hostname relies on the trusted private network. No arbitrary hostname is resolved to decide this exception. Userinfo, query strings and fragments are refused. A path prefix is preserved for `/identity`, `/prepare` and `/invoke`; path construction never changes the configured authority. Identity and preparation refuse redirects. Invocation returns function 3xx responses as ordinary results without following their Location. An invalid nonempty URL disables compute operations with `compute_unavailable` while core remains available.

## Measurements and compatibility

The trusted mounted entrypoint measures the executable before `exec`, refuses a mismatched expected hash, and exports `BP_WORKERD_RUNTIME_ID=workerd-binary-sha256:<observed-hash>` to the private authenticated loader. It also measures the control files in this exact order: `loader.js`, `config.capnp`, `start.sh`, `supervisor.ts`, `child-process.ts`. Each file's SHA-256 becomes a line `<lowercase-hex>  <filename>\n`; the SHA-256 of those five concatenated lines is `BP_WORKERD_CONTROL_SHA256`. This matches POSIX `sha256sum` output from `/compute` and Bun's explicit file-reading helper. There is no file I/O on module import.

Every server identity verification compares the observed control hash with its own checkout. Changed mounts or a newer server checkout require restarting workerd with matching files. Runtime Identity and `configHash` remain unchanged when the executable is unchanged, so the control update requires no redeployment. The server checks the private endpoint before registration, preparation and invocation. Verification returns the measured Runtime Identity and control hash plus the validated host-declared artifact facts. Prepare/invoke carry this exact observation in `x-backplane-runtime`, `x-backplane-control` and `x-backplane-artifact` request headers under the private control token. The loader compares all three with its entrypoint measurements and declaration before reading the body or loading code, and separately compares the manifest's Runtime Identity. A replacement with the same binary and different control or artifact facts refuses the admitted request. There is no second identity round trip and no cached checkout hash.

Runtime and control values are fixed-format (86 and 64 characters). Artifact JSON is canonical in `source`, `reference`, `hostObservedImageId` order, bounded to 1024 characters; references are bounded to 512 and image IDs to `sha256:<64 lowercase hex>` or null. Missing/malformed/mismatched operation evidence returns 503 with the reserved `x-backplane-error: compute_unavailable` control marker, which the adapter maps to `compute_unavailable`. The loader strips the reserved marker from child responses, so function 503 responses remain invocation results. A dispatch-time infrastructure refusal still finishes its child Run as `function.fail`; the HTTP 503 `compute_unavailable` response and caller-attributed rejection row distinguish it from a function result. This trusted protocol detects changed observations; it is neither a signature nor a unique runtime-instance identity. Identical observations may be served by a replacement instance. Each operation verifies identity once with a two-second deadline before opening its transaction. Activation has a separate two-second preparation deadline. Compute unavailability never blocks the core listener. Capability reporting is a separate M-BP concern.

The API field `runtimeDigest` holds the namespaced executable identity and participates in immutable `configHash`. It excludes the image base, CA bundle, architecture and loader. Packages with identical executable bytes have the same Runtime Identity and still require separate artifact qualification. Operator-controlled images, utilities, mounts and control network remain trusted. This is not attestation against a malicious image or host. No Docker socket is mounted in either service.

## Artifact evidence

Bootstrap inspects the selected full reference to obtain its actual local Docker image ID and architecture, verifies both executable hashes and version output in disposable network-disabled containers, and atomically records a private, fsynced launch decision under `data/compute/<uuid>.json` beside the bootstrap env file. `BP_DATA_DIR` overrides that host data directory; relative paths resolve beside the env file. The record contains only source, purpose, selected reference, host-observed image ID, workerd and supervisor binary hashes, both version strings, architecture and observation time. It is mode 0600 and contains no environment secrets. These host records are operator-owned and never automatically pruned. It records the immutable image selected for that launch attempt, including attempts where Compose later fails; it does not claim the image remains running forever.

Bootstrap passes that ID through `BP_WORKERD_EFFECTIVE_IMAGE` **only in its child environment** and supplies `BP_WORKERD_HOST_IMAGE_ID` as a host declaration. It never rewrites `BP_WORKERD_IMAGE` or persists an effective-image override. Bootstrap refuses any persisted `BP_WORKERD_EFFECTIVE_IMAGE` assignment. Every bootstrap resolves the current reference again. A subsequent bare `docker compose up` is an explicit deployment action and may resolve a moving tag again. Bare Compose cannot enforce that the internal effective-image override is absent from the shell or env file; an override can select an image different from the reported `BP_WORKERD_IMAGE`. Operators using bare Compose must remove that override and own the accuracy of their declarations. Use an immutable image ID/reference for repeatability. The evidence record never drives future image selection.

The private identity endpoint carries `artifact: { source: "host-declared", reference, hostObservedImageId }` separately from measured hashes. Bare Compose defaults the image ID to null; it is never inferred from a tag. A trusted operator may explicitly set `BP_WORKERD_HOST_IMAGE_ID`, including via tooling environment, and owns the accuracy of that declaration. The server validates and bounds these facts and records them in `function.deploy`, `function.activate` and `function.invoke` Audit Events. They are Workspace-readable audit evidence, absent from public status and deployment responses, and excluded from `configHash`. Malformed facts refuse compute; a valid change of artifact facts does not change eligibility. Invocation facts describe its verified admission observation. The loader must match that observation before dispatch; it still does not prove eventual execution. Principal, Run and temporary invocation authority remain unchanged.

## Legacy deployments and root integration

Historical bare 64-character `runtimeDigest` values retain their meaning as configured OCI digests. Migration 33 preserves them and existing Audit Events without rewriting history. These deployments remain readable; activation/invocation under the new runtime refuse with `compute_unavailable`. Active legacy deployments will therefore be unavailable until replaced. Register a new deployment ID through the API and activate it with the previous active ID. Legacy `BP_WORKERD_REPOSITORY` and `BP_WORKERD_DIGEST` configuration is refused by bootstrap and the entrypoint; replace it with the full image reference and expected executable hash.

Deploy the migration and server wiring together. Migration 33 follows root's storage/S-identity schema migration 32. Its constraint validation takes an exclusive lock; follow the [offline upgrade procedure](../../docs/operations/health.md) with the server stopped until migrations complete. There is no generated API shape change.

## Bounded acceptance gates

Root runs these in disposable fixtures:

```sh
# Owns containers sequentially. Includes real HTTPS unless --identity-only is supplied.
bun tests/acceptance/workerd-image.ts agent-backplane-workerd:1.20260918.1

# Set BP_COMPUTE_URL, BP_COMPUTE_TOKEN and BP_WORKERD_RUNTIME_ID for a separately owned runtime.
bun run test ./tests/acceptance/workerd-identity.ts
bun run test apps/server/compute/compute-launcher.test.ts apps/server/compute/compute-identity.test.ts tests/acceptance/workerd-legacy.test.ts
```

The image probe records reference, actual image ID, architecture, binary and control hashes. It checks private persistence, wrong identity refusal, null bare-Compose image evidence, stale admission evidence refusal for prepare/invoke after changing artifact declarations or loader bytes with the same binary, followed by healthy preparation of the original manifest. Each Docker command is bounded to 120 seconds, control requests to five seconds and startup/restart waits to 15 seconds. The 30-second PG gate writes through the server, checks persisted deployment/activation/invocation evidence and unchanged Principal/Run attribution, and uses real HTTP to check core readiness and authentication while compute refuses a wrong identity. The local HTTP/PG regression checks stored configuration hashes across two artifact declarations and one identity check per operation. The legacy PG gate seeds an active deployment under schema 32, applies migration 33, and checks unchanged history, API readability, attributed activation/invocation refusal, constraint enforcement, and replacement activation retiring the legacy deployment.

Full F-GATE remains unverified until the supervisor artifact and the cases below pass. Workerd remains an experimental trusted-code boundary. The old workerd-only image cannot start the new protocol; the Dockerfile includes the pinned Bun addition, which still requires the actual artifact gate before default promotion. No shipping support or published artifact custody is claimed.

## Operation lifecycle

`start.sh` verifies the workerd executable and control files, then execs Bun as PID 1.
One operation occupies the operation slot from admission through child reaping. Busy
operations return `compute_unavailable` without spawning or queueing. Identity has one
reserved, singleflight probe slot and no completed-result cache. It must complete a real
loader identity round trip within the existing two-second budget, including under CPU
load. N=1 is the initial bound; the artifact gate exercises it under the container CPU cap.

The admission deadline includes body reading, fresh child startup, execution and response
buffering. Invocation sends the remaining server budget after the authority transaction
in `x-backplane-budget-ms`; the supervisor clamps it to its configured maximum. Preparation
and identity each have a two-second maximum. The control FD is stdout (fd 1), read as one
bounded 256-byte listen event for the ephemeral loopback control port. Later output is
discarded, and stderr is never forwarded. Mounted controls are rechecked before each
spawn so new children cannot silently load drifted files under an old measurement.

The child is always SIGKILLed by its captured process handle and awaited on response,
error, oversize, deadline or observed caller disconnect. Response bytes are capped at
1 MiB and are released after exit, ending `waitUntil` work. Request bodies retain the
loader's encoded-envelope bound. Child failure after forwarding maps to `function_failed`,
deadline to `function_timeout`, and busy/startup failure to `compute_unavailable`.
Reserved markers remain stripped from function responses, and redirects are never followed.
If exit is not observed within one second of SIGKILL, the supervisor exits nonzero;
PID 1 exit and Compose restart provide the container fallback. This fallback requires
an actual container and is distinct from the host fault-injection fixture.

Bun's wire-disconnect signal remains a measured behavior, not the hard guarantee. The
remaining-budget deadline bounds lifetime even when a disconnect is unobserved. Parent
shutdown aborts outstanding work and kills captured children. The supervisor attempts
`oom_score_adj=1000` for each child; permission refusal leaves aggregate container OOM
and restart as the fallback. Memory is shared by the parent, one operation and one probe
under 512 MiB; no per-isolate memory guarantee is claimed.

## Invocation recovery

A separate startup, five-second periodic and opportunistic server pass selects at most
16 unfinished invocations under a session advisory lease. Migration 34 records pending
terminal work separately from immutable Runs and temporary authority, and backfills
unfinished historical invocations. Apply it with the server fenced under the existing
offline migration procedure. Its table locks serialize the backfill with writers;
lock acquisition fails within five seconds if live writers prevent the fence.
The closed invocation definers insert pending work with authority and remove it only
when a terminal audit event exists. Expired-token sweeping cannot lose recovery work.

An expiry index keeps selection independent of completed invocation history. Recovery
becomes eligible ten seconds after the invocation's configured timeout elapses,
allowing the original gateway to record its outcome. With the Compose default 10-second
timeout, eligibility begins about 20 seconds after invocation start. Scheduling and
contention can add delay. This affects terminal audit recording; authority still
expires at the configured timeout.
A keyset cursor advances past each attempted row so a contended Workspace cannot starve
later Workspaces; it wraps to retry unfinished rows. Selection has a two-second statement
timeout. The whole pass, including reservation and connection release, has a five-second
deadline. The original request's finalizer also bounds reservation and cleanup to five
seconds. Contention leaves pending work for another pass. Recovery emits the existing
`function.fail` event through the closed definer; SQL token expiry is unchanged.

Reconciled `durationMs` is observed wall time from Run creation to reconciliation,
capped at int32. It is neither CPU time nor exact execution duration. A terminal event
alone never proves child exit. A successful original finalizer wins idempotently if it
records the terminal event first.

## Supervisor acceptance commands

Ten new cases: six host lifecycle cases, three real-Postgres authority/recovery cases,
and one container-memory case with a companion artifact resource proof. No Docker is
used by the host or PG fixtures. Every missing runtime, EPERM, checksum mismatch, network
failure or missing fixture setting fails; no such outcome qualifies the runtime.

```sh
# Host prototype only, using the qualified amd64 binary. Requires local socket permission.
export BP_TEST_WORKERD_BINARY=/absolute/path/to/workerd
export BP_WORKERD_BINARY_SHA256=f31da6d248028d698806aa93d1b3aec28bbd4b4b7ddc31e967408ab6406fa5aa
bun test ./tests/acceptance/workerd-lifecycle.ts

# Start a separate prototype for the PG cases in one terminal; stop this captured process afterward.
BP_COMPUTE_TOKEN=fixture-secret BP_COMPUTE_TIMEOUT_MS=15000 BP_TEST_API_ADDRESS=127.0.0.1:18081 BP_TEST_SUPERVISOR_PORT=18080 \
  bun tests/acceptance/workerd-prototype.ts
# In another terminal, using that prototype:
BP_COMPUTE_URL=http://127.0.0.1:18080 BP_COMPUTE_TOKEN=fixture-secret BP_COMPUTE_TIMEOUT_MS=15000 \
  BP_WORKERD_RUNTIME_ID=workerd-binary-sha256:$BP_WORKERD_BINARY_SHA256 BP_TEST_API_PORT=18081 \
  bun run test ./tests/acceptance/workerd-authority.ts ./tests/acceptance/workerd-identity.ts

# Actual new artifact; root builds with the reviewed Bun pin first. Includes cgroup memory proof.
bun tests/acceptance/workerd-image.ts ROOT_BUILT_SUPERVISOR_IMAGE --lifecycle
# Owns a 512 MiB / one-CPU container, fresh PostgreSQL and temporary API listeners.
python3 tests/acceptance/workerd-gate.py ROOT_BUILT_SUPERVISOR_IMAGE
```

The lifecycle fixture checks captured children disappear and prints disconnect-reap timing
and the actual child OOM score. Its exit-observation fault injection uses a real killed
child plus a deliberately unresolved exit promise; it proves fatal-parent logic, not
kernel-uninterruptible process behavior or Docker restart. The artifact memory fixture
checks child absence, no zombies, subsequent healthy invocation and cgroup memory returning
within 64 MiB of baseline. The PG memory fixture checks terminal failure and token revocation.
The artifact fixture also records two-second identity under its one-CPU limit and
restart recovery after an injected lost exit observation in the owned control mount.
The original helper is restored before asserting healthy recovery. Run the artifact and PostgreSQL gates together for runtime qualification; a build alone is insufficient.

Preparation imports bundles in a child with empty bindings and no outbound access. The compatibility date is `2026-01-01`; both server and loader hash the identical trusted Check source into the deployment tuple. Children receive no disk, loader, raw network or API bindings. Egress permits only Workspace paths at `http://server:3000` and exact declared HTTPS URLs over workerd's public-only network.


Review follow-up: admitted supervisor requests and authenticated, parsed API invokes use
Bun's per-request `server.timeout(request, 0)` while their operation deadline is active.
Other requests retain the listener idle timeout. The pinned Elysia adapter defaults to
30 seconds; raw Bun defaults to 10. The supervisor transport cap is one MiB above the
handler cap so both limits are exercised. Bare transport 413s map to `function_failed`;
forwarded function responses carry the supervisor-owned `x-backplane-response: proxied`
header so an ordinary function 413 remains an ordinary result. The recovery pass has a
five-second deadline covering reservation through lease release, and shutdown disables
and aborts only that pool's recovery state. Interrupted artifact fixtures attempt
ownership-checked cleanup on SIGINT/SIGTERM at bounded operation boundaries. SIGKILL
cannot execute cleanup; `on-failure:10` bounds automatic failure retries and does not
remove a leaked container.
