# agent-backplane

A self-hosted backend for AI agents.

This stage contains the protected database schema, ordered migrations, PGMQ
initialization SQL and migration verification tests. API capabilities follow in
subsequent pull requests. This stage does not start an application listener.

Use Bun 1.4.2, pinned in `mise.toml`:

```sh
bun install --frozen-lockfile
bun run check
bun run test
```

Tests start a disposable embedded PostgreSQL cluster. Apply migrations to an
explicitly selected database with `BP_ADMIN_DATABASE_URL` and `bun run migrate`.
Read the [design](docs/DESIGN.md) and [decisions](docs/adr/) for the complete target
architecture. PGMQ’s [license](infra/init/core/PGMQ-LICENSE) accompanies its SQL.
