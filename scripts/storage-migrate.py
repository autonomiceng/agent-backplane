#!/usr/bin/env python3
"""Fenced, one-way filesystem to fresh local RustFS migration. Never removes storage."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import tempfile
import uuid
from checkpoint import (ROOT, RUSTFS_DIGEST, Stack, backup, check_writers, command,
                        pin_checkpoint, prove_root_credentials, start_existing_services, startup_timeout, verify)


def private_read(path, limit=1024 * 1024):
    stat = path.lstat()
    if path.is_symlink() or not path.is_file() or stat.st_nlink != 1 or stat.st_uid != os.getuid() or stat.st_mode & 0o077 or stat.st_size > limit:
        raise ValueError('operator files must be private, owned regular files')
    return path.read_bytes()


def atomic_private(path, content, expected=None):
    if expected is not None and private_read(path) != expected:
        raise ValueError('explicit environment changed; refusing cutover')
    fd, temporary = tempfile.mkstemp(prefix='.migration-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as file:
            file.write(content); file.flush(); os.fchmod(file.fileno(), 0o600); os.fsync(file.fileno())
        if expected is not None and private_read(path) != expected:
            raise ValueError('explicit environment changed; refusing cutover')
        os.replace(temporary, path)
        fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        Path(temporary).unlink(missing_ok=True)


def stack_from_env(path):
    content = private_read(path).decode()
    matches = re.findall(r'^COMPOSE_FILE=(.+)$', content, re.M)
    if len(matches) != 1 or any(not Path(name).is_absolute() for name in matches[0].split(os.pathsep)):
        raise ValueError('private env requires one explicit COMPOSE_FILE with absolute paths')
    old = os.environ.get('COMPOSE_FILE')
    try:
        os.environ['COMPOSE_FILE'] = matches[0]
        stack = Stack(path)
        # Freeze selection in argv; later environment replacement cannot change this stack.
        stack.compose += [arg for name in matches[0].split(os.pathsep) for arg in ('-f', name)]
        return stack
    finally:
        if old is None:
            os.environ.pop('COMPOSE_FILE', None)
        else:
            os.environ['COMPOSE_FILE'] = old


def target_identity(stack, migration):
    from checkpoint import credentials_digest
    return dict(project=stack.project, volume=stack.volume('rustfs-data'),
                bucket=stack.services['server']['environment']['BP_BLOB_S3_BUCKET'], endpoint='http://rustfs:9000',
                image=RUSTFS_DIGEST, credentialsSha256=credentials_digest(stack, migration, hashlib.sha256(migration.encode()).hexdigest()))


def attest_volume(stack, identity, migration):
    volume = json.loads(command(['docker', 'volume', 'inspect', identity['volume']]))[0]
    if volume.get('Driver') != 'local' or volume.get('Options') or volume.get('Labels', {}).get('backplane.storage-migration') != migration:
        raise ValueError('target must be the fresh local volume owned by this migration')
    actual = stack.attest_mounts('rustfs')['rustfs-data']
    if actual['name'] != identity['volume']:
        raise ValueError('target volume changed')
    if target_identity(stack, migration) != identity:
        raise ValueError('target selection or credentials changed')


def engine(stack, state_dir, action, migration, identity, checkpoint, empty_target=False):
    if action in ('complete', 'restore-complete'):
        verify(checkpoint, stack)
    if checkpoint.parent != stack.backups / 'backups':
        raise ValueError('checkpoint must be in the selected repository backups directory')
    pin, digest = pin_checkpoint(stack.backups / 'backups', checkpoint, migration)
    request = dict(action=action, id=migration, target=identity, checkpoint='/migration-checkpoint',
                   manifestSha256=digest, pin='/migration-pin', emptyTarget=empty_target)
    request_path = state_dir / 'request.json'
    atomic_private(request_path, json.dumps(request).encode())
    # Root/scoped selectors are inherited through a private Compose file, never argv or stdout.
    environment = {key: value for key, value in stack.services['blob-bootstrap']['environment'].items()
                   if key.startswith('BP_RUSTFS_ROOT_')}
    # Compose checks every declared external volume even for run --no-deps. The
    # prepare helper must not require or create the target before its intent exists.
    helper = {key: value for key, value in stack.services['storage-init'].items()
              if key not in ('depends_on', 'build', 'profiles')}
    helper['environment'] = {**helper.get('environment', {}), **environment,
                             'BP_STARTUP_VERIFY_TIMEOUT': str(startup_timeout(stack))}
    helper['image'] = stack.images['storage-init']['id']
    helper['pull_policy'] = 'never'
    model = dict(name=stack.project, services={'storage-init': helper},
                 networks={name: stack.config['networks'][name] for name in helper.get('networks', {})},
                 volumes={mount['source']: stack.config['volumes'][mount['source']]
                          for mount in helper.get('volumes', []) if mount['type'] == 'volume'})
    overlay = state_dir / 'helper.json'
    # Values are already resolved; preserve literal dollar signs on Compose's second read.
    atomic_private(overlay, json.dumps(model).replace('$', '$$').encode())
    helper_compose = ['docker', 'compose', '--project-directory', str(ROOT), '--env-file', str(stack.env_file),
                      '-p', stack.project, '-f', str(overlay)]
    try:
        result = subprocess.run(helper_compose + ['run', '--rm', '--no-deps', '-T', '--user', '0:0',
                         '-v', str(request_path) + ':/migration-request:ro',
                         '-v', str(checkpoint) + ':/migration-checkpoint:ro', '-v', str(pin) + ':/migration-pin:ro',
                         '-v', str(ROOT / 'scripts/s3-checkpoint-proof.js') + ':/app/scripts/s3-checkpoint-proof.js:ro',
                         '-v', str(ROOT / 'apps/server/blobs/s3-admin-request.ts') + ':/app/apps/server/blobs/s3-admin-request.ts:ro',
                         'storage-init', 'bun', 'apps/server/blobs/storage-migration-admin.ts', '/migration-request'],
                         capture_output=True, text=True, cwd=ROOT)
        if result.returncode:
            token = 'blob_binding_migration_helper_failed'
            for line in reversed(result.stderr.splitlines()):
                if len(line) > 256:
                    continue
                try:
                    diagnostic = json.loads(line)
                except ValueError:
                    continue
                if isinstance(diagnostic, dict) and re.fullmatch(r'blob_binding_[a-z_]{1,80}', str(diagnostic.get('error', ''))):
                    token = diagnostic['error']
                    break
            raise RuntimeError(token)
        return json.loads(result.stdout)
    finally:
        request_path.unlink(missing_ok=True)
        overlay.unlink(missing_ok=True)


def finalize_restored_migration(stack, checkpoint, doc):
    migration = doc['migration']
    if migration.get('phase') != 'committed_pending_checkpoint':
        raise ValueError('restore requires the captured pending migration')
    migration_id = str(uuid.UUID(migration['id']))
    rows = json.loads(stack.pg(f"SELECT coalesce(json_agg(t),'[]') FROM control.blob_storage_migration t WHERE id='{migration_id}'"))
    if len(rows) != 1 or rows[0]['id'] != migration['id'] or rows[0]['phase'] != migration['phase']:
        raise ValueError('restored migration intent differs')
    # Restore has already verified physical custody, exact binding/inventory and armed its gate.
    # New recovery volume names differ deliberately; immutable origin selection stays in the intent.
    # Restore temporarily assigns this parent to PostgreSQL. Return operator custody
    # before recording the private recovery pin, as restore does for its health receipt.
    stack.helper('chown "$1:$2" /backup/backups; chmod a+rx /backup/backups', str(os.getuid()), str(os.getgid()))
    with tempfile.TemporaryDirectory(prefix='.migration-restore-', dir=stack.backups) as temporary:
        engine(stack, Path(temporary), 'restore-complete', migration['id'], rows[0]['target'], checkpoint)


def run(args):
    state_dir = args.state.resolve()
    state_dir.mkdir(mode=0o700, parents=False, exist_ok=True)
    if state_dir.is_symlink() or state_dir.stat().st_mode & 0o077 or state_dir.stat().st_uid != os.getuid():
        raise ValueError('migration state directory must be private and owned')
    state_path = state_dir / 'intent.json'
    target = stack_from_env(args.target_env.resolve())
    if target.backend != 's3':
        raise ValueError('target env must select the shipped local RustFS overlay')
    private_read(args.env_file)
    env_path = args.env_file.resolve()
    target_bytes = private_read(args.target_env)
    if state_path.exists():
        state = json.loads(private_read(state_path))
        if state['targetEnvSha256'] != hashlib.sha256(target_bytes).hexdigest() or state['envPath'] != str(env_path):
            raise ValueError('migration environment selection changed')
    else:
        if args.action != 'migrate':
            raise ValueError('no saved migration to resume')
        source_bytes = private_read(env_path)
        source = stack_from_env(env_path)
        if source.backend != 'filesystem' or source.project != target.project or source.backups != target.backups:
            raise ValueError('migration requires the same filesystem installation and repository')
        if source.stores != {key: value for key, value in target.stores.items() if key != 'rustfs-data'}:
            raise ValueError('durable store layout changed')
        for name in source.stores:
            if source.volume(name) != target.volume(name):
                raise ValueError('source volume selection changed')
        for name, value in source.images.items():
            if target.images.get(name) != value:
                raise ValueError('capture and migration require identical application images')
        for service in ('server', 'storage-init', 'postgres'):
            without_storage = lambda env: {key: value for key, value in env.items() if not key.startswith('BP_BLOB_')}
            if without_storage(source.services[service].get('environment', {})) != without_storage(target.services[service].get('environment', {})):
                raise ValueError('non-storage environment differs')
        checkpoint = args.checkpoint.resolve()
        if checkpoint.parent != source.backups / 'backups':
            raise ValueError('source checkpoint must belong to this repository')
        doc = verify(checkpoint, source)
        if doc.get('captureMode') != 'offline' or doc['storage'].get('backend') != 'filesystem' or doc['storage'].get('phase') != 'ready':
            raise ValueError('source checkpoint must contain verified filesystem storage')
        check_writers(source)
        # An unrelated existing target is rejected before recording or mutating anything.
        if target.volume('rustfs-data') in command(['docker', 'volume', 'ls', '--format', '{{.Name}}']).splitlines():
            raise ValueError('target volume already exists; select a fresh target')
        migration = str(uuid.uuid4())
        pin, digest = pin_checkpoint(source.backups / 'backups', checkpoint, migration)
        state = dict(id=migration, envPath=str(env_path), sourceEnv=source_bytes.decode(), targetEnvSha256=hashlib.sha256(target_bytes).hexdigest(),
                     checkpoint=str(checkpoint), manifestSha256=digest, target=target_identity(target, migration))
        # Reserve custody of every future post-cutover capture before binding can change.
        atomic_private(pin.parent / (migration + '-pending.json'), json.dumps(dict(checkpoint=None, migration=migration)).encode())
        atomic_private(state_path, json.dumps(state).encode())
    checkpoint = Path(state['checkpoint'])
    from checkpoint import inventory, validate_archives
    source_doc = json.loads((checkpoint / 'manifest.json').read_text())
    if source_doc['artifacts'] != inventory(checkpoint):
        raise ValueError('source checkpoint artifacts changed')
    validate_archives(checkpoint, source_doc['artifacts'])
    if hashlib.sha256((checkpoint / 'manifest.json').read_bytes()).hexdigest() != state['manifestSha256']:
        raise ValueError('source checkpoint manifest changed')
    if target_identity(target, state['id']) != state['target']:
        raise ValueError('target credentials or selection drifted')
    check_writers(target)
    migration_id = str(uuid.UUID(state['id']))
    rows = json.loads(target.pg(f"SELECT coalesce(json_agg(t),'[]') FROM control.blob_storage_migration t WHERE id='{migration_id}'"))
    intent = rows[0] if len(rows) == 1 else None
    if rows and (len(rows) != 1 or intent['id'] != state['id']):
        raise ValueError('a different migration owns this database')
    if args.action == 'abort':
        if private_read(env_path) != state['sourceEnv'].encode():
            raise ValueError('abort requires unchanged source environment')
        return engine(target, state_dir, 'abort', state['id'], state['target'], checkpoint)
    if intent is None:
        if target.pg("SELECT EXISTS(SELECT FROM control.blob_storage_migration WHERE phase <> 'aborted')") != 'f':
            raise ValueError('a different migration owns this database')
        engine(target, state_dir, 'prepare', state['id'], state['target'], checkpoint)
        intent = {'phase': 'copying'}
    if intent['phase'] == 'copying':
        engine(target, state_dir, 'prepare', state['id'], state['target'], checkpoint)
        volume = state['target']['volume']
        fresh = volume not in command(['docker', 'volume', 'ls', '--format', '{{.Name}}']).splitlines()
        if fresh:
            command(['docker', 'volume', 'create', '--driver', 'local', '--label', 'backplane.storage-migration=' + state['id'], volume])
        info = json.loads(command(['docker', 'volume', 'inspect', volume]))[0]
        if info.get('Labels', {}).get('backplane.storage-migration') != state['id'] or info.get('Driver') != 'local' or info.get('Options'):
            raise ValueError('target volume is not owned by this migration')
        target.dc('up', '-d', '--wait', '--no-build', '--pull', 'never', '--no-deps', 'rustfs')
        # Bootstrap is idempotent on this exclusively tool-owned target and precedes all payload writes.
        target.dc('run', '--rm', '--no-deps', '-T', 'blob-bootstrap')
        attest_volume(target, state['target'], state['id'])
        engine(target, state_dir, 'copy', state['id'], state['target'], checkpoint, empty_target=fresh)
        intent = {'phase': 'committed_pending_checkpoint'}
    if intent['phase'] not in ('committed_pending_checkpoint', 'complete'):
        raise ValueError('aborted migration is immutable; use a new state directory, fresh checkpoint and fresh target')
    current = private_read(env_path)
    if current != target_bytes:
        atomic_private(env_path, target_bytes, expected=state['sourceEnv'].encode())
    if intent['phase'] == 'complete':
        return {'phase': 'complete', 'id': state['id']}
    # Inspect the existing container and labeled volume before starting that exact ID.
    attest_volume(target, state['target'], state['id'])
    start_existing_services(target, ['rustfs'])
    attest_volume(target, state['target'], state['id'])
    prove_root_credentials(target)
    engine(target, state_dir, 'repair', state['id'], state['target'], checkpoint)
    pending = dict(id=state['id'], phase='committed_pending_checkpoint')
    post_path = state_dir / 'postcheckpoint.json'
    if post_path.exists():
        post = json.loads(private_read(post_path))
        after = Path(post['checkpoint'])
        if hashlib.sha256((after / 'manifest.json').read_bytes()).hexdigest() != post['manifestSha256']:
            raise ValueError('postcheckpoint manifest changed')
    else:
        after = backup(target, offline=True, fenced=True, migration=pending)
        _, digest = pin_checkpoint(target.backups / 'backups', after, state['id'])
        atomic_private(post_path, json.dumps(dict(checkpoint=str(after), manifestSha256=digest)).encode())
    attest_volume(target, state['target'], state['id'])
    return engine(target, state_dir, 'complete', state['id'], state['target'], after)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['migrate', 'abort'])
    parser.add_argument('--env-file', required=True, type=Path)
    parser.add_argument('--target-env', required=True, type=Path)
    parser.add_argument('--checkpoint', type=Path)
    parser.add_argument('--state', required=True, type=Path)
    parser.add_argument('--fenced', action='store_true')
    args = parser.parse_args()
    if not args.fenced or args.action == 'migrate' and not args.state.joinpath('intent.json').exists() and not args.checkpoint:
        parser.error('--fenced and an initial --checkpoint are required')
    os.umask(0o077)
    # Prevent exported selectors from overriding either explicit private environment.
    if any(key.startswith('BP_') or key.startswith('COMPOSE_') for key in os.environ):
        raise ValueError('unset exported BP_* and COMPOSE_* selectors before migration')
    signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(RuntimeError('migration deadline exceeded; retain state and resume')))
    signal.alarm(86400)
    with args.env_file.with_suffix(args.env_file.suffix + '.lock').open('x'):
        try:
            target = stack_from_env(args.target_env)
            with (target.backups / '.checkpoint.lock').open('a') as repository_lock:
                fcntl.flock(repository_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                print(json.dumps(run(args)))
        finally:
            args.env_file.with_suffix(args.env_file.suffix + '.lock').unlink()


if __name__ == '__main__':
    try:
        main()
    except (ValueError, RuntimeError, OSError, KeyError) as error:
        # Third-party exceptions may carry secret-bearing Compose data.
        token = str(error) if re.fullmatch(r'blob_binding_[a-z_]{1,80}', str(error)) else 'blob_binding_migration_failed'
        print(json.dumps({'error': token}), file=__import__('sys').stderr)
        raise SystemExit(1)
