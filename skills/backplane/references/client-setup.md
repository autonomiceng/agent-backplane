# Agent client setup

Use this path when a User asks an agent to check out this repository and set itself up against an existing Backplane. Setup is complete when the credential identifies the expected Principal and Workspace, the CLI works by absolute path, the MCP client completes initialization and lists tools, and every capability reported ready below has passed its exercised check.

## Scope and credential stop

Client setup attaches to a server that a User or operator already installed and enrolled. Leave server deployment, enrollment, Workspace creation, Principal creation, credential issuance, host configuration, and CLI symlinks unchanged.

Require the User to supply the absolute path in `BP_CREDENTIALS_FILE`. If it is absent, stop and ask for that file. Do not search for credentials or substitute another Principal's environment variables. The CLI accepts a private JSON file containing exactly `url`, `workspaceId`, `principalId`, and `key`; it rejects unsafe permissions and conflicting `BP_*` credential variables without printing the key.

Use the repository-local client from the checkout instead of assuming `bp` is installed:

```sh
BACKPLANE_REPO=/absolute/path/to/agent-backplane
export BP_CREDENTIALS_FILE=/absolute/private/backplane.credentials.json
export BP_HARNESS=codex
export BP_SESSION=agent-setup-UNIQUE_SESSION_ID
bun "$BACKPLANE_REPO/packages/cli/runtime/main.ts" auth whoami
```

Choose one unique `BP_SESSION` for this Harness invocation and keep it for retries.
For the executable examples below, `bp` denotes the repository client. If it is
not installed, bind a shell function for this session without changing PATH or symlinks:

```sh
bp() { bun "$BACKPLANE_REPO/packages/cli/runtime/main.ts" "$@"; }
```

Set `BP_MODEL` and `BP_RUN_LABEL` when known. `auth whoami` must return the expected `workspaceId` and `principalId` before any writing check. The Principal is the durable identity; the CLI lazily creates and reuses a distinct Run for this Harness invocation.

## Discover the live client surface

Generated leaf help is authoritative. Run the leaf commands needed for the task; group help is unsupported.

```sh
bun "$BACKPLANE_REPO/packages/cli/runtime/main.ts" blobs put-blob --help
bun "$BACKPLANE_REPO/packages/cli/runtime/main.ts" blobs get-blob --help
bun "$BACKPLANE_REPO/packages/cli/runtime/main.ts" functions deploy-function --help
bun "$BACKPLANE_REPO/packages/cli/runtime/main.ts" functions activate-function --help
bun "$BACKPLANE_REPO/packages/cli/runtime/main.ts" functions invoke-function --help
bun "$BACKPLANE_REPO/packages/cli/runtime/main.ts" queue claim-message --help
bun "$BACKPLANE_REPO/packages/cli/runtime/main.ts" sql execute-sql --help
```

For a stdio MCP client, adapt the bootstrap-returned block only when `bp` is unavailable. Keep the private credential path in the process environment:

```json
{"mcpServers":{"backplane":{"command":"bun","args":["/absolute/path/to/agent-backplane/packages/cli/runtime/main.ts","mcp"],"env":{"BP_CREDENTIALS_FILE":"/absolute/private/backplane.credentials.json"}}}}
```

Verify the stdio server before installing client configuration:

```sh
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"setup","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | bun "$BACKPLANE_REPO/packages/cli/runtime/main.ts" mcp
```

Use the Harness's supported configuration command or location within the User's
setup request. If the Harness requires a manual restart or installation step,
report that step precisely. After restarting the MCP process, require a successful `initialize` response and `tools/list` containing `whoami`, `putBlob`, `getBlob`, `deployFunction`, `activateFunction`, and `invokeFunction`. A config file alone is not protocol readiness.

## Exercise Files

Files is named `blobs` by the generated CLI. Upload a small non-secret repository file under a setup-specific key. Bind `ONBOARDING_FILE` to its local path and `ONBOARDING_DOWNLOAD` to a new scratch path.

```bash
# bp-example onboarding.files-put capture=FILE_ID:/id
bp blobs put-blob --key onboarding/client-check.txt --file "$ONBOARDING_FILE"
```

```bash
# bp-example onboarding.files-get
bp blobs get-blob --id "$FILE_ID" --out "$ONBOARDING_DOWNLOAD"
```

Compare the downloaded bytes with the source. The CLI preserves an existing output unless `--force` is explicit and rejects symlinks. MCP `putBlob` reads a local `file` path in the MCP server process; MCP `getBlob` returns `{"encoding":"base64","content":"...","size":N}` instead of writing a file.

The setup check is one upload and one download, each capped at 4 MiB. Report Files ready only after the byte comparison succeeds. Preserve the returned ID so the User can delete the setup object later if desired.

## Exercise Functions

Functions requires the optional qualified runtime. Bind `DEPLOYMENT_ID` to a fresh UUID. This sample has no outbound network access and returns only its authenticated invocation input and Workspace ID.

```bash
# bp-example onboarding.functions-deploy
bp functions deploy-function --name onboarding-check --body - <<JSON
{"id":"$DEPLOYMENT_ID","bundle":"export default {async fetch(request, props) { return Response.json({input: await request.json(), workspaceId: props.workspaceId}); }}","entryPoint":"default","outboundUrls":[]}
JSON
```

Activate with compare-and-swap. `null` is correct only when no deployment is active; a replacement must use the current active deployment ID.

```bash
# bp-example onboarding.functions-activate
bp functions activate-function --name onboarding-check --id "$DEPLOYMENT_ID" --body - <<'JSON'
{"expectedActiveId":null}
JSON
```

Any Principal in the Workspace may invoke the active function. The deployment retains the deploying Principal's authority, and each invocation receives a temporary credential restricted to a child Run, the Workspace, the deployment, and its callback operations.

```bash
# bp-example onboarding.functions-invoke
bp functions invoke-function --name onboarding-check --body - <<'JSON'
{"input":{"check":"agent-client"},"timeoutMs":2000}
JSON
```

The successful response has status `200` and a result containing `{"input":{"check":"agent-client"},"workspaceId":"<expected Workspace>"}`. Report Functions ready only after that result. `compute_disabled`, `compute_unavailable`, timeout, or admission errors mean Functions is not ready; report the exact error and leave installation to the operator. The deadline bounds gateway occupancy, and the runtime/container resource limits provide the execution boundary. Functions is authenticated Workspace execution, not public anonymous web hosting.

## Continue with Workspace work

Use the main skill's dogfood workflow to exercise Queues and its `bp push` guidance for Workspace SQL. Read leaf help for every additional operation. State which Principal and Run performed setup, which checks passed, object and deployment IDs created, and every capability that remains disabled, unavailable, or untested.
