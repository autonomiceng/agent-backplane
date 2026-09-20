# agent-backplane: systems design

A self-hosted backplane your agents attach to: schema-defined shared state, queues, approvals, and a provenance trail for every row they write.

Status: implemented. Decisions with reasons live in `adr/`. Vocabulary lives in `../CONTEXT.md`. This document is the map.

## Why it exists

Agents running in harnesses the operator does not control (Claude Code, Codex, hosted bots such as Grok bot) keep state in JSON files on whatever disk they have. That state is invisible to other agents and humans, easily lost, and unattributable. The industry's answer so far is a nicer disk: shared filesystems and memory blocks. Cloud databases offer per-agent provisioning but not self-hosting, not queues, not approvals, and not an audit of what an agent provisioned and why.

The backplane gives every group of collaborating agents a Workspace with a Postgres schema, queues, blobs, an approvals inbox, and one credential per agent, and records who wrote what and who allowed it.

## Guarantees, stated exactly

- Every row, message, blob and schema change is attributed to a Principal and a Run. The API is the only write path (ADR-0001).
- A message claimed by an agent that dies is safely reclaimed, and the dead agent cannot later acknowledge it (ADR-0005).
- An irreversible outside action is retried only under a stable Effect Key, and uncertainty is recorded rather than guessed away. Exactly-once is never claimed (ADR-0012).
- Approval gates any action the backplane mediates. It cannot gate what an agent does with its own outside credentials (ADR-0007).
- Realtime is a cursor over the audit log, delivered at least once (ADR-0006).

## Shape

```
  Claude Code      Codex        Grok bot (own VM)      Human
      │              │               │                   │
      │  bp CLI / MCP (generated)    │  REST directly    │  Dashboard
      └──────────────┴───────────────┴───────────────────┘
                                │  HTTPS, OpenAPI
                    ┌───────────▼────────────┐
                    │  backplane server      │  one Bun + Elysia process
                    │  ├ auth (Better Auth)  │
                    │  ├ sql   (as Principal)│
                    │  ├ schema (migrations) │
                    │  ├ queue (Delivery     │
                    │  │        ledger)      │
                    │  ├ tx    (bounded)     │
                    │  ├ approvals           │
                    │  ├ events (SSE cursor) │
                    │  ├ blobs  [optional]   │
                    │  └ dashboard (Vite+)   │
                    └───────────┬────────────┘
                                │ one pool, transaction-local role, Run context bound per tx
                    ┌───────────▼────────────┐
                    │  PostgreSQL 18 + PGMQ  │
                    │  protected schemas:    │
                    │   control, queue, audit│
                    │  Workspace schemas:    │
                    │   ws_jobhunt, ws_triage│
                    └────────────────────────┘
        [overlay blobs]  S3 store      [overlay compute]  workerd
        [overlay edge]   Caddy
```

Compose overlays: the base file starts Postgres and the server. The `blobs`, `compute`, and `edge` overlays add optional services with matching Compose profiles (ADR-0009).

## Tenancy and identity

Organization owns Workspaces. A Workspace owns schemas, Queues, Approvals and its audit history. A Principal is an agent identity with one API key per Workspace membership. Users are humans with a login. Humans create Workspaces; agents never do. No cross-Workspace access exists; a Principal may belong to several Workspaces (ADR-0002, ADR-0010).

Each Principal maps to one Postgres role per Workspace with grants only inside that Workspace's schema. Table ownership stays with a protected executor role so an agent can never grant itself anything.

## Provenance

The CLI mints a Run lazily from environment variables on first call and records harness, model and a label when available. Every request carries Principal and Run. The server binds Workspace and actor once per transaction in a protected registry keyed by backend and transaction id, and that bind locks the Workspace's audit cursor until commit (ADR-0017). Audit writers stamp from the registry, so settings and role resets inside the transaction cannot change who is recorded, and no code path can write without a stamp. Rejected requests are recorded outside the transaction so a rollback does not erase the attempt.

Audit Events are metadata envelopes: who, what shape, which objects, how many rows. Parameters and row contents go to a separate expiring store (ADR-0013).

## Schema management

Agents submit imperative SQL Migrations with the schema revision they wrote against (ADR-0004):

1. Reject if the revision is stale (compare-and-swap, serialized per Workspace).
2. Dry-run live inside a rolled-back transaction under strict timeouts.
3. Apply in one transaction as the executor role, forced search_path, deny-by-default statement allowlist. Drops need `--destructive`.
4. Write the migrations row in the same transaction. Mirror to a server-owned git repository for human review.

Concurrent index builds and data backfills are separate paths with progress and limits. No revert; forward-fix or point-in-time restore. `bp push` wraps all of this in one noninteractive command with a plan preview. Declarative desired-state with server-side diff is v1.1.

## Queues and handoffs

PGMQ underneath, never exposed. Agents use verbs: send, claim, renew, ack, nack, hold, inspect, replay, cancel (ADR-0005).

Delivery lifecycle: scheduled, ready, leased, held, ambiguous, succeeded, dead-lettered, cancelled. A claim returns a Receipt bound to Principal, Run, attempt and expiry. Every transition validates the Receipt. Retries, backoff, attempt limits and dead-lettering are server policy. Replay creates a new Delivery linked to the original. Unordered in v1.

Atomic handoff: one bounded transaction endpoint runs row statements plus ack, send, nack or hold together under an idempotency key, with affected-row assertions (ADR-0011).

Irreversible actions: one Effect per Message, an Effect Key that survives retries, a begin-effect transition before acting, an ambiguous state on silent failure, and Reconciliation with evidence (ADR-0012).

## Approvals

A Principal requests an Approval against a row, message or migration. Approvers are Users or delegated Principals. Holding a message removes it from dispatch; approval grants a new claim. Approvals bind to the exact version approved and expire. Self-approval is off by default (ADR-0007). The dashboard's approvals inbox is the screen a human opens daily.

## Realtime

One cursor-based Server-Sent Events stream per Workspace over the audit log. Audit position allocation is serialized per Workspace through commit. Consumers: the dashboard, `bp events --since`, and `bp events --follow`. Expired cursors get a resync response (ADR-0006).

## Agent surfaces

REST with OpenAPI is canonical. The CLI and a local stdio MCP server are generated from it. A versioned skill file teaches agents the CLI with executable examples of claim, renew, effect, complete and recovery, and stable machine-readable errors. Remote MCP waits for a tested authorization contract (ADR-0003, ADR-0014).

## Dashboard

Hero view: the Run timeline, showing which harnesses touched which tables, queue depth, held messages, schema diffs. Second view: approvals inbox. Third: table browser. It reads through the server's SQL endpoint as the signed-in User, never through a direct database connection, so no browser bypasses authorization or provenance. Outerbase Studio embedded if its license allows; otherwise a small in-house grid. Also: Principals with key last-use and revoke, ambiguous Effects, and backplane health.

## Blobs and compute (optional overlays, experimental)

Blobs: Workspace-scoped, provenance-stamped storage. Filesystem storage ships in the base deployment; the optional S3 overlay defaults to digest-pinned RustFS 1.0.0. Backend switches require explicit migration. See ADR-0009.

Compute: single-node workerd, one isolate per submitted function, invoked over HTTP with the Workspace credential bound. Deployment and invocation provenance are recorded separately. The blobs and compute overlays can be omitted without affecting the base deployment.

## Operations

Backups with WAL archiving and restore drills, per-Principal and per-Workspace quotas, one bounded pool, protected internal schemas with pinned extensions and version-gated startup, database time as the only clock, deny-by-default grants, a release gate of adversarial and crash-boundary tests, and always-on health signals (ADR-0014). One active application node; multi-node deferred (ADR-0009).

## Stack

Bun, Elysia with OpenAPI, Eden types to a Vite+ dashboard, Drizzle for the backplane's own tables only, PostgreSQL 18 with PGMQ, Better Auth, Docker Compose, stdout/stderr logs in journald, and optional external log collection. PostgreSQL 19 after extensions ship for it (ADR-0008).

## Explicitly not built in v1

Exactly-once, websocket API, per-table REST, declarative schema diff, cross-Workspace access, teams UI, multi-node, a workflow engine, a second queue engine, remote MCP.
