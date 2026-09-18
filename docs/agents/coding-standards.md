# Coding standards

Slices S01 (`apps/server/platform`, `db/`) and S02 (`apps/server/runs`, `db/migrations/000002_provenance.sql`) are the exemplars. Match them. When this document and that code disagree, the code was reviewed later; say so and fix whichever is wrong.

## Shape of a primitive

- **Decide, then act.** A pure module makes the decision from plain data (`readiness.ts`). An adapter gathers facts or performs effects (`readiness-probe.ts`). A route file wires HTTP to both (`health-route.ts`). Tests hit the pure module for logic and the route against a real Postgres for behavior.
- **Nothing runs at import.** Only `apps/server/main.ts` and `db/migrate-cli.ts` read the environment and open connections. Every other module receives a `Pool`, a `Config`, or plain values.
- **One pool.** Borrow from the injected `Pool`. Never `new SQL(...)` outside `platform/pool.ts`, the migrate CLI, and test helpers.
- **Writes bind context first.** A writing transaction is `withRunContext(pool, context, fn)`; inside it, audit rows come only from the `emit` callback, which carries the per-transaction token. Expected failures inside the transaction are recorded with `recordRejection` after rollback.
- **Errors at the edge become responses.** Adapters catch and translate into the decision type (`unavailable(reason)`); routes set the status. Domain code does not throw for expected conditions.

## Files

- kebab-case, one concept per file, named for the noun or the verb it owns: `claim-route.ts`, `delivery-transition.ts`.
- No barrels, no `index.ts`, no re-export blocks. Import the owning file with its `.ts` extension.
- Every production module has a same-named sibling `.test.ts`. Shared test helpers live in `testing/` next to their consumers.
- Top-of-file comment says what the module is for and who calls it. No comments narrating lines.

## Types

- Inferred over annotated. Annotate exported function signatures and nothing internal that inference already proves.
- `type` aliases for data, `class` only for errors and stateful resources.
- No `any`, no non-null assertions except on a regex match you just tested, no `as` casts outside test files.
- Elysia routes declare `response` schemas and an `operationId`. The OpenAPI document is generated from these; if it is not in the schema it does not exist.

## SQL

- Tagged template queries (`` pool`SELECT ...` ``) for everything with parameters. `unsafe` only for migration files and vendored install scripts.
- Repository migrations: `db/migrations/NNNNNN_name.sql`, forward-only, one transaction each, recorded in `control.schema_version`. Never edit an applied file.
- Workspace schemas are never referenced from repository code except through the Migration endpoint (ADR-0015).

## Tests

- Real Postgres always. `bun run test` starts an embedded PostgreSQL 18 with pgmq; `emptyDatabase()` and `migratedDatabase()` give each test its own database.
- Each test title names the defect it detects. Assert observable outcomes: a status code, a row, a returned value.
- Budget per slice is set in the brief. One scenario asserting several related postconditions beats several near-identical scenarios.
- Requests in tests use `http://localhost/...`; Elysia rejects single-label hosts.
- Bun SQL queries are lazy thenables. `expect(query).rejects` never runs them and hangs the suite; write `expect(query.then()).rejects` or wrap the query in an async function.
- Every writing test transaction goes through `withRunContext`; a bare `pool.begin` is only for proving that unbound writes fail.
- Tests never edit ledger rows through the admin connection, with one exception: expiring a lease (`lease_expires_at`, `next_attempt_at`, and the matching pgmq visibility) so expiry paths run without wall-clock waits. Backoff waits use database time.

## Tooling

- `bun run check` is typecheck plus oxlint; `bun run test` is the suite. Both green before every commit.
- New dependencies need orchestrator approval and an exact version pin in `package.json`.
- Bun uses isolated installs. A package needing postinstall goes in `trustedDependencies`.
