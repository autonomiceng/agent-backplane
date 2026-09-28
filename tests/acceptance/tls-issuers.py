#!/usr/bin/env python3
"""Render the seven Issuer modes and validate Caddy without starting the installed stack."""

import json
import os
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HOST = "backplane.example.com"
MATRIX = (
    ("local-internal", "local", "internal", ()),
    ("local-files", "local", "files", ("compose.files.yaml",)),
    ("public-acme", "public", "acme", ("compose.public.yaml",)),
    ("public-acme-ca", "public", "acme", ("compose.public.yaml", "compose.acme-ca-root.yaml")),
    ("public-acme-eab", "public", "acme", ("compose.public.yaml", "compose.acme-eab.yaml")),
    ("public-files", "public", "files", ("compose.public.yaml", "compose.files.yaml")),
    ("proxy", "proxy", "", ()),
)


def run(args: list[str], env: dict[str, str] | None = None) -> str:
    result = subprocess.run(args, cwd=ROOT, env=env, capture_output=True, text=True, timeout=90)
    if result.returncode:
        raise RuntimeError(f"{args[:3]} failed: {result.stderr[-1200:]}")
    return result.stdout


def certificate_files(directory: Path) -> Path:
    certs = directory / "certs"
    certs.mkdir(mode=0o755)
    run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=fixture CA",
         "-keyout", str(directory / "ca.key"), "-out", str(directory / "ca.crt"), "-days", "1",
         "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"])
    run(["openssl", "req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", f"/CN={HOST}",
         "-keyout", str(certs / "tls.key"), "-out", str(directory / "leaf.csr")])
    (directory / "leaf.ext").write_text(
        "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n"
        f"extendedKeyUsage=serverAuth\nsubjectAltName=DNS:{HOST},DNS:localhost,IP:127.0.0.1\n")
    run(["openssl", "x509", "-req", "-in", str(directory / "leaf.csr"), "-CA", str(directory / "ca.crt"),
         "-CAkey", str(directory / "ca.key"), "-CAcreateserial", "-out", str(certs / "tls.crt"),
         "-days", "1", "-sha256", "-extfile", str(directory / "leaf.ext")])
    (certs / "tls.key").chmod(0o644)
    return certs


def fixture_env(mode: str, issuer: str, directory: Path, certs: Path) -> dict[str, str]:
    env = {key: value for key, value in os.environ.items() if not key.startswith(("BP_", "COMPOSE_"))}
    env.update(BP_ACCESS_MODE=mode, BP_TLS_ISSUER=issuer, BP_EDGE_HOST=HOST,
               BP_PUBLIC_DOMAIN="example.com", BP_PUBLIC_URL=f"https://{HOST}", BP_BACKUP_DIR=str(directory),
               BP_TLS_DIR=str(certs), BP_ACME_CA_ROOT=str(directory / "ca.crt"),
               BP_ACME_CA="https://ca.example/directory", BP_ACME_EAB_KEY_ID="fixture",
               BP_ACME_EAB_HMAC="fixture", BP_AUTH_SECRET="a" * 32,
               BP_POSTGRES_ADMIN_PASSWORD="fixture", BP_POSTGRES_PASSWORD="fixture")
    return env


def adapt(image: str, path: Path, mode: str, issuer: str | None) -> bytes:
    settings = ["-e", f"BP_ACCESS_MODE={mode}", "-e", f"BP_EDGE_HOST={HOST}",
                "-e", f"BP_PUBLIC_URL=https://{HOST}"]
    if issuer:
        settings += ["-e", f"BP_TLS_ISSUER={issuer}"]
    return run(["docker", "run", "--rm", "--network", "none", *settings,
                "-v", f"{path}:/etc/caddy/Caddyfile:ro", image,
                "caddy", "adapt", "--config", "/etc/caddy/Caddyfile"]).encode()


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="bp-t4-matrix-") as temporary:
        directory = Path(temporary)
        certs = certificate_files(directory)
        baseline = directory / "before-t4.Caddyfile"
        baseline.write_text(run(["git", "show", "719b7b8:infra/compose/Caddyfile"]))
        image = ""
        for name, mode, issuer, overlays in MATRIX:
            env = fixture_env(mode, issuer, directory, certs)
            selected = ["compose.yaml"] + ([] if mode == "proxy" else ["compose.edge.yaml", *overlays])
            command = ["docker", "compose", "--project-directory", str(ROOT), "--env-file", "/dev/null"]
            for file in selected:
                command += ["-f", str(ROOT / file)]
            if mode != "proxy":
                command += ["--profile", "edge"]
            config = json.loads(run(command + ["config", "--format", "json"], env))
            if mode == "proxy":
                assert "edge" not in config["services"]
                print("PASS proxy compose (no Caddy)")
                continue
            edge = config["services"]["edge"]
            assert edge["environment"]["BP_TLS_ISSUER"] == issuer
            image = edge["image"]
            mounts = ["-v", f"{ROOT / 'infra/compose/Caddyfile'}:/etc/caddy/Caddyfile:ro"]
            if issuer == "files":
                mounts += ["-v", f"{certs}:/certs:ro"]
            elif "compose.acme-ca-root.yaml" in overlays:
                mounts += ["-v", f"{directory / 'ca.crt'}:/certs/acme-ca-root.crt:ro"]
            settings = [part for key, value in edge["environment"].items() if key.startswith("BP_")
                        for part in ("-e", f"{key}={value}")]
            run(["docker", "run", "--rm", "--network", "none", *settings, *mounts, image,
                 "caddy", "validate", "--config", "/etc/caddy/Caddyfile"])
            print(f"PASS {name} compose and caddy validate")
        for mode, issuer in (("local", "internal"), ("public", "acme")):
            old = adapt(image, baseline, mode, None)
            new = adapt(image, ROOT / "infra/compose/Caddyfile", mode, issuer)
            assert old == new, f"{mode} default adapt differs ({len(old)} versus {len(new)} bytes)"
            print(f"PASS {mode} default adapt byte-identical ({len(new)} bytes)")


if __name__ == "__main__":
    main()
