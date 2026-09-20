#!/usr/bin/env python3
"""Destructive only within a fresh disposable Compose project and its private temporary repository."""
import argparse
import json
import hashlib
import os
from pathlib import Path
import secrets
import shutil
import tempfile
import time
import sys
import urllib.request
import uuid
from checkpoint import ROOT, Stack, backup, command, restore, inspect_storage, verify


def drill(offline=False, s3=False):
    offline = offline or s3
    root = Path(tempfile.mkdtemp(prefix='backplane-drill-'))
    host_uid, host_gid = os.getuid(), os.getgid()
    try:
        project = 'bp-drill-' + uuid.uuid4().hex[:12]
        port = int(os.environ.get('BP_DRILL_PORT', '18301' if s3 else '18300'))
        origin = f'http://localhost:{port}'
        # Keep the same credentials and public origin across the recovery incarnation.
        values = {name: secrets.token_hex(32) for name in ('BP_AUTH_SECRET', 'BP_OPERATIONS_TOKEN', 'BP_POSTGRES_PASSWORD', 'BP_POSTGRES_ADMIN_PASSWORD')}
        values.update(BP_PORT=str(port), BP_PUBLIC_URL=origin, BP_VOLUME_PREFIX=project, BP_SERVER_IMAGE='agent-backplane-drill:' + project)
        if s3:
            values.update({key: secrets.token_hex(24) for key in ('BP_RUSTFS_ROOT_USER', 'BP_RUSTFS_ROOT_PASSWORD', 'BP_BLOB_S3_ACCESS_KEY', 'BP_BLOB_S3_SECRET_KEY')})
            values['BP_BLOB_S3_BUCKET'] = project
        source = root / 'source'; source.mkdir()
        recovery = root / 'recovery'; recovery.mkdir()
        recovery_again = root / 'recovery-again'; recovery_again.mkdir()
        env_file = root / '.env'
        def write_env(repository):
            env_file.write_text('\n'.join(f'{k}={v}' for k, v in {**values, 'BP_BACKUP_DIR': str(repository)}.items()) + '\n')
            env_file.chmod(0o600)
        write_env(source)
        for key in list(os.environ):
            if key.startswith('BP_') or key.startswith('COMPOSE_'):
                del os.environ[key]
        os.environ['COMPOSE_PROJECT_NAME'] = project
        # An isolated bridge avoids aliases or enrollment traffic reaching the operator's platform network.
        overlay = root / 'drill.yaml'
        overlay.write_text('networks:\n  platform:\n    external: false\n    name: ' + project + '-platform\n')
        os.environ['COMPOSE_FILE'] = os.pathsep.join([str(ROOT / 'compose.yaml'), *([str(ROOT / 'compose.blobs.yaml')] if s3 else []), str(overlay)])
        if s3:
            os.environ['COMPOSE_PROFILES'] = 'blobs'
        compose = ['docker', 'compose', '--project-directory', str(ROOT), '--env-file', str(env_file)]
        postgres_image = json.loads(command(compose + ['config', '--format', 'json']))['services']['postgres']['image']
        volumes = [project + '_' + name for name in ('postgres-data', 'server-data', *(['rustfs-data'] if s3 else []))]
        if command(compose + ['ps', '-aq']):
            raise ValueError('disposable project already has containers')
        if set(volumes) & set(command(['docker', 'volume', 'ls', '-q']).split()):
            raise ValueError('disposable drill volumes already exist')
        owned_volumes = []
        built_image = None
        try:
            for volume in volumes:
                command(['docker', 'volume', 'create', '--label', 'com.docker.compose.project=' + project, volume])
                owned_volumes.append(volume)
            command(compose + ['up', '--build', '-d', '--wait', '--wait-timeout', '180'])
            stack = Stack(env_file)
            built_image = stack.images['server']['id']
            capability = root / 'capability'
            capability.write_text(stack.dc('exec', '-T', 'server', 'cat', '/data/enrollment/capability'))
            capability.chmod(0o600)
            password = secrets.token_hex(24)
            cli_env = {**os.environ, 'BP_BOOTSTRAP_PASSWORD': password, 'BP_DATA_DIR': str(root / 'cli')}
            cli = ['bun', str(ROOT / 'packages/cli/runtime/main.ts')]
            enrolled = json.loads(command(cli + ['bootstrap', '--url', origin, '--email', 'drill@example.com', '--capability-file', str(capability)], env=cli_env))
            credential = json.loads(Path(enrolled['credentialsFile']).read_text())
            base = '/api/v1/workspaces/' + enrolled['workspaceId']
            headers = {'content-type': 'application/json', 'authorization': 'Bearer ' + credential['key']}
            def request(path, body=None, extra=None):
                req = urllib.request.Request(origin + path, data=None if body is None else json.dumps(body).encode(), headers=extra or headers)
                with urllib.request.urlopen(req, timeout=30) as response:
                    return json.load(response)
            run = request(base + '/runs', {'harness': 'backup-drill'})
            headers['x-backplane-run'] = run['id']
            migration = dict(name='checkpoint proof', sql='CREATE TABLE checkpoint_proof (id integer PRIMARY KEY, value text NOT NULL)', expectedRevision=0, destructive=False)
            preview = request(base + '/migrations/preview', migration)
            request(base + '/migrations', {**migration, 'sqlHash': preview['sqlHash'], 'previewPosition': preview['previewPosition']})
            proof = secrets.token_hex(16)
            request(base + '/sql', {'statement': 'INSERT INTO checkpoint_proof (id,value) VALUES ($1,$2)', 'params': [1, proof]})
            blob = b'checkpoint durable blob proof'
            blob_req = urllib.request.Request(origin + base + '/blobs?key=checkpoint-proof', data=blob, headers={**headers, 'content-type': 'application/octet-stream'}, method='POST')
            with urllib.request.urlopen(blob_req, timeout=30) as response:
                stored_blob = json.load(response)
            if stored_blob['sha256'] != hashlib.sha256(blob).hexdigest():
                raise ValueError('upload hash differs')
            blob_id = str(uuid.UUID(stored_blob['id']))
            provenance_sql = f"SELECT row_to_json(b) FROM control.blobs b WHERE id='{blob_id}'"
            original_provenance = stack.pg(provenance_sql)
            if json.loads(original_provenance)['run_id'] != run['id']:
                raise ValueError('upload Run provenance missing')
            audit_sql = f"SELECT coalesce(json_agg(e ORDER BY position),'[]') FROM audit.events e WHERE workspace_id='{str(uuid.UUID(enrolled['workspaceId']))}' AND run_id='{str(uuid.UUID(run['id']))}'"
            original_audit = stack.pg(audit_sql)
            if not json.loads(original_audit):
                raise ValueError('fixture audit evidence missing')
            def s3_object(mode, object_id):
                result = stack.dc('run', '--rm', '--no-deps', '-T', '--entrypoint', 'bun',
                                  '-v', str(ROOT / 'scripts/s3-checkpoint-fixture.js') + ':/checkpoint-fixture.js:ro',
                                  'storage-init', '/checkpoint-fixture.js', mode, enrolled['workspaceId'], object_id)
                return json.loads(result)
            if s3:
                # An injected archive failure must preserve its cause and resume the real source.
                original_helper = stack.helper
                def fail_archive(script, *args, **kwargs):
                    if '--hard-dereference' in script and any('rustfs-data.tar' in str(arg) for arg in args):
                        raise RuntimeError('drill injected archive failure')
                    return original_helper(script, *args, **kwargs)
                stack.helper = fail_archive
                try:
                    backup(stack, fenced=True)
                except RuntimeError as error:
                    if str(error) != 'drill injected archive failure': raise
                else:
                    raise ValueError('injected capture failure was ignored')
                finally:
                    stack.helper = original_helper
                if not {'rustfs', 'server'} <= set(stack.dc('ps', '--status', 'running', '--services').split()):
                    raise ValueError('capture failure did not resume source services')
                backup(stack, fenced=True)
            retained = None
            if offline:
                stack.dc('stop', 'server')
                if s3:
                    # Exercise restored-IAM proof entrypoints without invoking mutating bootstrap.
                    for service, key, entry in [
                        ('blob-bootstrap', 'BP_RUSTFS_ROOT_PASSWORD', ['/checkpoint-proof.js']),
                        ('storage-init', 'BP_BLOB_S3_SECRET_KEY', ['apps/server/blobs/storage-admin.ts', 'inspect', '--fenced']),
                    ]:
                        try:
                            stack.dc('run', '--rm', '--no-deps', '-T', '--entrypoint', 'bun',
                                     '-e', key + '=deliberately-wrong-drill-secret',
                                     '-v', str(ROOT / 'scripts/s3-checkpoint-proof.js') + ':/checkpoint-proof.js:ro', service, *entry)
                        except RuntimeError:
                            pass
                        else:
                            raise ValueError('wrong credential passed the read-only proof')
                    retained = str(uuid.uuid4())
                    extra_proof = s3_object('extra', retained)
                    if extra_proof['sha256'] != hashlib.sha256(b'retained crash bytes').hexdigest():
                        raise ValueError('extra fixture hash differs')
                else:
                    retained = f"/data/blobs/{enrolled['workspaceId']}/{uuid.uuid4()}"
                    stack.dc('run', '--rm', '--no-deps', '--entrypoint', 'bun', 'server', '-e',
                             "const f=await Bun.file(process.argv[1]); await Bun.write(f,'retained crash bytes'); await import('node:fs/promises').then(fs=>fs.chmod(process.argv[1],0o600))", retained)
                # Capture includes an unclassified leftover; restore must retain it explicitly.
            for cycle, repository in enumerate((recovery, recovery_again), start=1):
                if offline:
                    stack.dc('stop', 'server')
                source_proof = inspect_storage(stack) if s3 else None
                checkpoint = backup(stack, offline=offline, fenced=True)
                if s3 and (inspect_storage(stack) != source_proof or json.loads((checkpoint / 'manifest.json').read_text())['storage'] != source_proof):
                    raise ValueError('capture changed source storage')
                if offline and 'server' in stack.dc('ps', '--status', 'running', '--services').split():
                    raise ValueError('offline backup restarted the server')
                command(compose + ['down'])
                for volume in volumes:
                    info = json.loads(command(['docker', 'volume', 'inspect', volume]))[0]
                    if (info.get('Labels') or {}).get('com.docker.compose.project') != project:
                        raise ValueError('restore drill refuses an unowned source volume')
                command(['docker', 'volume', 'rm', *volumes])
                copied = repository / 'backups' / checkpoint.name
                shutil.copytree(checkpoint, copied)
                write_env(repository)
                stack = Stack(env_file, copied)
                started = time.monotonic()
                if s3:
                    env = stack.services['blob-bootstrap']['environment']
                    original = env['BP_RUSTFS_ROOT_PASSWORD']
                    env['BP_RUSTFS_ROOT_PASSWORD'] = 'deliberately-wrong-drill-secret'
                    try:
                        verify(copied, stack)
                    except ValueError as error:
                        if 'captured RustFS root and scoped credentials' not in str(error): raise
                    else:
                        raise ValueError('wrong restore root credential accepted')
                    finally:
                        env['BP_RUSTFS_ROOT_PASSWORD'] = original
                restore(stack, copied, retain_unreferenced=offline)
                user_headers = {'content-type': 'application/json', 'origin': origin}
                login_req = urllib.request.Request(origin + '/api/auth/sign-in/email', data=json.dumps({'email': 'drill@example.com', 'password': password}).encode(), headers=user_headers)
                with urllib.request.urlopen(login_req, timeout=30) as response:
                    cookie = '; '.join(value.split(';')[0] for value in response.headers.get_all('Set-Cookie', []))
                    if json.load(response)['user']['email'] != 'drill@example.com' or not cookie:
                        raise ValueError('restored login failed')
                user_headers['cookie'] = cookie
                status = request(base + '/restore', extra=user_headers)
                for _ in range(100):
                    released = request(base + '/restore/release', {'epoch': status['epoch'], 'sourceFenced': True}, user_headers)
                    if released['done']:
                        break
                else:
                    raise ValueError('restore gate did not release')
                stack.dc('up', '-d', '--wait', '--wait-timeout', '180')
                headers.pop('x-backplane-run', None)  # creating a Run rejects a Run header
                headers['x-backplane-run'] = request(base + '/runs', {'harness': 'backup-drill-restored'})['id']
                row = request(base + '/sql', {'statement': 'SELECT value FROM checkpoint_proof WHERE id=$1', 'params': [1]})
                if row['rows'] != [{'value': proof}]:
                    raise ValueError('restored row differs')
                blob_req = urllib.request.Request(origin + base + '/blobs/' + stored_blob['id'], headers={'authorization': headers['authorization']})
                with urllib.request.urlopen(blob_req, timeout=30) as response:
                    if response.read() != blob:
                        raise ValueError('restored blob differs')
                if stack.pg(provenance_sql) != original_provenance or stack.pg(audit_sql) != original_audit:
                    raise ValueError('restored blob metadata or original Audit Events differ')
                if s3:
                    actual = s3_object('read', blob_id)
                    if actual != {'id': blob_id, 'size': len(blob), 'sha256': hashlib.sha256(blob).hexdigest()}:
                        raise ValueError('restored S3 API bytes differ')
                if retained:
                    if s3 and s3_object('read', retained) != extra_proof:
                        raise ValueError('restored S3 extra bytes differ')
                    if not s3 and stack.dc('exec', '-T', 'server', 'bun', '-e', "console.log(await Bun.file(process.argv[1]).text())", retained) != 'retained crash bytes':
                        raise ValueError('retained crash bytes changed')
                    if stack.pg('SELECT count(*) FROM control.blob_storage_retained') != '1':
                        raise ValueError('retention evidence missing after restore')
                # RTO spans restore startup, login, gate release and row/blob verification.
                print(json.dumps({'project': project, 'cycle': cycle, 'rtoSeconds': round(time.monotonic() - started, 3),
                                  'backend': stack.backend, 'row': 'verified', 'login': 'verified', 'blob': 'verified', 'provenance': 'verified', 'checkpoint': 'verified'}))
        finally:
            primary_error = sys.exc_info()[1]
            cleanup_error = None
            for label, args in [('compose down', compose + ['down', '--remove-orphans']),
                                *((f'volume rm {volume}', ['docker', 'volume', 'rm', volume]) for volume in owned_volumes),
                                ('repository chown', ['docker', 'run', '--rm', '--network', 'none', '--user', '0',
                                 '-v', f'{source}:/source', '-v', f'{recovery}:/recovery', '-v', f'{recovery_again}:/recovery-again',
                                 '--entrypoint', 'sh', postgres_image, '-ec',
                                 'chown -R "$1:$2" /source /recovery /recovery-again', 'sh', str(host_uid), str(host_gid)])]:
                try:
                    if label.startswith('volume rm '):
                        present = command(['docker', 'volume', 'ls', '-q']).split()
                        if args[-1] not in present:
                            continue
                        info = json.loads(command(['docker', 'volume', 'inspect', args[-1]]))[0]
                        if (info.get('Labels') or {}).get('com.docker.compose.project') != project:
                            raise ValueError('cleanup refuses an unowned volume')
                    command(args)
                except Exception as error:
                    print(f'Drill cleanup failed ({label}): {error}', file=sys.stderr)
                    cleanup_error = cleanup_error or error
            if built_image is not None:
                try:
                    actual = command(['docker', 'image', 'inspect', '--format', '{{.Id}}', values['BP_SERVER_IMAGE']])
                    if actual != built_image:
                        raise ValueError('cleanup refuses a replaced drill image tag')
                    command(['docker', 'image', 'rm', values['BP_SERVER_IMAGE']])
                except Exception as error:
                    print(f'Drill image cleanup failed: {error}', file=sys.stderr)
                    cleanup_error = cleanup_error or error
            if primary_error is None and cleanup_error is not None:
                raise cleanup_error
        shutil.rmtree(root)
    except BaseException:
        print(f'Drill failed; retained disposable repository: {root}', file=sys.stderr)
        raise


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--offline', action='store_true', help='also recover explicitly retained crash bytes from a stopped-server capture')
    parser.add_argument('--s3', action='store_true', help='qualify the shipped local RustFS capture and two fresh-volume restores, including an unknown extra object')
    args = parser.parse_args()
    drill(args.offline, args.s3)
