---
status: accepted
date: 2026-09-14
---
# PostgreSQL 18 now, 19 after extensions catch up

v1 runs on PostgreSQL 18 with PGMQ. Everything the design needs is in 18: OAuth authentication, uuidv7, RETURNING old and new, per-backend I/O statistics. PostgreSQL 19 is in beta with no GA date, is still removing features, and PGMQ and pg_tle will not have 19 builds until months after GA. 19 brings incremental wins for this workload (NOTIFY wakes only listeners, REPACK CONCURRENTLY, restart-free logical decoding, pg_stat_lock), so the audit layer is written to never need a wal_level restart, and an upgrade is planned once 19.1 and extension builds exist.
