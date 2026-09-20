#!/usr/bin/env python3
"""Qualify artifact protocol features in one owned, disposable runtime container."""
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]


def docker(*args, env=None):
    result = subprocess.run(['docker', *args], capture_output=True, text=True, env=env, timeout=120)
    if result.returncode:
        raise RuntimeError('Docker artifact probe failed; inspect the owned fixture privately')
    return result.stdout.strip()


def sha(value):
    return hashlib.sha256(value.encode()).hexdigest()


def manifest(bundle, runtime_digest):
    workspace = '00000000-0000-4000-8000-000000000001'
    principal = '00000000-0000-4000-8000-000000000002'
    loader = (ROOT / 'apps/server/compute/workerd/loader.js').read_text()
    check = re.search(r'const checkSource = `([^`]+)`;', loader)[1]
    value = dict(version=1, workspaceId=workspace, id='artifact-probe', entryPoint='default',
                 compatibilityDate='2026-01-01', bundle=bundle, bundleSha256=sha(bundle), outboundUrls=[],
                 keyRef=dict(workspaceId=workspace, principalId=principal), runtimeDigest=runtime_digest)
    value['configHash'] = sha(json.dumps([1, value['bundleSha256'], 'default', '2026-01-01', [],
                                        [workspace, principal], runtime_digest, sha(check)], separators=(',', ':')))
    return value


def main(image):
    identity = docker('image', 'inspect', '--format', '{{.Id}}', image)
    assert re.fullmatch(r'sha256:[0-9a-f]{64}', identity), 'invalid image content identity'
    token = secrets.token_hex(32)
    container = docker('create', '--name', 'bp-workerd-artifact-' + uuid.uuid4().hex,
                       '--pull', 'never', '--read-only', '--user', '65534:65534', '--cap-drop', 'ALL',
                       '--security-opt', 'no-new-privileges:true', '--memory', '512m', '--cpus', '1',
                       '--pids-limit', '128', '--publish', '127.0.0.1::8080', '--env', 'BP_COMPUTE_TOKEN',
                       '--mount', f'type=bind,src={ROOT / "apps/server/compute/workerd"},dst=/compute,readonly',
                       identity, 'serve', '/compute/config.capnp', '--experimental',
                       '--external-addr=api=127.0.0.1:9', env={**os.environ, 'BP_COMPUTE_TOKEN': token})
    try:
        docker('start', container)
        assert docker('exec', container, '/usr/bin/workerd', '--version') == 'workerd 2026-09-18', 'unexpected upstream version'
        address = docker('port', container, '8080').splitlines()[0]
        digest = docker('exec', container, 'sha256sum', '/usr/bin/workerd').split()[0]
        bundle = 'export default {async fetch(request, props) { return Response.json({input:await request.json(),workspaceId:props.workspaceId}); }};'
        value = manifest(bundle, digest)

        def request(path, body, auth=token):
            req = urllib.request.Request('http://' + address + path, data=json.dumps(body).encode(),
                                         headers={'Authorization': 'Bearer ' + auth, 'Content-Type': 'application/json'})
            try:
                with urllib.request.urlopen(req, timeout=5) as response:
                    return response.status, response.read(65537)
            except urllib.error.HTTPError as error:
                return error.code, error.read(65537)

        deadline = time.monotonic() + 15
        while True:
            try:
                status, _ = request('/prepare', value)
                break
            except (OSError, TimeoutError):
                if time.monotonic() >= deadline:
                    raise RuntimeError('runtime artifact startup deadline exceeded') from None
                time.sleep(.1)
        assert status == 204, 'Worker Loader or Check RPC failed'
        assert request('/prepare', value, 'invalid')[0] == 401, 'control endpoint accepted wrong credentials'
        assert request('/prepare', manifest('export default {', digest))[0] == 422, 'invalid source was accepted'
        props = dict(workspaceId=value['workspaceId'], runId='00000000-0000-4000-8000-000000000003',
                     token='bp_i_' + secrets.token_hex(32))
        status, body = request('/invoke', dict(manifest=value, props=props, input={'fixture': 'artifact'}))
        assert status == 200, 'null-ID Worker Loader invocation failed'
        assert json.loads(body) == {'input': {'fixture': 'artifact'}, 'workspaceId': value['workspaceId']}
        print(json.dumps({'imageId': identity, 'binarySha256': digest, 'checks': 5,
                          'result': 'artifact protocol passed; full runtime qualification remains separate'}))
    finally:
        docker('rm', '--force', container)


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) == 2 else 'agent-backplane-workerd:1.20260918.1')
