#!/bin/sh
# Retire the version 1 status timer and its records (Status v2 upgrade step). Safe to rerun.
# Usage: retire-status-timer.sh [env-file], the env file bootstrap used (default: .env).
set -eu
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
units=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
name=agent-backplane-status
# The records live under the installation's BP_STATUS_DIR, as bootstrap saved it.
env_file=${1:-$root/.env}
if [ ! -r "$env_file" ]; then
  echo "cannot read env file: $env_file" >&2
  exit 1
fi
state=$(sed -n 's/^BP_STATUS_DIR=//p' "$env_file" | tail -n 1)
state=${state#[\"\']}
state=${state%[\"\']}
state=${state:-./data}
case $state in /*) ;; *) state=$root/$state ;; esac
# Name only units whose files exist; systemctl fails on a missing one.
set --
for unit in "$name.timer" "$name.service"; do
  [ ! -e "$units/$unit" ] || set -- "$@" "$unit"
done
if [ "$#" -gt 0 ]; then
  systemctl --user disable --now "$@"
  for unit in "$@"; do
    rm -f -- "$units/$unit"
    echo "disabled and removed $unit"
  done
  systemctl --user daemon-reload
else
  echo "no $name units in $units"
fi
# The version 1 document is no longer mounted or served; nothing replaces it on disk.
for file in "$state/status/bootstrap.json" "$state/status/observer.lock" "$state/console/status.json"; do
  if [ -e "$file" ]; then
    rm -f -- "$file"
    echo "removed $file"
  fi
done
for dir in "$state/status" "$state/console"; do
  if [ -d "$dir" ] && rmdir -- "$dir" 2>/dev/null; then
    echo "removed $dir"
  fi
done
