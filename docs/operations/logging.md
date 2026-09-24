# Runtime logs

Every Compose service, including initialization jobs and optional overlays, sends stdout/stderr to Docker's `journald` driver with `cache-disabled: "true"`. This requires a Linux Docker host with systemd-journald available. Docker's secondary local file cache is disabled; runtime logs live in the host journal. See Docker's [journald driver](https://docs.docker.com/engine/logging/drivers/journald/) and [cache options](https://docs.docker.com/engine/logging/dual-logging/). Applications do not continuously write runtime log files.

The server and workerd use stdout/stderr. PostgreSQL explicitly disables its logging collector and selects stderr. Caddy emits JSON access logs on stdout and runtime diagnostics on stderr. It removes headers and query strings from request logs; never put credentials in URL paths. RustFS overrides the [pinned image's `/logs` default](https://raw.githubusercontent.com/rustfs/rustfs/1.0.0/Dockerfile) with an empty `RUSTFS_OBS_LOG_DIRECTORY` and enables stdout. The logging anchor is repeated in the core, blobs, compute and edge files because YAML anchors do not cross Compose files. Development overrides inherit core logging.

Inspect logs with `docker compose logs` or the host's `journalctl` filters such as `journalctl CONTAINER_NAME=agent-backplane-server-1`. Journal retention and persistence are operator policy. Installation does not edit the host journal or Docker daemon configuration.

Log collection is optional. Core and every overlay start without Alloy, Loki, or another collector. The observability stack automatically discovers Docker containers and reads their journal-backed output through Docker’s API, using Alloy’s `loki.source.docker`. No journal mount or additional application logging endpoint is required. Loki's product data, PostgreSQL WAL, Audit Events, and protected one-off backup/restore diagnostics keep their existing storage and retention rules. Backup volumes and formats remain unchanged.

## Other Docker hosts

Docker Desktop, a host without journald, or a different logging policy needs an operator-owned Compose override. Replace the complete logging mapping for **each enabled service**, including initialization jobs. For example, this portable bounded-file override for the server uses Compose's `!override` tag to remove the journald-only option:

```yaml
services:
  server:
    logging: !override
      driver: local
      options:
        max-size: "10m"
        max-file: "3"
```

Apply the same mapping to `postgres`, `migrate`, `storage-init`, and enabled `edge`, `rustfs`, `blob-bootstrap`, and `workerd` services. Pass that file last to Docker Compose and inspect `docker compose config` before starting it. The portable override intentionally restores Docker-managed files and is an operator choice. It requires a Compose version that supports [`!override`](https://docs.docker.com/reference/compose-file/merge/#replace-value).
