#!/usr/bin/env python3
"""Scenario 6: real coordinated postmigration checkpoint and fresh-volume restore, with API fixtures."""
import json
import os
from pathlib import Path
import runpy
import secrets
import shutil
import subprocess
import tempfile
from types import SimpleNamespace
import urllib.request
import uuid
from checkpoint import ROOT, Stack, command, backup, verify


def drill():
    os.umask(0o077)
    root = Path(tempfile.mkdtemp(prefix='bp-migration-drill-'))
    project = 'bp-migration-drill-' + uuid.uuid4().hex[:12]
    origin = 'http://localhost:' + os.environ.get('BP_DRILL_PORT', '18400')
    # The drill owns every named resource and never targets an installed project.
    for key in list(os.environ):
        if key.startswith('BP_') or key.startswith('COMPOSE_'):
            del os.environ[key]
    overlay = root / 'owned.yaml'
    overlay.write_text('networks:\n  platform:\n    external: false\n    name: ' + project + '-platform\n')
    # PostgreSQL must traverse each bind-mounted repository; the host parent stays private.
    source_repo = root / 'source'; source_repo.mkdir(); source_repo.chmod(0o755)
    recovery_repo = root / 'recovery'; recovery_repo.mkdir(); recovery_repo.chmod(0o755)
    values = {name: secrets.token_hex(32) for name in ('BP_AUTH_SECRET', 'BP_OPERATIONS_TOKEN', 'BP_POSTGRES_PASSWORD', 'BP_POSTGRES_ADMIN_PASSWORD', 'BP_RUSTFS_ROOT_PASSWORD')}
    values.update(BP_BLOB_S3_ACCESS_KEY=secrets.token_hex(10), BP_BLOB_S3_SECRET_KEY=secrets.token_hex(20), BP_RUSTFS_ROOT_USER=secrets.token_hex(10),
                  BP_BLOB_S3_BUCKET='migration-proof', BP_PORT=origin.rsplit(':', 1)[1], BP_PUBLIC_URL=origin,
                  BP_VOLUME_PREFIX=project, COMPOSE_PROJECT_NAME=project, BP_BACKUP_DIR=str(source_repo), BP_BACKUP_KEEP='1',
                  BP_SERVER_IMAGE='agent-backplane-migration-drill:' + project)
    source_files = [str(ROOT / 'compose.yaml'), str(overlay)]
    target_files = [str(ROOT / 'compose.yaml'), str(ROOT / 'compose.blobs.yaml'), str(overlay)]
    def write_env(path, files, extra=None):
        path.write_text('\n'.join(f'{key}={value}' for key, value in {**values, 'COMPOSE_FILE': os.pathsep.join(files), **(extra or {})}.items()) + '\n')
        path.chmod(0o600)
    env = root / '.env'; target_env = root / 'target.env'
    write_env(env, source_files); write_env(target_env, target_files, {'COMPOSE_PROFILES': 'blobs'})
    compose = ['docker', 'compose', '--project-directory', str(ROOT), '--env-file', str(env), *[arg for name in source_files for arg in ('-f', name)]]
    volumes = [project + '_' + name for name in ('postgres-data', 'server-data')]
    operator = runpy.run_path(str(ROOT / 'scripts/storage-migrate.py'))
    success = False
    stacks = []
    try:
        for volume in volumes:
            command(['docker', 'volume', 'create', '--label', 'backplane.test-owner=' + project, volume])
        command(compose + ['up', '--build', '-d', '--wait', '--wait-timeout', '180'])
        source = operator['stack_from_env'](env); stacks.append(source)
        capability = root / 'capability'; capability.write_text(source.dc('exec', '-T', 'server', 'cat', '/data/enrollment/capability')); capability.chmod(0o600)
        password = secrets.token_hex(24)
        enrolled = json.loads(command(['bun', str(ROOT / 'packages/cli/runtime/main.ts'), 'bootstrap', '--url', origin,
                                      '--email', 'migration@example.com', '--capability-file', str(capability)],
                                     env={**os.environ, 'BP_BOOTSTRAP_PASSWORD': password, 'BP_DATA_DIR': str(root / 'cli')}))
        credential = json.loads(Path(enrolled['credentialsFile']).read_text())
        base = '/api/v1/workspaces/' + enrolled['workspaceId']
        headers = {'content-type': 'application/json', 'authorization': 'Bearer ' + credential['key']}
        def request(path, body=None, actor=None):
            with urllib.request.urlopen(urllib.request.Request(origin + path, data=None if body is None else json.dumps(body).encode(), headers=actor or headers), timeout=30) as response:
                return json.load(response)
        def login():
            login = urllib.request.Request(origin + '/api/auth/sign-in/email', data=json.dumps({'email': 'migration@example.com', 'password': password}).encode(),
                                           headers={'content-type': 'application/json', 'origin': origin})
            with urllib.request.urlopen(login, timeout=30) as response:
                cookie = '; '.join(value.split(';')[0] for value in response.headers.get_all('Set-Cookie', []))
            return {'content-type': 'application/json', 'origin': origin, 'cookie': cookie}
        user = login()
        principal = request(base + '/principals', {'name': 'second migration Principal'}, user)
        second = request(base + '/principals/' + principal['id'] + '/keys', {}, user)
        actors = [headers, {'content-type': 'application/json', 'authorization': 'Bearer ' + second['key']}]
        blobs = []
        for index, actor in enumerate(actors):
            actor['x-backplane-run'] = request(base + '/runs', {'harness': 'storage-migration-drill'}, actor)['id']
            payload = ('migration bytes ' + str(index)).encode()
            req = urllib.request.Request(origin + base + '/blobs?key=proof-' + str(index), data=payload, headers={**actor, 'content-type': 'application/octet-stream'}, method='POST')
            with urllib.request.urlopen(req, timeout=30) as response:
                blobs.append((json.load(response)['id'], payload, actor))
        migration = dict(name='migration proof', sql='CREATE TABLE migration_proof (id integer PRIMARY KEY, value text)', expectedRevision=0, destructive=False)
        preview = request(base + '/migrations/preview', migration)
        request(base + '/migrations', {**migration, 'sqlHash': preview['sqlHash'], 'previewPosition': preview['previewPosition']})
        request(base + '/sql', dict(statement="INSERT INTO migration_proof VALUES (1, 'preserved')", params=[]))
        source.dc('stop', 'server')
        retained = '/data/blobs/' + enrolled['workspaceId'] + '/' + str(uuid.uuid4()) + '.stage'
        source.dc('run', '--rm', '--no-deps', '--entrypoint', 'bun', 'storage-init', '-e',
                  "await Bun.write(process.argv[1],'retained staging'); await import('node:fs/promises').then(fs=>fs.chmod(process.argv[1],0o600))", retained)
        from checkpoint import storage_admin
        storage_admin(source, 'reconcile', '--fenced', '--checkpoint', 'drill-retention', '--retain-unreferenced')
        before = backup(source, offline=True, fenced=True)
        metadata = source.pg("SELECT json_agg(b ORDER BY id) FROM control.blobs b")
        heads = source.snapshot()['heads']
        args = SimpleNamespace(action='migrate', state=root / 'state', target_env=target_env, env_file=env, checkpoint=before)
        operator_globals = operator['run'].__globals__
        capture = operator_globals['backup']
        interrupted = {}
        def interrupt_capture(stack, offline=False, fenced=False, migration=None):
            if not offline or not fenced or not migration or migration['phase'] != 'committed_pending_checkpoint':
                raise ValueError('capture fault did not reach the pending boundary')
            interrupted['id'] = str(uuid.UUID(migration['id']))
            interrupted['container'] = stack.dc('ps', '-aq', 'rustfs')
            interrupted['binding'] = stack.pg('SELECT row_to_json(b) FROM control.blob_storage_binding b')
            stack.dc('stop', '-t', '60', 'rustfs')
            if 'rustfs' in stack.dc('ps', '--status', 'running', '--services').split():
                raise ValueError('capture fault did not leave RustFS stopped')
            raise RuntimeError('blob_binding_drill_capture_interrupted')
        operator_globals['backup'] = interrupt_capture
        try:
            try:
                operator['run'](args)
            except RuntimeError as error:
                if str(error) != 'blob_binding_drill_capture_interrupted':
                    raise
            else:
                raise ValueError('capture fault did not interrupt migration')
        finally:
            operator_globals['backup'] = capture
        if (root / 'state/postcheckpoint.json').exists():
            raise ValueError('interrupted capture published a completion receipt')
        pending_target = operator['stack_from_env'](target_env)
        if pending_target.pg(f"SELECT phase FROM control.blob_storage_migration WHERE id='{interrupted['id']}'") != 'committed_pending_checkpoint':
            raise ValueError('interrupted capture released the migration gate')
        result = operator['run'](args)
        if pending_target.dc('ps', '-aq', 'rustfs') != interrupted['container']:
            raise ValueError('pending retry recreated the RustFS container')
        if pending_target.pg('SELECT row_to_json(b) FROM control.blob_storage_binding b') != interrupted['binding']:
            raise ValueError('pending retry changed the committed binding')
        if result['phase'] != 'complete' or result['id'] != interrupted['id']:
            raise ValueError('migration did not complete')
        target = operator['stack_from_env'](env); stacks.append(target)
        volumes.append(target.volume('rustfs-data'))
        post = Path(json.loads((root / 'state/postcheckpoint.json').read_text())['checkpoint'])
        doc = verify(post, target)
        if target.pg("SELECT json_agg(b ORDER BY id) FROM control.blobs b") != metadata or target.snapshot()['heads'] != heads:
            raise ValueError('migration changed provenance')
        if not before.exists():
            raise ValueError('keep=1 pruned the pinned filesystem checkpoint')
        target.dc('down')
        copied = recovery_repo / 'backups' / post.name
        copied.parent.mkdir(exist_ok=True)
        copied.parent.chmod(0o755)  # Restore hands this parent to PostgreSQL; snapshots stay private.
        shutil.copytree(post, copied)
        recovery_prefix = project + '-recovery'
        recovery_env = root / 'recovery.env'
        write_env(recovery_env, target_files, dict(BP_BACKUP_DIR=str(recovery_repo), BP_VOLUME_PREFIX=recovery_prefix, COMPOSE_PROJECT_NAME=recovery_prefix, COMPOSE_PROFILES='blobs'))
        # Stack's existing restore path checks exact image/archive custody before starting any server.
        os.environ['COMPOSE_FILE'] = os.pathsep.join(target_files)
        recovery = Stack(recovery_env, copied); stacks.append(recovery)
        del os.environ['COMPOSE_FILE']
        recovery.compose += [arg for name in target_files for arg in ('-f', name)]
        volumes.extend(recovery.volume(name) for name in recovery.stores)
        result = subprocess.run(['python3', str(ROOT / 'scripts/checkpoint.py'), 'restore', '--env-file', str(recovery_env),
                                 str(copied), '--fenced', '--migration-budget', '7200'],
                                capture_output=True, text=True, cwd=ROOT, timeout=7500,
                                env={**os.environ, 'COMPOSE_FILE': os.pathsep.join(target_files), 'COMPOSE_PROFILES': 'blobs'})
        if result.returncode:
            detail = result.stderr.strip()
            for value in sorted(values.values(), key=len, reverse=True):
                if value:
                    detail = detail.replace(value, '[redacted]')
            detail = ''.join(char for char in detail if char in '\n\t' or ' ' <= char <= '~')[-2048:]
            raise RuntimeError(f'restore CLI failed (exit {result.returncode}): ' + detail)
        if recovery.pg(f"SELECT phase FROM control.blob_storage_migration WHERE id='{str(uuid.UUID(doc['migration']['id']))}'") != 'complete':
            raise ValueError('captured pending intent was not exactly reconciled')
        user = login(); status = request(base + '/restore', actor=user)
        for _ in range(100):
            if request(base + '/restore/release', {'epoch': status['epoch'], 'sourceFenced': True}, user)['done']:
                break
        else:
            raise ValueError('restore gate did not release')
        for blob_id, payload, actor in blobs:
            req = urllib.request.Request(origin + base + '/blobs/' + blob_id, headers={'authorization': actor['authorization']})
            with urllib.request.urlopen(req, timeout=30) as response:
                if response.read() != payload:
                    raise ValueError('restored Files differ')
        headers.pop('x-backplane-run'); headers['x-backplane-run'] = request(base + '/runs', {'harness': 'restored migration'})['id']
        if request(base + '/sql', dict(statement='SELECT value FROM migration_proof WHERE id=1', params=[]))['rows'] != [{'value': 'preserved'}]:
            raise ValueError('restored SQL differs')
        if recovery.pg("SELECT json_agg(b ORDER BY id) FROM control.blobs b") != metadata:
            raise ValueError('restored metadata/provenance differs')
        print(json.dumps(dict(scenario=6, result='pass', restoreBudgetSeconds=7200, checkpoint=doc['name'], retry='stopped pending target resumed with same container and binding', restored='SQL, two Principals, Files, provenance, retained inventory')))
        success = True
    finally:
        # Failed drills retain their fresh resources and bytes for root diagnosis.
        if success:
            for stack in reversed(stacks):
                stack.dc('down', '--remove-orphans')
            for volume in dict.fromkeys(volumes):
                command(['docker', 'volume', 'rm', volume])
        print('Disposable migration drill artifacts: ' + str(root))


if __name__ == '__main__':
    drill()
