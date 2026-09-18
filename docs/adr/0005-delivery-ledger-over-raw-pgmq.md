---
status: accepted
date: 2026-09-14
---
# Queues are typed verbs over a Delivery ledger, never raw PGMQ

PGMQ stores and dispatches messages, but agents never call it. They use typed verbs: send (idempotency key required), claim, renew, ack, nack, hold, inspect, replay, cancel. Every claim returns a Receipt bound to Principal, Run, attempt and expiry, and every later consumer transition must present a valid Receipt. Replay, release and cancellation use separate recovery authorization; forced cancellation can end a leased Delivery without a Receipt. Approval-authorized release grants a new claim (ADR-0007). Retry policy, backoff, maximum attempts and dead-lettering belong to the server. Queues are unordered in v1.

Why: PGMQ's visibility timeout is not ownership. A stalled agent can wake up and acknowledge work another agent already reclaimed. Only a Receipt check makes handoffs between agents that die mid-task safe, and only the verbs can stamp provenance and hold messages for Approval. Raw PGMQ access would let agents bypass all three.

Explicitly not built: exactly-once claims, agent-editable visibility, global ordering, a workflow engine, a second queue engine.
