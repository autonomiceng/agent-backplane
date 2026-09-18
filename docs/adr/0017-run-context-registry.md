---
status: accepted
date: 2026-09-14
---
# Run context is bound once per transaction in a server-only registry

The server binds Workspace, Principal and Run (or User) for a writing transaction by calling `audit.bind_context()`, a definer function only the server role may execute. It records the binding under the backend and transaction id and locks the Workspace's audit cursor. `audit.emit()` stamps every Audit Event from that record. A transaction can be bound once; a second bind fails.

Why: session settings authenticate nothing. Any SQL that runs inside the transaction can `SET`, `set_config()` or `RESET ROLE`, so a stamp read from a setting is a claim, not a fact. A registry row written by the server before the first agent statement cannot be rewritten from inside the transaction, which is the claim ADR-0001 needs.

Consequence: every writing transaction in a Workspace is serialized from bind to commit, so audit positions are gap-free in commit order (ADR-0006) and per-Workspace write throughput is bounded by transaction length. Statement allowlists in the SQL and Migration endpoints still forbid settings and role changes as defense in depth.

Scope: the registry covers Workspace data and the backplane's own tenancy rows. Identity tables written by Better Auth (users, sessions, accounts, organization membership) belong to no Workspace and are written without a bound context.
