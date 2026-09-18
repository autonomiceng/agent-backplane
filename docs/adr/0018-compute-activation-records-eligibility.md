---
status: proposed
date: 2026-09-14
---
# Compute activation records eligibility

Compute activation records eligibility after isolated preparation. Workerd's experimental Worker Loader materializes disposable isolates on demand; committed Postgres deployments remain authoritative. No runtime residency guarantee or server actor is introduced.

Preparation may succeed before a transaction rolls back. Prepared isolates have no invocation ingress, and invocation must authorize against committed active deployments on every request. Isolates are disposable caches and may disappear after eviction or restart.

Workerd is not a hardened sandbox. The two-second preparation deadline bounds server occupancy, without guaranteeing termination of an initializer. Container resource limits constrain damage; hostile code needs stronger isolation beyond this experimental profile.
