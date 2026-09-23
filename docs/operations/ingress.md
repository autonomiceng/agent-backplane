# Access setup

Choose `BP_ACCESS_MODE` with `--access-mode` or in the environment file used by bootstrap:

| Mode | What you get | Setup |
| --- | --- | --- |
| Local (`local`, default) | HTTP and self-signed HTTPS, no domain needed | Add `--profile edge` for both protocols. Core alone serves HTTP on port 3000. |
| Public (`public`) | Automatically renewed trusted HTTPS certificates for your own domain | Set `BP_PUBLIC_DOMAIN`, publish the edge on `BP_BIND_HOST=0.0.0.0`, and add `--profile edge`. |
| Behind another gateway (`proxy`) | That gateway handles HTTPS; this stack receives HTTP internally | Pass `--access-mode proxy --public-url` with the gateway's backplane URL and omit `--profile edge`. |

For local mode, run bootstrap from this checkout with an existing encrypted backup mount:

```sh
python3 scripts/bootstrap.py --access-mode local --profile edge \
  --backup-dir /mnt/backplane-backups --capability-file "$HOME/.bp-enrollment"
```

The local edge serves HTTP on port 80 and HTTPS on port 443 together, without redirecting HTTP or telling browsers to require HTTPS. Bootstrap defaults the configured browser address to `http://localhost` for that setup. Without the edge profile it defaults to `http://localhost:3000`. Set `BP_HTTP_PORT`, `BP_HTTPS_PORT` or `BP_PORT` before bootstrap to change the published ports. Core's container always receives HTTP on port 3000 and its host port stays on `127.0.0.1`.

The local HTTPS listener covers `localhost`, `127.0.0.1`, and `backplane.localhost`. With `BP_PUBLIC_DOMAIN=example.com`, the configured hostname becomes `backplane.example.com` and bootstrap defaults to its HTTPS origin. Set up DNS or a hosts entry for a custom hostname. Local HTTPS clients need the trust setup below.

For public mode, put `BP_ACCESS_MODE=public`, `BP_PUBLIC_DOMAIN=example.com`, and `BP_BIND_HOST=0.0.0.0` in the selected environment file, then run bootstrap with `--profile edge`. Point `backplane.example.com` at this host and allow inbound ports 80 and 443. A loopback bind is also supported if a separate TCP forwarder makes those ports publicly reachable; a loopback bind alone cannot obtain public certificates. HTTP redirects to the configured HTTPS address; `/health` stays available over HTTP for health checks. HTTPS tells browsers to require HTTPS on future visits.

For Platform Edge, run bootstrap with `--access-mode proxy --public-url <exact external URL> --profile gateway`. Platform Edge forwards to the internal Caddy at `bp-gateway:80` on `BP_PLATFORM_NETWORK` (default `platform`). Platform Edge owns certificate issuance and any HTTP-to-HTTPS redirects. The internal gateway listens only on HTTP port 80 and retains operator-route exclusions. Keep the standalone edge profile off when another gateway owns ports 80 and 443.

The Platform Network has one allocation on every host, defined in the [platform contract](../conventions.md#platform-contract): subnet `172.30.0.0/24` (`BP_PLATFORM_SUBNET`), dynamic range `172.30.0.128/25` (`BP_PLATFORM_IP_RANGE`) and gateway `172.30.0.1`, the subnet's first host. Platform Edge holds the reserved address `172.30.0.2` outside the dynamic range, and `BP_TRUSTED_PROXIES` defaults to `172.30.0.2/32`, so no Edge address discovery is needed. Whichever bootstrap runs first creates the network with these parameters. Bootstrap validates an existing network and refuses a different subnet, range or gateway, or a network with no IPv4 IPAM configuration, with `platform_network_mismatch` and the observed and expected values. To repair a network created before this contract, stop every stack on it, run `docker network rm` on the network the error names, then rerun bootstrap. Bootstrap also refuses a dynamic range that contains a trusted IPv4 proxy address.

Bootstrap preserves existing secrets and rejects conflicting mode/origin settings before starting services. Set one mode directly; the previous scheme, issuer and edge override settings are unsupported. No configuration or data migration runs. Existing volume names and backup contents remain unchanged. On a host with several deployments, choose distinct `BP_VOLUME_PREFIX` and `BP_PLATFORM_NETWORK` values so the `bp-server` and `bp-gateway` aliases resolve uniquely; each additional network needs its own non-overlapping `BP_PLATFORM_SUBNET` and `BP_PLATFORM_IP_RANGE`.

## Browser address for authentication

`BP_PUBLIC_URL` is one configured origin, even when both listener protocols are available. Choose the address used for browser login and the CLI. A local edge accepts an explicitly selected HTTP loopback origin or HTTPS origin on one of its certificate names and corresponding published ports. Other listener addresses can serve requests, but authenticated browser mutations still require the configured browser Origin; sessions and secure-cookie attributes follow its scheme. Public mode requires the derived `https://backplane.<BP_PUBLIC_DOMAIN>` origin, including a non-default HTTPS port. Behind another gateway, bootstrap preserves the configured gateway origin.

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

## Internal gateway behind Platform Edge

Set `BP_ACCESS_MODE=proxy` and `BP_PUBLIC_URL` to the browser’s HTTPS origin.
For the default prepared installation, run from the Backplane checkout:

```sh
docker compose --env-file .env --project-name agent-backplane \
  -f compose.yaml -f compose.gateway.yaml --profile gateway up -d --wait
```

If bootstrap used `--env-file PATH` or `--compose-project NAME`, replace `.env`
and `agent-backplane` with those same values. Keep those options on subsequent
Compose commands so the public URL, volume prefix and network come from the
prepared deployment.
The gateway uses `bp-gateway:80` on the shared Platform Network and publishes no host ports.
Platform Edge routes Backplane requests through that gateway. Do not combine this overlay
with the standalone `edge` profile. Existing direct server access remains for internal telemetry.
The advanced deployment with an operator-owned proxy can still target the server directly.


## Native RustFS console

The console is an opt-in human storage administration surface. Keep
`BP_RUSTFS_CONSOLE=false` for the default deployment. Disabled consoles have no
published console link or forwarding route, and standalone Caddy requests no
console certificate. Reserved HTTP console hosts return 404.

On an existing RustFS installation, set `BP_RUSTFS_CONSOLE=true` in its private
environment file and run bootstrap with `--profile blobs` plus either `--profile edge`
or `--profile gateway`. Enabling the console never selects a storage backend.
Keep the original profiles, credentials, bucket, source bytes and volumes;
a filesystem deployment requires an explicit storage migration first. An explicit
`BP_BLOB_BACKEND=filesystem` conflicts with enabling this console.

Standalone mode derives `https://rustfs.<BP_PUBLIC_DOMAIN or localhost>` with
`BP_HTTPS_PORT` when non-default. Optional `BP_RUSTFS_HOST` overrides the native
DNS hostname. The local HTTP hostname on `BP_HTTP_PORT` is reserved and always
returns 404. `BP_RUSTFS_URL` must select the HTTPS listener in every mode.
Point the console hostname at Caddy and use the same local CA trust procedure as
Backplane. Only Caddy publishes console ports; RustFS stays on `blob-internal`,
off the Platform Network. Core plus edge remains valid without blobs.

Behind Platform Edge, set a separate external HTTPS origin explicitly, for example:

```dotenv
BP_ACCESS_MODE=proxy
BP_PUBLIC_URL=https://darkforge.tail694fe2.ts.net:8449
BP_RUSTFS_CONSOLE=true
BP_RUSTFS_URL=https://darkforge.tail694fe2.ts.net:8450
BP_RUSTFS_CONSOLE_ALLOW='100.100.1.2/32 fd7a:115c:a1e0::1/128'
```

Replace the example IPs with actual operator addresses. `BP_TRUSTED_PROXIES`
defaults to Platform Edge's reserved address, `172.30.0.2/32`; an empty value
uses the same default. Change it only for another gateway or a different Platform
Network subnet. An existing env file keeps an older nonempty value; replace it
with the default after the network cutover. `BP_RUSTFS_CONSOLE_ALLOW` accepts space-separated
IP literals or CIDRs. `BP_TRUSTED_PROXIES` accepts only exact IPs or host routes
(`/32` or `/128`); Docker and Tailnet ranges are never trusted proxy peers.
Forwarded client IPs affect the console allowlist only when the direct peer is
trusted. That peer must replace untrusted `X-Forwarded-For` with a single verified
client address. Platform Edge's console route normalizes it this way, so Backplane
trusts only the exact Edge peer IP. A custom ingress that preserves a chain must
append the address it actually observes and configure every actual trusted proxy
hop in `BP_TRUSTED_PROXIES`; it must never pass a client-supplied chain through
unchanged. Caddy evaluates that chain from the nearest hop toward the client.
Untrusted callers cannot gain access by supplying forwarded headers when this
upstream contract is enforced.
Native RustFS root authentication is still required after the allowlist check.
The Backplane server's forwarded-header stripping and configured authentication
origin remain unchanged. Functions retain their trusted operator boundary.

Platform Edge must preserve the full original Host, including a non-default
port, and forward the complete console origin to `bp-gateway:80`. The internal
gateway matches the console authority before its normal Backplane fallback,
so a shared hostname with different ports stays separate. It proxies assets,
STS, S3 and admin requests to RustFS 1.0.0 on port 9001. Only `GET`/`HEAD` of `/`
with `Accept: text/html` redirects to `/rustfs/console/`; other requests retain
their path, method and Host for native login and SigV4. Platform Edge publication
on port 8450 is a separate follow-up; this setup does not publish that port.

Run bootstrap again with the same environment file, project and profiles after
editing these settings. It validates before Docker calls, preserves credentials
and user settings, and refreshes the derived `BP_RUSTFS_URL_HOST` and
`BP_RUSTFS_AUTHORITY` fields used by Caddy. Subsequent bare Compose commands must
use that prepared file. Bootstrap prints the console link only when enabled.
Sign in using `BP_RUSTFS_ROOT_USER` and `BP_RUSTFS_ROOT_PASSWORD` from that private
file. These are human administration credentials, not Backplane User credentials.
Agents must use the Files API with Principal and Run context to preserve provenance;
native storage administration bypasses those application records.

Pure bootstrap tests do not establish installed login or ingress qualification.
Release checks must cover actual root-key browser login, signed account info,
trusted-peer allow/deny, standalone/proxy routing, and disabled 404 behavior.


The disposable console gate, `python3 tests/acceptance/rustfs-console.py`, uses the
pinned Caddy image to adapt and validate all six local/public/proxy and enabled/
disabled configurations, plus the unprepared gateway defaults. In the same fixture,
signed admin account-info and S3 root-list GETs must return 200 through the trusted
peer with the original Host and port. Signed requests cannot follow redirects.
The existing HTML, native-auth requirement, client allow/deny, spoof rejection and
disabled-console checks remain required. Browser login is a separate optional
host gate selected with `BP_CONSOLE_PROOF_BROWSER`.

When the storage-migration parent lands, CI integration must retain a gates job
budget of at least 60 minutes (`timeout-minutes: 60` or higher) and all actual gates
from both branches, including the console acceptance above, storage migration,
storage startup/identity, workerd lifecycle/runtime, and both offline and S3 backup
drills. Preserve the check and test steps too. Resolve the workflow conflict by
keeping both branches' gate additions; config validation alone does not qualify
signed requests, browser login, or storage migration.

The native RustFS console requires an HTTPS browser origin in every mode. Local
HTTP requests to its hostname return 404, even when the console is enabled;
Backplane's ordinary local HTTP interface is unchanged. Behind a trusted gateway,
HTTPS terminates there and the private gateway hop remains HTTP.

The console allowlist defaults to loopback and does not automatically permit Docker
bridge peers. For standalone access, inspect Caddy's observed peer and explicitly
permit that exact address. For proxy access, permit verified client addresses and
trust only the gateway. A denied client receives 404.
