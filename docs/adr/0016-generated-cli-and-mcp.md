---
status: accepted
date: 2026-09-14
---
# The CLI and MCP server are generated from the OpenAPI contract

`contracts/openapi/openapi.json` is exported from the server without starting it. `packages/cli/generated` and `packages/mcp/generated` are produced from it by `tooling/codegen` and are never edited by hand; only `runtime/` in each package is hand-written (credentials, lazy Run creation, streaming, push). An endpoint author adds a route and regenerates; CI fails on generation drift.

Why: three hand-maintained surfaces drift within a week, and agents learn the drifted one. One contract keeps the CLI, the MCP server, the skill file's examples, and the dashboard's Eden types telling the same story.
