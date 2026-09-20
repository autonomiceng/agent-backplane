# Local bootstrap

Prepare an existing encrypted off-host backup mount, install Docker Compose and Bun on a Linux host with journald, then run from this checkout. Other hosts need a [logging override](../../docs/operations/logging.md).

```bash
bun infra/bootstrap/prepare.ts --public-url http://localhost:3000 \
  --backup-dir /mnt/backplane-backups --capability-file "$HOME/.bp-enrollment"
bp bootstrap --url http://localhost:3000 --email user@example.com \
  --capability-file "$HOME/.bp-enrollment"
```

Preparation writes absent secrets to the repository-root `.env`, creates the external network selected by `BP_PLATFORM_NETWORK` (default `platform`) and durable volumes named with `BP_VOLUME_PREFIX` (default `agent-backplane`), starts the core services with `up --wait`, and exports the pending enrollment capability. `--env-file PATH` selects another environment file; `--compose-project NAME` selects the local Compose project. Its subprocess output is captured privately. `BP_ACCESS_MODE` defaults to `local`. Add `--profile edge` for local HTTP and self-signed HTTPS, with no domain needed. For Platform Edge, use `--access-mode proxy --profile gateway --public-url <browser-url>` to include an internal Caddy without host ports. For public access or use behind another gateway, follow [access setup](../../docs/operations/ingress.md). Preparation chooses and validates the browser URL before creating resources. Use `--access-mode local|public|proxy` to select a mode, or set it in the selected environment file.

Preparation records `COMPOSE_PROJECT_NAME`, `COMPOSE_FILE` and `COMPOSE_PROFILES` in
the selected env file. A fresh installation still defaults to core only. Omitted
profile flags reuse the recorded selection; repeated `--profile NAME` flags select
the complete profile set. `--profile ''` explicitly selects no optional profiles,
and a recorded empty `COMPOSE_PROFILES` has that same meaning. Edge and gateway
are mutually exclusive. Conflicting CLI or shell Compose selectors are rejected.
Preparation preserves existing project, volume, network, secret and image values.
It refuses profile changes and a rendered Files backend that differs from the saved
`BP_BLOB_BACKEND`; use an explicit storage migration for backend changes.

`COMPOSE_FILE` is an ordered, colon-separated list. The first file must be this
checkout's root `compose.yaml`; custom overlays follow it in their existing order.
Relative entries resolve beside the selected env file and are saved as absolute
paths. Relative bind and build paths inside Compose files resolve from the checkout
root. Only the native Linux `:` separator is supported.
Set custom overlays in `COMPOSE_FILE` before preparation. With the default `.env`,
`docker compose up -d` reuses the saved selection. With a custom env file, use
`docker compose --env-file /absolute/path/to/.env up -d`.

An installation with resources or secrets and incomplete recorded selection requires
`--confirm-existing-selection`, an explicit `--compose-project`, and explicit
`--profile` flags. Restore the original custom `COMPOSE_FILE` first, if applicable.
This flag confirms the original selection, including its rendered Files backend;
it does not authorize changing or migrating an installation. For incomplete legacy
selection, an existing `<BP_VOLUME_PREFIX>_rustfs-data` volume requires `blobs` and
an S3 Files backend. For an original core-only installation, for example:

```bash
bun infra/bootstrap/prepare.ts --env-file /path/to/.env \
  --confirm-existing-selection --compose-project original-project --profile '' \
  --capability-file "$HOME/.bp-enrollment"
```

Run `--help` for the selection flags. Successful local resource inventory and Compose
configuration validation precede network or volume mutation. Selection and secrets
are published together by atomic replacement before durable volumes are created,
so an interrupted preparation reuses the same identities on its next run. An
inventory failure refuses preparation. Bootstrap status records the actual project,
ordered Compose files and profile set. The observer reports bootstrap health only
when that selection matches; older records without selection remain unknown until
preparation records another outcome.

`python3 scripts/status_observer.py --checkout "$PWD" --env-file /path/to/.env`
reads the saved native Compose selection and `BP_STATUS_DIR`. Explicit observer or
timer selectors must agree with recorded values. `--profile ''` explicitly selects
no optional profiles. Existing timers supply project and file arguments; omitted
profile flags with explicit files retain their original empty-selection meaning.
The timer installer reuses saved profiles when `--profile` is omitted and writes
the resolved selection into the unit arguments.
Without recorded settings, the observer retains its core-only and checkout `data`
defaults. `--state-dir` still explicitly selects the publication directory.

Add `--profile blobs` to use RustFS and bootstrap helpers from the effective server image. `BP_BLOB_BOOTSTRAP_IMAGE` remains an explicit helper-code experiment override. Add `--profile compute` to build the pinned amd64 workerd recipe locally when `BP_WORKERD_IMAGE` is unset or empty. This requires build network access and compatible Docker/BuildKit; default promotion remains gated on H-PROOF/F-GATE. An explicit full `BP_WORKERD_IMAGE` must already exist locally, with its expected `BP_WORKERD_BINARY_SHA256` and the pinned Bun supervisor. Explicit overrides are never built over or implicitly pulled. Bootstrap resolves tags for each launch, verifies both executable hashes and version output, and saves private launch evidence under `BP_DATA_DIR/compute` (default `data/compute` beside the env file). The effective image override exists only in the child environment. Compose defaults to the same local tag for preflight and later native startup with the saved selection; a later bare Compose deployment may resolve the tag again. Workerd has no Compose build stanza, so `up --build` cannot rebuild an explicit workerd override. Rerun preparation if the local default image is absent. See [runtime identity](../compute/runtime.md); legacy repository/digest configuration requires migration. Core generates auth, database and operations secrets; blobs generates independent root and service credentials; compute generates its token. Preparation does not provision backup storage.

Set complete image references in the selected `.env`: `BP_POSTGRES_IMAGE`, `BP_SERVER_IMAGE`, `BP_CADDY_IMAGE`, and `BP_RUSTFS_IMAGE` accept tags, digests and local images. Empty or unset settings retain the shipped defaults. PostgreSQL shares its image with backup initialization; server shares its image with migration, data initialization and blob helpers. Prebuilt server images must contain this checkout's helper entrypoints; pull or load them before preparation, which disables Compose builds when `BP_SERVER_IMAGE` is set. The default workerd build remains independent. The default server image is built locally. Overrides are unvalidated experiments; preserve PostgreSQL 18's layout, helper users, extension compatibility and RustFS's unversioned storage contract. Use fresh storage and explicit migration for incompatible stateful images. See [checkpoint prerequisites](../backup/README.md).

Existing environment values and unrelated lines are preserved. Use literal assignments, quoting values containing spaces. Empty managed assignments are preparation placeholders, except `COMPOSE_PROFILES`, whose empty value selects core only. Duplicate, interpolated or malformed managed assignments require repair, including duplicate empty placeholders. Unrelated lines, including duplicate assignments and interpolations, remain verbatim. Existing data volumes with missing secrets require restoration of the original secrets. Preparation rejects remote Docker endpoints and unsafe files. Owned `.env` files are tightened to mode `0600`.

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

Storage initialization runs as the shared-image `storage-init` one-shot after
migrations and data-directory setup, before the server verifies store identity
and content. It initializes only an empty installation. The
[storage identity procedure](../../docs/operations/storage-identity.md) also documents
explicit operator commands and fenced adoption for an existing unbound installation. Crash leftovers can be
recorded for permanent retention without deleting or moving their bytes.

Fresh Files preparation generates a 40-character scoped S3 secret, within RustFS’s
service-account creation limit. Existing credentials are preserved. If an earlier
uncompleted installation generated a longer `BP_BLOB_S3_SECRET_KEY`, preparation may
report `compose_command_failed` when RustFS refuses creation. Keep all other secrets
and replace that value with a generated 40-character secret before rerunning
preparation; do not rotate a serving installation as a bootstrap repair. Readiness
or enrollment state cannot prove that a credential is unused: an existing
installation may be stopped, and RustFS accepts longer secrets through its
account-update path. Preparation therefore never silently repairs existing credentials.
