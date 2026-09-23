#!/usr/bin/env python3
"""Qualify the optional native console and exact proxy trust with disposable containers."""
from datetime import datetime, timezone
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
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
tls_context = None
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


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request(origin, path='/rustfs/console/', headers=None, redirects=True):
    handlers = [urllib.request.HTTPSHandler(context=tls_context)]
    if not redirects:
        handlers.append(NoRedirect())
    opener = urllib.request.build_opener(*handlers)
    try:
        response = opener.open(urllib.request.Request(origin + path, headers=headers or {}), timeout=5)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        return response.status, response.read(1024 * 1024), response.headers


def signed_get(origin, path):
    # Fixed fixture paths/queries are already canonical; sign the external Host including port.
    url = urllib.parse.urlsplit(origin + path)
    date = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    day = date[:8]
    scope = day + '/us-east-1/s3/aws4_request'
    payload_hash = hashlib.sha256(b'').hexdigest()
    headers = {'host': url.netloc, 'x-amz-content-sha256': payload_hash, 'x-amz-date': date}
    signed = 'host;x-amz-content-sha256;x-amz-date'
    canonical = '\n'.join(['GET', url.path, url.query,
                           ''.join(key + ':' + value + '\n' for key, value in headers.items()),
                           signed, payload_hash])
    key = ('AWS4' + child_env['RUSTFS_SECRET_KEY']).encode()
    for part in [day, 'us-east-1', 's3', 'aws4_request']:
        key = hmac.new(key, part.encode(), hashlib.sha256).digest()
    to_sign = '\n'.join(['AWS4-HMAC-SHA256', date, scope, hashlib.sha256(canonical.encode()).hexdigest()])
    signature = hmac.new(key, to_sign.encode(), hashlib.sha256).hexdigest()
    headers['authorization'] = ('AWS4-HMAC-SHA256 Credential=' + child_env['RUSTFS_ACCESS_KEY'] + '/' + scope
                                + ', SignedHeaders=' + signed + ', Signature=' + signature)
    return request(origin, path, headers, redirects=False)


with tempfile.TemporaryDirectory(prefix='bp-console-proof-') as temporary:
    root = Path(temporary)
    try:
        network = docker('network', 'create', '--label', label + '=' + owner, 'bp-console-' + owner)
        # Adapt and provision every conditional site without running listeners or issuing certificates.
        configurations = []
        for mode in ('local', 'public', 'proxy'):
            for enabled in ('true', 'false'):
                proxy = mode == 'proxy'
                settings = {
                    'BP_ACCESS_MODE': mode, 'BP_RUSTFS_CONSOLE': enabled,
                    'BP_EDGE_HOST': 'backplane.example.test',
                    'BP_PUBLIC_URL': 'https://shared.example.test:8449' if proxy else 'https://backplane.example.test:8443',
                    'BP_RUSTFS_HOST': 'rustfs.example.test',
                    'BP_RUSTFS_URL': 'https://shared.example.test:8450' if proxy else 'https://rustfs.example.test:8443',
                    'BP_RUSTFS_URL_HOST': 'shared.example.test' if proxy else 'rustfs.example.test',
                    'BP_RUSTFS_AUTHORITY': 'shared.example.test:8450' if proxy else 'rustfs.example.test:8443',
                    'BP_TRUSTED_PROXIES': '192.0.2.2/32' if proxy else '',
                    'BP_RUSTFS_CONSOLE_ALLOW': '100.64.0.7/32',
                }
                configurations.append(settings)
        configurations.append({
            'BP_ACCESS_MODE': 'proxy', 'BP_RUSTFS_CONSOLE': 'false',
            'BP_EDGE_HOST': 'backplane.localhost', 'BP_PUBLIC_URL': 'https://backplane.example.test',
            'BP_RUSTFS_HOST': 'rustfs.localhost', 'BP_RUSTFS_URL': 'https://rustfs.localhost:443',
            'BP_RUSTFS_URL_HOST': 'unused.invalid', 'BP_RUSTFS_AUTHORITY': '',
            'BP_TRUSTED_PROXIES': '172.30.0.2/32', 'BP_RUSTFS_CONSOLE_ALLOW': '127.0.0.1/8 ::1',
        })
        for settings in configurations:
            validation = create('--tmpfs', '/data', '--tmpfs', '/config',
                                '--mount', f'type=bind,src={ROOT}/infra/compose/Caddyfile,dst=/etc/caddy/Caddyfile,readonly',
                                *[arg for key, value in settings.items() for arg in ('--env', key + '=' + value)],
                                CADDY, 'caddy', 'adapt', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile', '--validate')
            result = subprocess.run(['docker', 'start', '--attach', validation], env=child_env,
                                    capture_output=True, text=True, timeout=90)
            if result.returncode:
                detail = result.stderr
                for key in ('RUSTFS_ACCESS_KEY', 'RUSTFS_SECRET_KEY'):
                    detail = detail.replace(child_env[key], '[redacted]')
                detail = ''.join(char for char in detail if char in '\n\t' or ' ' <= char <= '~')[-500:]
                raise RuntimeError(f"Caddy validation failed for mode={settings['BP_ACCESS_MODE']} "
                                   f"console={settings['BP_RUSTFS_CONSOLE']}: {detail}")
        rustfs = create('--network-alias', 'rustfs', '--memory', '1g', '--cpus', '1', '--pids-limit', '128',
                        '--tmpfs', '/data:rw,size=256m,mode=0777', '--env', 'RUSTFS_ACCESS_KEY', '--env', 'RUSTFS_SECRET_KEY',
                        '--env', 'RUSTFS_CONSOLE_ENABLE=true', '--env', 'RUSTFS_CONSOLE_ADDRESS=:9001',
                        '--env', 'RUSTFS_OBS_LOG_DIRECTORY=', '--env', 'RUSTFS_OBS_LOG_STDOUT_ENABLED=true', RUSTFS, '/data')
        docker('start', rustfs)
        # A controlled ingress fixture asserts an allowed or denied original client.
        # The gateway trusts only this container's exact peer address.
        certificate, key = root / 'localhost.crt', root / 'localhost.key'
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                        '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost',
                        '-keyout', str(key), '-out', str(certificate)],
                       check=True, capture_output=True, timeout=30)
        key.chmod(0o600)
        tls_context = ssl.create_default_context(cafile=str(certificate))
        peer_file = root / 'Caddyfile'
        peer_file.write_text('''{
 auto_https off
}
https://localhost:443 {
 tls /tls/localhost.crt /tls/localhost.key
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
        peer = create('--publish', '127.0.0.1::443', '--tmpfs', '/data', '--tmpfs', '/config',
                      '--mount', f'type=bind,src={root},dst=/tls,readonly',
                      '--mount', f'type=bind,src={peer_file},dst=/etc/caddy/Caddyfile,readonly', CADDY)
        docker('start', peer)
        address = docker('port', peer, '443').splitlines()[0]
        origin = 'https://localhost:' + address.rsplit(':', 1)[1]
        authority = urllib.parse.urlsplit(origin).netloc
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
                status, body, _ = request(origin)
                assert status == 200 and b'<html' in body.lower()
                break
            except (OSError, AssertionError):
                if time.monotonic() > deadline:
                    raise
                time.sleep(.2)
        assert request(origin, headers={'X-Proof-Deny': 'true'})[0] == 404
        assert request(direct, headers={'Host': authority, 'X-Forwarded-For': '100.64.0.7'})[0] == 404
        assert request(origin, '/rustfs/admin/v3/accountinfo')[0] == 403
        assert signed_get(origin, '/rustfs/admin/v3/accountinfo')[0] == 200, 'signed admin account info failed'
        assert signed_get(origin, '/?list-type=2')[0] == 200, 'signed S3 root list failed'
        landing, _, headers = request(origin, '/', {'Accept': 'text/html'}, redirects=False)
        assert landing == 302 and headers['Location'] == '/rustfs/console/'
        local = create('--publish', '127.0.0.1::80', '--tmpfs', '/data', '--tmpfs', '/config',
                       '--mount', f'type=bind,src={ROOT}/infra/compose/Caddyfile,dst=/etc/caddy/Caddyfile,readonly',
                       '--env', 'BP_ACCESS_MODE=local', '--env', 'BP_EDGE_HOST=backplane.localhost',
                       '--env', 'BP_PUBLIC_URL=http://backplane.localhost', '--env', 'BP_RUSTFS_CONSOLE=true',
                       '--env', 'BP_RUSTFS_HOST=rustfs.localhost', CADDY)
        docker('start', local)
        local_origin = 'http://' + docker('port', local, '80').splitlines()[0]
        deadline = time.monotonic() + 10
        while True:
            try:
                for path in ('/rustfs/console/', '/rustfs/admin/v3/accountinfo', '/'):
                    assert request(local_origin, path, {'Host': 'rustfs.localhost'}, redirects=False)[0] == 404
                break
            except OSError:
                if time.monotonic() > deadline:
                    raise
                time.sleep(.1)
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
            result = subprocess.run(['node', browser_script], env={**child_env, 'CONSOLE_ORIGIN': origin, 'CONSOLE_TLS_CERT': str(certificate)},
                                    capture_output=True, text=True, timeout=60)
            if result.returncode:
                raise RuntimeError('owned native console browser login failed')
            print(json.dumps({'browserLogin': 'pass'}))
        print(json.dumps({'gate': 'rustfs-console', 'nativeHtml': 'pass', 'tlsCertificateVerified': True, 'landingRedirect': 302, 'nativeAuthRequired': 'pass',
                          'localHttpConsole': '404', 'signedAdminAccountInfo': 200, 'signedS3RootList': 200, 'caddyConfigurationsValidated': len(configurations),
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
