#!/usr/bin/env bash
set -euo pipefail
script_root=$(cd "$(dirname "$0")/.." && pwd)
exec python3 -B "$script_root/scripts/checkpoint.py" backup "$@"
