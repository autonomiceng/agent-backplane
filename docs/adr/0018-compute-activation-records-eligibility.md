---
status: proposed
date: 2026-09-14
---
# Compute activation records eligibility

Compute activation records eligibility after isolated preparation. Workerd's experimental Worker Loader materializes disposable isolates on demand; committed Postgres deployments remain authoritative. No runtime residency guarantee or server actor is introduced.

Preparation may succeed before a transaction rolls back. Prepared isolates have no invocation ingress, and invocation must authorize against committed active deployments on every request. Isolates are disposable caches and may disappear after eviction or restart.

Workerd is not a hardened sandbox. The two-second preparation deadline bounds server occupancy, without guaranteeing termination of an initializer. Container resource limits constrain damage; hostile code needs stronger isolation beyond this experimental profile.

Amended 2026-09-20: Runtime Identity is the measured workerd executable, recorded as
`workerd-binary-sha256:<sha256>` in `runtimeDigest` and the immutable deployment
configuration hash. It excludes the image, base, CA bundle, architecture and loader.
This permits full image overrides without attributing a different executable to an
unrelated configured registry digest. Historical bare digests retain their original
meaning and remain readable; activation and invocation refuse them until a new
Deployment is registered and activated through the API. History is never rewritten.

The trusted entrypoint separately measures `loader.js`, `config.capnp` and `start.sh`.
The server compares that control-surface hash with its checkout on private identity
verification. Changed control files require a workerd restart, without a new deployment
when the binary is unchanged. Verification is bounded per compute operation; an
unavailable runtime does not prevent the core listener from starting. The verified
binary/control/artifact observation accompanies each authenticated prepare/invoke
request; the loader compares it with its own measurements and declarations before
loading code. A changed observation refuses that request without another identity
round trip. This comparison is not a signature or a unique runtime-instance identity.
The immutable configuration hash still excludes control and artifact facts.

Control URLs require HTTPS except for the trusted Compose authority
`http://workerd:8080` and explicit loopback HTTP (localhost, IPv4 127/8, IPv6 ::1).
Other cleartext endpoints, URL credentials, queries and fragments are refused before
sending the control token. Path prefixes remain supported; redirects are never followed.
Invocation relays function 3xx responses as ordinary results.

Image facts are distinct host-declared artifact evidence. Bootstrap privately records
the selected reference, resolved local image config ID, binary hash, architecture and
observation time as a launch decision. The private control endpoint carries the
selected reference and an optional host-observed image ID into deploy, activate and
invoke Audit Events. Those facts are Workspace-readable audit evidence, absent from
public status and deployment responses. Host launch records are operator-owned and
never automatically pruned. Valid evidence does not change eligibility or `configHash`;
malformed evidence is refused. Principal and Run authority are unchanged. No container
claims to measure its own image ID, and no Docker socket is exposed.

An explicit Compose deployment may resolve a moving tag again. Bootstrap's effective
image override lives only in its child environment, and bootstrap refuses persisted
overrides. Bare Compose cannot enforce this restriction; its operator owns the accuracy
of the selected reference and declarations. The evidence record never selects
future images. Direct Compose reports a null image ID unless the trusted operator
supplies a declaration. Use an immutable reference for repeatability. There is no
shipped image default until runtime qualification, publication and B-DEFAULT approval.
The known amd64 binary hash alone does not qualify another architecture or image.


Amended runtime lifecycle, pending artifact qualification: the authenticated Bun
supervisor runs as PID 1 and creates a disposable workerd process per prepare/invoke.
One operation slot and a separate singleflight identity probe bound process count.
Identity includes an actual loader round trip. Deadlines kill and reap captured children;
successful responses are released only after exit, ending background work. Reap failure
exits the parent for container restart. This supersedes the initializer-termination
limitation above for the supervisor protocol once qualified; standalone workerd limits
still do not establish CPU termination. The control hash includes `supervisor.ts` and
`child-process.ts` in addition to the original three files. Artifact identity remains
host-declared, and the new Bun packaging and resource gates remain release requirements.

Expired or missing-token invocation Runs without terminal events are repaired through
the existing `finishInvocation` definer by bounded startup, periodic and opportunistic
server passes outside bound transactions. Ordinary Runs and live tokens are excluded.
Recovery records `function.fail`; its `durationMs` is observed wall time from Run creation
to reconciliation capped at int32, not CPU time or exact execution duration. SQL credential
expiry and Principal/Workspace authority are unchanged. The terminal record alone is
not evidence of runtime child exit.
