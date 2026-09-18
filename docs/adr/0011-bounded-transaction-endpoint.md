---
status: accepted
date: 2026-09-14
---
# A bounded transaction endpoint for atomic handoffs

"Ack the current message, update a row, send the next stage" must be atomic or an agent dying between calls loses work. So there is one endpoint that runs a short ordered list of operations in a single Postgres transaction: row statements executed as the Principal's role, plus send, ack, nack and hold with Receipts. Claims, migrations and external I/O are excluded. Statement, lock and whole-transaction timeouts are enforced, operation count and payload size are capped, and no transaction survives beyond the request.

Red-team requirements adopted: every transaction carries an idempotency key bound to a request hash, and the recorded outcome is returned on retry, so a lost commit response cannot cause a double handoff. Delivery rows are locked in canonical order before Workspace rows. Row statements can assert affected-row counts, because an agent will otherwise update zero rows and send anyway. Principal SQL never touches ledger tables, and the server's ledger writes run under its own role on the same connection.

Considered: an outbox table alone (still needs consumption bookkeeping and a dispatcher), and "ack with attached statements" (needs the same boundary and grows into this).
