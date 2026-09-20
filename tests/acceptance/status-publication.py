#!/usr/bin/env python3
"""Exercise selected status publication with one owned unprivileged Caddy fixture."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
from install_status_timer import installation, units
from record_status import prepare
from status_io import directory, publish
from status_observer import observe

IMAGE = 'caddy:2.11.4@sha256:13ba145cba2f3e28fa801994876e4c086d1b95d5aa2a520a734765ffb6b12017'
owner = str(uuid.uuid4())
project = 'bp-status-proof-' + owner[:12]
container = None
networks = []
child_env = {key: value for key, value in os.environ.items() if not key.startswith(('BP_', 'COMPOSE_'))}


def docker(*args):
    result = subprocess.run(['docker', *args], env=child_env, capture_output=True,
                            text=True, timeout=60, cwd=ROOT)
    if result.returncode:
        raise RuntimeError('owned status fixture Docker ' + args[0] + ' failed')
    return result.stdout.strip()


with tempfile.TemporaryDirectory(prefix='bp-status-proof-') as temporary:
    root = Path(temporary)
    state, backup = root / 'private parent' / 'state', root / 'backup'
    backup.mkdir()
    old_umask = os.umask(0o077)
    try:
        prepare(state)
    finally:
        os.umask(old_umask)
    assert state.parent.stat().st_mode & 0o777 == 0o700
    assert (state / 'console').stat().st_mode & 0o777 == 0o755
    env_file = root / 'selected.env'
    sentinel = uuid.uuid4().hex
    settings = dict(BP_STATUS_DIR=str(state), BP_BACKUP_DIR=str(backup), BP_PUBLIC_URL='http://localhost:3000',
                    BP_AUTH_SECRET=sentinel, BP_POSTGRES_ADMIN_PASSWORD=sentinel, BP_POSTGRES_PASSWORD=sentinel,
                    BP_OPERATIONS_TOKEN=sentinel, BP_RUSTFS_ROOT_USER='proofroot', BP_RUSTFS_ROOT_PASSWORD=sentinel,
                    BP_BLOB_S3_ACCESS_KEY='proofaccess', BP_BLOB_S3_SECRET_KEY=sentinel,
                    BP_COMPUTE_TOKEN=sentinel, BP_WORKERD_IMAGE='agent-backplane-workerd:status-config-only',
                    BP_PLATFORM_NETWORK=project + '-platform', BP_VOLUME_PREFIX=project)
    env_file.write_text(''.join(key + "='" + value + "'\n" for key, value in settings.items()))
    env_file.chmod(0o600)
    variants = [(), ('blobs',), ('compute',), ('edge',), ('gateway',), ('blobs', 'compute', 'gateway')]
    selected_gateway = None
    for profiles in variants:
        files = ['compose.yaml', *['compose.' + profile + '.yaml' for profile in profiles]]
        selected = installation(ROOT, env_file, project, files, profiles, state)
        assert selected[-1] == state
        if 'gateway' in profiles:
            selected_gateway = selected
        if {'edge', 'gateway'} & set(profiles):
            try:
                installation(ROOT, env_file, project, files, profiles, root / 'wrong')
            except Exception as error:
                from status_io import Unavailable
                assert isinstance(error, Unavailable)
            else:
                raise AssertionError('conflicting consumer state accepted')
    assert selected_gateway is not None
    service = units(*selected_gateway)['agent-backplane-status.service']
    assert 'TimeoutStartSec=120' in service and str(state) in service
    assert sentinel not in service
    # Verify actual systemd syntax without installing or starting any unit.
    unit_dir = root / 'units'
    unit_dir.mkdir()
    for name, contents in units(*selected_gateway).items():
        (unit_dir / name).write_text(contents)
    result = subprocess.run(['systemd-analyze', 'verify', *map(str, unit_dir.iterdir())],
                            capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, 'generated user unit syntax failed'
    try:
        for name in [project + '_default', project + '-platform']:
            networks.append(docker('network', 'create', '--label', 'io.backplane.status-proof=' + owner, name))
        container = docker('create', '--name', project, '--pull', 'missing', '--user', '65534:65534',
                           '--label', 'io.backplane.status-proof=' + owner,
                           '--label', 'com.docker.compose.project=' + project,
                           '--label', 'com.docker.compose.service=edge',
                           '--network', project + '_default', '--publish', '127.0.0.1::80',
                           '--tmpfs', '/data:rw,mode=1777', '--tmpfs', '/config:rw,mode=1777',
                           '--health-cmd', 'wget -qO- http://127.0.0.1/health || exit 1', '--health-interval', '1s',
                           '--mount', f'type=bind,src={ROOT}/infra/compose/Caddyfile,dst=/etc/caddy/Caddyfile,readonly',
                           '--mount', f'type=bind,src={state}/console,dst=/srv/status,readonly',
                           '--env', 'BP_ACCESS_MODE=proxy', '--env', 'BP_PUBLIC_URL=http://localhost:3000', IMAGE)
        docker('network', 'connect', project + '-platform', container)
        docker('start', container)
        origin = 'http://' + docker('port', container, '80').splitlines()[0]

        def request(method='GET', headers=None):
            try:
                response = urllib.request.urlopen(urllib.request.Request(origin + '/status.json',
                                                   method=method, headers=headers or {}), timeout=5)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                return response.status, {key.lower(): value for key, value in response.headers.items()}, response.read()

        deadline = time.monotonic() + 20
        while True:
            try:
                status, _, body = request()
                assert status == 404 and body == b''
                break
            except (OSError, AssertionError):
                if time.monotonic() > deadline:
                    raise
                time.sleep(.1)
        _, selected_env, selected_project, files, profiles, selected_state = selected_gateway
        document = observe(ROOT, selected_env, selected_project, files, profiles, selected_state)
        assert document is not None
        original = (state / 'console/status.json').read_bytes()
        assert sentinel.encode() not in original and len(original) <= 65536
        assert (state / 'console/status.json').stat().st_mode & 0o777 == 0o644
        headers = {'Authorization': 'Bearer ' + sentinel, 'Cookie': 'secret=' + sentinel,
                   'If-Modified-Since': 'Wed, 01 Jan 2100 00:00:00 GMT', 'If-None-Match': '*', 'Range': 'bytes=0-1'}
        status, response_headers, body = request(headers=headers)
        assert status == 200 and body == original
        assert response_headers.get('content-type') == 'application/json'
        assert response_headers.get('cache-control') == 'no-store'
        assert 'etag' not in response_headers and 'last-modified' not in response_headers
        assert request('HEAD', headers)[0::2] == (200, b'')
        assert request('POST')[0] == 405
        # Reorder valid envelope fields to prove an atomic replacement is served immediately.
        with directory(state / 'console') as descriptor:
            publish(descriptor, 'status.json', dict(reversed(list(document.items()))))
        replacement = (state / 'console/status.json').read_bytes()
        assert replacement != original and request(headers=headers)[2] == replacement
        (state / 'console/status.json').unlink()
        assert request()[0::2] == (404, b'')
        print(json.dumps({'gate': 'status-publication', 'composeSelections': len(variants),
                          'unprivilegedHttp': 'GET HEAD POST missing conditional range atomic replacement passed',
                          'observer': 'owned selected deployment only', 'units': 'verified; not installed'}))
    finally:
        primary_error = sys.exc_info()[1]
        cleanup_failed = False
        resources = [('container', container)] if container else []
        resources.extend(('network', network) for network in reversed(networks))
        for kind, identifier in resources:
            try:
                if kind == 'container':
                    assert docker('inspect', '--format', '{{index .Config.Labels "io.backplane.status-proof"}}', identifier) == owner
                    docker('rm', '--force', identifier)
                else:
                    assert docker('network', 'inspect', '--format', '{{index .Labels "io.backplane.status-proof"}}', identifier) == owner
                    docker('network', 'rm', identifier)
            except Exception:
                cleanup_failed = True
                print('Owned status fixture cleanup failed for ' + kind + ' ' + identifier, file=sys.stderr)
        if cleanup_failed and primary_error is None:
            raise RuntimeError('owned status fixture cleanup failed')
