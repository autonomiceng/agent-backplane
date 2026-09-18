---
status: accepted
date: 2026-09-14
---
# Audit Events are metadata envelopes, payloads expire

An Audit Event permanently records who, what, when and where: Principal, Run, statement shape, affected objects, counts. It does not permanently store SQL parameters, secrets or row contents. Sensitive captures expire independently in their primitive stores with a 30-day default retention. User-triggered purge scrubs expired queue bodies, deletes expired archive rows, and nulls expired SQL and evidence; deletion is documented across live data, exports and backups.

Why: a permanent provenance log that contains the mailbox contents it was auditing is a privacy liability, and a public post that ignores this would be picked apart.

Amended 2026-09-14: Message payloads, Migration SQL and Reconciliation evidence expire in place in their primitive stores. User-triggered purge scrubs expired queue bodies, deletes expired archive rows, and nulls expired SQL and evidence. A separate store added duplication and a dispatch rewrite without removing live copies. Permanent Audit Event envelopes, the 30-day default and independent capture expiry remain unchanged.
