# Official Cloudflare binaries, independently checked against npm's SHA-512 integrity.
# Keep this input version synchronized with README.md and the acceptance probe.
ARG TARGETARCH
FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251 AS base

FROM base AS binary-amd64
ADD --checksum=sha256:fbc282b4687c92fc8d4946b2dc33559bc8bc0e9e70aa192c362186ef508181d8 https://registry.npmjs.org/@cloudflare/workerd-linux-64/-/workerd-linux-64-1.20260918.1.tgz /tmp/workerd.tgz
RUN mkdir /artifact && tar -xzOf /tmp/workerd.tgz package/bin/workerd > /artifact/workerd \
    && echo 'f31da6d248028d698806aa93d1b3aec28bbd4b4b7ddc31e967408ab6406fa5aa  /artifact/workerd' | sha256sum -c - \
    && chmod 0555 /artifact/workerd

FROM base AS binary-arm64
ADD --checksum=sha256:ac1c41d706fac8aefe7a178cfd20e5237f6ad0f784becd8043be7dd6799ecf51 https://registry.npmjs.org/@cloudflare/workerd-linux-arm64/-/workerd-linux-arm64-1.20260918.1.tgz /tmp/workerd.tgz
RUN mkdir /artifact && tar -xzOf /tmp/workerd.tgz package/bin/workerd > /artifact/workerd \
    && echo '1ffd1a34403a7f04dc782926fe563efc7d4810ab54d205a00647646dd21a7bba  /artifact/workerd' | sha256sum -c - \
    && chmod 0555 /artifact/workerd

FROM binary-${TARGETARCH} AS artifact
FROM base AS runtime
COPY --from=artifact /artifact/workerd /usr/bin/workerd
ADD --chmod=0444 --checksum=sha256:0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594 https://raw.githubusercontent.com/cloudflare/workerd/679c09e5eea0af8a04062e1875e99c75af532e3b/LICENSE /usr/share/licenses/workerd/LICENSE
LABEL org.opencontainers.image.source="https://github.com/autonomiceng/agent-backplane" \
      org.opencontainers.image.version="1.20260918.1" \
      org.opencontainers.image.licenses="Apache-2.0" \
      io.backplane.workerd.source="https://github.com/cloudflare/workerd/tree/679c09e5eea0af8a04062e1875e99c75af532e3b"
USER 65534:65534
ENTRYPOINT ["/usr/bin/workerd"]
