---
status: accepted
date: 2026-09-14
---
# Schema changes are imperative SQL migrations submitted through the API

An agent changes a Workspace schema by submitting a Migration: plain SQL plus the schema revision it was written against. The server serializes migrations per Workspace, rejects a stale revision, dry-runs the SQL live inside a rolled-back transaction under strict timeouts, then applies it in one transaction as a non-login executor role with a forced search_path and a deny-by-default statement allowlist. Drops require an explicit destructive flag. Concurrent index builds and data backfills use separate, non-transactional paths. There is no revert; recovery is a forward migration or point-in-time restore.

The migrations table is the ledger and is written in the same transaction. A server-owned git repository mirrors it for human review. Git is a projection, never the source of truth.

Considered and rejected, after two red-team rounds:
- Agents push to a git repo with a webhook applier: too many failure points, git is not a serialization mechanism.
- Convex-style push of a TypeScript schema: desired state describes a destination, never a transition, so renames and backfills still need explicit migrations. Self-hosting Convex replaces SQL with a document model and its CLI needs an admin key.
- Declarative SQL with server-side diff (pg-schema-diff): stronger authoring, but needs the same executor and adds a diff engine that currently lists support only through PostgreSQL 17. Planned for v1.1.

We borrow from push workflows anyway: one noninteractive `bp push` command, plan previews bound to a base revision, content hashes, generated schema snapshots.
