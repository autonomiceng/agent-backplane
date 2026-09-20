---
status: accepted
date: 2026-09-14
---
# One server binary, upstream images, compose profiles

The backplane is a modular monolith: one Bun and Elysia process that serves the API, the dashboard and the event stream. Everything else is an unmodified upstream image: PostgreSQL 18 with PGMQ, an S3 store for the blobs profile, workerd for the compute profile, Grafana Alloy and LGTM for the observability profile. The core profile (Postgres, server, dashboard) must come up with one command. Blobs, compute and observability are off by default.

Why: for a single-operator box, a five-service compose file is the embarrassing choice. The system is event-driven where it matters because the audit log is the event backbone and Postgres is the broker.

Consequence: v1 supports one active application node. Control-plane state lives in Postgres; durable blob bytes live in the selected filesystem or S3 backend. Backups coordinate Postgres and blob storage. Background workers are fenced with database leases, and rolling upgrades and active-active are explicitly deferred.

Amended 2026-09-14: Blob bytes are durable state outside Postgres. Filesystem blobs ship with core; S3 is an explicitly selected backend. Backups must cover both Postgres and blob storage. Backend switches are explicit migrations, never automatic fallback.

S33, 2026-09-14: By explicit user decision, RustFS 1.0.0-rc.6 replaces MinIO as the default optional S3 overlay while still a release candidate, superseding DESIGN.md’s GA prerequisite. Filesystem remains core’s default. Accept prerelease compatibility risk with validated digest pins and three real-backend acceptance scenarios. Root credentials remain confined to RustFS and isolated bootstrap. Buckets must never have versioning enabled. Backend changes require fresh storage and explicit object migration; coordinated PostgreSQL/blob backup obligations remain.

Amended 2026-09-17: RustFS 1.0.0 replaces the release candidate at `rustfs/rustfs:1.0.0@sha256:8cc9801755448b71a786705ce76692c77e14936cccd87cf2fc31842e58f4d1ff`. The accepted storage, credential, versioning, migration, and backup constraints remain unchanged.

Amended 2026-09-20: Complete image references may be selected through `BP_*_IMAGE`
for operator experiments. Shipped defaults remain digest-pinned; an override is not
a qualified release. Stateful compatibility and the three real RustFS acceptance
scenarios remain release obligations. Checkpoints require verified reproducible image
content and may refuse local-only upstream images before fencing.

Amended 2026-09-20: Backplane may package an unmodified official Cloudflare workerd binary
in a minimal project-owned container because no maintained official workerd OCI image
has been verified. Pin and verify the binary archive, extracted binary and runtime base;
preserve the upstream license and source identity. This is a narrow exception to the
upstream-image policy, not permission to modify the runtime or claim stronger isolation.
The artifact must pass real runtime qualification before becoming a supported default.
Local image content IDs and registry manifest digests remain distinct identities.

Amended 2026-09-20: ADR-0018 defines measured Runtime Identity, separate image artifact
evidence and control-surface compatibility. Workerd requires an explicit full image
reference until F-GATE, publication and B-DEFAULT approval; a local config ID is not a
registry pin or a supported default.


Amended 2026-09-20 (local artifact delivery): This supersedes the publication prerequisite
above. After H-PROOF/F-GATE and B-DEFAULT approval, the shipped checksum-pinned recipe
is the supported local-build delivery method for amd64; registry publication is optional.
Missing or blank `BP_WORKERD_IMAGE` builds that recipe. Explicit overrides remain
operator-selected local artifacts and must pass executable verification without being
built over or implicitly pulled. This trades registry release infrastructure for build
network access and a compatible Docker/BuildKit toolchain on the installation host.
No registry release or arm64 qualification is claimed. Arm64 recipe inputs alone cannot
promote an arm64 default. Fresh minimal selection and the trusted operator/enrolled-agent
boundary remain unchanged; this preparatory change does not satisfy either runtime gate.

Amended 2026-09-20 (B-PROMOTE preparation, pending H-PROOF): This supersedes the fresh
minimal selection policy above. Fresh bootstrap defaults to full mode with RustFS-backed
Files and Functions; explicit `--mode minimal` retains core plus filesystem Files and no
workerd. Full costs additional memory and local build/network prerequisites in exchange
for both capabilities being available from initial preparation. Ingress remains separately
selected through edge/gateway. Native Compose reuses the saved project, ordered files
and profiles without a wrapper. Complete existing selections remain authoritative;
no-mode reruns preserve them, and explicit modes must agree or refuse with an upgrade/
migration diagnostic. Incomplete installations retain the explicit original-selection
confirmation contract. Storage and secrets never migrate silently. Root must confirm
actual host consoles/runtime and the existing gates before any qualified release claim.
