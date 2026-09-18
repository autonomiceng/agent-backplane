---
status: proposed
date: 2026-09-14
---
# Proxy trust boundary

Authentication uses one validated configured public origin. The server unconditionally strips forwarded origin and client-IP claims and disables Better Auth proxy-header trust. This avoids a trusted-peer CIDR policy and makes direct requests obey the same authentication policy as proxied requests. Cookies derive their security attributes from the configured scheme. HTTP requires loopback or an explicit server override, and remains visible as a readiness diagnostic without changing readiness status.

Public ingress owns TLS and exclusion of operator routes. The server cannot prove client TLS, firewall isolation or proxy honesty. Plaintext upstream credentials require a trusted host and Docker network; loopback publication and restricted Docker access establish deployment isolation. A redirect cannot recover credentials already transmitted over HTTP. Optional Caddy fits ADR-0009; operator-supplied proxies must implement the same contract.

The operator owns persisted certificate and CA state, protected backups, recovery and manual client trust installation. CA private keys remain private; distribute only the root certificate through an authenticated channel. Synthetic upstream login tests prove application cookie and CSRF behavior. Real certificate verification and ingress acceptance must pass before release; browser trust provisioning remains manual.

Better Auth has no trusted client IP in production and uses a shared per-path rate-limit bucket. We accept that limitation without disabling IP tracking, which would also bypass its limiter. No trusted proxy switch is provided.
