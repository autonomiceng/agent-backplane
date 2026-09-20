# Local bootstrap

Prepare an existing encrypted off-host backup mount, install Docker Compose and Bun on a Linux host with journald, then run from this checkout. Other hosts need a [logging override](../../docs/operations/logging.md).

```bash
bun infra/bootstrap/prepare.ts --public-url http://localhost:3000 \
  --backup-dir /mnt/backplane-backups --capability-file "$HOME/.bp-enrollment"
bp bootstrap --url http://localhost:3000 --email user@example.com \
  --capability-file "$HOME/.bp-enrollment"
```

Preparation writes absent secrets to the repository-root `.env`, creates the external network selected by `BP_PLATFORM_NETWORK` (default `platform`) and durable volumes named with `BP_VOLUME_PREFIX` (default `agent-backplane`), starts the core services with `up --wait`, and exports the pending enrollment capability. `--env-file PATH` selects another environment file; `--compose-project NAME` selects the local Compose project. Its subprocess output is captured privately. `BP_ACCESS_MODE` defaults to `local`. Add `--profile edge` for local HTTP and self-signed HTTPS, with no domain needed. For public access or use behind another gateway, follow [access setup](../../docs/operations/ingress.md). Preparation chooses and validates the browser URL before creating resources. Use `--access-mode local|public|proxy` to select a mode, or set it in the selected environment file.

Add `--profile blobs` with the digest-pinned `BP_BLOB_BOOTSTRAP_IMAGE` built from this checkout already in `.env`. RustFS is pinned in `compose.blobs.yaml`. Add `--profile compute` with `BP_WORKERD_REPOSITORY` and `BP_WORKERD_DIGEST` in `.env` and that image installed locally. Core generates auth, database and operations secrets; blobs generates independent root and service credentials; compute generates its token. Preparation does not provision backup storage or workerd images.

Existing environment values and unrelated lines are preserved. Use literal assignments, quoting values containing spaces. Empty managed assignments are preparation placeholders. Duplicate nonempty, interpolated or malformed managed assignments require repair. Unrelated lines, including duplicate assignments and interpolations, remain verbatim. Existing data volumes with missing secrets require restoration of the original secrets. Preparation rejects remote Docker endpoints and unsafe files. Owned `.env` files are tightened to mode `0600`.

Bootstrap reads the password from the terminal with echo disabled, or `BP_BOOTSTRAP_PASSWORD` for noninteractive use. Passwords never appear in arguments. The first Workspace and Principal are named `default`. Successful output is JSON containing their IDs and an MCP configuration:

```json
{"mcpServers":{"backplane":{"command":"bp","args":["mcp"],"env":{"BP_CREDENTIALS_FILE":"/absolute/private/credentials.json"}}}}
```

Use the emitted configuration directly. CLI commands also accept `BP_CREDENTIALS_FILE`. The private JSON contains exactly `url`, `workspaceId`, `principalId`, and `key`; conflicting credential environment variables are rejected.

## Resume and recovery

Checkpoints live in `<CLI state root>/bootstrap/<origin SHA-256>.json`, with the credential file beside them. The state root is `$BP_DATA_DIR/cli`, otherwise `$XDG_STATE_HOME/backplane` or `~/.local/state/backplane`. Files are `0600`, directories `0700`. Private file operations hold a checked parent directory: it must be owned by the current uid with no group or world write, or be root-owned and sticky. Checkpoint creation is exclusive; subsequent transitions use exclusive temporary files, fsync and atomic replacement. Credential files are never overwritten. Checkpoints contain only the fields permitted for their current step, never keys. The credential-file reference exists only in key states; the initial state has no step. Retain these files securely.

Version-1 checkpoints remain compatible. Legacy pre-key credential-file references are accepted and omitted in memory; key states require all IDs and a reference. The legacy `recoveryFile` alias is accepted when it does not conflict with `credentialFile`. Normalization requires no upgrade-time rewrite.

Invalid checkpoints remain untouched and report `checkpoint_invalid` with a sanitized reason, exiting `1`. Preserve the checkpoint and credential files. Reconcile IDs against server records and the matching User session, then repair from evidence or restore a known-good checkpoint.

Rerun `bp bootstrap --url URL` to validate the saved credential. A valid session is reused while provisioning. If sign-in is needed, supply the same password. Missing or revoked resources require investigation. Bootstrap never rotates an existing key automatically.

After an uncertain Workspace or Principal creation, investigate server records and adopt the exact ID with `--workspace-id UUID` or `--principal-id UUID`. Names are never used to infer identity.

Ambiguous key issuance exits `3` and prints recovery commands with the recorded IDs. Set `BP_USER_EMAIL` to the enrolled User's email, and sign in with `bp login` if the saved session expired. Explicitly issue a replacement:

```bash
bp auth issue-principal-key --workspace-id UUID --principal-id UUID \
  --credential-out NEW_PRIVATE_FILE
bp bootstrap --url URL --recover-key-file NEW_PRIVATE_FILE
```

The issuance command uses `BP_URL` and the User session. It reserves the output file before issuance and keeps stdout redacted. Any uncertain issuance or post-commit persistence failure exits `3` with `key_ambiguous`, including an empty output file; preserve it and investigate. Choose a new path for another explicit issuance. Bootstrap verifies the recovery file with `whoami`, copies it to a new private file under the CLI state root, and preserves earlier credential files.

A stale `.lock` requires investigation. Confirm no preparation or bootstrap process is running before removing only that lock. Retain the checkpoint: recovered `key:in-flight` validates its existing credential file with `whoami` and promotes it to `key:saved`; otherwise it becomes `key:ambiguous`. Only a proven pre-send connection or handshake failure (`transport_unsent`), or a local session failure identified before invocation, returns issuance to `principal:saved` for retry and removes the credential-file reference. Ordinary HTTP 4xx responses now retain ambiguity; they no longer qualify for this rollback. Failed recovery from `key:saved` preserves that checkpoint.

Exit codes: `0` complete, `1` usage or invalid input, `2` server not ready or recovery required (adoption, capability or identity), `3` ambiguous issuance. A readiness probe waits up to 120 seconds.
