---
status: accepted
date: 2026-09-14
---
# One server binary, upstream images, compose profiles

The backplane is a modular monolith: one Bun and Elysia process that serves the API, the dashboard and the event stream. Everything else is an unmodified upstream image: PostgreSQL 18 with PGMQ, an S3 store for the blobs profile, workerd for the compute profile, Grafana Alloy and LGTM for the observability profile. The core profile (Postgres, server, dashboard) must come up with one command. Blobs, compute and observability are off by default.

Why: for a single-operator box, a five-service compose file is the embarrassing choice. The system is event-driven where it matters because the audit log is the event backbone and Postgres is the broker.

Consequence: v1 supports one active application node. Durable state lives only in Postgres, background workers are fenced with database leases, and rolling upgrades and active-active are explicitly deferred.

Amended 2026-09-14: Blob bytes are durable state outside Postgres. Filesystem blobs ship with core; S3 is an explicitly selected backend. Backups must cover both Postgres and blob storage. Backend switches are explicit migrations, never automatic fallback.

S33, 2026-09-14: By explicit user decision, RustFS 1.0.0-rc.6 replaces MinIO as the default optional S3 overlay while still a release candidate, superseding DESIGN.md’s GA prerequisite. Filesystem remains core’s default. Accept prerelease compatibility risk with validated digest pins and three real-backend acceptance scenarios. Root credentials remain confined to RustFS and isolated bootstrap. Buckets must never have versioning enabled. Backend changes require fresh storage and explicit object migration; coordinated PostgreSQL/blob backup obligations remain.

Amended 2026-09-17: RustFS 1.0.0 replaces the release candidate at `rustfs/rustfs:1.0.0@sha256:8cc9801755448b71a786705ce76692c77e14936cccd87cf2fc31842e58f4d1ff`. The accepted storage, credential, versioning, migration, and backup constraints remain unchanged.
