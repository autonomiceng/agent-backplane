---
status: accepted
date: 2026-09-14
---
# Better Auth, with long-lived revocable keys for agents

Human login and Organizations use Better Auth with its organization plugin, so teams in v2 need no auth rewrite. Principal credentials are a backplane-owned hashed-key table, one key per Principal, because Better Auth's api-key plugin binds keys to Users or Organizations, never to a Principal. Agent keys are long-lived because hosted agents cannot practically refresh short-lived tokens. In exchange each key is scoped to one Principal in one Workspace, stored hashed, shows last-use in the dashboard, and can be rotated or revoked instantly. Revoking a Principal also invalidates its Receipts and pauses any Effect it had begun. New requests fail immediately and no new transaction can bind as that Principal; transactions already bound finish under their statement timeout. Key last-use is identity telemetry written without Run context, like Better Auth's session rows.
