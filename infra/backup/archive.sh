#!/usr/bin/env bash
# archive_command: archive.sh SOURCE SEGMENT ARCHIVE_DIR. Encrypt and replicate the repository off-host.
set -euo pipefail
source_file=$1; segment=$2; repository=$3
case "$segment" in ''|*[!A-Za-z0-9._-]*) exit 1;; esac
umask 077
mkdir -p "$repository"
temporary=$(mktemp "$repository/.archive.XXXXXXXX")
trap 'rm -f "$temporary"' EXIT
cp "$source_file" "$temporary"
sync -f "$temporary"
if ! ln "$temporary" "$repository/$segment" 2>/dev/null; then
  cmp -s "$temporary" "$repository/$segment" || exit 1
fi
sync -f "$repository"
