# agent-backplane

A self-hosted backend for AI agents. Agents get a shared place to store state, pass work through queues, keep files, and run small apps, and every change is attributed to the agent that made it.

Read before changing anything: `CONTEXT.md` (vocabulary, use these words), `docs/DESIGN.md` (the map), `docs/adr/` (decisions and why). A change that contradicts an ADR is declared, never made quietly.

## Ways to hurt yourself

1. **Killing by pattern.** Never `pkill -f`, `pgrep | kill`, or `kill` a PID you found by matching a name, path, or worktree string. Your own agent process has this worktree's path in its argv, and this machine runs several other dev servers at once. Kill only a PID you captured at spawn, or the owner of your port from `ss -H -ltnp` after confirming `/proc/<pid>/cwd` is your worktree.
2. **Writing around the API.** No code path writes to a Workspace schema or the queue ledger except through the server with Run context set. Tests included. This is ADR-0001 and the product's headline.

## Communication

Short, direct, precise, industry standard language. No "not X, but Y", no em-dashes. State the result, then the evidence.

## Commits

- [Conventional Commits](https://conventionalcommits.org): `<type>(scope): <description>`, for example `feat(queue): claim returns a receipt`.
- "Co-Authored-By:" should be set to "Various Models". Do not claim work performed by other models / subagents.

## Documentation

Most code changes need no documentation change. Update `CONTEXT.md` when a term changes meaning, and add an ADR only for a decision that is hard to reverse, surprising, and a real trade-off.

## Plans and scratch

Never commit plans, research notes, or agent scratch. `.scratch/`, `.agents/`, `.devloop/` are gitignored.

## Delegation

Model choice, risk paths, and the brief templates every delegation carries: `docs/agents/model-routing.md`.

## Where code lives

Bun workspaces monorepo. One server process serves the API, SSE, and the built dashboard. Bun is a development and image-build dependency; an installation host needs Docker and Python only.

- `apps/server/` - Elysia server. One directory per primitive: `platform` (pool, request context, quotas, health, leases), `auth` (Better Auth, tenancy, Principals), `runs` (Runs, provenance, audit writing), `sql`, `schema` (Workspace Migrations), `queue` (PGMQ adapter, Deliveries, Receipts, Effects), `tx`, `approvals`, `events` (audit cursor, SSE), `blobs`, `compute`. `main.ts` starts resources, `app.ts` composes the app and exports its type for Eden. Imports start nothing.
- `apps/web/` - Vite+ React dashboard: `screens/`, `components/`, `client/` (Eden, SSE adapter). Built and served by the server.
- `packages/cli/` and `packages/mcp/` - `backplane`/`bp` and the stdio MCP server. `runtime/` is hand-written; `generated/` comes from the OpenAPI contract and is never edited by hand.
- `contracts/openapi/` - the canonical `openapi.json`. `tooling/openapi/` exports it, `tooling/codegen/` generates the CLI and MCP from it.
- `db/internal/` - Drizzle table catalog for the backplane's own tables only. `db/migrations/` - ordered, forward-only SQL for the protected `control`, `queue`, `audit` schemas. Workspace schemas never enter Drizzle; their Migrations live in the database ledger with a git projection under `$BP_DATA_DIR`.
- `infra/` - `compose/` (the server image and Caddyfile), `postgres/` (pins), `init/` (fresh-install SQL such as PGMQ), `observability/`, `backup/`, `bootstrap/README.md` (installation and recovery).
- `scripts/bootstrap.py` - the host bootstrap: Python 3.11 standard library, no Bun. Root `compose*.yaml` hold every service and profile; `compose.enroll.yaml` runs the first-User enrollment inside the server image. Tests in `tests/test_bootstrap*.py` use a fake runner and never call Docker.
- `skills/backplane/` - the versioned SKILL.md that teaches agents the CLI, with executable examples.
- `tests/acceptance/` and `tests/adversarial/` - cross-primitive scenarios against a real Postgres. Unit tests sit beside their module as `<name>.test.ts`.

Conventions: kebab-case files, one concept per file, no barrels, sibling test per production module. Routes are `/api/v1/workspaces/:workspaceId/<primitive>`. Roles are `bp_server` (login), `bp_executor` and `bp_p_<workspace>_<principal>` (NOLOGIN). Env vars are `BP_*`.

Orchestrator-only files: root manifests and lockfile, tsconfig, `apps/server/{main,app,openapi-plugin}.ts`, `apps/web/routes.tsx`, `db/**`, `infra/compose/**`, `infra/init/**`, CI, and every `generated/` tree. A slice that needs a change there proposes the exact diff in its report.

Adding a primitive: create `apps/server/<primitive>/` with pure modules plus adapters, add `<verb>-route.ts` and `<verb>-input.ts` with a stable operation id, propose the `db/internal` catalog entry and `db/migrations` file, get registered in `app.ts`, then run `bun tooling/openapi/export.ts` and `bun tooling/codegen/generate.ts`.

## Taste

- Complexity belongs at the adapter boundary. Core logic is pure, the API layer is thin, the dashboard is dumb.
- Inferred types over annotations. `any` is the enemy.
- Comments describe how a thing is used and move when the code moves. Do not narrate behavior line by line.
- Users drive agents all day and notice a dropped frame, a lying spinner, and a stale label. No continuously repainting animations.
- If a rule here fights the task in front of you, say so and get a human sign-off before breaking it.
