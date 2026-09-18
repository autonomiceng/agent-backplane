---
status: proposed
date: 2026-09-14
---
# Invocation authority is temporary and deployment-bound

Amend ADR-0010 to permit hashed, expiring credentials restricted to one invocation Run, its Workspace and an explicit operation allowlist. The gateway creates a child Run under the active deployment's Principal; immutable metadata and the parent Run identify the caller. Activation exposes invocation to Workspace Principals. Each invocation receives a fresh isolate with only its temporary credential, Run and Workspace; readable credentials remain exportable capabilities.

Amend ADR-0017 to permit caller-bound child Run creation and a closed terminal-audit definer. The caller's bound transaction creates authority and records `function.invoke`, then commits before dispatch. Callback writes bind independently as the deployment Principal and child Run, rechecking live authority after acquiring the Workspace cursor. No server actor is introduced.

The terminal definer derives identity from the persisted invocation and normally emits exactly one completion, failure or timeout event while deleting the credential atomically. If cursor contention prevents terminal recording, its audit subtransaction rolls back and credential deletion commits independently; bounded retries record the terminal event idempotently. Exhausting those retries returns a finalization failure with authority already removed. This narrowly specializes the callback-only audit convention: it may run after expiry, revocation or restoration gating, exposes no general transaction callback and performs no Workspace or queue writes. Expiry rejects reuse even if process death or database failure prevents physical cleanup; later bound requests sweep expired credentials without inventing execution outcomes.

Admission reserves capacity for callbacks. A monotonic gateway deadline and byte caps bound gateway occupancy and response buffering. Aborting fetch does not prove termination of an infinite loop; the S30 runtime validation and container resource limits remain release requirements.
