#!/bin/sh
# Trusted operator entrypoint. Measure the executable before starting the loader.
set -eu
if [ -n "${BP_WORKERD_DIGEST:-}${BP_WORKERD_REPOSITORY:-}" ]; then
  echo 'legacy workerd image configuration requires migration' >&2
  exit 1
fi
reference=${BP_WORKERD_IMAGE:-}
invalid_reference() {
  echo 'invalid BP_WORKERD_IMAGE reference' >&2
  exit 1
}
[ "${#reference}" -le 512 ] || invalid_reference
case "$reference" in
  *@*)
    suffix=${reference#*@sha256:}
    case "$suffix" in *[!0-9a-f]*|'') invalid_reference;; esac
    [ "${#suffix}" -eq 64 ] || invalid_reference
    ;;
esac
name=${reference%%@*}
case "$name" in ''|[!A-Za-z0-9]*|*[!A-Za-z0-9._:/-]*|*//*|*/|*:) invalid_reference;; esac
expected=${BP_WORKERD_BINARY_SHA256:?required}
case "$expected" in *[!0-9a-f]*|'') exit 1;; esac
[ "${#expected}" -eq 64 ] || exit 1
observed=$(sha256sum /usr/bin/workerd)
observed=${observed%% *}
if [ "$observed" != "$expected" ]; then
  echo 'workerd binary identity mismatch' >&2
  exit 1
fi
export BP_WORKERD_RUNTIME_ID="workerd-binary-sha256:$observed"
control=$(cd /compute && sha256sum loader.js config.capnp start.sh supervisor.ts child-process.ts)
control=$(printf '%s\n' "$control" | sha256sum)
export BP_WORKERD_CONTROL_SHA256="${control%% *}"
exec /usr/bin/bun /compute/supervisor.ts "$@"
