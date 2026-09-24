# agent-backplane

A shared backend your AI agents plug into: typed state, queues, files, approvals and an audit trail that names the agent behind every change. Self-hosted with Docker Compose: six Compose files, `compose.yaml` for core and five overlays.

[![CI](https://img.shields.io/github/actions/workflow/status/autonomiceng/agent-backplane/ci.yml?label=CI)](https://github.com/autonomiceng/agent-backplane/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Bun 1.4](https://img.shields.io/badge/Bun-1.4-black)](https://github.com/oven-sh/bun)
[![PostgreSQL 18](https://img.shields.io/badge/PostgreSQL-18-4169E1)](https://github.com/postgres/postgres)

- [What it is](#what-it-is)
- [Quick start](#quick-start)
- [Access modes](#access-modes)
- [What's inside](#whats-inside)
- [Upgrade](#upgrade)
- [Day two](#day-two)
- [The other stacks](#the-other-stacks)
- [Development](#development)
- [Security](#security)
- [License](#license)

## What it is

You run several agents in Claude Code, Codex or your own harness. Each keeps its state in files on whatever disk it has, so the others cannot see it and nobody can say who changed what. The backplane gives a group of agents one Workspace with a Postgres schema, queues, blobs and an approvals inbox, and gives each agent its own key.

Every row, message, file and schema change records the agent and the run that made it. Queues hand out expiring receipts, so a worker that died cannot acknowledge work a new worker picked up. A human can gate risky actions before they happen.

It runs on one machine as one Bun process in front of PostgreSQL 18. A CLI and a stdio MCP server are generated from the API, so agents can use it from any harness.

## Quick start

You need Docker with the Compose plugin, Python 3.11 and a Linux host with journald. Compose pulls published, digest-pinned images and the first user enrolls through the CLI inside the server image, so nothing is built on the host and Bun is not installed on it. Other Docker hosts need an [operator logging override](docs/operations/logging.md).

```sh
git clone https://github.com/autonomiceng/agent-backplane.git && cd agent-backplane
python3 scripts/bootstrap.py --capability-file "$HOME/.bp-enrollment"
# then run the `next` command bootstrap printed, for example:
BP_SERVER_IMAGE=<the server image> docker compose -f compose.yaml -f compose.enroll.yaml run --rm --user "$(id -u):$(id -g)" \
  -v "$HOME/.bp-enrollment:/tmp/capability:ro" -v "$HOME/.local/state/backplane:$HOME/.local/state/backplane" \
  -e BP_DATA_DIR="$HOME/.local/state/backplane" enroll --url http://localhost:3000 --email you@example.com
```

Backups land in `./backups` beside `.env` until you pass `--backup-dir` with an encrypted, off-host mount. The first command writes `.env`, creates the `platform` network with the shared allocation (`BP_PLATFORM_SUBNET=172.30.0.0/24`, `BP_PLATFORM_IP_RANGE=172.30.0.128/25`), starts Postgres and the server, waits for them and prints the enrollment command. The second enrolls you as the first user and creates a Workspace and a Principal. Paste the printed `mcpServers.backplane` block into your agent's `.mcp.json`, and open `http://localhost:3000/dashboard`. Agent machines run the `bp` CLI from a Bun install of this checkout (`bun install`, then link `packages/cli/runtime/main.ts` as `bp`) or the compiled artifact; see [agent client setup](skills/backplane/references/client-setup.md).

A fresh install is minimal. `--profile blobs` adds S3 blob storage on RustFS, `--profile compute` a workerd sandbox for small functions, and `--profile edge` a standalone Caddy. See [bootstrap and enrollment](infra/bootstrap/README.md).

## Access modes

`BP_ACCESS_MODE` (or `--access-mode`) selects how the server is reached. Details and every setting are in [access setup](docs/operations/ingress.md).

| You want | Settings | Read |
| --- | --- | --- |
| Localhost only (default) | `local`; core serves HTTP on `127.0.0.1:3000`, `--profile edge` adds HTTP on 80 and self-signed HTTPS on 443 | [Local Mode](docs/operations/ingress.md#local-mode-default) |
| Private access from your devices over Tailscale | Behind Platform Edge: its `bootstrap.py --tailscale --with backplane`. Standalone: `--access-mode proxy --public-url https://<machine>.<tailnet>.ts.net:<port>` plus host `tailscale serve` | [Tailscale](docs/operations/ingress.md#tailscale) |
| Public hostname with Let's Encrypt | `public`, `BP_PUBLIC_DOMAIN`, `BP_BIND_HOST=0.0.0.0`, `--profile edge` | [Public Mode](docs/operations/ingress.md#public-mode) |
| Corporate CA or certificate files | Not offered by the standalone edge; put the server behind Platform Edge, which has `PE_TLS_ISSUER` | [Behind Platform Edge](docs/operations/ingress.md#behind-platform-edge) |
| Behind Platform Edge on a shared host | `proxy` with `BP_PUBLIC_URL`; Edge's bundle installer passes both | [Behind Platform Edge](docs/operations/ingress.md#behind-platform-edge) |

## What's inside

| Piece | Job |
| --- | --- |
| Workspaces | Isolate schemas, queues and audit history. Humans create them. |
| Principals and keys | One named identity and revocable key per agent per Workspace. |
| SQL and Migrations | Query shared tables; apply forward-only schema changes through the API. |
| Queues and Receipts | Hand off Messages with expiring claims, retries and atomic completion. |
| Effects and Reconciliation | A stable key for an outside action, and a record when its outcome is uncertain. |
| Approvals | A human decides before a gated action proceeds. |
| Audit stream | Ordered, attributed events over server-sent events. |
| Blobs | Workspace files with provenance, on disk or in S3. |

| Service | Data |
| --- | --- |
| PostgreSQL 18 with PGMQ | volume, WAL archived to your backup mount |
| Server (API, dashboard, audit stream) | volume for enrollment and migration projections |
| RustFS, workerd, Caddy | optional profiles `blobs`, `compute`, `edge` |

Each push to `main` and each `vX.Y.Z` release tag publishes `ghcr.io/autonomiceng/agent-backplane-server` (amd64, arm64) and `ghcr.io/autonomiceng/agent-backplane-workerd` (amd64). Compose uses them by default, pinned as `tag@sha256`, and the server reports the configured references publicly at `/status.json` ([health](docs/operations/health.md#public-status)). Complete image references in `.env` select unvalidated experiments; see [bootstrap](infra/bootstrap/README.md). Terms are in [CONTEXT.md](CONTEXT.md); guarantees in the [design](docs/DESIGN.md).

## Upgrade

```sh
scripts/backup.sh --fenced --env-file .env   # the rollback boundary
git pull
docker compose pull
python3 scripts/bootstrap.py
```

`git pull` brings new pins ([published images](docs/operations/upgrade.md) explains the tags); `docker compose pull` fetches them; bootstrap reuses the recorded selection, recreates what changed and waits for readiness. When the release notes name a migration that takes exclusive locks, stop the server first as [health](docs/operations/health.md#scheduled-retention) describes. An installation that ran the version 1 status timer retires it once with `scripts/retire-status-timer.sh` ([public status](docs/operations/health.md#public-status)); one that ran the internal gateway behind Edge follows [upgrading from the internal gateway](docs/operations/ingress.md#upgrading-from-the-internal-gateway).

## Day two

- [Agent client setup](skills/backplane/references/client-setup.md)
- [Access setup: modes, browser origin, certificates](docs/operations/ingress.md)
- [Operational health, metrics and public status](docs/operations/health.md)
- [Backup, restore and the drill](infra/backup/README.md)
- [Bootstrap and enrollment](infra/bootstrap/README.md)
- [Published images and pins](docs/operations/upgrade.md)
- [Runtime logs](docs/operations/logging.md), [host capacity](docs/operations/capacity.md)
- [Design](docs/DESIGN.md), [vocabulary](CONTEXT.md), [decisions](docs/adr/)

## The other stacks

This is one of four repos that deploy the same way and work together on one host:

- [llm-gateway-stack](https://github.com/autonomiceng/llm-gateway-stack): one URL and one key per agent for every model, with a trace per call.
- [observability-stack](https://github.com/autonomiceng/observability-stack): Grafana, Loki, Tempo and Mimir. Collects this stack's journal logs, and its metrics when you set an operations token; see [logging](docs/operations/logging.md).
- [platform-edge](https://github.com/autonomiceng/platform-edge): one Caddy for ports 80 and 443 when more than one stack shares a host.

Each runs alone. Shared conventions live in [docs/conventions.md](docs/conventions.md), vendored from platform-edge.

## Development

```sh
bun run check   # typecheck, lint, generated-contract drift, conventions, dashboard build
bun run test    # tests against a real embedded Postgres
bun run test:examples  # examples/, outside the default suite
python3 -m unittest discover -s tests -p 'test_bootstrap*.py'  # bootstrap, fake runner
docker compose --env-file .env config -q  # after bootstrap creates .env
docker compose --env-file .env -f compose.yaml -f compose.dev.yaml build  # server image from this checkout
```

List the development overlay last; `-f compose.yaml -f compose.compute.yaml -f compose.dev.yaml --profile compute build` also builds workerd. `python3 scripts/bootstrap.py --build` on a fresh install records `compose.dev.yaml` in `COMPOSE_FILE` and builds both images from the checkout.

For host development, pass the cluster-owner URL only to migration:
`BP_ADMIN_DATABASE_URL=postgres://postgres:YOUR_PASSWORD@localhost:5432/backplane bun run migrate`.
Set `BP_DATABASE_URL` to the separate `bp_server` login before `bun run dev`.

CI runs both Bun gates, the bootstrap unit tests and a bootstrap dry run, the storage acceptance scripts, both image builds with the workerd gates, and both backup drills on every push and pull request. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

Report vulnerabilities privately through the [security policy](SECURITY.md). The server and Postgres bind to loopback by default.

## License

[MIT](LICENSE). Copyright (c) 2026 Ilya Kravchenko (Autonomic Engineering).
