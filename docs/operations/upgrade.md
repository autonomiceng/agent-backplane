# Published images

The `Publish` workflow builds and pushes two images to GitHub Container Registry
after each push to `main` and each `v*` tag. Pull requests never publish.

| Image | Platforms | Recipe |
| --- | --- | --- |
| `ghcr.io/autonomiceng/agent-backplane-server` | `linux/amd64`, `linux/arm64` | `infra/compose/server.Dockerfile` |
| `ghcr.io/autonomiceng/agent-backplane-workerd` | `linux/amd64` | `infra/compute/image/Dockerfile` |

Compose does not use these images yet. The server image is still built from the
checkout and the workerd image from its local recipe.

## Tags

| Git event | Tags |
| --- | --- |
| Push to `main` at commit `<sha>` | `main-<first 7 hex of sha>`, `sha-<full sha>` |
| Tag `v1.2.3` | `1.2.3`, `latest` |
| Tag `v1.2.3-rc.1` | `1.2.3-rc.1` |

Commit tags name the source commit. Rerunning `Publish` for the same commit pushes
them again, possibly with a different digest, so only a digest identifies one build.
`latest` moves with each stable release tag. Every image carries `org.opencontainers.image.source`,
`org.opencontainers.image.revision` (the commit) and `org.opencontainers.image.created`.
The workerd image also keeps its recipe's `org.opencontainers.image.version`, the
packaged workerd release.

## Pin by digest

A tag is a name the registry can move; a digest is the content. Pin both, so the
reference stays readable and the content cannot change:

```sh
docker buildx imagetools inspect ghcr.io/autonomiceng/agent-backplane-server:main-<sha7>
# Name:      ghcr.io/autonomiceng/agent-backplane-server:main-<sha7>
# Digest:    sha256:<digest>
```

Use `ghcr.io/autonomiceng/agent-backplane-server:main-<sha7>@sha256:<digest>`. The
`Publish` run summary lists every pushed tag with its digest. The server digest names
the multi-platform index; Docker selects the matching platform when it pulls.

## Visibility

A package can start private on its first push, and a workflow cannot change its
visibility. An organization owner makes each package public once; GitHub cannot make
it private again:

1. Open `https://github.com/orgs/autonomiceng/packages/container/package/agent-backplane-server`.
2. Select **Package settings** on the right.
3. Under **Danger Zone** at the bottom, select **Change visibility**, choose **Public**, type the package
   name to confirm, and select **I understand the consequences, change package visibility**.
4. Repeat for `agent-backplane-workerd`.

Verify anonymously with an empty Docker client configuration:

```sh
DOCKER_CONFIG="$(mktemp -d)" docker manifest inspect ghcr.io/autonomiceng/agent-backplane-server:main-<sha7>
```
