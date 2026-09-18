# Public origin and ingress

Core Compose defaults `BP_PUBLIC_URL` to `http://localhost:${BP_PORT:-3000}`. The edge overlay derives `https://backplane.<BP_PUBLIC_DOMAIN>` when `BP_SCHEME=https` and `BP_PUBLIC_URL` is unset, including `BP_HTTPS_PORT` when explicitly set. A derived plain-HTTP non-loopback origin is unsupported. `BP_PUBLIC_URL` remains an explicit override for one release, and deprecated `BP_AUTH_URL` remains a fallback; if aliases are set, their normalized origins must match. Origins accept HTTP(S), a hostname or IP, and an optional port and root slash. Credentials, paths, query strings, fragments, whitespace and backslashes are rejected. Case, IDNA and default ports normalize before comparison.

HTTP is allowed only for `localhost`, literal `127.0.0.0/8` or `::1`, without DNS lookup, unless a directly launched server explicitly sets `BP_ALLOW_INSECURE_ORIGIN=true`. The flag accepts only `true` or `false`. Every HTTP origin reports `insecure_origin` in readiness problems; that diagnostic does not change readiness status. `BP_SIGNUP` defaults to `closed`; the one-time enrollment capability remains the source of initial authority. Open sign-up is effective only on loopback origins.

The CLI and MCP resolve `BP_PUBLIC_URL`, then `BP_URL`, then `BP_AUTH_URL`. Configured aliases must identify the same origin before any credential is sent. They reject non-loopback HTTP even when the server override is enabled and never follow credential-bearing redirects. Login uses that same origin for its Origin header and stored session identity.

Core Compose publishes only the server on `127.0.0.1`; Postgres remains unpublished. The development overlay can publish Postgres on loopback. The server receives an explicit environment allowlist. The blobs and compute overlays supply their own server keys. Host `.env` values are Compose interpolation inputs, and the server has no `env_file`. The core allowlist does not pass the insecure HTTP override.

Supply `BP_OPERATIONS_*` thresholds through a Compose override; empty passthrough values become zero and fail operations configuration validation.

## Optional Caddy edge

Export these settings before starting Compose (or put them in the root `.env` and use `--env-file .env` with Compose):

```sh
export BP_PUBLIC_DOMAIN=example.com
export BP_SCHEME=https
export BP_TLS_ISSUER=acme
mise exec -- bun infra/compose/validate-edge.ts
docker compose -f compose.yaml -f compose.edge.yaml --profile edge up -d --build
```

If bootstrap created the root `.env`, replace its exact `BP_PUBLIC_URL=http://localhost:3000` line with `BP_PUBLIC_URL=https://backplane.example.com` before running preflight. Include the explicit HTTPS port when it is not 443.

Supply core's `BP_AUTH_SECRET` and encrypted backup mount `BP_BACKUP_DIR` as usual. The preflight computes values with the same environment precedence as Compose and validates the scheme, hostname, issuer, loopback core binding and exact HTTPS-origin agreement. The overlay uses `BP_HTTP_PORT` and `BP_HTTPS_PORT`, which default to 80 and 443. For standalone public ingress, set `BP_EDGE_BIND_HOST=0.0.0.0`, keep `BP_BIND_HOST=127.0.0.1`, point the hostname at this host and permit inbound 80/443 for ACME issuance. On a shared host, keep this repository’s edge profile off. The platform edge forwards public application traffic to `bp-server:3000` over the external network selected by `BP_PLATFORM_NETWORK` (default `platform`).

Edge and server share the project default network and the external platform network;
the service name `server` resolves on both. Only server-to-workerd traffic is confined
to the default network. Every platform peer can reach the plaintext server. Trust the
host and peers on both networks, restrict Docker access and network membership, and
isolate untrusted peers or use authenticated HTTPS for upstream traffic.

Port 80 redirects to the configured HTTPS hostname. HTTPS alone sends HSTS. Both listeners return 404 for `/health/operations`, `/metrics`, their descendants and normalized-path variants, even with an operator token, and strip `Authorization` from `/health/ready`, its trailing slash and descendants so the public form (enrollment state, status, problem codes) is all the internet can see. Operators use the loopback server port with `BP_OPERATIONS_TOKEN` for readiness details.

The server ignores `Forwarded`, every `X-Forwarded-*`, `X-Real-IP`, `CF-Connecting-IP` and `True-Client-IP`. The configured origin determines authentication and secure cookies through an HTTP upstream connection. Custom proxies must terminate TLS, exclude operator paths, preserve browser Origin and Fetch Metadata, and carry SSE without buffering or a stream lifetime limit. Caddy's default SSE flushing preserves client-disconnect cancellation; do not set `flush_interval -1`. See [Caddy streaming behavior](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#streaming) and [ADR-0021](../adr/0021-proxy-trust-boundary.md).

## Internal CA

For private deployments, use `BP_TLS_ISSUER=internal`. Caddy stores certificates and CA keys in `edge-data`, with configuration state in `edge-config`. Back up both securely and preserve them during recovery. Export only the public root certificate:

```sh
docker compose -f compose.yaml -f compose.edge.yaml --profile edge \
  cp edge:/data/caddy/pki/authorities/local/root.crt ./edge-root.crt
```

Verify and distribute that certificate through an authenticated channel, then manually install it into each browser, OS or runtime trust store. Never distribute `root.key` or disable certificate verification. The overlay deliberately disables automatic trust installation. Ensure `backplane.${BP_PUBLIC_DOMAIN}` resolves to the edge, using private DNS or a local hosts entry. `BP_PUBLIC_HOST` and `BP_EDGE_CA` remain explicit compatibility overrides for one release. See [Caddy local HTTPS](https://caddyserver.com/docs/automatic-https#local-https).

## Release acceptance

After enrolling the first User with bp bootstrap, run the single edge acceptance scenario against the running core and edge deployment:

```sh
export BP_EDGE_CA_CERT="$PWD/edge-root.crt"
export BP_USER_EMAIL="<enrolled-user-email>"
export BP_USER_PASSWORD="<enrolled-user-password>"
export BP_OPERATIONS_TOKEN="<configured-operator-token>"
mise exec -- bun tests/acceptance/public-ingress.ts
```

Keep the same Compose project name and environment for startup and acceptance (`COMPOSE_PROJECT_NAME` selects a custom project). Acceptance requires Docker, the running core and edge services, the internal CA root, and enrolled credentials. It verifies TLS hostname and chain, redirect and HSTS, operator exclusions, actual loopback bindings, login, SSE ready/heartbeat delivery, disconnect cleanup and exclusive ordered resume. Readiness checks send the operations bearer over TLS to `/health/ready` and `/health/ready/` and require only the public response keys. Public HTTP exclusion probes use a decoy bearer; the real operations token is sent only over HTTPS or to the validated loopback operator address. Missing prerequisites fail. It creates one Workspace and two Principals through the API; use a disposable release deployment. Run the two embedded application scenarios with `mise exec -- bun run test`.
