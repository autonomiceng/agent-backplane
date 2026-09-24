# Access setup

How the server is reached: the three access modes, the one browser origin, Platform Edge,
Tailscale, local certificate trust, and the RustFS console.

- [Modes](#modes)
- [Local Mode (default)](#local-mode-default)
- [Public Mode](#public-mode)
- [Behind Platform Edge](#behind-platform-edge)
- [Tailscale](#tailscale)
- [Shared network](#shared-network)
- [Browser address for authentication](#browser-address-for-authentication)
- [Local certificate trust](#local-certificate-trust)
- [Verification](#verification)
- [Upgrading from the internal gateway](#upgrading-from-the-internal-gateway)
- [Native RustFS console](#native-rustfs-console)
- [Troubleshooting](#troubleshooting)

## Modes

Choose `BP_ACCESS_MODE` with `--access-mode` or in the environment file used by bootstrap:

| Mode | What you get | Setup |
| --- | --- | --- |
| Local (`local`, default) | HTTP and self-signed HTTPS, no domain needed | Add `--profile edge` for both protocols. Core alone serves HTTP on port 3000. |
| Public (`public`) | Automatically renewed trusted HTTPS certificates for your own domain | Set `BP_PUBLIC_DOMAIN`, publish the edge on `BP_BIND_HOST=0.0.0.0`, and add `--profile edge`. |
| Behind Platform Edge or another gateway (`proxy`) | That gateway handles HTTPS and reaches the server directly | Pass `--access-mode proxy --public-url` with the gateway's backplane URL and omit `--profile edge`. |

## Local Mode (default)

Run bootstrap from this checkout with an existing encrypted backup mount:

```sh
python3 scripts/bootstrap.py --access-mode local --profile edge \
  --backup-dir /mnt/backplane-backups --capability-file "$HOME/.bp-enrollment"
```

The local edge serves HTTP on port 80 and HTTPS on port 443 together, without redirecting HTTP or telling browsers to require HTTPS. Bootstrap defaults the configured browser address to `http://localhost` for that setup. Without the edge profile it defaults to `http://localhost:3000`. Set `BP_HTTP_PORT`, `BP_HTTPS_PORT` or `BP_PORT` before bootstrap to change the published ports. Core's container always receives HTTP on port 3000 and its host port stays on `127.0.0.1`.

The local HTTPS listener covers `localhost`, `127.0.0.1`, and `backplane.localhost`. With `BP_PUBLIC_DOMAIN=example.com`, the configured hostname becomes `backplane.example.com` and bootstrap defaults to its HTTPS origin. Set up DNS or a hosts entry for a custom hostname. Local HTTPS clients need the trust setup below.

## Public Mode

Put `BP_ACCESS_MODE=public`, `BP_PUBLIC_DOMAIN=example.com`, and `BP_BIND_HOST=0.0.0.0` in the selected environment file, then run bootstrap with `--profile edge`. Point `backplane.example.com` at this host and allow inbound ports 80 and 443. A loopback bind is also supported if a separate TCP forwarder makes those ports publicly reachable; a loopback bind alone cannot obtain public certificates. HTTP redirects to the configured HTTPS address; `/health` stays available over HTTP for health checks. HTTPS tells browsers to require HTTPS on future visits.

## Behind Platform Edge

Edge's bundle installer (`python3 scripts/bootstrap.py --with backplane --capability-file PATH`
in the Edge checkout) writes `BP_ACCESS_MODE=proxy`, `BP_PUBLIC_URL`, the bind and port
settings and the Platform Network allocation into this stack's `.env`, then runs this
bootstrap with `--access-mode proxy --public-url URL`. By hand, run bootstrap with
`--access-mode proxy --public-url <exact external URL>` and no ingress profile.
Edge reaches the server directly at `bp-server:3000` on `BP_PLATFORM_NETWORK` (default `platform`); no Backplane Caddy runs, and the `gateway` profile is refused (`gateway_profile_retired`, see [Upgrading from the internal gateway](#upgrading-from-the-internal-gateway)).
Edge owns certificates, HTTP-to-HTTPS redirects, the operator-route exclusion and SSE pass-through; the server strips forwarded headers and authenticates on `BP_PUBLIC_URL` (ADR-0021).

## Shared network

The Platform Network has one allocation on every host, defined in the [platform contract](../conventions.md#platform-contract): subnet `172.30.0.0/24` (`BP_PLATFORM_SUBNET`), dynamic range `172.30.0.128/25` (`BP_PLATFORM_IP_RANGE`) and gateway `172.30.0.1`, the subnet's first host. Platform Edge holds the reserved address `172.30.0.2` outside the dynamic range. Whichever bootstrap runs first creates the network with these parameters. Bootstrap validates an existing network and refuses a different subnet, range or gateway, or a network with no IPv4 IPAM configuration, with `platform_network_mismatch` and the observed and expected values. To repair a network created before this contract, stop every stack on it, run `docker network rm` on the network the error names, then rerun bootstrap. Bootstrap also refuses a dynamic range that contains Edge's reserved address.

Bootstrap preserves existing secrets and rejects conflicting mode/origin settings before starting services. Set one mode directly; the previous scheme, issuer and edge override settings (`BP_SCHEME`, `BP_TLS_ISSUER`, `BP_EDGE_CA`, `BP_PUBLIC_HOST`, `BP_EDGE_BIND_HOST`) are refused with `unsupported_setting`, which names each key and its replacement. The standalone edge issues certificates from its internal CA (local) or Let's Encrypt (public) only; for a private ACME CA or certificate files, run behind Platform Edge, which has `PE_TLS_ISSUER`. No configuration or data migration runs. Existing volume names and backup contents remain unchanged. On a host with several deployments, choose distinct `BP_VOLUME_PREFIX` and `BP_PLATFORM_NETWORK` values so the `bp-server` alias resolves uniquely; each additional network needs its own non-overlapping `BP_PLATFORM_SUBNET` and `BP_PLATFORM_IP_RANGE`.

## Tailscale

Private access from your own devices without exposing anything to the internet.

**Behind Platform Edge** (shared host): Edge runs one Tailscale node per hostname and gives
the backplane the origin `https://backplane.<tailnet>.ts.net`. Its
`python3 scripts/bootstrap.py --tailscale --with backplane --capability-file PATH` writes
that origin as `BP_PUBLIC_URL` and reruns this bootstrap; nothing else changes here. See
Edge's [Tailscale setup](https://github.com/autonomiceng/platform-edge/blob/main/docs/operations/tailscale.md).

**Standalone**: not offered. The server alone serves its operator routes
(`/health/operations`, `/metrics`) on the same port as the application, and ADR-0021
requires any proxy in front of the server to exclude them; the standalone `edge` profile
does that but accepts only its own certificate names as the browser origin, not a tailnet
name. Put the server behind Platform Edge for tailnet access. A host `tailscale serve`
pointed at `127.0.0.1:3000` would work technically, but it exposes the token-gated
operator routes to every tailnet device the access rule admits, which the contract forbids.

## Browser address for authentication

`BP_PUBLIC_URL` is one configured origin, even when both listener protocols are available. Choose the address used for browser login and the CLI. A local edge accepts an explicitly selected HTTP loopback origin or HTTPS origin on one of its certificate names and corresponding published ports. Other listener addresses can serve requests, but authenticated browser mutations still require the configured browser Origin; sessions and secure-cookie attributes follow its scheme. Public mode requires the derived `https://backplane.<BP_PUBLIC_DOMAIN>` origin, including a non-default HTTPS port. Behind another gateway, bootstrap preserves the configured gateway origin.

Origins normalize case, IDNA and default ports. Credentials, paths, query strings, fragments, whitespace and backslashes are rejected. `BP_AUTH_URL` is unsupported: bootstrap refuses any assignment of it, even empty, with `unsupported_setting`, and the server refuses to start with a non-empty value; use `BP_PUBLIC_URL`. CLI and MCP accept `BP_PUBLIC_URL` or the CLI endpoint setting `BP_URL` and reject conflicts before sending credentials. They never follow credential-bearing redirects.

HTTP authentication requires a loopback origin unless a directly launched server explicitly enables `BP_ALLOW_INSECURE_ORIGIN=true`. Compose does not pass that override. HTTP appears as an `insecure_origin` readiness diagnostic without changing readiness status. Sign-up remains closed by default; initial enrollment still uses the protected capability file.

The server strips `Forwarded`, every `X-Forwarded-*`, `X-Real-IP`, `CF-Connecting-IP` and `True-Client-IP`. It never derives an authentication origin from a request Host header. The configured scheme determines cookie security through the HTTP upstream connection. Both standalone listeners exclude operator routes (`/health/operations`, `/metrics` and normalized variants) and strip Authorization from public readiness. Operators use the loopback server port with `BP_OPERATIONS_TOKEN`.

The standalone edge shares only the project network with the server; Platform Edge reaches the server over the external Platform Network. Trust the host and Docker peers, restrict Docker access and network membership, and isolate untrusted peers. Custom gateways must preserve browser Origin and Fetch Metadata and carry SSE without buffering or a stream lifetime limit. See [ADR-0021](../adr/0021-proxy-trust-boundary.md).

## Local certificate trust

Local mode uses a self-signed root certificate to sign the server certificates. Public mode obtains and renews trusted certificates for your domain. Caddy stores certificates and private CA keys in `edge-data`, with configuration state in `edge-config`. Preserve and back up both securely. Automatic trust installation is disabled. Export only the public root certificate from the matching Compose project:

```sh
docker compose --env-file .env --project-name agent-backplane \
  -f compose.yaml -f compose.edge.yaml --profile edge \
  cp edge:/data/caddy/pki/authorities/local/root.crt ./edge-root.crt
```

Use the same environment file and project name as bootstrap: replace `.env` if you supplied `--env-file PATH`, and replace `agent-backplane` if you supplied `--compose-project NAME`.

Verify and distribute that certificate through an authenticated channel, then install it into each browser, OS or runtime trust store. Never distribute `root.key` or disable certificate verification. If choosing a configured HTTPS address for local bootstrap, install trust before running the emitted `bp bootstrap` command. See [Caddy local HTTPS](https://caddyserver.com/docs/automatic-https#local-https).

## Verification

Configuration tests render isolated environment files without contacting Docker's daemon; the bootstrap tests use a fake runner and never call Docker:

```sh
python3 -m unittest discover -s tests -p 'test_bootstrap*.py'
bun test infra/compose/compose.test.ts apps/server/platform/config.test.ts
```

The disposable listener probes require Docker with journald and the pinned Caddy image already cached. They use a unique project, random loopback ports, a dedicated network with outbound certificate requests blocked, and temporary certificate storage. Only the public CA certificate is exported. No application database or installed deployment is used:

```sh
bun tests/acceptance/access-modes.ts
```

These three probes cover local dual protocols, verified hostname/localhost/IP certificates, and public HTTP redirects with the health exception. Public certificate issuance and renewal require reachable public DNS and cannot be proven by this isolated probe.

The existing application ingress acceptance uses a disposable, enrolled local core plus edge deployment with a configured HTTPS address. Supply its matching environment and project, `BP_EDGE_CA_CERT`, `BP_USER_EMAIL`, `BP_USER_PASSWORD`, and `BP_OPERATIONS_TOKEN`, then run `bun tests/acceptance/public-ingress.ts`. It checks cookie/CSRF policy, operator exclusions, actual loopback bindings and SSE lifetime/resume through Caddy. Missing prerequisites fail. For direct application checks against temporary PostgreSQL, run `bun run test apps/server/platform/forwarded-headers.test.ts`.

## Upgrading from the internal gateway

Installations prepared before 2026-09-24 ran a second Caddy (`compose.gateway.yaml`, profile
`gateway`, alias `bp-gateway:80`) behind Platform Edge. That overlay is gone. In the private
environment file bootstrap records:

1. Remove `gateway` from `COMPOSE_PROFILES` (for example `'gateway,blobs,compute'` becomes `'blobs,compute'`, or `''` for core only).
2. Remove the `compose.gateway.yaml` entry from `COMPOSE_FILE`, keeping the order of the rest.
3. Delete the `BP_TRUSTED_PROXIES`, `BP_RUSTFS_CONSOLE`, `BP_RUSTFS_CONSOLE_ALLOW`, `BP_RUSTFS_HOST`, `BP_RUSTFS_URL`, `BP_RUSTFS_URL_HOST` and `BP_RUSTFS_AUTHORITY` lines; nothing reads them.
4. Rerun `python3 scripts/bootstrap.py` with the same `--env-file` and `--compose-project` as before. It refuses with `gateway_profile_retired` until steps 1 and 2 are done, and never edits the selection itself.
5. Remove the orphaned gateway container, which the reduced selection leaves running: `docker compose --env-file <the same env file> up -d --remove-orphans`, with `--project-name <the same project>` when bootstrap used one; the recorded `COMPOSE_FILE` in that file selects the services. Its `edge-data` and `edge-config` volumes hold internal CA state and stay until you delete them deliberately.
6. Re-run Platform Edge's bootstrap so it renders the direct `bp-server:3000` routes.

Standalone `edge` installations (local or public mode) are unaffected.

## Native RustFS console

RustFS serves its human console on port 9001 in the `rustfs` container, on the internal
`blob-internal` network only: no Caddy publishes it, it has no host port, and nothing on the
Platform Network reaches it. Root login with `BP_RUSTFS_ROOT_USER` and
`BP_RUSTFS_ROOT_PASSWORD` from the private environment file is required. These are human
administration credentials, not Backplane User credentials; agents use the Files API with
Principal and Run context so provenance is recorded.

For an administration session, address the container directly from the host. Docker refuses
to publish a port for a container that sits only on an internal network, so use its address:

```sh
ip="$(docker inspect --format '{{ (index .NetworkSettings.Networks "agent-backplane_blob-internal").IPAddress }}' \
  "$(docker compose --env-file <the bootstrap env file> ps -q rustfs)")"
echo "http://$ip:9001/rustfs/console/"
```

Use the env file bootstrap wrote (`.env` by default) and, when bootstrap used
`--compose-project`, that project name in place of `agent-backplane` in the network name.
Open the printed address in a browser on the host. From another machine, copy the printed
address and forward it over SSH, `ssh -L 9001:<printed address>:9001 <host>`, then open
`http://localhost:9001/rustfs/console/`. The session is plaintext HTTP inside the host;
close the tunnel when done. The address changes when the container is recreated.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `unsupported_setting` | `.env` holds a retired key; the message names it and its replacement. Delete the line. |
| `invalid_public_url` | `BP_PUBLIC_URL` (or `--public-url`) is not a bare `http(s)://host[:port]` origin. Remove path, query, credentials or whitespace. |
| `invalid_access_settings` naming HTTP | A non-loopback HTTP origin needs HTTPS (an edge, Edge or Tailscale) or the explicit `BP_ALLOW_INSECURE_ORIGIN=true` for a directly launched server. |
| `selection_conflict` | The `--profile` set differs from the recorded `COMPOSE_PROFILES`. Rerun without `--profile`, or edit the recorded selection deliberately ([bootstrap](../../infra/bootstrap/README.md)). |
| `gateway_profile_retired` | A recorded `gateway` profile from before 2026-09-24. Follow [upgrading from the internal gateway](#upgrading-from-the-internal-gateway). |
| `platform_network_mismatch` | The shared network exists with another allocation. Stop every stack on it, `docker network rm` the network the error names, rerun bootstrap. |
| Login works over HTTP but not over the edge | The browser origin differs from `BP_PUBLIC_URL`. Use the configured origin exactly; the server never derives one from the request Host. |
| Certificate warning on a local HTTPS address | Install the exported public root ([local certificate trust](#local-certificate-trust)); never disable verification. |
