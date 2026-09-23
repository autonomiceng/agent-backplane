# Published images

The `Publish` workflow builds and pushes two images to GitHub Container Registry
after each push to `main` and each semver release tag (`vX.Y.Z`, optionally with a
prerelease suffix such as `v1.2.3-rc.1`). Other tags and pull requests never publish.

| Image | Platforms | Recipe |
| --- | --- | --- |
| `ghcr.io/autonomiceng/agent-backplane-server` | `linux/amd64`, `linux/arm64` | `infra/compose/server.Dockerfile` |
| `ghcr.io/autonomiceng/agent-backplane-workerd` | `linux/amd64` | `infra/compute/image/Dockerfile` |

Compose pins both by digest: `compose.yaml` and `compose.blobs.yaml` default the server,
migration, data and blob helpers to the server image, and `compose.compute.yaml` defaults
workerd. `scripts/bootstrap.py` pulls the workerd default and verifies its executables before launch;
Compose pulls the server image on first `up`. `BP_SERVER_IMAGE` and `BP_WORKERD_IMAGE`
still override them. `compose.dev.yaml` holds the only `build:` stanzas, for development
(see the README).

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

## Move the pins

The pinned revision's image contains the server code and migrations, while Compose mounts
`infra/init/core`, `infra/backup` and the workerd control files from the checkout. Run
Compose from a checkout whose mounted files match the pinned images. To move to a newer
build, take the tag and digest from the `Publish` run summary (or `docker buildx
imagetools inspect`) and replace both references in one change: the server default in
`compose.yaml` and `compose.blobs.yaml`, and the workerd default in both places in
`compose.compute.yaml`. Renovate refreshes the digest of a pinned tag; it cannot order
`main-<sha7>` tags, so moving to a newer commit is a manual change. Then follow the
[offline upgrade procedure](health.md).
