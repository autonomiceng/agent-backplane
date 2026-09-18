---
status: accepted
date: 2026-09-14
---
# The audit log is the only event stream

Every change in a Workspace produces one Audit Event. The ordered stream of Audit Events is served over Server-Sent Events with a cursor, and that is what "realtime" means here. The dashboard, an agent asking "what changed since my last Run", and a blocking follow all read the same stream. There is no websocket API, no per-table subscription, and no separate realtime service.

Why: the agents we serve cannot hold a socket open between turns, so a change feed for them is a cursor. Building realtime as a view over provenance gives one primitive with three uses instead of a second system.

Consequence: audit position allocation is serialized per Workspace through commit so a cursor never skips a committed event. Delivery is at least once. An expired cursor gets an explicit resync response.
