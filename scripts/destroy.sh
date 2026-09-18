#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
project=${1:?Usage: scripts/destroy.sh PROJECT [Compose options]}
shift
[[ "$project" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || { echo 'Invalid project name' >&2; exit 1; }
printf 'Destroy durable volumes for %s. Type the project name: ' "$project" >&2
read -r confirmation
[[ "$confirmation" == "$project" ]] || { echo 'Destroy refused: project name does not match' >&2; exit 1; }
volumes=$(docker compose --project-name "$project" "$@" config --format json | python3 -c '
import json, re, sys
config = json.load(sys.stdin)
volumes = [v["name"] for v in config.get("volumes", {}).values()]
if not volumes or any(not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]*", v) for v in volumes):
    raise SystemExit("Destroy refused: invalid volume inventory")
print("\n".join(volumes))
')
while IFS= read -r volume; do
  if docker volume inspect "$volume" >/dev/null 2>&1; then
    owner=$(docker volume inspect --format '{{index .Labels "com.docker.compose.project"}}' "$volume")
    [[ "$owner" == "$project" ]] || { echo "Destroy refused: volume $volume belongs to another project" >&2; exit 1; }
  fi
done <<< "$volumes"
docker compose --project-name "$project" "$@" down --remove-orphans
while IFS= read -r volume; do
  if docker volume inspect "$volume" >/dev/null 2>&1; then
    docker volume rm "$volume"
  fi
done <<< "$volumes"
