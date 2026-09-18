---
status: accepted
date: 2026-09-14
---
# REST with OpenAPI is canonical; data access is SQL over POST

Agents reach the backplane over HTTP. Every capability is a REST endpoint described by OpenAPI. The CLI (`backplane`, alias `bp`) and the MCP server are thin generated clients of that API, and a skill file teaches agents the CLI. Row access is a single parameterized SQL endpoint executed as the Principal's Postgres role, plus typed endpoints for queues, schema, approvals, runs and blobs.

Considered: one REST route per table (PostgREST style). Rejected for v1 because it is a second query language for agents to learn, and Postgres roles are the security boundary either way. Hosted agents such as Grok bot, which run on their own Linux VM, can use both the CLI and raw HTTP.
