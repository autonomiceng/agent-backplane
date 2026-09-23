# agent-backplane

A shared backend your AI agents plug into: typed state, queues, files, approvals and an audit trail that names the agent behind every change. Self-hosted, one Docker Compose file.

[![CI](https://img.shields.io/github/actions/workflow/status/autonomiceng/agent-backplane/ci.yml?label=CI)](https://github.com/autonomiceng/agent-backplane/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Bun 1.4](https://img.shields.io/badge/Bun-1.4-black)](https://github.com/oven-sh/bun)
[![PostgreSQL 18](https://img.shields.io/badge/PostgreSQL-18-4169E1)](https://github.com/postgres/postgres)

## What it is

You run several agents in Claude Code, Codex or your own harness. Each keeps its state in files on whatever disk it has, so the others cannot see it and nobody can say who changed what. The backplane gives a group of agents one Workspace with a Postgres schema, queues, blobs and an approvals inbox, and gives each agent its own key.

Every row, message, file and schema change records the agent and the run that made it. Queues hand out expiring receipts, so a worker that died cannot acknowledge work a new worker picked up. A human can gate risky actions before they happen.

It runs on one machine as one Bun process in front of PostgreSQL 18. A CLI and a stdio MCP server are generated from the API, so agents can use it from any harness.

## Quick start

You need Docker with the Compose plugin, Bun 1.4 for preparation and the `bp` CLI, and a Linux host with journald. Compose pulls published, digest-pinned images; nothing is built on the host. Other Docker hosts need an [operator logging override](docs/operations/logging.md). [mise](https://mise.jdx.dev) installs the pinned tools: `mise install`.

```sh
git clone https://github.com/autonomiceng/agent-backplane.git
cd agent-backplane
mise install
eval "$(mise activate bash)"
bun install
mkdir -p "$HOME/.local/bin" && ln -sf "$PWD/packages/cli/runtime/main.ts" "$HOME/.local/bin/bp"
```

Prepare a backup mount (any directory works for a first look; production wants an encrypted, off-host one), then:

```sh
bun infra/bootstrap/prepare.ts --public-url http://localhost:3000 \
  --backup-dir /mnt/backplane-backups --capability-file "$HOME/.bp-enrollment"
bp bootstrap --url http://localhost:3000 --email you@example.com \
  --capability-file "$HOME/.bp-enrollment"
```

The first command writes `.env`, creates the `platform` network with the shared allocation (`BP_PLATFORM_SUBNET=172.30.0.0/24`, `BP_PLATFORM_IP_RANGE=172.30.0.128/25`, see [access setup](docs/operations/ingress.md)), starts Postgres and the server and waits for them. The second enrolls you as the first user and creates a Workspace and a Principal. Paste the printed `mcpServers.backplane` block into your agent's `.mcp.json`, and open `http://localhost:3000/dashboard`.

Optional profiles add S3 blob storage on RustFS, a workerd sandbox for small functions, and a standalone edge. Choose local HTTP and self-signed HTTPS, trusted HTTPS for your own domain, or access behind another gateway in [access setup](docs/operations/ingress.md). See [bootstrap and recovery](infra/bootstrap/README.md).

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
| RustFS, workerd, Caddy | optional profiles |

Each push to `main` and each `vX.Y.Z` release tag publishes `ghcr.io/autonomiceng/agent-backplane-server` (amd64, arm64) and `ghcr.io/autonomiceng/agent-backplane-workerd` (amd64). Compose uses them by default. See [published images](docs/operations/upgrade.md).

Every shipped image default, including the server and workerd, is pinned as `tag@sha256`. Complete image references in `.env` select unvalidated experiments; see [preparation](infra/bootstrap/README.md). Terms are in [CONTEXT.md](CONTEXT.md); guarantees in the [design](docs/DESIGN.md).

## Built on

| Project | Stars | What we use it for |
| --- | --- | --- |
| [Bun](https://github.com/oven-sh/bun) | ![stars](https://img.shields.io/github/stars/oven-sh/bun?style=flat) | Runtime, package manager, test runner |
| [Elysia](https://github.com/elysiajs/elysia) | ![stars](https://img.shields.io/github/stars/elysiajs/elysia?style=flat) | HTTP routes, OpenAPI, typed client |
| [PostgreSQL](https://github.com/postgres/postgres) | ![stars](https://img.shields.io/github/stars/postgres/postgres?style=flat) | State, transactions, audit |
| [PGMQ](https://github.com/pgmq/pgmq) | ![stars](https://img.shields.io/github/stars/pgmq/pgmq?style=flat) | Queue storage under the delivery ledger |
| [Better Auth](https://github.com/better-auth/better-auth) | ![stars](https://img.shields.io/github/stars/better-auth/better-auth?style=flat) | Human login and organizations |
| [Drizzle ORM](https://github.com/drizzle-team/drizzle-orm) | ![stars](https://img.shields.io/github/stars/drizzle-team/drizzle-orm?style=flat) | Catalog for internal tables |
| [libpg_query](https://github.com/pganalyze/libpg_query) | ![stars](https://img.shields.io/github/stars/pganalyze/libpg_query?style=flat) | SQL validation with the real parser |
| [embedded-postgres](https://github.com/leinelissen/embedded-postgres) | ![stars](https://img.shields.io/github/stars/leinelissen/embedded-postgres?style=flat) | Real Postgres in tests |
| [React](https://github.com/facebook/react) and [Vite](https://github.com/vitejs/vite) | ![stars](https://img.shields.io/github/stars/vitejs/vite?style=flat) | The dashboard |
| [RustFS](https://github.com/rustfs/rustfs) | ![stars](https://img.shields.io/github/stars/rustfs/rustfs?style=flat) | Optional S3 blob storage |
| [workerd](https://github.com/cloudflare/workerd) | ![stars](https://img.shields.io/github/stars/cloudflare/workerd?style=flat) | Optional function sandbox |
| [Caddy](https://github.com/caddyserver/caddy) | ![stars](https://img.shields.io/github/stars/caddyserver/caddy?style=flat) | Optional HTTPS edge |
| [Docker Compose](https://github.com/docker/compose) | ![stars](https://img.shields.io/github/stars/docker/compose?style=flat) | Running it all |

## The other stacks

This is one of four repos that deploy the same way and work together on one host:

- [llm-gateway-stack](https://github.com/autonomiceng/llm-gateway-stack): one URL and one key per agent for every model, with a trace per call.
- [observability-stack](https://github.com/autonomiceng/observability-stack): Grafana, Loki, Tempo and Mimir. Can collect this stack's journal logs, and its metrics when you set an operations token. Collection is optional; see [logging](docs/operations/logging.md).
- [platform-edge](https://github.com/autonomiceng/platform-edge): one Caddy for ports 80 and 443 when more than one stack shares a host.

Each runs alone. Shared conventions live in [docs/conventions.md](docs/conventions.md), vendored from platform-edge.

## Day two

- [Agent client setup](skills/backplane/references/client-setup.md)
- [Browser URLs and HTTPS](docs/operations/ingress.md)
- [Backup, restore and the drill](infra/backup/README.md)
- [Bootstrap and recovery](infra/bootstrap/README.md)
- [Design](docs/DESIGN.md), [vocabulary](CONTEXT.md), [decisions](docs/adr/)

## Development

```sh
bun run check   # typecheck, lint, generated-contract drift, dashboard build
bun run test    # tests against a real embedded Postgres
docker compose --env-file .env config -q  # after prepare creates .env
docker compose --env-file .env -f compose.yaml -f compose.dev.yaml build  # server image from this checkout
```

List the development overlay last; `-f compose.yaml -f compose.compute.yaml -f compose.dev.yaml --profile compute build` also builds workerd. Preparation launches the saved Compose files, so set `BP_SERVER_IMAGE=agent-backplane-server:local` (and `BP_WORKERD_IMAGE=agent-backplane-workerd:local`) in `.env` to run those builds.

For host development, pass the cluster-owner URL only to migration:
`BP_ADMIN_DATABASE_URL=postgres://postgres:YOUR_PASSWORD@localhost:5432/backplane bun run migrate`.
Set `BP_DATABASE_URL` to the separate `bp_server` login before `bun run dev`.

CI runs both Bun gates and builds the server image on every push and pull request. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

Report vulnerabilities privately through the [security policy](SECURITY.md). The server and Postgres bind to loopback by default.

## License

[MIT](LICENSE). Copyright (c) 2026 Ilya Kravchenko (Autonomic Engineering).
