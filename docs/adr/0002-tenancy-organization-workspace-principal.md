---
status: accepted
date: 2026-09-14
---
# Organization owns Workspaces, Workspaces own Principals

Humans (Users) belong to an Organization. An Organization owns Workspaces. A Workspace is the tenancy boundary for schemas, queues, approvals and audit history. A Principal is an agent identity with its own API key inside a Workspace. Humans create Workspaces; agents never do. A Principal has no access to any Workspace it is not a member of, and may be a member of several. v1 seeds exactly one Organization.

Why: keeps the blast radius of any agent bounded to one Workspace, makes one Postgres role per Principal per Workspace the security model, and leaves room for teams in v2 without a rename.
