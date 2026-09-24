---
status: accepted
date: 2026-09-14
---
# One server binary, published images, opt-in profiles

The backplane is a modular monolith: one Bun and Elysia process serves the API, the dashboard and the event stream. Everything else runs unmodified from a pinned upstream image: PostgreSQL 18 with PGMQ in core, RustFS for the `blobs` profile and Caddy for the standalone `edge` profile.

A fresh installation is minimal: PostgreSQL, the server and filesystem Files. A full installation opts in to `blobs` (RustFS-backed Files), `compute` (Functions on workerd) and `edge` explicitly. Bootstrap records the selection literally and preserves it on rerun; it never changes the capabilities or the Files backend of an existing installation. S3 Files start on fresh storage, bucket versioning stays off, and RustFS root credentials stay with RustFS and its isolated bootstrap.

Every shipped image default is pinned as `tag@sha256`. `.github/workflows/publish.yml` publishes the server (amd64, arm64) and workerd (amd64) images to GHCR; Compose pins them and bootstrap pulls them, so the host needs Docker and Python, no build toolchain. Only `compose.dev.yaml` builds images. The workerd image is the one project-packaged runtime: an unmodified official Cloudflare workerd binary and the pinned Bun supervisor in a minimal image, because no maintained official workerd image has been verified. Both executables are pinned and verified, and the upstream license and source identity are preserved. `BP_*_IMAGE` settings select complete references for experiments; an override is not a qualified release, and bootstrap never builds over or pulls an explicit workerd override. Checkpoints cover PostgreSQL and blob storage together and require verified, reproducible image content.

Why: for a single-operator box, a five-service Compose file is the embarrassing choice. A minimal default keeps memory and prerequisites low, and published images keep the installation host free of Bun and build tooling. The system is event-driven where it matters because the audit log is the event backbone and Postgres is the broker.

Consequences: one active application node; control-plane state lives in Postgres and blob bytes in the selected backend. Background workers are fenced with database leases; rolling upgrades and active-active are deferred. Each published build needs a pin bump. The workerd default is amd64 only; another architecture needs an explicit binary pin and its own runtime qualification. Workerd is a trusted-code boundary, not a hardened sandbox (ADR-0018).

History: this record replaces its amendments of 2026-09-14 (filesystem Files in core; RustFS release candidate replacing MinIO), 2026-09-17 (RustFS 1.0.0), 2026-09-20 (complete image overrides; project-packaged workerd; Runtime Identity; local-build delivery; full default) and 2026-09-23 (published image delivery; minimal default). The full-mode default and local-build delivery are superseded; the rest is folded in above.
