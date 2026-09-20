# Access setup

Choose `BP_ACCESS_MODE` in the environment file used by preparation:

| Mode | What you get | Setup |
| --- | --- | --- |
| Local (`local`, default) | HTTP and self-signed HTTPS, no domain needed | Add `--profile edge` for both protocols. Core alone serves HTTP on port 3000. |
| Public (`public`) | Automatically renewed trusted HTTPS certificates for your own domain | Set `BP_PUBLIC_DOMAIN`, publish the edge on `BP_BIND_HOST=0.0.0.0`, and add `--profile edge`. |
| Behind another gateway (`proxy`) | That gateway handles HTTPS; this stack receives HTTP internally | Set `BP_PUBLIC_URL` to the gateway's backplane URL and omit `--profile edge`. |

For local mode, run preparation from this checkout with an existing encrypted backup mount:

```sh
bun infra/bootstrap/prepare.ts --access-mode local --profile edge \
  --backup-dir /mnt/backplane-backups --capability-file "$HOME/.bp-enrollment"
```

The local edge serves HTTP on port 80 and HTTPS on port 443 together, without redirecting HTTP or telling browsers to require HTTPS. Preparation defaults the configured browser address to `http://localhost` for that setup. Without the edge profile it defaults to `http://localhost:3000`. Set `BP_HTTP_PORT`, `BP_HTTPS_PORT` or `BP_PORT` before preparation to change the published ports. Core's container always receives HTTP on port 3000 and its host port stays on `127.0.0.1`.

The local HTTPS listener covers `localhost`, `127.0.0.1`, and `backplane.localhost`. With `BP_PUBLIC_DOMAIN=example.com`, the configured hostname becomes `backplane.example.com` and preparation defaults to its HTTPS origin. Set up DNS or a hosts entry for a custom hostname. Local HTTPS clients need the trust setup below.

For public mode, put `BP_ACCESS_MODE=public`, `BP_PUBLIC_DOMAIN=example.com`, and `BP_BIND_HOST=0.0.0.0` in the selected environment file, then run preparation with `--profile edge`. Point `backplane.example.com` at this host and allow inbound ports 80 and 443. A loopback bind is also supported if a separate TCP forwarder makes those ports publicly reachable; a loopback bind alone cannot obtain public certificates. HTTP redirects to the configured HTTPS address; `/health` stays available over HTTP for health checks. HTTPS tells browsers to require HTTPS on future visits.

For Platform Edge, use `BP_ACCESS_MODE=proxy` and the exact external `BP_PUBLIC_URL`. Preparation starts core without a standalone Caddy. Platform Edge forwards to `bp-server:3000` on `BP_PLATFORM_NETWORK` (default `platform`). The gateway owns certificate issuance, HTTP redirects and operator-route exclusions. Keep the standalone edge profile off when another gateway owns ports 80 and 443.

Preparation preserves existing secrets and rejects conflicting mode/origin settings before starting services. Set one mode directly; the previous scheme, issuer and edge override settings are unsupported. No configuration or data migration runs. Existing volume names and backup contents remain unchanged. On a host with several deployments, choose distinct `BP_VOLUME_PREFIX` and `BP_PLATFORM_NETWORK` values so the `bp-server` and `bp-gateway` aliases resolve uniquely.

## Browser address for authentication

`BP_PUBLIC_URL` is one configured origin, even when both listener protocols are available. Choose the address used for browser login and the CLI. A local edge accepts an explicitly selected HTTP loopback origin or HTTPS origin on one of its certificate names and corresponding published ports. Other listener addresses can serve requests, but authenticated browser mutations still require the configured browser Origin; sessions and secure-cookie attributes follow its scheme. Public mode requires the derived `https://backplane.<BP_PUBLIC_DOMAIN>` origin, including a non-default HTTPS port. Behind another gateway, preparation preserves the configured gateway origin.

Origins normalize case, IDNA and default ports. Credentials, paths, query strings, fragments, whitespace and backslashes are rejected. `BP_AUTH_URL`, if supplied separately, must normalize to the same configured browser address; it no longer supplies a fallback origin. CLI and MCP accept `BP_PUBLIC_URL` or the CLI endpoint setting `BP_URL` and reject conflicts before sending credentials. They never follow credential-bearing redirects.

HTTP authentication requires a loopback origin unless a directly launched server explicitly enables `BP_ALLOW_INSECURE_ORIGIN=true`. Compose does not pass that override. HTTP appears as an `insecure_origin` readiness diagnostic without changing readiness status. Sign-up remains closed by default; initial enrollment still uses the protected capability file.

The server strips `Forwarded`, every `X-Forwarded-*`, `X-Real-IP`, `CF-Connecting-IP` and `True-Client-IP`. It never derives an authentication origin from a request Host header. The configured scheme determines cookie security through the HTTP upstream connection. Both standalone listeners exclude operator routes (`/health/operations`, `/metrics` and normalized variants) and strip Authorization from public readiness. Operators use the loopback server port with `BP_OPERATIONS_TOKEN`.

Edge and server share the project network and external platform network. Trust the host and Docker peers, restrict Docker access and network membership, and isolate untrusted peers. Custom gateways must preserve browser Origin and Fetch Metadata and carry SSE without buffering or a stream lifetime limit. See [ADR-0021](../adr/0021-proxy-trust-boundary.md).

## Local certificate trust

Local mode uses a self-signed root certificate to sign the server certificates. Public mode obtains and renews trusted certificates for your domain. Caddy stores certificates and private CA keys in `edge-data`, with configuration state in `edge-config`. Preserve and back up both securely. Automatic trust installation is disabled. Export only the public root certificate from the matching Compose project:

```sh
docker compose --env-file .env --project-name agent-backplane \
  -f compose.yaml -f compose.edge.yaml --profile edge \
  cp edge:/data/caddy/pki/authorities/local/root.crt ./edge-root.crt
```

Use the same environment file and project name as preparation: replace `.env` if you supplied `--env-file PATH`, and replace `agent-backplane` if you supplied `--compose-project NAME`.

Verify and distribute that certificate through an authenticated channel, then install it into each browser, OS or runtime trust store. Never distribute `root.key` or disable certificate verification. If choosing a configured HTTPS address for local bootstrap, install trust before running the emitted `bp bootstrap` command. See [Caddy local HTTPS](https://caddyserver.com/docs/automatic-https#local-https).

## Verification

Configuration tests render isolated environment files without contacting Docker's daemon:

```sh
bun test infra/bootstrap/prepare.test.ts infra/compose/validate-edge.test.ts infra/compose/compose.test.ts apps/server/platform/config.test.ts
```

The disposable listener probes require Docker with journald and the pinned Caddy image already cached. They use a unique project, random loopback ports, a dedicated network with outbound certificate requests blocked, and temporary certificate storage. Only the public CA certificate is exported. No application database or installed deployment is used:

```sh
bun tests/acceptance/access-modes.ts
```

These three probes cover local dual protocols, verified hostname/localhost/IP certificates, and public HTTP redirects with the health exception. Public certificate issuance and renewal require reachable public DNS and cannot be proven by this isolated probe.

The existing application ingress acceptance uses a disposable, enrolled local core plus edge deployment with a configured HTTPS address. Supply its matching environment and project, `BP_EDGE_CA_CERT`, `BP_USER_EMAIL`, `BP_USER_PASSWORD`, and `BP_OPERATIONS_TOKEN`, then run `bun tests/acceptance/public-ingress.ts`. It checks cookie/CSRF policy, operator exclusions, actual loopback bindings and SSE lifetime/resume through Caddy. Missing prerequisites fail. For direct application checks against temporary PostgreSQL, run `bun run test apps/server/platform/forwarded-headers.test.ts`.
