---
status: accepted
date: 2026-09-14
---
# Irreversible actions get an Effect Key and an ambiguous state

A Message that asks for an irreversible outside action carries exactly one Effect, identified by an Effect Key derived from the Workspace, the logical action and the destination, never from the attempt. Retries and replays keep the key. Before performing the Effect the agent records a begin-effect transition; if the lease then expires with no result, the Delivery becomes ambiguous and is never retried automatically. Reconciliation is a recorded decision with evidence: applied, not applied, or unknown. Applied completes the Delivery, not applied allows a new Delivery with the same key, unknown stays blocked. Reconciling needs its own authorization, not a consumer Receipt.

Why: the job-application dogfood hits this on day one, and the honest promise is controlled retry with explicit uncertainty. We never claim exactly-once external execution. Where the destination has no idempotency contract the key is only a correlation id, and the skill file says so.
