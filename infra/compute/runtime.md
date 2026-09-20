# Compute Runtime Identity and release gate

No workerd artifact has completed full runtime qualification. **Release remains blocked until F-GATE passes.** The [project image](image/README.md) packages a verified official binary under ADR-0009. No registry artifact has been published. ADR-0018 defines Runtime Identity and its separate artifact evidence.

## Configuration

`BP_WORKERD_IMAGE` is required for compute, including when using bootstrap. An absent or empty value refuses clearly. It accepts full references including local tags, registry digests and local `sha256:<image-config-id>` references. There is no shipped image default until F-GATE, publication and B-DEFAULT approval. `pull_policy: never` requires the image already present. The local candidate `agent-backplane-workerd:1.20260918.1` has only packaging qualification. Core omits this overlay and leaves `BP_COMPUTE_URL` unset.

`BP_WORKERD_BINARY_SHA256` is the expected SHA-256 of `/usr/bin/workerd`. Empty uses the known packaged amd64 binary, `f31da6d248028d698806aa93d1b3aec28bbd4b4b7ddc31e967408ab6406fa5aa`. Another executable requires an explicit verified hash. Other architectures require an explicit pin and their own runtime gate. The supervisor protocol requires images to provide `/bin/sh`, `sha256sum`, `/usr/bin/bun` and `/usr/bin/workerd` and run with the overlay restrictions. Settings and host declarations are documented in `.env.example`.

`BP_COMPUTE_URL` is a secret-bearing destination: verification sends the control token before checking identity, so every HTTPS override must point to an operator-owned runtime. It accepts HTTPS authorities, the private Compose authority `http://workerd:8080`, and explicit loopback HTTP (`localhost`, IPv4 `127.0.0.0/8`, or IPv6 `[::1]`, with any port). Other cleartext authorities, including private LAN addresses, are refused before any token is sent. Loopback is for an operator-owned local runtime; the Compose hostname relies on the trusted private network. No arbitrary hostname is resolved to decide this exception. Userinfo, query strings and fragments are refused. A path prefix is preserved for `/identity`, `/prepare` and `/invoke`; path construction never changes the configured authority. Identity and preparation refuse redirects. Invocation returns function 3xx responses as ordinary results without following their Location. An invalid nonempty URL disables compute operations with `compute_unavailable` while core remains available.

## Measurements and compatibility

The trusted mounted entrypoint measures the executable before `exec`, refuses a mismatched expected hash, and exports `BP_WORKERD_RUNTIME_ID=workerd-binary-sha256:<observed-hash>` to the private authenticated loader. It also measures the control files in this exact order: `loader.js`, `config.capnp`, `start.sh`, `supervisor.ts`, `child-process.ts`. Each file's SHA-256 becomes a line `<lowercase-hex>  <filename>\n`; the SHA-256 of those five concatenated lines is `BP_WORKERD_CONTROL_SHA256`. This matches POSIX `sha256sum` output from `/compute` and Bun's explicit file-reading helper. There is no file I/O on module import.

Every server identity verification compares the observed control hash with its own checkout. Changed mounts or a newer server checkout require restarting workerd with matching files. Runtime Identity and `configHash` remain unchanged when the executable is unchanged, so the control update requires no redeployment. The server checks the private endpoint before registration, preparation and invocation. Verification returns the measured Runtime Identity and control hash plus the validated host-declared artifact facts. Prepare/invoke carry this exact observation in `x-backplane-runtime`, `x-backplane-control` and `x-backplane-artifact` request headers under the private control token. The loader compares all three with its entrypoint measurements and declaration before reading the body or loading code, and separately compares the manifest's Runtime Identity. A replacement with the same binary and different control or artifact facts refuses the admitted request. There is no second identity round trip and no cached checkout hash.

Runtime and control values are fixed-format (86 and 64 characters). Artifact JSON is canonical in `source`, `reference`, `hostObservedImageId` order, bounded to 1024 characters; references are bounded to 512 and image IDs to `sha256:<64 lowercase hex>` or null. Missing/malformed/mismatched operation evidence returns 503 with the reserved `x-backplane-error: compute_unavailable` control marker, which the adapter maps to `compute_unavailable`. The loader strips the reserved marker from child responses, so function 503 responses remain invocation results. A dispatch-time infrastructure refusal still finishes its child Run as `function.fail`; the HTTP 503 `compute_unavailable` response and caller-attributed rejection row distinguish it from a function result. This trusted protocol detects changed observations; it is neither a signature nor a unique runtime-instance identity. Identical observations may be served by a replacement instance. Each operation verifies identity once with a two-second deadline before opening its transaction. Activation has a separate two-second preparation deadline. Compute unavailability never blocks the core listener. Capability reporting is a separate M-BP concern.

The API field `runtimeDigest` holds the namespaced executable identity and participates in immutable `configHash`. It excludes the image base, CA bundle, architecture and loader. Packages with identical executable bytes have the same Runtime Identity and still require separate artifact qualification. Operator-controlled images, utilities, mounts and control network remain trusted. This is not attestation against a malicious image or host. No Docker socket is mounted in either service.

## Artifact evidence

Bootstrap inspects the selected full reference to obtain its actual local Docker image ID and architecture, verifies the binary in a disposable network-disabled container, and atomically records a private, fsynced launch decision under `data/compute/<uuid>.json` beside the bootstrap env file. `BP_DATA_DIR` overrides that host data directory; relative paths resolve beside the env file. The record contains only source, purpose, selected reference, host-observed image ID, binary hash, architecture and observation time. It is mode 0600 and contains no environment secrets. These host records are operator-owned and never automatically pruned. It records the immutable image selected for that launch attempt, including attempts where Compose later fails; it does not claim the image remains running forever.

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

Full F-GATE remains unverified until the supervisor artifact and the cases below pass. Workerd remains an experimental trusted-code boundary. The old workerd-only image cannot start the new protocol; root has supplied the pinned Bun addition, which still requires the actual artifact gate before publication. No shipping support or published artifact custody is claimed.

## Operation lifecycle

`start.sh` verifies the workerd executable and control files, then execs Bun as PID 1.
One operation occupies the operation slot from admission through child reaping. Busy
operations return `compute_unavailable` without spawning or queueing. Identity has one
reserved, singleflight probe slot and no completed-result cache. It must complete a real
loader identity round trip within the existing two-second budget, including under CPU
load. N=1 is the initial bound; it has not been qualified under the container CPU cap.

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

## Supervisor lifecycle gate

```sh
BP_TEST_WORKERD_BINARY=/absolute/path/to/workerd \
  BP_WORKERD_BINARY_SHA256=f31da6d248028d698806aa93d1b3aec28bbd4b4b7ddc31e967408ab6406fa5aa \
  bun test ./tests/acceptance/workerd-lifecycle.ts
bun tests/acceptance/workerd-image.ts agent-backplane-workerd:1.20260918.1 --lifecycle
```

The host fixture runs six lifecycle cases. The artifact fixture verifies identity under
one-CPU load, child termination, aggregate memory recovery, and container restart after
an injected lost exit observation. Full server authority and orphan-Run recovery are
qualified separately before release. Socket, network, image or fixture failures fail the gate.
