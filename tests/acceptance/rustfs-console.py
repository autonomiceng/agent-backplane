#!/usr/bin/env python3
"""Qualify the optional native console and exact proxy trust with disposable containers."""
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
CADDY = 'caddy:2.11.4@sha256:13ba145cba2f3e28fa801994876e4c086d1b95d5aa2a520a734765ffb6b12017'
RUSTFS = 'rustfs/rustfs:1.0.0@sha256:8cc9801755448b71a786705ce76692c77e14936cccd87cf2fc31842e58f4d1ff'
owner = str(uuid.uuid4())
label = 'io.backplane.console-proof'
containers = []
network = None
child_env = {key: value for key, value in os.environ.items() if not key.startswith(('BP_', 'COMPOSE_'))}
child_env.update(RUSTFS_ACCESS_KEY=secrets.token_hex(10), RUSTFS_SECRET_KEY=secrets.token_hex(20))


def docker(*args):
    result = subprocess.run(['docker', *args], env=child_env, capture_output=True, text=True, timeout=90)
    if result.returncode:
        raise RuntimeError('owned console fixture Docker ' + args[0] + ' failed')
    return result.stdout.strip()


def create(*args):
    identifier = docker('create', '--label', label + '=' + owner, '--network', network, *args)
    containers.append(identifier)
    return identifier


def request(origin, path='/rustfs/console/', headers=None):
    try:
        response = urllib.request.urlopen(urllib.request.Request(origin + path, headers=headers or {}), timeout=5)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        return response.status, response.read(1024 * 1024)


with tempfile.TemporaryDirectory(prefix='bp-console-proof-') as temporary:
    root = Path(temporary)
    try:
        network = docker('network', 'create', '--label', label + '=' + owner, 'bp-console-' + owner)
        rustfs = create('--network-alias', 'rustfs', '--memory', '1g', '--cpus', '1', '--pids-limit', '128',
                        '--tmpfs', '/data:rw,size=256m,mode=0777', '--env', 'RUSTFS_ACCESS_KEY', '--env', 'RUSTFS_SECRET_KEY',
                        '--env', 'RUSTFS_CONSOLE_ENABLE=true', '--env', 'RUSTFS_CONSOLE_ADDRESS=:9001',
                        '--env', 'RUSTFS_OBS_LOG_DIRECTORY=', '--env', 'RUSTFS_OBS_LOG_STDOUT_ENABLED=true', RUSTFS, '/data')
        docker('start', rustfs)
        # A controlled ingress fixture asserts an allowed or denied original client.
        # The gateway trusts only this container's exact peer address.
        peer_file = root / 'Caddyfile'
        peer_file.write_text('''{
 auto_https off
}
:80 {
 route {
  @denied header X-Proof-Deny true
  handle @denied {
   reverse_proxy gateway:80 {
    header_up X-Forwarded-For 203.0.113.5
   }
  }
  handle {
   reverse_proxy gateway:80 {
    header_up X-Forwarded-For 100.64.0.7
   }
  }
 }
}
''')
        peer = create('--publish', '127.0.0.1::80', '--tmpfs', '/data', '--tmpfs', '/config',
                      '--mount', f'type=bind,src={peer_file},dst=/etc/caddy/Caddyfile,readonly', CADDY)
        docker('start', peer)
        address = docker('port', peer, '80').splitlines()[0]
        origin = 'http://localhost:' + address.rsplit(':', 1)[1]
        authority = origin.removeprefix('http://')
        peer_ip = docker('inspect', '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', peer)
        common = ['--publish', '127.0.0.1::80', '--tmpfs', '/data', '--tmpfs', '/config',
                  '--mount', f'type=bind,src={ROOT}/infra/compose/Caddyfile,dst=/etc/caddy/Caddyfile,readonly',
                  '--env', 'BP_ACCESS_MODE=proxy', '--env', 'BP_PUBLIC_URL=https://backplane.example.test',
                  '--env', 'BP_RUSTFS_HOST=rustfs.localhost', '--env', 'BP_RUSTFS_URL_HOST=localhost',
                  '--env', 'BP_RUSTFS_AUTHORITY=' + authority, '--env', 'BP_TRUSTED_PROXIES=' + peer_ip,
                  '--env', 'BP_RUSTFS_CONSOLE_ALLOW=100.64.0.7/32']
        gateway = create('--network-alias', 'gateway', *common, '--env', 'BP_RUSTFS_CONSOLE=true', CADDY)
        docker('start', gateway)
        direct = 'http://' + docker('port', gateway, '80').splitlines()[0]
        deadline = time.monotonic() + 40
        while True:
            try:
                status, body = request(origin)
                assert status == 200 and b'<html' in body.lower()
                break
            except (OSError, AssertionError):
                if time.monotonic() > deadline:
                    raise
                time.sleep(.2)
        assert request(origin, headers={'X-Proof-Deny': 'true'})[0] == 404
        assert request(direct, headers={'Host': authority, 'X-Forwarded-For': '100.64.0.7'})[0] == 404
        assert request(origin, '/rustfs/admin/v3/accountinfo')[0] == 403
        assert request(origin, '/', {'Accept': 'text/html'})[0] == 200
        disabled = create(*common, '--env', 'BP_RUSTFS_CONSOLE=false', CADDY)
        docker('start', disabled)
        disabled_origin = 'http://' + docker('port', disabled, '80').splitlines()[0]
        deadline = time.monotonic() + 10
        while True:
            try:
                assert request(disabled_origin, headers={'Host': authority})[0] == 404
                break
            except OSError:
                if time.monotonic() > deadline:
                    raise
                time.sleep(.1)
        # Optional host-only browser proof; the portable CI gate above needs no browser.
        browser_script = os.environ.get('BP_CONSOLE_PROOF_BROWSER')
        if browser_script:
            result = subprocess.run(['node', browser_script], env={**child_env, 'CONSOLE_ORIGIN': origin},
                                    capture_output=True, text=True, timeout=60)
            if result.returncode:
                raise RuntimeError('owned native console browser login failed')
            print(result.stdout.strip())
        print(json.dumps({'gate': 'rustfs-console', 'nativeHtml': 'pass', 'nativeAuthRequired': 'pass',
                          'trustedClientAllowDeny': 'pass', 'untrustedForwardedSpoofDenied': 'pass', 'disabled': '404'}))
    finally:
        primary_error = sys.exc_info()[1]
        cleanup_failed = False
        for identifier in reversed(containers):
            try:
                assert docker('inspect', '--format', '{{index .Config.Labels "' + label + '"}}', identifier) == owner
                docker('rm', '--force', identifier)
            except Exception:
                cleanup_failed = True
                print('Owned console container cleanup failed: ' + identifier, file=sys.stderr)
        if network:
            try:
                assert docker('network', 'inspect', '--format', '{{index .Labels "' + label + '"}}', network) == owner
                docker('network', 'rm', network)
            except Exception:
                cleanup_failed = True
                print('Owned console network cleanup failed: ' + network, file=sys.stderr)
        if cleanup_failed and primary_error is None:
            raise RuntimeError('owned console fixture cleanup failed')
