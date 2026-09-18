---
status: accepted
date: 2026-09-14
---
# Operational baseline every deployment gets

Defaults adopted wholesale from the third red-team round, each easy to forget and expensive to add later:

- Backups: encrypted off-host base backups plus continuous WAL archiving, a stated recovery objective, a monthly restore drill, and Queues paused after a restore until Effects are reconciled.
- Quotas: per-Principal rate and concurrency limits, per-Workspace storage, backlog, audit-volume, result-size and event-stream limits, with reserved capacity for administration.
- Connections: one bounded server pool with a transaction-local role and Run context bound once per transaction (ADR-0017), never a pool per Principal. Table ownership stays with protected executor roles.
- Internal schemas: control, queue and audit tables live in protected schemas separate from Workspace schemas, extension versions are pinned, and the server refuses to start on an incompatible schema version.
- Time: database time governs leases, retries and Approval expiry. Harness timestamps are recorded but never trusted.
- Authorization: deny-by-default grants for tables, Queues, migrations, replay and reconciliation.
- Release gate: tests for cross-Workspace access, Run-context spoofing, concurrent claims, crash at every handoff boundary, and restore.
- Health: queue age, ambiguous Effects, database saturation, WAL and disk growth, backup age and event-stream lag are always exposed.
- MCP: local stdio through the CLI first; remote MCP waits for a tested authorization contract.
