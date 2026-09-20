#!/usr/bin/env python3
"""Qualify invocation authority in one owned container and fresh PostgreSQL databases."""
import argparse
import json
import os
from pathlib import Path
import secrets
import socket
import signal
import subprocess
import sys
import time
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('image', help='already built supervisor image; never pulls')
parser.add_argument('--api-port', type=int, default=28411)
args = parser.parse_args()
if not 1024 <= args.api_port <= 65535:
    parser.error('API port must be in 1024..65535')

token, owner = secrets.token_hex(32), str(uuid.uuid4())
env = {**os.environ, 'BP_COMPUTE_TOKEN': token, 'BP_WORKERD_IMAGE': args.image,
       'BP_COMPUTE_TIMEOUT_MS': '15000',
       'BP_WORKERD_BINARY_SHA256': 'f31da6d248028d698806aa93d1b3aec28bbd4b4b7ddc31e967408ab6406fa5aa'}


interrupted_signal = None
cleaning = False


def docker(*command):
    if interrupted_signal is not None and not cleaning:
        raise SystemExit(128 + interrupted_signal)
    result = subprocess.run(['docker', *command], env=env, capture_output=True,
                            text=True, timeout=120, cwd=ROOT)
    if result.returncode:
        detail = result.stderr.replace(token, '[redacted]')[:1000]
        raise RuntimeError('owned Docker ' + command[0] + ' failed: ' + detail)
    return result.stdout.strip()


container = None

def interrupted(signum, _frame):
    global interrupted_signal
    interrupted_signal = signum

# SIGKILL cannot run cleanup; finite on-failure retries do not remove a leaked container.
signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)
try:
    context = docker('context', 'inspect', '--format', '{{.Endpoints.docker.Host}}')
    if not context.startswith('unix://') or os.environ.get('DOCKER_HOST', context) != context:
        raise RuntimeError('qualification requires matching local Docker endpoints')
    image_id = docker('image', 'inspect', '--format', '{{.Id}}', args.image)
    if docker('image', 'inspect', '--format', '{{.Architecture}}', image_id) != 'amd64':
        raise RuntimeError('this runtime gate currently qualifies linux/amd64 only')
    gateway = json.loads(docker('network', 'inspect', 'bridge'))[0]['IPAM']['Config'][0]['Gateway']
    with socket.socket() as probe:
        probe.bind((gateway, args.api_port))
    # Each test owns a fresh listener; a subsequent conflict fails before invocation.
    env.update(BP_WORKERD_HOST_IMAGE_ID=image_id, BP_TEST_API_HOST=gateway,
               BP_TEST_API_PORT=str(args.api_port), BP_TEST_MEMORY_CONTAINER='512m',
               BP_WORKERD_RUNTIME_ID='workerd-binary-sha256:' + env['BP_WORKERD_BINARY_SHA256'])
    container = docker('create', '--name', 'bp-runtime-pg-' + owner,
        '--label', 'io.backplane.runtime-proof=' + owner, '--pull', 'never', '--read-only',
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--restart', 'on-failure:10',
        '--memory', '512m', '--cpus', '1', '--pids-limit', '128', '--publish', '127.0.0.1::8080',
        '--mount', 'type=bind,src=' + str(ROOT / 'apps/server/compute/workerd') + ',dst=/compute,readonly',
        '--env', 'BP_COMPUTE_TOKEN', '--env', 'BP_COMPUTE_TIMEOUT_MS', '--env', 'BP_WORKERD_IMAGE', '--env', 'BP_WORKERD_HOST_IMAGE_ID',
        '--env', 'BP_WORKERD_BINARY_SHA256', '--entrypoint', '/bin/sh', image_id, '/compute/start.sh',
        '--external-addr=api=' + gateway + ':' + str(args.api_port))
    docker('start', container)
    env['BP_COMPUTE_URL'] = 'http://' + docker('port', container, '8080').splitlines()[0]
    deadline = time.monotonic() + 15
    while True:
        try:
            request = urllib.request.Request(env['BP_COMPUTE_URL'] + '/identity',
                                             headers={'Authorization': 'Bearer ' + token})
            with urllib.request.urlopen(request, timeout=2) as response:
                if response.status == 204:
                    break
        except Exception:
            pass
        if time.monotonic() > deadline:
            raise RuntimeError('owned runtime identity startup failed')
        time.sleep(.1)
    result = subprocess.run(['bun', 'run', 'test', './tests/acceptance/workerd-authority.ts',
        './tests/acceptance/workerd-memory.ts', './tests/acceptance/workerd-identity.ts'],
        env=env, timeout=160, cwd=ROOT)
    if interrupted_signal is not None:
        raise SystemExit(128 + interrupted_signal)
    print(json.dumps({'gate': 'actual-runtime-postgres', 'exitCode': result.returncode,
                      'imageId': image_id, 'memory': '512m', 'cpus': 1}), flush=True)
    if result.returncode:
        raise RuntimeError('actual runtime PostgreSQL gate failed')
finally:
    cleaning = True
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    if container is not None:
        primary_error = sys.exc_info()[1]
        try:
            observed = docker('inspect', '--format', '{{index .Config.Labels "io.backplane.runtime-proof"}}', container)
            if observed != owner:
                raise RuntimeError('refusing unowned cleanup')
            docker('rm', '--force', container)
        except Exception as error:
            reason = 'ownership verification refused' if str(error) == 'refusing unowned cleanup' else 'Docker cleanup command failed'
            print('Owned runtime cleanup failed (' + reason + '); inspect captured container ' + container, file=sys.stderr, flush=True)
            if primary_error is None:
                raise
