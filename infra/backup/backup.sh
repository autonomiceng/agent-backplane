#!/usr/bin/env bash
# BP_BACKUP_ADMIN_URL_FILE names an operator-owned mode 0600 credential file.
# Arguments: DATA_DIR BACKUP_DIR ARCHIVE_DIR PG_BIN_DIR.
set -euo pipefail
script_root=$(cd "$(dirname "$0")/../.." && pwd)
exec bun "$script_root/apps/server/restore/backup-restore.ts" backup "$@"
