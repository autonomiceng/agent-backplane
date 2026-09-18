#!/usr/bin/env bash
# Arguments: ADMIN_URL DATA_DIR BACKUP_DIR ARCHIVE_DIR PG_BIN_DIR.
set -euo pipefail
script_root=$(cd "$(dirname "$0")/../.." && pwd)
exec bun "$script_root/apps/server/restore/backup-restore.ts" backup "$@"
