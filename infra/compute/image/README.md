# Backplane workerd image

The mounted supervisor protocol requires `/usr/bin/bun`. The Dockerfile pins the official
Bun `1.4.2-debian` OCI index and independently verifies each extracted architecture binary.
The image gate checks those executable bytes and both Bun license files. This addition
still needs actual-artifact qualification before default promotion. See the
[runtime gate](../runtime.md) for prototype and actual-artifact commands.

This packages Cloudflare's unmodified workerd `1.20260918.1` and official Bun `1.4.2` binaries on the pinned Debian
Bookworm slim base. It installs no packages and includes no Backplane code or credentials.
The Compose overlay mounts the trusted loader separately. This is a Backplane image,
not an official Cloudflare container image.

```sh
docker build --platform linux/amd64 -f infra/compute/image/Dockerfile \
  -t agent-backplane-workerd:1.20260918.1 infra/compute/image
docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true agent-backplane-workerd:1.20260918.1 --version
```

The Dockerfile frontend and base are pinned by OCI index digest. Each architecture has a fixed official npm
archive checksum and an independent extracted-binary checksum. Docker verifies the
archive before extraction; the build verifies the binary before copying it into the
runtime image. Builds require BuildKit support for `ADD --checksum`. A checksum failure
must stop the build; never replace a pin merely to make a download pass.

Source inputs were checked against the official npm release integrity:

| Platform | npm package | SHA-512 integrity |
| --- | --- | --- |
| linux/amd64 | `@cloudflare/workerd-linux-64@1.20260918.1` | `UQ2nnY3qpXLzQ80frmWO+8HvtqyWaQILe8QYZwpemdjT+sqwCz4Dz+0/WVkFco0v/04kIIqikVeLTY/7gEhmkw==` |
| linux/arm64 | `@cloudflare/workerd-linux-arm64@1.20260918.1` | `4rib51MaLNWweUIUxM/Xj558M5QmyZoBSf0ffv+lYah5VTrvwnez3XGxX72pElnBKHROvAPOi5msQ5Ts8JSI0A==` |

This fixes build inputs; it does not claim bit-identical OCI output from different
Docker builders. Record `docker image inspect` content identity after building. A local
image ID is not a registry manifest digest. Do not place it in the legacy `BP_WORKERD_DIGEST`. The [runtime identity contract](../runtime.md)
accepts local tags through `BP_WORKERD_IMAGE` and verifies executable bytes against
`BP_WORKERD_BINARY_SHA256` at startup. The locally qualified amd64 packaging artifact is
`agent-backplane-workerd:1.20260918.1`, image ID
`sha256:1b5694d34643f982d7e7a511f81afbb1f59ec49bce0a60685e88deff24bebe3f`.
This local config ID is candidate evidence. With compute selected, bootstrap builds the
recipe under this tag when `BP_WORKERD_IMAGE` is unset or empty, then verifies both
workerd and Bun by resolved image ID. An explicit override must already exist locally;
bootstrap neither builds over it nor pulls it. It requires the recipe's Bun 1.4.2 bytes and workerd version `2026-09-18`.
The default build refuses non-amd64 Docker hosts. Build inputs require network access
and compatible Docker/BuildKit tooling; no installed compiler is needed.

The Compose overlay uses the same local tag when the override is unset or empty, so
configuration preflight and later native `docker compose up` work with the saved selection.
The local image must exist for startup. Workerd has no Compose build stanza;
`docker compose up --build` leaves its selected image untouched, including explicit
overrides. Rerun preparation or use the `docker build` command above to rebuild the recipe.

ADR-0009/0018 permit this qualified local recipe as the supported delivery method after
H-PROOF/F-GATE and B-DEFAULT approval. Registry publication is optional. This preparatory
change claims neither completed runtime qualification nor a registry release.
Arm64 input integrity does not establish arm64 runtime qualification.

Run `bun tests/acceptance/workerd-image.ts agent-backplane-workerd:1.20260918.1`
to check binary and license hashes, source identity, the non-root default, Worker Loader/Check RPC,
control authentication, invalid-source rejection, HTTPS trust and a null-ID invocation in an owned container. This uses synthetic authority
props and does not prove server-issued credentials or cross-Workspace isolation.

The image includes the [curl conversion of Mozilla CA roots](https://curl.se/docs/caextract.html),
revision 2026-08-13, checksum-pinned under MPL 2.0. `SSL_CERT_FILE` points workerd at that
file; the artifact probe performs a declared HTTPS request to verify trust. Updating the
root bundle is an explicit reviewed artifact update. The probe requires outbound HTTPS
to `example.com`; network or endpoint failure is a failed gate to diagnose and retry.

The image runs as UID/GID 65534. Keep the Compose read-only filesystem, dropped capabilities,
resource limits and authenticated private control endpoint. A non-root container does not
make workerd a hardened sandbox. Full invocation authority, limits, failure recovery and
subsequent healthy invocation require the separate runtime acceptance gate.

Sources: [Cloudflare release](https://github.com/cloudflare/workerd/releases/tag/v1.20260918.1),
[upstream runtime requirements and isolation limits](https://github.com/cloudflare/workerd/blob/679c09e5eea0af8a04062e1875e99c75af532e3b/README.md),
[amd64 metadata](https://registry.npmjs.org/@cloudflare/workerd-linux-64/1.20260918.1),
[arm64 metadata](https://registry.npmjs.org/@cloudflare/workerd-linux-arm64/1.20260918.1).
