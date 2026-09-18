# agent-backplane

A self-hosted backend for AI agents.

This stage provides the protected database and migrations, enrollment, human and
Principal credentials, Workspaces, Runs, admission, health and operations endpoints.
Queue, SQL, blob and dashboard capabilities follow in later pull requests.

Use Bun 1.4.2, pinned in `mise.toml`:

```sh
bun install --frozen-lockfile
bun run check
bun run test
```

Tests start a disposable embedded PostgreSQL cluster. Development requires a
migrated database; `bun run dev:cluster` starts a disposable local database and
prints its connection settings. Configure the server environment as described in
[the design](docs/DESIGN.md), then run `bun run dev`.

The [ADRs](docs/adr/) describe the complete target architecture. Deployment
packaging follows after the API and clients. PGMQ’s license accompanies its SQL.
