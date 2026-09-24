#!/usr/bin/env python3
"""Bring agent-backplane up from a clean checkout, or refuse with a reason.

Lock the env file, fill in missing secrets, refuse to invent secrets over existing
installation state, record the Compose selection literally, create the Platform Network
and durable volumes, start the selected services, wait for readiness, export the pending
enrollment capability and print the enrollment command. Exit codes: 0 ready, 1 refused
(one JSON line on stderr names why), 2 bad usage, 3 the stack did not become ready.
Python 3.11+ standard library only.
"""

from __future__ import annotations

import argparse
import fcntl
import http.client
import ipaddress
import json
import os
import re
import secrets
import shlex
import subprocess
import stat
import sys
import tempfile
import time
import urllib.parse
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

ROOT = Path(__file__).resolve().parent.parent
PROJECT = "agent-backplane"
NETWORK = "platform"
# Platform Network allocation shared by every stack (docs/conventions.md). Edge holds this
# reserved address outside the dynamic range and reaches the server directly at bp-server:3000.
PLATFORM_SUBNET = "172.30.0.0/24"
PLATFORM_IP_RANGE = "172.30.0.128/25"
EDGE_ADDRESS = "172.30.0.2"
PROFILES = ("blobs", "compute", "edge")
# The internal gateway behind Platform Edge is gone (ADR-0021, 2026-09-24); the profile name is refused, not ignored.
GATEWAY_RETIRED = ("the internal gateway profile is retired: Platform Edge reaches bp-server:3000 directly. Remove gateway from "
                   "COMPOSE_PROFILES and compose.gateway.yaml from COMPOSE_FILE as docs/operations/ingress.md "
                   "\"Upgrading from the internal gateway\" describes, then rerun")
# Secrets each profile needs and how many random bytes each gets (hex encoded).
CORE_SECRETS = {"BP_AUTH_SECRET": 32, "BP_POSTGRES_ADMIN_PASSWORD": 32, "BP_POSTGRES_PASSWORD": 32, "BP_OPERATIONS_TOKEN": 32}
# RustFS service-account creation accepts at most 40 characters.
BLOB_SECRETS = {"BP_RUSTFS_ROOT_USER": 10, "BP_RUSTFS_ROOT_PASSWORD": 32, "BP_BLOB_S3_ACCESS_KEY": 10, "BP_BLOB_S3_SECRET_KEY": 20}
COMPUTE_SECRETS = {"BP_COMPUTE_TOKEN": 32}
SECRETS = CORE_SECRETS | BLOB_SECRETS | COMPUTE_SECRETS
SELECTORS = ("COMPOSE_PROJECT_NAME", "COMPOSE_FILE", "COMPOSE_PROFILES")
# Settings nothing reads any more, with their replacements. Any assignment, even empty, is refused.
UNSUPPORTED = {
    "BP_SCHEME": "BP_ACCESS_MODE",
    "BP_TLS_ISSUER": "BP_ACCESS_MODE (local uses the internal CA, public uses ACME)",
    "BP_EDGE_CA": "the edge root certificate exported from edge-data (docs/operations/ingress.md)",
    "BP_PUBLIC_HOST": "BP_PUBLIC_DOMAIN",
    "BP_EDGE_BIND_HOST": "BP_BIND_HOST",
    "BP_AUTH_URL": "BP_PUBLIC_URL",
    "BP_WORKERD_REPOSITORY": "BP_WORKERD_IMAGE",
    "BP_WORKERD_DIGEST": "BP_WORKERD_IMAGE and BP_WORKERD_BINARY_SHA256",
}
# Assignments bootstrap reads or writes; every other line is preserved verbatim.
MANAGED = set(SECRETS) | set(SELECTORS) | set(UNSUPPORTED) | {
    "COMPOSE_PATH_SEPARATOR", "COMPOSE_ENV_FILES", "BP_BLOB_BACKEND", "BP_ACCESS_MODE", "BP_PUBLIC_URL",
    "BP_ALLOW_INSECURE_ORIGIN", "BP_PUBLIC_DOMAIN", "BP_PORT", "BP_BIND_HOST", "BP_HTTP_PORT", "BP_HTTPS_PORT", "BP_BACKUP_DIR",
    "BP_POSTGRES_IMAGE", "BP_SERVER_IMAGE", "BP_CADDY_IMAGE", "BP_RUSTFS_IMAGE", "BP_BLOB_BOOTSTRAP_IMAGE",
    "BP_WORKERD_IMAGE", "BP_WORKERD_BINARY_SHA256",
    "BP_DATA_DIR", "BP_PLATFORM_NETWORK", "BP_PLATFORM_SUBNET", "BP_PLATFORM_IP_RANGE", "BP_VOLUME_PREFIX",
    "BP_BACKUP_KEEP",
}
NAME_LINE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)")
ASSIGNMENT = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$")
DNS_LABEL = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$", re.IGNORECASE)
SAFE_NAME = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]*$")
IMAGE_REFERENCE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/:@-]*")
# Verified upstream amd64 workerd executable and the pinned Bun supervisor, by architecture.
WORKERD_BINARY = "f31da6d248028d698806aa93d1b3aec28bbd4b4b7ddc31e967408ab6406fa5aa"
WORKERD_VERSION = "workerd 2026-09-18"
SUPERVISOR_BINARIES = {
    "amd64": "a83d263767d839e4d2649ca8e35d07159c7afc99afdc96d731ced29e056dda0c",
    "arm64": "616f267a34278ff5ac282df37ffdfba1d7141f4f6926bca99af2cd6ef3ad32b1",
}
SUPERVISOR_VERSION = "1.4.2"
CAPABILITY_PATH = "/data/enrollment/capability"
NOT_READY = ("not_ready", "compose_up_failed", "selected_capabilities_not_ready")
# Parsed subprocess output (compose config JSON) and the diagnostic tail kept from stderr.
OUTPUT_LIMIT = 4 * 1024 * 1024
DIAGNOSTIC_LIMIT = 4096


class Refused(Exception):
    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(code)
        self.code = code
        self.detail = detail


Runner = Callable[..., subprocess.CompletedProcess[str]]


def run(argv: list[str], *, timeout: float | None = None, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    """Bounded capture: stdout up to OUTPUT_LIMIT for parsing, the stderr tail for diagnostics."""
    # Compose startup has its own 300s health budget; image pulls and builds need their own room.
    budget = timeout if timeout is not None else (900 if "pull" in argv or "build" in argv else 360 if "up" in argv else 120)
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        try:
            code = subprocess.run(argv, stdout=out, stderr=err, stdin=subprocess.DEVNULL, check=False, timeout=budget, env=env).returncode
        except subprocess.TimeoutExpired:
            raise Refused("docker_timeout", f"{argv[0]} {argv[1] if len(argv) > 1 else ''} exceeded its {budget:.0f}s deadline") from None
        out.seek(0)
        stdout = out.read(OUTPUT_LIMIT).decode("utf-8", "replace")
        err.seek(max(0, err.seek(0, os.SEEK_END) - DIAGNOSTIC_LIMIT))
        stderr = err.read().decode("utf-8", "replace")
    return subprocess.CompletedProcess(argv, code, stdout, stderr)


def output(result: subprocess.CompletedProcess[str]) -> str:
    return (result.stderr or result.stdout).strip()[-2000:]


def check_private_file(path: Path, code: str) -> None:
    """A regular file owned by the caller, one link, no symlink, readable by nobody else."""
    info = os.lstat(path)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or info.st_mode & 0o077:
        raise Refused(code, f"{path} must be a regular file owned by you with mode 0600 and no other links")


def docker(runner: Runner, argv: list[str], env: dict[str, str], code: str = "docker_command_failed", **options) -> str:
    result = runner(["docker", *argv], env=env, **options)
    if result.returncode:
        raise Refused(code, output(result))
    return result.stdout


class EnvFile:
    """Managed assignments of an env file; unrelated lines survive byte for byte."""

    def __init__(self, path: Path, source: str | None) -> None:
        self.path, self.source = path, source
        self.lines = (source or "").split("\n")
        self.entries: dict[str, str] = {}
        self.assignments: dict[str, int] = {}
        for index, line in enumerate(self.lines):
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            name = NAME_LINE.match(line)
            key = name.group(1) if name else None
            if key == "BP_WORKERD_EFFECTIVE_IMAGE":
                raise Refused("workerd_effective_image_persisted", "BP_WORKERD_EFFECTIVE_IMAGE is bootstrap's child setting; remove it from " + str(path))
            if key is None or key not in MANAGED:
                continue
            if key in UNSUPPORTED:
                # Refused in settings() by name, whatever the line's form.
                self.assignments.setdefault(key, index)
                continue
            if key in self.assignments:
                raise Refused("env_repair_required", f"{key} is set twice in {path}")
            self.assignments[key] = index
            match = ASSIGNMENT.match(line)
            if not match or re.search(r"[$`\r]", match.group(2)):
                raise Refused("env_repair_required", f"{key} must be a literal KEY=value assignment in {path}")
            value = match.group(2)
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
                value = value[1:-1]
            elif re.search(r"[\s#]", value):
                raise Refused("env_repair_required", f"quote the {key} value in {path}")
            if re.search(r"['\"\\\n]", value):
                raise Refused("env_repair_required", f"{key} holds characters bootstrap cannot preserve in {path}")
            if value or key == "COMPOSE_PROFILES":
                self.entries[key] = value

    def save(self, key: str, value: str) -> None:
        self.entries[key] = value
        line = f"{key}='{value}'"
        index = self.assignments.get(key)
        if index is None:
            if self.lines and self.lines[-1] == "":
                self.lines.pop()
            self.assignments[key] = len(self.lines)
            self.lines.append(line)
        else:
            self.lines[index] = line

    def default(self, key: str, value: str) -> None:
        if key not in self.entries and value:
            self.save(key, value)

    def render(self) -> str:
        text = "\n".join(self.lines)
        return text if text.endswith("\n") else text + "\n"

    def write(self) -> None:
        text = self.render()
        if text == self.source:
            # Secrets live here whatever created the file; tighten an owned file on every run.
            if self.path.stat().st_mode & 0o177:
                os.chmod(self.path, 0o600)
            return
        temporary = self.path.with_name(f"{self.path.name}.{uuid.uuid4().hex}")
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(text)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
        finally:
            temporary.unlink(missing_ok=True)
        directory = os.open(self.path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
        self.source = text


def read_env(path: Path, template: Path) -> EnvFile:
    """An absent or empty env file starts from the template; nothing is recorded until write()."""
    if path.is_symlink():
        raise Refused("unsafe_env_file", f"{path} must not be a symlink")
    if path.exists():
        info = os.lstat(path)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
            raise Refused("unsafe_env_file", f"{path} must be a regular file owned by you with no other links")
        if info.st_size:
            return EnvFile(path, path.read_text(encoding="utf-8"))
    env = EnvFile(path, template.read_text(encoding="utf-8"))
    env.source = None
    return env


def is_ipv4(value: str) -> bool:
    try:
        return ipaddress.ip_address(value).version == 4
    except ValueError:
        return False


def is_ip(value: str) -> bool:
    try:
        ipaddress.ip_address(value.strip("[]"))
        return True
    except ValueError:
        return False


def is_loopback_host(host: str) -> bool:
    return host == "localhost" or host == "[::1]" or (is_ipv4(host) and host.startswith("127."))


def normalize_origin(value: str) -> str:
    """One absolute HTTP(S) origin: lowercase host, default port dropped, nothing else."""
    match = re.fullmatch(r"(https?)://(\[[^\]]+\]|[^/:]+)(?::([0-9]+))?/?", value, re.IGNORECASE)
    if re.search(r"[\s\\?#@%]", value) or not match:
        raise Refused("invalid_public_url", "public URL must be an absolute HTTP(S) origin without credentials, path, query or fragment")
    scheme, host, port = match.group(1).lower(), match.group(2).lower(), match.group(3)
    if re.search(r"(?:^|\.)(?:0x[\da-f]+|\d+)\.?$", host, re.IGNORECASE) and not is_ipv4(host):
        raise Refused("invalid_public_url", "public URL host must be a hostname or an IPv4 literal")
    if host.startswith("[") and not is_ip(host):
        raise Refused("invalid_public_url", "public URL host must be a valid IPv6 literal")
    if port is not None and (int(port) < 1 or int(port) > 65535):
        raise Refused("invalid_public_url", "public URL port must be between 1 and 65535")
    port = None if port is None or int(port) == (80 if scheme == "http" else 443) else str(int(port))
    return f"{scheme}://{host}" + (f":{port}" if port else "")


def split_origin(origin: str) -> tuple[str, str, str]:
    scheme, rest = origin.split("://", 1)
    host, _, port = rest.rpartition(":") if re.search(r"\]:[0-9]+$|^[^\[\]]+:[0-9]+$", rest) else (rest, "", "")
    return scheme, host, port or ("443" if scheme == "https" else "80")


def resolve_public_origin(entries: dict[str, str], fallback: str) -> str:
    allow = entries.get("BP_ALLOW_INSECURE_ORIGIN", "false")
    if allow not in ("true", "false"):
        raise Refused("invalid_access_settings", "BP_ALLOW_INSECURE_ORIGIN must be true or false")
    origin = normalize_origin(entries["BP_PUBLIC_URL"]) if entries.get("BP_PUBLIC_URL") else normalize_origin(fallback)
    if origin.startswith("http:") and not is_loopback_host(split_origin(origin)[1]) and allow != "true":
        raise Refused("invalid_access_settings", "non-loopback HTTP requires BP_ALLOW_INSECURE_ORIGIN=true")
    return origin


def resolve_access(entries: dict[str, str], edge: bool = False) -> dict[str, str]:
    """The browser origin the server, the edge and the CLI agree on, validated before Docker runs."""
    mode = entries.get("BP_ACCESS_MODE", "local")
    if mode not in ("local", "public", "proxy"):
        raise Refused("invalid_access_settings", "BP_ACCESS_MODE must be local, public or proxy")
    domain = entries.get("BP_PUBLIC_DOMAIN", "")
    host = f"backplane.{domain or 'localhost'}".lower()
    if edge and (len(host) > 253 or not all(DNS_LABEL.match(label) for label in host.split("."))):
        raise Refused("invalid_access_settings", "BP_PUBLIC_DOMAIN must be a domain without scheme, port or path")

    def port(name: str, fallback: str) -> str:
        value = entries.get(name) or fallback
        if not value.isdigit() or not 1 <= int(value) <= 65535:
            raise Refused("invalid_access_settings", f"{name} must be a port between 1 and 65535")
        return str(int(value))

    http_port = port("BP_HTTP_PORT", "80") if edge else "80"
    https_port = port("BP_HTTPS_PORT", "443") if edge else "443"
    server_port = port("BP_PORT", "3000")
    https = normalize_origin(f"https://{host}:{https_port}") if edge else ""
    if edge and mode == "proxy":
        raise Refused("invalid_access_settings", "behind another gateway uses core only; omit --profile edge")
    if mode == "public" and (not edge or "." not in domain or is_ip(domain) or domain.lower().endswith(".localhost")):
        raise Refused("invalid_access_settings", "public mode requires your own domain and --profile edge")
    if mode == "proxy" and not entries.get("BP_PUBLIC_URL"):
        raise Refused("invalid_access_settings", "BP_PUBLIC_URL (--public-url) is required behind another gateway")
    if edge:
        fallback = https if mode == "public" or domain else normalize_origin(f"http://localhost:{http_port}")
    else:
        fallback = f"http://localhost:{server_port}"
    origin = resolve_public_origin(entries, fallback)
    if mode == "public" and origin != https:
        raise Refused("invalid_access_settings", "BP_PUBLIC_URL must match the public HTTPS listener " + https)
    if mode == "local":
        scheme, hostname, listener = split_origin(origin)
        expected = (https_port if scheme == "https" else http_port) if edge else server_port
        local = hostname in ("localhost", "127.0.0.1", host) if edge else is_loopback_host(hostname)
        if not local or listener != expected or (not edge and scheme != "http"):
            raise Refused("invalid_access_settings", f"BP_PUBLIC_URL {origin} must match a local listener")
    bind = entries.get("BP_BIND_HOST", "127.0.0.1")
    if edge and not is_ipv4(bind) and bind != "[::1]":
        raise Refused("invalid_access_settings", "BP_BIND_HOST must be an IP literal")
    if edge and http_port == https_port:
        raise Refused("invalid_access_settings", "HTTP and HTTPS ports must differ")
    return {"mode": mode, "host": host, "origin": origin}


def platform_allocation(entries: dict[str, str]) -> tuple[str, str, str]:
    subnet, ip_range = entries.get("BP_PLATFORM_SUBNET") or PLATFORM_SUBNET, entries.get("BP_PLATFORM_IP_RANGE") or PLATFORM_IP_RANGE
    try:
        pool, dynamic = ipaddress.IPv4Network(subnet), ipaddress.IPv4Network(ip_range)
    except ValueError as error:
        raise Refused("invalid_platform_network", "BP_PLATFORM_SUBNET and BP_PLATFORM_IP_RANGE must be IPv4 networks") from error
    # The derived gateway is the subnet's first host; the range needs an allocatable host besides it.
    if not dynamic.subnet_of(pool) or min(int(dynamic[-1]), int(pool[-1]) - 1) < max(int(dynamic[0]), int(pool[0]) + 2):
        raise Refused("invalid_platform_network", "BP_PLATFORM_IP_RANGE must lie inside BP_PLATFORM_SUBNET with an allocatable host")
    # Docker could otherwise hand Edge's reserved address to any attached container.
    if ipaddress.ip_address(EDGE_ADDRESS) in dynamic:
        raise Refused("invalid_platform_network", f"BP_PLATFORM_IP_RANGE {dynamic} must exclude Edge's reserved address {EDGE_ADDRESS}")
    return str(pool), str(dynamic), str(next(pool.hosts()))


def ensure_network(runner: Runner, env: dict[str, str], name: str, subnet: str, ip_range: str, gateway: str) -> None:
    inspect = ["docker", "network", "inspect", "--format", "{{.Driver}} {{json .IPAM.Config}}", name]
    probe = runner(inspect, env=env)
    if probe.returncode:
        created = runner(["docker", "network", "create", "--driver", "bridge", "--subnet", subnet, "--ip-range", ip_range,
                          "--gateway", gateway, name], env=env)
        if created.returncode == 0:
            return
        # A concurrent bootstrap may have created it first; validate that network instead.
        probe = runner(inspect, env=env)
        if probe.returncode:
            raise Refused("network_create_failed", output(created))
    driver, _, config = probe.stdout.strip().partition(" ")
    try:
        pools = json.loads(config) or []
    except ValueError:
        pools = []
    ipv4 = [pool for pool in pools if isinstance(pool, dict) and isinstance(pool.get("Subnet"), str) and ":" not in pool["Subnet"]]
    found = f"driver {driver or 'none'} " + ("; ".join(
        f"subnet {pool['Subnet']} ip-range {pool.get('IPRange') or 'none'} gateway {pool.get('Gateway') or 'none'}" for pool in ipv4)
        or "no IPv4 IPAM configuration")
    expected = f"driver bridge subnet {subnet} ip-range {ip_range} gateway {gateway}"
    if found != expected:
        raise Refused("platform_network_mismatch", f"network {name} has {found}; expected {expected}. "
                      f"One-time fix: stop every stack on {name}, run `docker network rm {name}`, then rerun bootstrap")


def volume_names(prefix: str, profiles: list[str]) -> list[str]:
    names = ["postgres-data", "server-data"]
    if "edge" in profiles:
        names += ["edge-data", "edge-config"]
    if "blobs" in profiles:
        names.append("rustfs-data")
    return [f"{prefix}_{name}" for name in names]


def ensure_volumes(runner: Runner, env: dict[str, str], names: list[str], project: str) -> None:
    for name in names:
        docker(runner, ["volume", "create", "--label", f"com.docker.compose.project={project}", name], env, "volume_create_failed")


def installation_state(runner: Runner, env: dict[str, str], project: str, prefix: str) -> tuple[list[str], set[str]]:
    """Every Docker resource an earlier installation of this project could have left, and all volume names."""
    found: list[str] = []
    for kind, argv in (("volume", ["volume", "ls", "--filter", f"label=com.docker.compose.project={project}", "--format", "{{.Name}}"]),
                       ("container", ["ps", "--all", "--filter", f"label=com.docker.compose.project={project}", "--format", "{{.ID}}"]),
                       ("network", ["network", "ls", "--filter", f"label=com.docker.compose.project={project}", "--format", "{{.Name}}"])):
        found += [f"{kind} {name}" for name in docker(runner, argv, env, "docker_unavailable").split()]
    volumes = set(docker(runner, ["volume", "ls", "--format", "{{.Name}}"], env, "docker_unavailable").split())
    found += [f"volume {name}" for name in sorted(volumes) if name.startswith(f"{prefix}_") and f"volume {name}" not in found]
    return found, volumes


def verify_workerd_image(entries: dict[str, str], env: dict[str, str], runner: Runner, published: str, pull_default: bool) -> dict[str, str]:
    """Docker stays on the trusted host; every launch verifies the executables it will run."""
    reference = entries.get("BP_WORKERD_IMAGE") or published
    binary = entries.get("BP_WORKERD_BINARY_SHA256") or WORKERD_BINARY
    if not IMAGE_REFERENCE.fullmatch(reference) or not re.fullmatch(r"[0-9a-f]{64}", binary):
        raise Refused("workerd_identity_invalid", "BP_WORKERD_IMAGE must be an image reference and BP_WORKERD_BINARY_SHA256 a SHA-256 hex digest")
    if pull_default:
        if binary != WORKERD_BINARY:
            raise Refused("workerd_default_binary_mismatch", "the published workerd default requires the default BP_WORKERD_BINARY_SHA256")
        if docker(runner, ["info", "--format", "{{.Architecture}}"], env, timeout=10).strip() not in ("amd64", "x86_64"):
            raise Refused("workerd_default_architecture_unqualified", "the published workerd image is amd64 only; set BP_WORKERD_IMAGE")
        docker(runner, ["pull", "--platform", "linux/amd64", reference], env, "workerd_pull_failed")
    inspected = docker(runner, ["image", "inspect", "--format", "{{.Id}} {{.Architecture}}", reference], env, "workerd_image_absent", timeout=10).split()
    if len(inspected) != 2 or not re.fullmatch(r"sha256:[0-9a-f]{64}", inspected[0]) or not re.fullmatch(r"[a-z0-9_-]{1,32}", inspected[1]):
        raise Refused("workerd_image_identity_invalid", f"cannot identify {reference}")
    image_id, architecture = inspected
    if pull_default and architecture != "amd64":
        raise Refused("workerd_default_architecture_unqualified", "the published workerd image is amd64 only")
    if not entries.get("BP_WORKERD_BINARY_SHA256") and architecture != "amd64":
        raise Refused("workerd_binary_pin_required", f"set BP_WORKERD_BINARY_SHA256 for the {architecture} executable")
    supervisor = SUPERVISOR_BINARIES.get(architecture)
    if not supervisor:
        raise Refused("workerd_supervisor_architecture_unsupported", f"no pinned supervisor for {architecture}")
    create = ["create", "--pull", "never", "--network", "none", "--read-only", "--cap-drop", "ALL",
              "--security-opt", "no-new-privileges:true", "--user", "65534:65534", "--entrypoint"]

    def probe(executable: str, args: list[str]) -> str:
        container = docker(runner, [*create, executable, image_id, *args], env, "workerd_verifier_failed", timeout=10).strip()
        if not re.fullmatch(r"[0-9a-f]{64}", container):
            raise Refused("workerd_verifier_identity_invalid", "docker create returned no container id")
        try:
            return docker(runner, ["start", "--attach", container], env, "workerd_verifier_failed", timeout=10).strip()
        finally:
            runner(["docker", "rm", "--force", container], env=env, timeout=10)

    observed = probe("sha256sum", ["/usr/bin/workerd", "/usr/bin/bun"])
    if observed != f"{binary}  /usr/bin/workerd\n{supervisor}  /usr/bin/bun":
        raise Refused("workerd_binary_identity_mismatch", f"{reference} does not contain the expected workerd and bun executables")
    workerd_version, supervisor_version = probe("/usr/bin/workerd", ["--version"]), probe("/usr/bin/bun", ["--version"])
    compatible = workerd_version == WORKERD_VERSION if binary == WORKERD_BINARY else re.fullmatch(r"workerd \d{4}-\d{2}-\d{2}", workerd_version)
    if not compatible or supervisor_version != SUPERVISOR_VERSION:
        raise Refused("workerd_binary_incompatible", f"{reference} reports {workerd_version!r} and bun {supervisor_version!r}")
    return {"reference": reference, "imageId": image_id, "binarySha256": binary, "supervisorBinarySha256": supervisor,
            "workerdVersion": workerd_version, "supervisorVersion": supervisor_version, "architecture": architecture,
            "observedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")}


def persist_workerd_evidence(data_dir: Path, identity: dict[str, str]) -> Path:
    """A durable private launch decision, even if Compose subsequently fails. Never used to select an image."""
    directory = data_dir / "compute"
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = directory / f"{uuid.uuid4()}.json"
    evidence = {"source": "host-declared", "purpose": "launch-decision", "selectedReference": identity["reference"],
                "hostObservedImageId": identity["imageId"], "binarySha256": identity["binarySha256"],
                "supervisorBinarySha256": identity["supervisorBinarySha256"], "workerdVersion": identity["workerdVersion"],
                "supervisorVersion": identity["supervisorVersion"], "architecture": identity["architecture"], "observedAt": identity["observedAt"]}
    temporary = path.with_suffix(".json.tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(json.dumps(evidence) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
    return path


def http_get(url: str, headers: dict[str, str] | None = None, timeout: float = 5.0) -> tuple[int, str]:
    parts = urllib.parse.urlsplit(url)
    connection = http.client.HTTPConnection(parts.hostname or "127.0.0.1", parts.port or 80, timeout=timeout)
    try:
        connection.request("GET", parts.path or "/", headers=headers or {})
        response = connection.getresponse()
        return response.status, response.read(1 << 20).decode("utf-8", "replace")
    finally:
        connection.close()


def wait_ready(base: str, timeout: float = 120.0) -> str:
    """Poll the direct port until readiness answers 200; return the enrollment state."""
    deadline, last = time.monotonic() + timeout, ""
    while True:
        try:
            status, body = http_get(base + "/health/ready")
            state = json.loads(body).get("enrollment", {}).get("state") if status == 200 else None
            if status == 200 and state in ("pending", "claimed"):
                return state
            last = f"http {status}" + (f" enrollment {state}" if status == 200 else "")
        except (OSError, http.client.HTTPException, ValueError, AttributeError) as error:
            last = str(error) or error.__class__.__name__
        if time.monotonic() >= deadline:
            raise Refused("not_ready", f"{base}/health/ready: {last}")
        time.sleep(3)


def wait_capabilities(base: str, token: str, selected: dict[str, str], timeout: float = 30.0) -> None:
    """Operations may return 503 for an absent first backup; only the selected capabilities matter."""
    deadline = time.monotonic() + timeout
    for attempt in range(4):
        try:
            _, body = http_get(base + "/health/operations", {"Authorization": "Bearer " + token})
            operations = json.loads(body)
        except (OSError, http.client.HTTPException):
            operations = None
        except ValueError:
            raise Refused("selected_capabilities_not_ready", "/health/operations returned no JSON") from None
        if isinstance(operations, dict):
            if not isinstance(operations.get("capabilities"), dict):
                raise Refused("operations_capabilities_unsupported", "the selected server image lacks the capability sampler")
            if all(capability_ready(operations["capabilities"].get(name), backend) for name, backend in selected.items()):
                return
        if attempt == 3 or deadline - time.monotonic() < 5:
            break
        # Capability observations cache failures for five seconds. Let a retry resample.
        time.sleep(5)
    raise Refused("selected_capabilities_not_ready", "selected Files/Functions capabilities did not report healthy; rerun after recovery")


def capability_ready(observation: object, backend: str, window: float = 15.0) -> bool:
    if not isinstance(observation, dict) or observation.get("state") != "healthy" or observation.get("backend") != backend:
        return False
    return observed_recently(observation.get("observedAt"), window)


def observed_recently(value: object, window: float = 15.0) -> bool:
    if not isinstance(value, str):
        return False
    try:
        age = datetime.now(timezone.utc) - datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return 0 <= age.total_seconds() <= window


def export_capability(runner: Runner, env: dict[str, str], compose: list[str], path: Path) -> None:
    capability = docker(runner, [*compose[1:], "exec", "-T", "server", "cat", CAPABILITY_PATH], env, "capability_unavailable")
    if not re.fullmatch(r"[a-f0-9]{64}\n?", capability):
        raise Refused("invalid_capability", "the server published no usable enrollment capability")
    if path.exists():
        check_private_file(path, "unsafe_capability_file")
        if path.read_text(encoding="utf-8") != capability:
            raise Refused("capability_recovery_required", f"{path} holds another capability; move it aside before rerunning")
        return
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(capability)


def pull_missing_images(runner: Runner, env: dict[str, str], config: dict) -> None:
    """Downloads get the pull budget so `up` spends its deadline on health checks. Only absent images:
    Compose's own `pull --policy missing` still refreshes `:latest` tags, and an explicit local image
    (BP_SERVER_IMAGE, BP_WORKERD_IMAGE) exists in no registry."""
    services = config["services"].values() if isinstance(config.get("services"), dict) else []
    references = sorted({service["image"] for service in services if isinstance(service, dict) and isinstance(service.get("image"), str)})
    for reference in references:
        if runner(["docker", "image", "inspect", "--format", "{{.Id}}", reference], env=env, timeout=10).returncode == 0:
            continue
        docker(runner, ["pull", reference], env, "image_pull_failed")


def cli_state_dir() -> Path:
    """Where the containerized CLI keeps its checkpoint and credentials: the operator's own state root."""
    return Path(os.environ.get("XDG_STATE_HOME") or Path.home() / ".local" / "state") / "backplane"


def enrollment_command(root: Path, env_file: Path, origin: str, capability: Path, state: Path, image: str) -> str:
    """The enrollment container runs the image the server runs, including a local `--build`."""
    argv = [f"BP_SERVER_IMAGE={image}", "docker", "compose", "--project-directory", str(root), "--env-file", str(env_file),
            "-f", str(root / "compose.yaml"), "-f", str(root / "compose.enroll.yaml"), "run", "--rm",
            "--user", f"{os.getuid()}:{os.getgid()}", "-v", f"{capability}:/tmp/capability:ro", "-v", f"{state}:{state}",
            "-e", f"BP_DATA_DIR={state}", "enroll", "--url", origin, "--email"]
    return " ".join(shlex.quote(part) for part in argv) + " USER_EMAIL"


class ArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        print(json.dumps({"error": "invalid_arguments", "detail": message}), file=sys.stderr)
        raise SystemExit(2)


def bootstrap(argv: list[str], runner: Runner | None = None) -> int:
    runner = runner or run
    parser = ArgumentParser(prog="bootstrap.py", description=__doc__.splitlines()[0])
    parser.add_argument("--env-file", default=str(ROOT / ".env"), help="environment file (default: checkout .env)")
    parser.add_argument("--dry-run", action="store_true", help="render and validate the plan, write nothing, call no Docker")
    parser.add_argument("--capability-file", help="where the pending enrollment capability is exported (required until enrolled)")
    parser.add_argument("--compose-project", help="Compose project name recorded on the first run")
    parser.add_argument("--profile", action="append", default=None, help="blobs, compute or edge; repeatable; '' records none")
    parser.add_argument("--access-mode", choices=("local", "public", "proxy"))
    parser.add_argument("--public-url")
    parser.add_argument("--backup-dir")
    parser.add_argument("--build", action="store_true", help="build the server and workerd images from this checkout (compose.dev.yaml)")
    args = parser.parse_args(argv)
    if Path(args.env_file).is_symlink():
        raise Refused("unsafe_env_file", f"{args.env_file} must not be a symlink")
    env_file = Path(args.env_file).resolve()
    template = ROOT / ".env.example"
    explicit = None if args.profile is None else [name for name in args.profile if name]
    if "gateway" in (explicit or []):
        raise Refused("gateway_profile_retired", GATEWAY_RETIRED)
    if args.profile is not None and ("" in args.profile and len(args.profile) != 1 or any(name not in PROFILES for name in explicit or [])):
        parser.error("--profile accepts blobs, compute or edge; '' alone selects none")
    if not args.dry_run and os.environ.get("DOCKER_HOST", "unix://").partition("://")[0] != "unix":
        raise Refused("remote_docker_unsupported", "bootstrap reads the capability through the local Docker socket")

    if args.dry_run:
        return plan(args, env_file, template, explicit)
    lock_path = env_file.with_name(env_file.name + ".lock")
    with open(lock_path, "w", encoding="utf-8") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise Refused("bootstrap_already_running", str(lock_path)) from error
        return prepare(args, env_file, template, explicit, runner)


def select(env: EnvFile, args, explicit: list[str] | None) -> dict:
    """The Compose selection: recorded values win; explicit flags must agree or refuse."""
    entries = env.entries
    project = entries.get("COMPOSE_PROJECT_NAME") or args.compose_project or PROJECT
    if args.compose_project and args.compose_project != project:
        raise Refused("selection_conflict", f"recorded COMPOSE_PROJECT_NAME={project} differs from --compose-project {args.compose_project}")
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", project):
        raise Refused("invalid_compose_project", "COMPOSE_PROJECT_NAME must be lowercase letters, digits, - and _")
    if entries.get("COMPOSE_PATH_SEPARATOR", ":") != ":" or entries.get("COMPOSE_ENV_FILES"):
        raise Refused("selection_conflict", "COMPOSE_PATH_SEPARATOR and COMPOSE_ENV_FILES are unsupported")
    secrets_present = any(key in entries for key in SECRETS)
    if "COMPOSE_PROFILES" in entries:
        profiles = [name for name in dict.fromkeys(entries["COMPOSE_PROFILES"].split(",")) if name]
        if "gateway" in profiles:
            raise Refused("gateway_profile_retired", GATEWAY_RETIRED)
        if explicit is not None and sorted(set(explicit)) != sorted(set(profiles)):
            requested = ",".join(explicit) or "''"
            raise Refused("selection_conflict", f"recorded COMPOSE_PROFILES='{entries['COMPOSE_PROFILES']}' differs from --profile {requested}; "
                          f"omit --profile to reuse the recorded selection, or edit COMPOSE_PROFILES and COMPOSE_FILE in {env.path} deliberately")
    elif explicit is None and (secrets_present or "COMPOSE_FILE" in entries):
        raise Refused("existing_selection_required", f"{env.path} records secrets but no COMPOSE_PROFILES; pass --profile for each "
                      "profile of the existing installation, or --profile '' for core only, so the selection is recorded")
    else:
        profiles = list(dict.fromkeys(explicit or []))
    if any(name not in PROFILES for name in profiles):
        raise Refused("selection_conflict", "COMPOSE_PROFILES may name only blobs, compute or edge")
    derived = [str(ROOT / "compose.yaml"), *(str(ROOT / f"compose.{name}.yaml") for name in profiles)]
    fresh = "COMPOSE_FILE" not in entries
    files = [str((env.path.parent / name).resolve()) if name else "" for name in entries["COMPOSE_FILE"].split(":")] if not fresh else derived
    if args.build and str(ROOT / "compose.dev.yaml") not in files:
        if not fresh:
            raise Refused("selection_conflict", f"--build needs compose.dev.yaml in the recorded COMPOSE_FILE of {env.path}")
        files.append(str(ROOT / "compose.dev.yaml"))
    if files[0] != str(ROOT / "compose.yaml"):
        raise Refused("invalid_compose_file", "COMPOSE_FILE must start with this checkout's compose.yaml")
    for name in files:
        if not name or re.search(r"[\n\r$`'\"\\:]", name) or not Path(name).is_file():
            raise Refused("invalid_compose_file", f"COMPOSE_FILE entry {name or '(empty)'} is not a readable file")
    for key, value in (("COMPOSE_PROJECT_NAME", project), ("COMPOSE_PROFILES", ",".join(profiles)), ("COMPOSE_FILE", ":".join(files))):
        shell = os.environ.get(key)
        if shell is not None and (sorted(shell.split(",")) if key == "COMPOSE_PROFILES" else shell) != (sorted(value.split(",")) if key == "COMPOSE_PROFILES" else value):
            raise Refused("selection_conflict", f"the shell exports {key}; unset it, the recorded selection in {env.path} is authoritative")
    return {"project": project, "profiles": profiles, "files": files, "fresh": fresh and not secrets_present}


def settings(env: EnvFile, args, selection: dict) -> dict:
    """Access and network settings, applied to the env file in memory."""
    entries = env.entries
    unsupported = [key for key in UNSUPPORTED if key in env.assignments or key in os.environ]
    if unsupported:
        raise Refused("unsupported_setting", "; ".join(f"{key} is unsupported, use {UNSUPPORTED[key]}" for key in unsupported)
                      + f"; remove {', '.join(unsupported)} from {env.path} and the shell environment")
    for key, value in (("BP_ACCESS_MODE", args.access_mode), ("BP_PUBLIC_URL", args.public_url), ("BP_BACKUP_DIR", args.backup_dir)):
        if value is None:
            continue
        if re.search(r"[\n\r$`'\"\\]", value):
            raise Refused("env_conflict", f"{key} holds characters bootstrap cannot record")
        if key in entries and entries[key] != value and env.source is not None:
            raise Refused("env_conflict", f"{key}={entries[key]} is recorded in {env.path}; edit the file to change it")
        if key not in entries or env.source is None:
            env.save(key, value)
    # A first look needs no separate mount; production replaces this with an encrypted off-host one.
    env.default("BP_BACKUP_DIR", str(env.path.parent / "backups"))
    profiles = selection["profiles"]
    access = resolve_access(entries, "edge" in profiles)
    env.default("BP_ACCESS_MODE", access["mode"])
    env.default("BP_PUBLIC_URL", access["origin"])
    # The blob helper runs BP_BLOB_BOOTSTRAP_IMAGE, or BP_SERVER_IMAGE when that is empty.
    for key in ("BP_RUSTFS_IMAGE", "BP_BLOB_BOOTSTRAP_IMAGE", "BP_SERVER_IMAGE"):
        if key in entries and not IMAGE_REFERENCE.fullmatch(entries[key]):
            raise Refused("image_reference_invalid", f"{key} must be a complete image reference")
    network, prefix = entries.get("BP_PLATFORM_NETWORK") or NETWORK, entries.get("BP_VOLUME_PREFIX") or PROJECT
    if not SAFE_NAME.match(network):
        raise Refused("invalid_platform_network", "BP_PLATFORM_NETWORK must be a Docker network name")
    if not SAFE_NAME.match(prefix):
        raise Refused("invalid_volume_prefix", "BP_VOLUME_PREFIX must be a Docker volume name prefix")
    subnet, ip_range, gateway = platform_allocation(entries)
    return {"access": access, "network": network, "prefix": prefix, "subnet": subnet, "ip_range": ip_range,
            "gateway": gateway, "data_dir": (env.path.parent / (entries.get("BP_DATA_DIR") or "data")).resolve(),
            "secrets": {**CORE_SECRETS, **(BLOB_SECRETS if "blobs" in profiles else {}), **(COMPUTE_SECRETS if "compute" in profiles else {})}}


def compose_command(project: str, env_file: Path, files: list[str], profiles: list[str]) -> list[str]:
    return ["docker", "compose", "--project-name", project, "--project-directory", str(ROOT), "--env-file", str(env_file),
            *(part for name in files for part in ("-f", name)), *(part for name in profiles for part in ("--profile", name))]


def plan(args, env_file: Path, template: Path, explicit: list[str] | None) -> int:
    env = read_env(env_file, template)
    selection = select(env, args, explicit)
    resolved = settings(env, args, selection)
    missing = sorted(key for key in resolved["secrets"] if key not in env.entries)
    backup = Path(env.entries["BP_BACKUP_DIR"])
    warnings = [] if backup.is_dir() or backup == env_file.parent / "backups" else [f"backup directory {backup} does not exist; create the mount or pass --backup-dir"]
    if not selection["fresh"] and missing:
        warnings.append("an existing installation is missing secrets: " + ", ".join(missing) + "; restore the original env file")
    print(json.dumps({
        "dryRun": True, "envFile": str(env_file), "exists": env.source is not None, "project": selection["project"],
        "profiles": selection["profiles"], "composeFiles": selection["files"], "accessMode": resolved["access"]["mode"],
        "url": resolved["access"]["origin"], "blobBackend": "s3" if "blobs" in selection["profiles"] else "filesystem",
        "network": {"name": resolved["network"], "subnet": resolved["subnet"], "ipRange": resolved["ip_range"], "gateway": resolved["gateway"]},
        "volumes": volume_names(resolved["prefix"], selection["profiles"]), "backupDir": str(backup), "generate": missing,
        "compose": compose_command(selection["project"], env_file, selection["files"], selection["profiles"]) + ["up", "-d", "--wait"],
        "warnings": warnings,
    }))
    return 0


def prepare(args, env_file: Path, template: Path, explicit: list[str] | None, runner: Runner) -> int:
    env = read_env(env_file, template)
    selection = select(env, args, explicit)
    resolved = settings(env, args, selection)
    entries, profiles, files, project = env.entries, selection["profiles"], selection["files"], selection["project"]
    backup = Path(entries["BP_BACKUP_DIR"])
    if backup == env_file.parent / "backups":
        # Postgres and the server traverse it as their own users; the postgres entrypoint owns the leaves.
        backup.mkdir(mode=0o755, exist_ok=True)
    if not backup.is_dir():
        raise Refused("backup_directory_required", f"{backup} does not exist; mount it or pass --backup-dir, the server reads Checkpoints from it")
    if args.build and (entries.get("BP_SERVER_IMAGE") or entries.get("BP_WORKERD_IMAGE")):
        raise Refused("build_conflicts_with_image_override", "--build would build over the explicit BP_SERVER_IMAGE or BP_WORKERD_IMAGE; clear the override or omit --build")
    child = {key: value for key, value in os.environ.items() if not key.startswith(("BP_", "COMPOSE_"))}
    found, volumes = installation_state(runner, child, project, resolved["prefix"])
    if args.capability_file is None and selection["fresh"] and not found:
        raise Refused("capability_file_required", "a fresh installation enrolls its first User; pass --capability-file PATH before anything is created")
    missing = sorted(key for key in resolved["secrets"] if key not in entries)
    if found and missing:
        raise Refused("existing_installation_missing_secrets",
                      "restore the original env file before starting; found " + "; ".join(found) + "; missing " + ", ".join(missing))
    legacy_rustfs = "COMPOSE_PROFILES" not in entries and f"{resolved['prefix']}_rustfs-data" in volumes
    if legacy_rustfs and "blobs" not in profiles:
        raise Refused("backend_change_unsupported", "an existing rustfs-data volume needs --profile blobs; the Files backend never changes")
    for key in missing:
        env.save(key, secrets.token_hex(resolved["secrets"][key]))
    env.save("COMPOSE_PROJECT_NAME", project)
    env.save("COMPOSE_FILE", ":".join(files))
    env.save("COMPOSE_PROFILES", ",".join(profiles))
    env.default("BP_VOLUME_PREFIX", resolved["prefix"])
    env.default("BP_PLATFORM_NETWORK", resolved["network"])
    child.update(entries)
    compose = compose_command(project, env_file, files, profiles)
    # Interpolate the prospective env in memory; a fresh env file holds only the template so far.
    preflight = list(compose)
    preflight[preflight.index("--env-file") + 1] = "/dev/null" if env.source is None else str(env_file)
    try:
        config = json.loads(docker(runner, [*preflight[1:], "config", "--format", "json"], child, "invalid_compose_config"))
        server, storage_init = config["services"]["server"]["environment"], config["services"]["storage-init"]["environment"]
        server_image = config["services"]["server"]["image"]
    except (ValueError, KeyError, TypeError):
        raise Refused("invalid_compose_config", "the selected Compose files do not render the server and storage-init services") from None
    backend = server.get("BP_BLOB_BACKEND") or "filesystem"
    if backend not in ("filesystem", "s3") or (storage_init.get("BP_BLOB_BACKEND") or "filesystem") != backend \
            or entries.get("BP_BLOB_BACKEND", backend) != backend or (legacy_rustfs and backend != "s3"):
        raise Refused("backend_change_unsupported",
                      f"the selected files render Files backend {backend} but {env.path} records {entries.get('BP_BLOB_BACKEND', 'none')}; "
                      "keep the recorded backend's selection, or create a new installation for another backend")
    env.save("BP_BLOB_BACKEND", backend)
    if args.build:
        docker(runner, [*preflight[1:], "build"], child, "compose_build_failed")
    identity = None
    if "compute" in profiles:
        workerd = config["services"].get("workerd", {}).get("environment", {}) if isinstance(config["services"].get("workerd"), dict) else {}
        published = workerd.get("BP_WORKERD_IMAGE") if isinstance(workerd.get("BP_WORKERD_IMAGE"), str) else ""
        identity = verify_workerd_image(entries, child, runner, published, not entries.get("BP_WORKERD_IMAGE") and not args.build)
    env.write()
    if identity:
        persist_workerd_evidence(resolved["data_dir"], identity)
        child.update(BP_WORKERD_IMAGE=identity["reference"], BP_WORKERD_EFFECTIVE_IMAGE=identity["imageId"], BP_WORKERD_HOST_IMAGE_ID=identity["imageId"])
    ensure_network(runner, child, resolved["network"], resolved["subnet"], resolved["ip_range"], resolved["gateway"])
    ensure_volumes(runner, child, volume_names(resolved["prefix"], profiles), project)
    if not args.build:
        pull_missing_images(runner, child, config)
    up = runner([*compose, "up", "--detach", "--build" if args.build else "--no-build", "--wait", "--wait-timeout", "300"], env=child)
    if up.returncode:
        raise Refused("compose_up_failed", output(up))
    base = f"http://127.0.0.1:{entries.get('BP_PORT') or '3000'}"
    enrollment = wait_ready(base)
    wait_capabilities(base, entries["BP_OPERATIONS_TOKEN"], {"files": backend, **({"functions": "workerd"} if "compute" in profiles else {})})
    capability = Path(args.capability_file).resolve() if args.capability_file else None
    if enrollment == "pending":
        if capability is None:
            raise Refused("capability_file_required", "enrollment is pending; rerun with --capability-file PATH to export the capability")
        export_capability(runner, child, compose, capability)
        state = cli_state_dir()
        state.mkdir(parents=True, exist_ok=True)
        state.chmod(0o700)
    origin = resolved["access"]["origin"]
    print(json.dumps({
        "project": project, "envFile": str(env_file), "profiles": profiles, "composeFiles": files, "url": origin,
        "enrollment": enrollment, "capabilityFile": str(capability) if enrollment == "pending" else None,
        "next": enrollment_command(ROOT, env_file, origin, capability, cli_state_dir(), server_image) if enrollment == "pending"
        else f"Enrollment is complete; open {origin}/dashboard or run bp with the saved credentials.",
    }))
    return 0


def main() -> int:
    try:
        return bootstrap(sys.argv[1:])
    except Refused as refused:
        print(json.dumps({"error": refused.code, "detail": refused.detail}), file=sys.stderr)
        return 3 if refused.code in NOT_READY else 1
    except OSError as error:
        print(json.dumps({"error": "io_error", "detail": str(error)}), file=sys.stderr)
        return 1
    except SystemExit as exit_:
        return 2 if exit_.code not in (0, None) else 0


if __name__ == "__main__":
    raise SystemExit(main())
