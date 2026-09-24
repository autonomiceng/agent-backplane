# Bootstrap and enrollment

The host needs Docker with the Compose plugin, Python 3.11 and journald (other hosts need a [logging override](../../docs/operations/logging.md)). Bun never runs on the host: Compose pulls the published, digest-pinned images and the first User enrolls through the CLI inside the server image.

```sh
python3 scripts/bootstrap.py --capability-file "$HOME/.bp-enrollment"
```

Bootstrap copies `.env.example` to `.env` on the first run, generates the missing secrets once (present values are never rewritten, unrelated lines are preserved, the file is written atomically with mode `0600`), records `COMPOSE_PROJECT_NAME`, `COMPOSE_FILE`, `COMPOSE_PROFILES` and `BP_BLOB_BACKEND` literally, validates the browser URL, creates or validates the Platform Network with the [shared allocation](../../docs/operations/ingress.md), creates the durable volumes named with `BP_VOLUME_PREFIX`, starts the selection with `up --wait`, waits for `/health/ready` on the direct port and for the selected Files and Functions capabilities, exports the pending enrollment capability to `--capability-file`, and prints one JSON line whose `next` is the exact enrollment command. Errors are one JSON line on stderr. Exit codes: 0 ready, 1 refused, 2 usage, 3 not ready.

Flags: `--env-file PATH` (default `.env`), `--dry-run` (render and validate the plan, write nothing, call no Docker), `--compose-project NAME`, `--profile NAME` (repeatable: `blobs`, `compute`, `edge`; `''` records none), `--access-mode local|public|proxy`, `--public-url URL`, `--backup-dir PATH` (an existing directory; the default `./backups` beside the env file is created for a first look, production wants an encrypted off-host mount), `--build` (build the server and workerd images from this checkout through `compose.dev.yaml`; refused when `BP_SERVER_IMAGE` or `BP_WORKERD_IMAGE` names an explicit image, which bootstrap never builds over).

A fresh install is minimal: Postgres, the server and filesystem Files. `--profile blobs` adds RustFS-backed Files, `--profile compute` adds Functions, `--profile edge` adds a standalone Caddy (local HTTP and self-signed HTTPS, or trusted HTTPS in public mode). Behind Platform Edge, `--access-mode proxy --public-url URL` runs core only; Edge reaches the server directly. A recorded or requested `gateway` profile is refused with `gateway_profile_retired`. See [access setup](../../docs/operations/ingress.md).

The recorded selection is authoritative. A rerun without `--profile` reuses it; a rerun with a different `--profile` set is refused with `selection_conflict`. To change the selection, edit `COMPOSE_PROFILES` and `COMPOSE_FILE` deliberately; bootstrap never upgrades capabilities or switches the Files backend on an existing installation (`backend_change_requires_migration`), and there is no tool that moves Files between backends. An installation with secrets but no recorded `COMPOSE_PROFILES` needs explicit `--profile` flags once (`existing_selection_required`). Existing Docker volumes or containers with a missing secret refuse with `existing_installation_missing_secrets`: restore the original `.env`. `COMPOSE_FILE` is an ordered, colon-separated list of absolute paths starting with this checkout's `compose.yaml`; with the default `.env`, `docker compose up -d` reuses the saved selection.

Selected Functions pull the published amd64 workerd image pinned in `compose.compute.yaml` when `BP_WORKERD_IMAGE` is empty, verify both executable hashes and versions in isolated containers, and save private launch evidence under `BP_DATA_DIR/compute`. An explicit `BP_WORKERD_IMAGE` must already exist locally and is never built over or pulled. `--build` builds both images from the checkout instead; see [runtime identity](../compute/runtime.md).

## Enrollment

When enrollment is pending, bootstrap prints the exact command. Its shape:

```sh
BP_SERVER_IMAGE=<the image the server runs> docker compose -f compose.yaml -f compose.enroll.yaml run --rm \
  --user "$(id -u):$(id -g)" \
  -v "$HOME/.bp-enrollment:/tmp/capability:ro" \
  -v "$HOME/.local/state/backplane:$HOME/.local/state/backplane" \
  -e BP_DATA_DIR="$HOME/.local/state/backplane" \
  enroll --url http://localhost:3000 --email you@example.com
```

`compose.enroll.yaml` runs `bp bootstrap` from the image the server runs (bootstrap reads it from the rendered Compose configuration, so a `--build` or `BP_SERVER_IMAGE` selection is honoured) with host networking, so `--url` is the same browser URL agents on this host use. The capability file is mounted read-only; the CLI state directory (`$XDG_STATE_HOME/backplane` or `~/.local/state/backplane`, created by bootstrap with mode `0700`) is mounted at its own path and the container runs as your uid, so the checkpoint and the credential file land on the host owned by you and the printed paths are valid host paths. Enter the password at the terminal or set `BP_BOOTSTRAP_PASSWORD`. The overlay is never listed in `COMPOSE_FILE`; `docker compose up` ignores it. The server image must contain the CLI's contract and command table: `infra/compose/server.Dockerfile` copies them from this commit on, so enrollment needs a server image published from it or later (or `--build`). The published pin in `compose.yaml` is bumped after each publish.

The first Workspace and Principal are named `default`. Successful output is JSON containing their IDs and an MCP configuration:

```json
{"mcpServers":{"backplane":{"command":"bp","args":["mcp"],"env":{"BP_CREDENTIALS_FILE":"/absolute/private/credentials.json"}}}}
```

Use the emitted configuration directly on agent machines that have the `bp` CLI (a Bun install of this checkout or the compiled artifact). CLI commands also accept `BP_CREDENTIALS_FILE`. The private JSON contains exactly `url`, `workspaceId`, `principalId`, and `key`; conflicting credential environment variables are rejected.

## Resume and recovery

Checkpoints live in `<CLI state root>/bootstrap/<origin SHA-256>.json`, with the credential file beside them. The state root is `$BP_DATA_DIR/cli`, otherwise `$XDG_STATE_HOME/backplane` or `~/.local/state/backplane`. Files are `0600`, directories `0700`. Private file operations hold a checked parent directory: it must be owned by the current uid with no group or world write, or be root-owned and sticky. Checkpoint creation is exclusive; subsequent transitions use exclusive temporary files, fsync and atomic replacement. Credential files are never overwritten. Checkpoints contain only the fields permitted for their current step, never keys. Retain these files securely.

Invalid checkpoints remain untouched and report `checkpoint_invalid` with a sanitized reason, exiting `1`. Preserve the checkpoint and credential files. Reconcile IDs against server records and the matching User session, then repair from evidence or restore a known-good checkpoint.

Rerun the enrollment command to validate the saved credential. A valid session is reused while provisioning. If sign-in is needed, supply the same password. Missing or revoked resources require investigation. Bootstrap never rotates an existing key automatically.

After an uncertain Workspace or Principal creation, investigate server records and adopt the exact ID with `--workspace-id UUID` or `--principal-id UUID`. Names are never used to infer identity.

Ambiguous key issuance exits `3` and prints recovery commands with the recorded IDs. Set `BP_USER_EMAIL` to the enrolled User's email, and sign in with `bp login` if the saved session expired. Explicitly issue a replacement:

```bash
bp auth issue-principal-key --workspace-id UUID --principal-id UUID \
  --credential-out NEW_PRIVATE_FILE
bp bootstrap --url URL --recover-key-file NEW_PRIVATE_FILE
```

The issuance command uses `BP_URL` and the User session. It reserves the output file before issuance and keeps stdout redacted. Any uncertain issuance or post-commit persistence failure exits `3` with `key_ambiguous`, including an empty output file; preserve it and investigate. Choose a new path for another explicit issuance. Bootstrap verifies the recovery file with `whoami`, copies it to a new private file under the CLI state root, and preserves earlier credential files.

A stale `.lock` requires investigation. Confirm no bootstrap process is running before removing only that lock. Retain the checkpoint: recovered `key:in-flight` validates its existing credential file with `whoami` and promotes it to `key:saved`; otherwise it becomes `key:ambiguous`. Only a proven pre-send connection or handshake failure (`transport_unsent`), or a local session failure identified before invocation, returns issuance to `principal:saved` for retry and removes the credential-file reference. Failed recovery from `key:saved` preserves that checkpoint.

CLI exit codes: `0` complete, `1` usage or invalid input, `2` server not ready or recovery required (adoption, capability or identity), `3` ambiguous issuance. Its readiness probe waits up to 120 seconds.

Storage initialization runs as the shared-image `storage-init` one-shot after migrations, before the server verifies store identity and content. It starts as root only to assign `/data` to the image's `bun` user (fresh, restored or root-helper-written volumes), then drops to `bun` with `setpriv`. Bootstrap validates `BP_RUSTFS_IMAGE`, `BP_BLOB_BOOTSTRAP_IMAGE` and `BP_SERVER_IMAGE` as image references (`image_reference_invalid`). It initializes only an empty installation; data without a storage binding is refused (`blob_binding_unbound_data_unsupported`). The [storage identity procedure](../../docs/operations/storage-identity.md) documents the fenced inspection and reconciliation commands.

A fresh blobs selection generates a 40-character scoped S3 secret, within RustFS's service-account creation limit. Existing credentials are preserved and never silently repaired: if an earlier uncompleted installation generated a longer `BP_BLOB_S3_SECRET_KEY`, replace that one value with a generated 40-character secret before rerunning bootstrap.

Complete image references in the selected `.env` (`BP_POSTGRES_IMAGE`, `BP_SERVER_IMAGE`, `BP_CADDY_IMAGE`, `BP_RUSTFS_IMAGE`) select unvalidated experiments; empty values keep the shipped digest pins. See [published images](../../docs/operations/upgrade.md) and [checkpoint prerequisites](../backup/README.md).
