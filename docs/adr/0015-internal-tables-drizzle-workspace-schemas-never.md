---
status: accepted
date: 2026-09-14
---
# Drizzle for the backplane's own tables, never for Workspace schemas

The backplane's own tables live in protected schemas (`control`, `queue`, `audit`), are defined in Drizzle for type inference, and change only through ordered forward-only SQL files in `db/migrations`. Workspace schemas are agent-owned, change only through the Migration endpoint, and never appear in Drizzle or in the repository. A table browser or any human tool reads Workspace data through the server as the signed-in User, never through a direct database connection.

Why: two kinds of schema with two owners must not share one tool, or a developer will "fix" an agent's table in a repo migration and break provenance. This is the on-disk consequence of ADR-0001 and ADR-0004.
