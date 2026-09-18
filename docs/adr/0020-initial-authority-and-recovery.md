---
status: proposed
date: 2026-09-14
---
# Initial authority and recovery

Initial authority comes from possession of a random capability delivered through a protected local file. A database claim permanently records its consumption and intended User. Better Auth identity creation, the claim, and Organization membership commit atomically as global identity writes (ADR-0017); Workspace tenancy remains User-bound.

The capability file is an explicit plaintext delivery exception to hashed database storage. It is published once, never logged or returned, and removed after consumption. Database hashes cannot reconstruct it. The committed claim overrides file presence and identity counts on every restart.

Zero-User auto-open is rejected because deletion, failed provisioning, and restoration must never authorize strangers. Existing Users and memberships remain intact when migration seals an installation. Users without a claim or an unsafe capability file require deliberate administrative recovery. Restoring a pre-enrollment database is an administrative rollback of authority and requires restore fencing. This slice introduces no reset endpoint, server actor, background worker, or dependency.

Sign-up defaults to closed; ordinary sign-in remains available. Explicit open sign-up is effective only on loopback origins and creates Users without Organization membership. On a public origin, configured open sign-up remains effectively closed, Better Auth returns its native 404, and readiness reports `signup_open_public_origin`. Auth and health use the same pure sign-up policy. Pending enrollment reports HTTP 200 readiness so installation health checks can finish before the first User enrolls. Unknown enrollment state and required recovery fail readiness.
