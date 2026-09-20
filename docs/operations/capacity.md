# Host capacity

The Compose limits are conservative starting points for a 16 GB single-operator host. They are not measurements or guarantees. Revisit them after observing the deployment's workload, database cache behavior, and container memory pressure.

| Service | Memory limit | Reservation | Reasoning |
| --- | ---: | ---: | --- |
| PostgreSQL | 4 GB | 1 GB | Leaves room for the database cache and maintenance work without allowing one datastore to consume the host. |
| Server | 2 GB | 512 MB | Covers the Bun API, dashboard, migrations, and bounded request concurrency. |
| RustFS | 2 GB | 1 GB | Allows buffering and concurrent object transfers when the blobs overlay is enabled. |
| workerd | 512 MB | 128 MB | Matches the existing experimental sandbox bound and limits untrusted function impact. |
| Caddy | 256 MB | 64 MB | Covers TLS and reverse-proxy traffic for a single-node deployment. |

All optional overlays total 8.75 GB of hard limits and 2.7 GB of reservations. The remaining memory is available to Docker, the kernel, filesystem cache, one-shot initialization jobs, and short bursts. PostgreSQL also has a 256 PID limit; the other services have narrow process models and memory limits that bound their primary failure mode.

Every long-lived service restarts unless an operator stops it. All services use Docker journald logging with its file cache disabled; see [logging](logging.md) for host requirements and portability overrides. PostgreSQL, the server, RustFS, and Caddy have healthchecks. Workerd has no Compose healthcheck because its image is an immutable runtime-only image and its HTTP surface exposes only authenticated `POST /prepare` and `POST /invoke`; there is no read-only health path to probe. Adding an unauthenticated runtime health endpoint requires an application change and runtime-image validation.
