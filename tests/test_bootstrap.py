"""Bootstrap contract. Docker is never called; a fake runner and a fake HTTP probe answer instead."""

import contextlib
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import bootstrap  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CONTRACT_IPAM = 'bridge [{"Subnet":"172.30.0.0/24","IPRange":"172.30.0.128/25","Gateway":"172.30.0.1"}]'
IMAGE_ID = "sha256:" + "a" * 64
PUBLISHED = "registry.example/workerd:main-abc1234@sha256:" + "f" * 64


def runner_with(volumes=(), containers=(), network_exists=True, ipam=CONTRACT_IPAM, create_fails=False, capability="c" * 64):
    calls, probes = [], {}

    def completed(argv, code=0, stdout=""):
        return subprocess.CompletedProcess(argv, code, stdout, "" if code == 0 else "fake failure")

    def run(argv, **options):
        calls.append(argv)
        if argv[0] != "docker":
            return completed(argv)
        head = argv[1:3]
        if head == ["volume", "ls"]:
            # The fake knows no labels: the project-filtered listing is empty, the full listing is `volumes`.
            return completed(argv, stdout="" if "--filter" in argv else "\n".join(volumes))
        if argv[1] == "ps":
            return completed(argv, stdout="\n".join(containers))
        if head == ["network", "ls"]:
            return completed(argv)
        if head == ["network", "inspect"]:
            exists = network_exists or (create_fails and any(c[1:3] == ["network", "create"] for c in calls))
            return completed(argv, 0 if exists else 1, ipam if exists else "")
        if head == ["network", "create"]:
            return completed(argv, 1 if create_fails else 0)
        if argv[1] == "compose":
            env = options.get("env", {})
            profiles = env.get("COMPOSE_PROFILES", "").split(",")
            if "config" in argv:
                backend = "s3" if "blobs" in profiles else "filesystem"
                services = {"server": {"image": "server:rendered", "environment": {"BP_BLOB_BACKEND": backend}}, "storage-init": {"environment": {"BP_BLOB_BACKEND": backend}}}
                if "compute" in profiles:
                    services["server"]["environment"]["BP_COMPUTE_URL"] = "http://workerd:8080"
                    services["workerd"] = {"environment": {"BP_WORKERD_IMAGE": env.get("BP_WORKERD_IMAGE") or PUBLISHED}}
                return completed(argv, stdout=json.dumps({"services": services}))
            if "exec" in argv:
                return completed(argv, stdout=capability + "\n")
            return completed(argv)
        if argv[1] == "info":
            return completed(argv, stdout="amd64\n")
        if argv[1] == "image":
            return completed(argv, stdout=f"{IMAGE_ID} amd64\n")
        if argv[1] == "create":
            container = "b" * 64
            probes[container] = argv[argv.index("--entrypoint") + 1:]
            return completed(argv, stdout=container + "\n")
        if argv[1] == "start":
            executable = probes[argv[-1]][0]
            if executable == "sha256sum":
                return completed(argv, stdout=f"{bootstrap.WORKERD_BINARY}  /usr/bin/workerd\n{bootstrap.SUPERVISOR_BINARIES['amd64']}  /usr/bin/bun\n")
            return completed(argv, stdout=(bootstrap.WORKERD_VERSION if executable == "/usr/bin/workerd" else bootstrap.SUPERVISOR_VERSION) + "\n")
        return completed(argv)

    run.calls = calls
    return run


def fake_http(enrollment="pending", backend="filesystem"):
    def http_get(url, headers=None, timeout=5.0):
        now = bootstrap.datetime.now(bootstrap.timezone.utc).isoformat()
        if url.endswith("/health/ready"):
            return 200, json.dumps({"status": "ready", "enrollment": {"state": enrollment}, "problems": []})
        return 503, json.dumps({"capabilities": {"files": {"state": "healthy", "backend": backend, "observedAt": now},
                                                 "functions": {"state": "healthy", "backend": "workerd", "observedAt": now}}})
    return http_get


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.env = self.dir / ".env"
        self.capability = self.dir / "capability"
        self.backup = self.dir / "backups"
        self.environ = patch.dict(os.environ, {"HOME": self.tmp.name, "PATH": os.environ["PATH"]}, clear=True)
        self.environ.start()

    def tearDown(self):
        self.environ.stop()
        self.tmp.cleanup()

    def bootstrap(self, *extra, runner=None, http=None, profiles=()):
        runner = runner or runner_with()
        argv = ["--env-file", str(self.env), "--capability-file", str(self.capability),
                *(part for name in profiles for part in ("--profile", name)), *extra]
        out = io.StringIO()
        with patch.object(bootstrap, "http_get", http or fake_http("pending", "s3" if "blobs" in profiles else "filesystem")), \
                patch.object(bootstrap.time, "sleep"), contextlib.redirect_stdout(out):
            code = bootstrap.bootstrap(argv, runner)
        return code, json.loads(out.getvalue()), runner.calls

    def test_fresh_run_generates_every_secret_once_and_never_rewrites_present_values(self):
        code, result, calls = self.bootstrap(profiles=("blobs", "compute"))
        self.assertEqual(code, 0)
        text = self.env.read_text()
        self.assertEqual(oct(self.env.stat().st_mode & 0o777), "0o600")
        for key, size in bootstrap.SECRETS.items():
            self.assertEqual(len(re.findall(rf"^{key}='[a-f0-9]{{{size * 2}}}'$", text, re.M)), 1, key)
        self.assertNotIn("BP_AUTH_SECRET=\n", text, "template placeholders are replaced in place")
        self.assertIn("COMPOSE_PROFILES='blobs,compute'", text)
        self.assertIn(f"BP_BACKUP_DIR='{self.backup}'", text, "the default backup directory sits beside the env file")
        self.assertTrue(self.backup.is_dir())
        self.assertIn("BP_BLOB_BACKEND='s3'", text)
        self.assertEqual(result["enrollment"], "pending")
        self.assertEqual(self.capability.read_text(), "c" * 64 + "\n")
        self.assertEqual(oct(self.capability.stat().st_mode & 0o777), "0o600")
        self.assertTrue(result["next"].startswith("BP_SERVER_IMAGE=server:rendered docker compose "), result["next"])
        self.assertIn("compose.enroll.yaml", result["next"])
        self.assertIn(f"--user {os.getuid()}:{os.getgid()}", result["next"])
        self.assertIn(f"{self.capability}:/tmp/capability:ro", result["next"])
        self.assertIn("--url http://localhost:3000 --email USER_EMAIL", result["next"])
        self.assertEqual([c for c in calls if c[1] == "pull"], [["docker", "pull", "--platform", "linux/amd64", PUBLISHED]])
        self.assertFalse(any(c[1] == "build" or (c[1] == "compose" and "build" in c) for c in calls))
        with self.env.open("a") as handle:
            handle.write("MY_CUSTOM=${KEEP_THIS}\n# a comment\n")
        before = self.env.read_text()
        self.env.chmod(0o644)
        code, _, _ = self.bootstrap(profiles=("blobs", "compute"))
        self.assertEqual(code, 0)
        self.assertEqual(self.env.read_text(), before)
        self.assertEqual(oct(self.env.stat().st_mode & 0o777), "0o600", "an unchanged env file is tightened on every run")

    def test_rerun_preserves_recorded_profiles_and_refuses_a_conflicting_explicit_set(self):
        code, _, _ = self.bootstrap("--access-mode", "proxy", "--public-url", "https://backplane.example.com", profiles=("gateway", "blobs", "compute"))
        self.assertEqual(code, 0)
        saved = self.env.read_text()
        code, result, calls = self.bootstrap(http=fake_http("claimed", "s3"))
        self.assertEqual(code, 0)
        self.assertEqual(result["profiles"], ["gateway", "blobs", "compute"])
        self.assertEqual(result["enrollment"], "claimed")
        self.assertIsNone(result["capabilityFile"])
        self.assertEqual(self.env.read_text(), saved)
        for flags in (("edge",), ("blobs",), ("",)):
            with self.assertRaises(bootstrap.Refused) as refused:
                self.bootstrap(profiles=flags)
            self.assertEqual(refused.exception.code, "selection_conflict")
            self.assertIn("recorded COMPOSE_PROFILES='gateway,blobs,compute'", refused.exception.detail)
            self.assertIn("omit --profile", refused.exception.detail)
        self.assertEqual(self.env.read_text(), saved)
        with self.assertRaises(bootstrap.Refused) as refused:
            self.bootstrap("--access-mode", "local")
        self.assertEqual(refused.exception.code, "env_conflict")

    def test_proxy_requires_public_url_and_non_loopback_http_needs_the_insecure_override(self):
        with self.assertRaises(bootstrap.Refused) as refused:
            self.bootstrap("--access-mode", "proxy")
        self.assertEqual(refused.exception.code, "invalid_access_settings")
        self.assertIn("BP_PUBLIC_URL", refused.exception.detail)
        with self.assertRaises(bootstrap.Refused) as refused:
            bootstrap.resolve_access({"BP_ACCESS_MODE": "proxy", "BP_PUBLIC_URL": "http://backplane.example.com"})
        self.assertIn("BP_ALLOW_INSECURE_ORIGIN", refused.exception.detail)
        allowed = bootstrap.resolve_access({"BP_ACCESS_MODE": "proxy", "BP_PUBLIC_URL": "HTTP://Backplane.Example.com:80/", "BP_ALLOW_INSECURE_ORIGIN": "true"})
        self.assertEqual(allowed["origin"], "http://backplane.example.com")
        self.assertEqual(bootstrap.resolve_access({})["origin"], "http://localhost:3000")
        self.assertEqual(bootstrap.resolve_access({"BP_PUBLIC_DOMAIN": "example.com", "BP_HTTPS_PORT": "8443"}, edge=True)["origin"], "https://backplane.example.com:8443")
        for entries in ({"BP_ACCESS_MODE": "public", "BP_PUBLIC_DOMAIN": "example.com"},
                        {"BP_ACCESS_MODE": "local", "BP_TLS_ISSUER": "acme"},
                        {"BP_PUBLIC_URL": "https://127.0.0.2"},
                        {"BP_PUBLIC_URL": "http://localhost:3000", "BP_AUTH_URL": "http://localhost"}):
            with self.assertRaises(bootstrap.Refused, msg=entries):
                bootstrap.resolve_access(entries)
        self.assertFalse(self.env.exists())

    def test_platform_network_is_created_with_the_contract_and_mismatches_refuse(self):
        runner = runner_with(network_exists=False)
        code, _, calls = self.bootstrap(runner=runner)
        self.assertEqual(code, 0)
        self.assertIn(["docker", "network", "create", "--driver", "bridge", "--subnet", "172.30.0.0/24", "--ip-range", "172.30.0.128/25",
                       "--gateway", "172.30.0.1", "platform"], calls)
        self.assertEqual([c for c in calls if c[1:3] == ["volume", "create"]],
                         [["docker", "volume", "create", "--label", "com.docker.compose.project=agent-backplane", f"agent-backplane_{name}"]
                          for name in ("postgres-data", "server-data")])
        code, _, calls = self.bootstrap(runner=runner_with(network_exists=False, create_fails=True))
        self.assertEqual(code, 0, "a concurrent creation is validated instead of failing")
        for ipam in ('bridge [{"Subnet":"172.18.0.0/16","Gateway":"172.18.0.1"}]', "bridge null", 'macvlan [{"Subnet":"172.30.0.0/24","IPRange":"172.30.0.128/25","Gateway":"172.30.0.1"}]'):
            with self.assertRaises(bootstrap.Refused) as refused:
                self.bootstrap(runner=runner_with(ipam=ipam))
            self.assertEqual(refused.exception.code, "platform_network_mismatch")
            self.assertIn("expected driver bridge subnet 172.30.0.0/24 ip-range 172.30.0.128/25 gateway 172.30.0.1", refused.exception.detail)
            self.assertIn("docker network rm platform", refused.exception.detail)
        with self.assertRaises(bootstrap.Refused) as refused:
            bootstrap.platform_allocation({"BP_PLATFORM_IP_RANGE": "172.30.0.0/25"})
        self.assertEqual(refused.exception.code, "invalid_platform_network")

    def test_dry_run_writes_nothing_and_calls_no_docker(self):
        runner = runner_with()
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = bootstrap.bootstrap(["--dry-run", "--env-file", str(self.env), "--capability-file", str(self.capability), "--profile", "edge"], runner)
        plan = json.loads(out.getvalue())
        self.assertEqual(code, 0)
        self.assertEqual(runner.calls, [])
        self.assertFalse(self.env.exists())
        self.assertFalse(self.env.with_name(".env.lock").exists())
        self.assertEqual(plan["profiles"], ["edge"])
        self.assertEqual(plan["composeFiles"], [str(ROOT / "compose.yaml"), str(ROOT / "compose.edge.yaml")])
        self.assertEqual(plan["url"], "http://localhost")
        self.assertEqual(sorted(plan["generate"]), sorted(bootstrap.CORE_SECRETS))
        self.assertEqual(plan["network"], {"name": "platform", "subnet": "172.30.0.0/24", "ipRange": "172.30.0.128/25", "gateway": "172.30.0.1"})
        self.assertEqual(plan["compose"][-3:], ["up", "-d", "--wait"])
        self.assertEqual(plan["warnings"], [])
        self.assertEqual(plan["backupDir"], str(self.backup), "the default backup directory is created on the real run")

    def test_missing_secret_over_existing_installation_state_is_refused(self):
        code, _, _ = self.bootstrap()
        self.assertEqual(code, 0)
        text = self.env.read_text()
        broken = re.sub(r"^BP_AUTH_SECRET=.*\n", "", text, flags=re.M)
        self.env.write_text(broken)
        with self.assertRaises(bootstrap.Refused) as refused:
            self.bootstrap(runner=runner_with(volumes=["agent-backplane_postgres-data", "other_x"]))
        self.assertEqual(refused.exception.code, "existing_installation_missing_secrets")
        self.assertIn("volume agent-backplane_postgres-data", refused.exception.detail)
        self.assertNotIn("other_x", refused.exception.detail)
        self.assertEqual(self.env.read_text(), broken)
        with self.assertRaises(bootstrap.Refused) as refused:
            self.bootstrap(runner=runner_with(containers=["0123abcd"]))
        self.assertEqual(refused.exception.code, "existing_installation_missing_secrets")
        self.env.write_text(text.replace("COMPOSE_PROFILES=''\n", ""))
        with self.assertRaises(bootstrap.Refused) as refused:
            self.bootstrap()
        self.assertEqual(refused.exception.code, "existing_selection_required")
        self.env.unlink()
        runner = runner_with()
        with self.assertRaises(bootstrap.Refused) as refused:
            with patch.object(bootstrap, "http_get", fake_http()), contextlib.redirect_stdout(io.StringIO()):
                bootstrap.bootstrap(["--env-file", str(self.env)], runner)
        self.assertEqual(refused.exception.code, "capability_file_required")
        self.assertFalse(any(c[1:3] in (["volume", "create"], ["network", "create"]) or "up" in c for c in runner.calls))
        self.assertFalse(self.env.exists())

    def test_compose_command_lists_the_recorded_files_and_profiles_in_order(self):
        files = [ROOT / "compose.yaml", ROOT / "compose.gateway.yaml", ROOT / "compose.blobs.yaml", ROOT / "compose.compute.yaml"]
        self.env.write_text("COMPOSE_PROJECT_NAME='original'\nCOMPOSE_PROFILES='gateway,blobs,compute'\nBP_ACCESS_MODE=proxy\n"
                            "BP_PUBLIC_URL=https://backplane.example.com\nBP_WORKERD_IMAGE=agent-backplane-workerd:local\n"
                            f"COMPOSE_FILE='{':'.join(map(str, files))}'\n" + "".join(f"{key}={'e' * size * 2}\n" for key, size in bootstrap.SECRETS.items()))
        code, result, calls = self.bootstrap(http=fake_http("claimed", "s3"))
        self.assertEqual(code, 0)
        up = next(c for c in calls if c[1] == "compose" and "up" in c)
        self.assertEqual(up[:8], ["docker", "compose", "--project-name", "original", "--project-directory", str(ROOT), "--env-file", str(self.env)])
        self.assertEqual(up[8:16], [part for path in files for part in ("-f", str(path))])
        self.assertEqual(up[16:22], ["--profile", "gateway", "--profile", "blobs", "--profile", "compute"])
        self.assertEqual(up[22:], ["up", "--detach", "--no-build", "--wait", "--wait-timeout", "300"])
        self.assertFalse(any(c[1] == "pull" for c in calls), "an explicit workerd override is verified, never pulled")
        self.assertEqual([c[-2:] for c in calls if c[1:3] == ["volume", "create"]][:1],
                         [["com.docker.compose.project=original", "agent-backplane_postgres-data"]])
        self.assertIn("COMPOSE_PROFILES='gateway,blobs,compute'", self.env.read_text())
        self.assertIn("BP_BLOB_BACKEND='s3'", self.env.read_text())
        with self.assertRaises(bootstrap.Refused) as refused:
            self.bootstrap("--build", http=fake_http("claimed", "s3"))
        self.assertEqual(refused.exception.code, "selection_conflict")
        self.env.unlink()
        code, _, calls = self.bootstrap("--build")
        self.assertEqual(code, 0)
        build = next(c for c in calls if c[1] == "compose" and c[-1] == "build")
        self.assertEqual(build[build.index("--env-file") + 1], "/dev/null", "a fresh build cannot read an env file that does not exist yet")
        self.assertIn(str(ROOT / "compose.dev.yaml"), build)
        self.assertEqual(next(c for c in calls if "up" in c)[-4], "--build")
        self.env.write_text("BP_SERVER_IMAGE=custom:tag\n")
        with self.assertRaises(bootstrap.Refused) as refused:
            self.bootstrap("--build")
        self.assertEqual(refused.exception.code, "build_conflicts_with_image_override")

    def test_readiness_timeout_exits_3_with_not_ready(self):
        def refused(url, headers=None, timeout=5.0):
            raise ConnectionRefusedError(111, "Connection refused")
        original = bootstrap.wait_ready
        err = io.StringIO()
        argv = ["bootstrap.py", "--env-file", str(self.env), "--capability-file", str(self.capability)]
        with patch.object(bootstrap, "http_get", refused), patch.object(bootstrap.time, "sleep"), \
                patch.object(bootstrap, "wait_ready", lambda base: original(base, timeout=0)), \
                patch.object(bootstrap, "run", runner_with()), patch.object(sys, "argv", argv), contextlib.redirect_stderr(err):
            code = bootstrap.main()
        self.assertEqual(code, 3)
        error = json.loads(err.getvalue())
        self.assertEqual(error["error"], "not_ready")
        self.assertIn("/health/ready", error["detail"])
        self.assertIn("Connection refused", error["detail"])
        self.assertTrue(self.env.exists(), "the selection and secrets stay recorded for the rerun")
        self.assertFalse(self.capability.exists())


if __name__ == "__main__":
    unittest.main()
