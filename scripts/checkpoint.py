#!/usr/bin/env python3
"""Compose checkpoints: fence application writes, archive all local durable stores, restore empty volumes."""
import argparse
import fcntl
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import signal
import shutil
import subprocess
import sys
import time
import tarfile
import tempfile
import uuid
import runpy
from urllib.parse import urlsplit
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parent.parent
RUSTFS_DIGEST = 'sha256:8cc9801755448b71a786705ce76692c77e14936cccd87cf2fc31842e58f4d1ff'
MUTATING_HELPERS = {'storage-init', 'blob-bootstrap', 'migrate', 'data-init', 'backup-init'}


def qualify_storage(services):
    server = services['server'].get('environment', {})
    backend = server.get('BP_BLOB_BACKEND', 'filesystem')
    selected = services.get('storage-init', {}).get('environment', {})
    if any(env.get('BP_DATA_DIR', '/data') != '/data' for env in (server, selected)) or selected.get('BP_STORAGE_ADMIN_URL_FILE'):
        raise ValueError('checkpoint requires /data and the selected Compose admin database')
    if selected.get('BP_BLOB_BACKEND', 'filesystem') != backend:
        raise ValueError('server and storage-init storage selections differ')
    if backend == 'filesystem':
        return backend
    if backend != 's3' or not {'rustfs', 'blob-bootstrap', 'blob-image-check', 'storage-init'} <= services.keys():
        raise ValueError('only filesystem and shipped local single-volume RustFS checkpoints are supported')
    rustfs = services['rustfs']
    if rustfs['image'].split('@')[-1] != RUSTFS_DIGEST or rustfs.get('command') != ['/data']:
        raise ValueError('S3 checkpoints require the shipped pinned single-volume RustFS')
    if set(rustfs.get('environment', {})) - {'RUSTFS_ACCESS_KEY', 'RUSTFS_SECRET_KEY', 'RUSTFS_ADDRESS', 'RUSTFS_CONSOLE_ENABLE', 'RUSTFS_OBS_LOG_DIRECTORY', 'RUSTFS_OBS_LOG_STDOUT_ENABLED'}:
        raise ValueError('custom RustFS environment is unsupported')
    if rustfs.get('entrypoint') or rustfs.get('environment', {}).get('RUSTFS_ADDRESS') != ':9000':
        raise ValueError('custom RustFS launch configuration is unsupported')
    mounts = rustfs.get('volumes', [])
    if len(mounts) != 1 or any(mounts[0].get(k) != v for k, v in dict(type='volume', source='rustfs-data', target='/data').items()) or mounts[0].get('read_only'):
        raise ValueError('custom RustFS volume layout is unsupported')
    for key in ('BP_BLOB_S3_ENDPOINT', 'BP_BLOB_S3_REGION', 'BP_BLOB_S3_BUCKET', 'BP_BLOB_S3_ACCESS_KEY', 'BP_BLOB_S3_SECRET_KEY'):
        if not server.get(key) or selected.get(key) != server[key]:
            raise ValueError('server and storage-init S3 selections differ')
    if server['BP_BLOB_S3_ENDPOINT'] != 'http://rustfs:9000' or server['BP_BLOB_S3_REGION'] != 'us-east-1':
        raise ValueError('remote or custom S3 endpoints are unsupported')
    bootstrap = services['blob-bootstrap'].get('environment', {})
    for key in ('BP_BLOB_S3_BUCKET', 'BP_BLOB_S3_ACCESS_KEY', 'BP_BLOB_S3_SECRET_KEY'):
        if bootstrap.get(key) != server[key]:
            raise ValueError('bootstrap and server S3 selections differ')
    for key, root_key in [('BP_RUSTFS_ROOT_USER', 'RUSTFS_ACCESS_KEY'), ('BP_RUSTFS_ROOT_PASSWORD', 'RUSTFS_SECRET_KEY')]:
        if not bootstrap.get(key) or bootstrap[key] != rustfs.get('environment', {}).get(root_key):
            raise ValueError('RustFS and bootstrap root credentials differ')
    for env, key in [(server, 'BP_DATABASE_URL'), (selected, 'BP_ADMIN_DATABASE_URL')]:
        try:
            url = urlsplit(env.get(key, ''))
            selected_database = url.hostname == 'postgres' and url.port in (None, 5432) and url.path == '/backplane'
        except ValueError:
            selected_database = False
        if not selected_database:
            raise ValueError('storage inspection must select the checkpoint PostgreSQL database')
    return backend


def command(args, env=None):
    result = subprocess.run(args, capture_output=True, text=True, env=env, cwd=ROOT)
    if result.returncode:
        # Compose diagnostics can contain interpolated credentials.
        tokens = {'checkpoint_proof_' + step for step in ('configuration', 'readiness', 'authentication', 'account', 'versioning')}
        tokens |= {'checkpoint_fixture_' + step for step in ('identity', 'configuration', 'create', 'read')}
        token = next((line.strip() for line in reversed(result.stderr.splitlines()) if line.strip() in tokens), None)
        if token:
            raise RuntimeError(token)
        raise RuntimeError(f'{Path(args[0]).name} command failed (exit {result.returncode})')
    return result.stdout.strip()


def inventory(root):
    result = {}
    for path in sorted(root.rglob('*')):
        if path.is_symlink():
            raise ValueError('checkpoint contains a symlink')
        if path.is_file() and path != root / 'manifest.json':
            digest = hashlib.sha256()
            with path.open('rb') as file:
                for chunk in iter(lambda: file.read(1024 * 1024), b''):
                    digest.update(chunk)
            result[path.relative_to(root).as_posix()] = {'sha256': digest.hexdigest(), 'bytes': path.stat().st_size}
    return result


def manifest(before, after, name, lsn, segment, images, volumes, revision, artifacts):
    # Deliberate allowlist: resolved Compose environments never enter a checkpoint manifest.
    return dict(version=1, before=before, after=after, name=name, targetLsn=lsn,
                segment=segment, images=images, volumes=volumes, revision=revision,
                artifacts=artifacts)


def publish_checkpoint(dest, doc):
    dest.chmod(0o700)
    command(['sync', '-f', str(dest)])
    doc['completedAt'] = datetime.now(timezone.utc).isoformat()
    with os.fdopen(os.open(dest / '.manifest.json.tmp', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as file:
        json.dump(doc, file, indent=2); file.write('\n'); file.flush()
        os.fchmod(file.fileno(), 0o600); os.fsync(file.fileno())
    (dest / '.manifest.json.tmp').rename(dest / 'manifest.json')
    command(['sync', '-f', str(dest)])
    publish_health(dest.parent, doc)


def publish_health(root, doc):
    receipt = dict(version=1, systemId=doc['after']['systemId'], completedAt=doc['completedAt'],
                   restorePoint=dict(name=doc['name'], lsn=doc['targetLsn'], timeline=doc['after']['timeline']))
    fd, temporary = tempfile.mkstemp(prefix='.health-', dir=root)
    try:
        with os.fdopen(fd, 'w') as file:
            json.dump(receipt, file); file.write('\n'); file.flush()
            os.fchmod(file.fileno(), 0o644); os.fsync(file.fileno())
        os.replace(temporary, root / 'health.json')
        command(['sync', '-f', str(root)])
    finally:
        Path(temporary).unlink(missing_ok=True)


EMPTY_TARGET_CHECK = 'entries=$(ls -A "$1"); test -z "$entries" || { echo "restore refuses non-empty targets" >&2; exit 1; }'


def require_empty(path):
    if path.is_symlink() or path.exists() and (not path.is_dir() or next(path.iterdir(), None) is not None):
        raise ValueError('restore refuses non-empty targets')


class Stack:
    def __init__(self, env_file, source=None):
        self.env_file = env_file.resolve()
        self.compose = ['docker', 'compose', '--project-directory', str(ROOT), '--env-file', str(self.env_file)]
        if not os.environ.get('COMPOSE_FILE'):
            self.compose += ['-f', str(ROOT / 'compose.yaml')]
        self.config = json.loads(self.dc('config', '--format', 'json'))
        self.project = self.config['name']
        self.services = self.config['services']
        startup_timeout(self)
        self.backend = qualify_storage(self.services)
        self.backups = Path(next(v['source'] for v in self.services['postgres']['volumes'] if v['target'] == '/backup')).resolve()
        if not self.backups.is_dir():
            raise ValueError('backup mount must exist')
        self.stores = {'postgres-data': '/var/lib/postgresql', 'server-data': '/data'}
        if self.backend == 's3':
            self.stores['rustfs-data'] = '/data'
        if 'edge' in self.services:
            self.stores.update({'edge-data': '/data', 'edge-config': '/config'})
        self.keep = int(self.services['server']['environment'].get('BP_BACKUP_KEEP', '7'))
        if self.keep < 1:
            raise ValueError('BP_BACKUP_KEEP must be positive')
        recorded = None
        if source is not None:
            if self.dc('ps', '-aq'):
                raise ValueError('remove target containers before restore; leave the source fenced')
            doc = json.loads((source / 'manifest.json').read_text())
            if doc['artifacts'] != inventory(source):
                raise ValueError('checkpoint artifacts or checksums differ')
            captured_schema = doc.get('after', {}).get('schema')
            if 'storage-init' in self.services and ('storage-init' not in doc['images'] or isinstance(captured_schema, int) and captured_schema < 32):
                raise ValueError('pre-binding Checkpoint requires the matching pre-upgrade checkout before restore; its archived image has no storage-init command')
            recorded = doc['images']
            if 'server-image.tar' in doc['artifacts']:
                command(['docker', 'load', '--input', str(source / 'server-image.tar')])
        self.images = {}
        helpers = {'backup-init': 'postgres', 'migrate': 'server', 'data-init': 'server'}
        if 'storage-init' in self.services:
            helpers['storage-init'] = 'server'
        blob_services = ['rustfs', 'blob-bootstrap', 'blob-image-check'] if self.backend == 's3' else []
        for service in ('postgres', 'server', *(['edge'] if 'edge' in self.services else []), *helpers, *blob_services):
            ref = self.services[service]['image']
            expected = recorded.get(service, recorded.get(helpers.get(service))) if recorded is not None else None
            try:
                if recorded is not None:
                    if expected is None or expected['reference'] != ref:
                        raise ValueError(f'{service}: restore requires the recorded image reference; check the env file and exported BP_* settings')
                    recovery = expected.get('recoveryReference', ref)
                    covered = service in ('blob-bootstrap', 'blob-image-check') and expected['id'] == recorded['server']['id']
                    if service not in helpers and service != 'server' and not covered:
                        if not re.fullmatch(r'[^\s@]+@sha256:[a-f0-9]{64}', recovery):
                            raise ValueError(f'{service}: checkpoint has no immutable recovery image; recover the original image and capture a new Checkpoint')
                        try:
                            recovered_id = command(['docker', 'image', 'inspect', '--format', '{{.Id}}', recovery])
                        except RuntimeError:
                            command(['docker', 'pull', recovery])
                            recovered_id = command(['docker', 'image', 'inspect', '--format', '{{.Id}}', recovery])
                        if recovered_id != expected['id']:
                            raise ValueError(f'{service}: recovery image content differs; obtain the recorded image for this platform')
                    # An ID-only server archive can restore tags without relying on the registry.
                    if '@' not in ref and not ref.startswith('sha256:'):
                        command(['docker', 'tag', expected['id'], ref])
                info = json.loads(command(['docker', 'image', 'inspect', ref]))[0]
            except RuntimeError:
                raise ValueError(f'{service}: image unavailable; pull or load the recorded image on this Docker host and retry before fencing or restoring') from None
            image_id = info['Id']
            if expected is not None and image_id != expected['id']:
                raise ValueError(f'{service}: image content differs; load the recorded image before restoring')
            self.images[service] = dict(reference=ref, id=image_id)
            if service in helpers:
                if image_id != self.images[helpers[service]]['id']:
                    raise ValueError(f'{service}: helper must use the same content as {helpers[service]}')
            elif service != 'server' and not (service in ('blob-bootstrap', 'blob-image-check') and image_id == self.images['server']['id']):
                digests = info.get('RepoDigests') or []
                recovery = expected.get('recoveryReference', ref) if expected is not None else next((d for d in digests
                    if re.fullmatch(r'[^\s@]+@sha256:[a-f0-9]{64}', d)
                    and command(['docker', 'image', 'inspect', '--format', '{{.Id}}', d]) == image_id), None)
                if recovery is None:
                    raise ValueError(f'{service}: no verified RepoDigest; publish and pull this exact image or select a reproducible image before capture')
                self.images[service]['recoveryReference'] = recovery
        self.attest()

    def attest(self):
        for service, image in self.images.items():
            for container in self.dc('ps', '-aq', service).split():
                if command(['docker', 'inspect', '--format', '{{.Image}}', container]) != image['id']:
                    raise ValueError(f'{service}: container differs from configured image; reconcile the deployment before capture')

    def check_mount_config(self):
        for volume, destination in self.stores.items():
            service = volume.split('-')[0]
            configured = [v for v in self.services[service].get('volumes', []) if v['target'] == destination]
            if any(v['target'].startswith(destination + '/') for v in self.services[service].get('volumes', [])):
                raise ValueError(f'{service}: nested durable mounts are unsupported')
            if len(configured) != 1 or configured[0].get('type') != 'volume' or configured[0].get('source') != volume:
                raise ValueError(f'{service}: configured durable mount differs')
        if 'storage-init' in self.services:
            mounts = self.services['storage-init'].get('volumes', [])
            if not any(v.get('source') == 'server-data' and v.get('target') == '/data' and v.get('type') == 'volume' for v in mounts):
                raise ValueError('storage-init must mount server-data at /data')

    def attest_mounts(self, selected=None):
        self.check_mount_config()
        proof = {}
        for volume, destination in self.stores.items():
            service = volume.split('-')[0]
            if selected is not None and service != selected:
                continue
            name = self.volume(volume)
            command(['docker', 'volume', 'inspect', name])
            containers = self.dc('ps', '-aq', service).split()
            if len(containers) != 1:
                raise ValueError(f'{service}: expected one existing container for mount proof')
            actual = json.loads(command(['docker', 'inspect', containers[0]]))[0]
            if actual['Image'] != self.images[service]['id']:
                raise ValueError(f'{service}: actual container image differs')
            if any(m['Destination'].startswith(destination + '/') for m in actual['Mounts']):
                raise ValueError(f'{service}: actual nested durable mounts are unsupported')
            mounts = [m for m in actual['Mounts'] if m['Destination'] == destination]
            if len(mounts) != 1 or mounts[0].get('Type') != 'volume' or mounts[0].get('Name') != name:
                raise ValueError(f'{service}: actual durable mount differs from configured volume')
            if service == 'rustfs':
                launch = json.loads(command(['docker', 'image', 'inspect', self.images[service]['id']]))[0]['Config']
                if len(actual['Mounts']) != 1 or actual['Config'].get('Cmd') != ['/data'] or actual['Config'].get('Entrypoint') != launch.get('Entrypoint'):
                    raise ValueError('running RustFS has a custom launch or volume layout')
            proof[volume] = dict(name=name, destination=destination)
            if service == 'rustfs':
                proof[volume].update(image=actual['Image'], command=actual['Config'].get('Cmd'),
                                     entrypoint=actual['Config'].get('Entrypoint'))
        return proof

    def dc(self, *args):
        return command(self.compose + list(args))

    def pg(self, sql):
        return self.dc('exec', '-T', 'postgres', 'psql', '-X', '-U', 'postgres', '-d', 'backplane', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql)

    def volume(self, name):
        return self.config['volumes'][name]['name']

    def helper(self, script, *args, mounts=(), user='0'):
        return command(['docker', 'run', '--rm', '--network', 'none', '--user', user,
                        '-v', f'{self.backups}:/backup', *mounts,
                        '--entrypoint', 'sh', self.images['postgres']['id'], '-ec', script, 'sh', *args])

    def snapshot(self):
        return json.loads(self.pg(SNAPSHOT))


SNAPSHOT = """SELECT json_build_object('systemId',(pg_control_system()).system_identifier::text,
 'timeline',(pg_control_checkpoint()).timeline_id,'postgres',current_setting('server_version_num'),
 'schema',(SELECT max(version) FROM control.schema_version),'pgmq',(SELECT version FROM pgmq.backplane_install LIMIT 1),
 'heads',(SELECT coalesce(json_agg(json_build_object('workspaceId',workspace_id,'head',last_position::text) ORDER BY workspace_id),'[]') FROM audit.cursor))"""


def wal_boundary(base_manifest, segment_bytes):
    boundaries = {}
    for item in base_manifest['WAL-Ranges']:
        high, low = (int(part, 16) for part in item['Start-LSN'].split('/'))
        number = ((high << 32) + low) // segment_bytes
        per_log = (1 << 32) // segment_bytes
        timeline = int(item['Timeline'])
        name = f'{timeline:08X}{number // per_log:08X}{number % per_log:08X}'
        boundaries[timeline] = min(boundaries.get(timeline, name), name)
    if not boundaries:
        raise ValueError('backup_manifest has no WAL boundary')
    return boundaries


def pin_checkpoint(repository, checkpoint, migration):
    if str(uuid.UUID(migration)) != migration:
        raise ValueError('invalid migration pin identity')
    directory = repository / '.pins'
    directory.mkdir(mode=0o700, exist_ok=True)
    if directory.is_symlink() or directory.stat().st_mode & 0o077:
        raise ValueError('blob_binding_checkpoint_pin_recovery_required')
    digest = hashlib.sha256((checkpoint / 'manifest.json').read_bytes()).hexdigest() if checkpoint is not None else None
    record = dict(checkpoint=checkpoint.name, manifestSha256=digest, migration=migration) if checkpoint is not None else dict(checkpoint=None, migration=migration)
    path = directory / (migration + '-' + (digest or 'pending') + '.json')
    content = json.dumps(record, sort_keys=True).encode() + b'\n'
    # Callers hold the repository lock. Only a fully synced record is published;
    # this recognizable unpublished name carries no checkpoint custody obligation.
    if path.exists() or path.is_symlink():
        if (path.is_symlink() or not path.is_file() or path.stat().st_mode & 0o077 or path.stat().st_nlink != 1
                or path.stat().st_uid != os.getuid() or path.stat().st_size > 4096 or path.read_bytes() != content):
            raise ValueError('blob_binding_checkpoint_pin_recovery_required')
    else:
        temporary = directory / ('.' + path.name + '.' + uuid.uuid4().hex + '.tmp')
        try:
            with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'wb') as file:
                file.write(content); file.flush(); os.fsync(file.fileno())
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)
    for parent in (directory, repository):
        fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    return path, digest


def pinned_checkpoints(repository):
    try:
        directory = repository / '.pins'
        if directory.is_symlink():
            raise ValueError('blob_binding_checkpoint_pin_recovery_required')
        if not directory.exists():
            return set()
        if not directory.is_dir() or directory.stat().st_mode & 0o077:
            raise ValueError('blob_binding_checkpoint_pin_recovery_required')
        result = set()
        for path in directory.iterdir():
            if path.is_symlink() or not path.is_file() or path.stat().st_mode & 0o077 or path.stat().st_nlink != 1 or path.stat().st_uid != os.getuid() or path.stat().st_size > 4096:
                raise ValueError('invalid checkpoint pin')
            if re.fullmatch(r'\.[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}-(?:[a-f0-9]{64}|pending)\.json\.[a-f0-9]{32}\.tmp', path.name):
                continue
            record = json.loads(path.read_text())
            migration, name = record['migration'], record['checkpoint']
            if str(uuid.UUID(migration)) != migration:
                raise ValueError('invalid pin identity')
            if name is None:
                if set(record) != {'checkpoint', 'migration'} or path.name != migration + '-pending.json':
                    raise ValueError('invalid reservation')
                candidates = [candidate for candidate in repository.iterdir() if candidate.is_dir() and not candidate.is_symlink()
                              and (candidate / 'manifest.json').is_file()
                              and json.loads((candidate / 'manifest.json').read_text()).get('migration', {}).get('id') == migration]
            else:
                digest = record['manifestSha256']
                if (set(record) != {'checkpoint', 'migration', 'manifestSha256'} or not re.fullmatch('[a-f0-9]{64}', digest)
                        or path.name != migration + '-' + digest + '.json' or Path(name).name != name or name in ('.', '..')):
                    raise ValueError('invalid pinned checkpoint')
                candidates = [repository / name]
            for checkpoint in candidates:
                if checkpoint.is_symlink() or (checkpoint / 'manifest.json').is_symlink():
                    raise ValueError('invalid pinned checkpoint')
                if name is not None and hashlib.sha256((checkpoint / 'manifest.json').read_bytes()).hexdigest() != record['manifestSha256']:
                    raise ValueError('pinned checkpoint manifest changed')
                doc = json.loads((checkpoint / 'manifest.json').read_text())
                if doc['artifacts'] != inventory(checkpoint):
                    raise ValueError('pinned checkpoint artifacts changed')
                result.add(checkpoint.name)
        return result
    except (ValueError, OSError, KeyError, TypeError, AttributeError):
        raise ValueError('blob_binding_checkpoint_pin_recovery_required') from None


def prune_checkpoints(root, keep, remove=shutil.rmtree):
    if keep < 1:
        raise ValueError('BP_BACKUP_KEEP must be positive')
    pins = pinned_checkpoints(root)
    complete = []
    for path in root.iterdir():
        if path.is_dir() and not path.is_symlink() and (path / 'manifest.json').is_file():
            doc = json.loads((path / 'manifest.json').read_text())
            complete.append((doc['completedAt'], path, doc))
    complete.sort(key=lambda item: item[0], reverse=True)
    kept = [item for index, item in enumerate(complete) if index < keep or item[1].name in pins]
    boundaries = {}
    for _, path, doc in kept:
        base = json.loads((path / 'postgres/backup_manifest').read_text())
        segment_bytes = doc.get('walSegmentBytes') or (path / 'wal' / doc['segment']).stat().st_size
        for timeline, name in wal_boundary(base, segment_bytes).items():
            boundaries[timeline] = min(boundaries.get(timeline, name), name)
    for _, path, _ in complete[keep:]:
        if path.name not in pins:
            remove(path)
    return boundaries


def require_backup_services(running, edge, offline):
    if set(running) & MUTATING_HELPERS:
        raise ValueError('stop mutating helpers before backup')
    if offline:
        if 'postgres' not in running or set(running) & {'server', 'edge', 'storage-init'}:
            raise ValueError('offline backup requires postgres running and server, edge, storage-init stopped')
    elif not {'postgres', 'server', *(['edge'] if edge else [])} <= set(running):
        raise ValueError('backup requires running postgres and server')


def startup_timeout(stack):
    value = str(stack.services.get('server', {}).get('environment', {}).get('BP_STARTUP_VERIFY_TIMEOUT', '120'))
    if not re.fullmatch(r'[0-9]+', value) or not 1 <= int(value) <= 86400:
        raise ValueError('BP_STARTUP_VERIFY_TIMEOUT must be an integer from 1 to 86400 seconds')
    return int(value)


def start_existing_services(stack, services):
    # Compose start can require absent one-shot dependencies. Resume only the existing IDs.
    budget = startup_timeout(stack)
    deadline = time.monotonic() + budget
    def remaining():
        left = deadline - time.monotonic()
        if left <= 0:
            raise TimeoutError()
        return left
    def run(args):
        result = subprocess.run(args, capture_output=True, text=True, check=True,
                                timeout=remaining(), cwd=ROOT)
        remaining()
        return result.stdout.strip()
    fields = ('{"id":{{json .Id}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},'
              '"service":{{json (index .Config.Labels "com.docker.compose.service")}},'
              '"healthcheck":{{if and .Config.Healthcheck .Config.Healthcheck.Test '
              '(ne (index .Config.Healthcheck.Test 0) "NONE")}}true{{else}}false{{end}},'
              '"status":{{json .State.Status}},"oomKilled":{{.State.OOMKilled}},'
              '"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}"none"{{end}}}')
    def inspect(cid, service):
        container = json.loads(run(['docker', 'inspect', '--format', fields, cid]))
        if (container['id'], container['project'], container['service']) != (cid, stack.project, service):
            raise ValueError()
        return container
    try:
        for service in services:
            deadline = time.monotonic() + budget
            ids = run(stack.compose + ['ps', '-aq', service]).split()
            if len(ids) != 1 or not re.fullmatch(r'[0-9a-f]{64}', ids[0]):
                raise ValueError()
            cid = ids[0]
            healthcheck = inspect(cid, service)['healthcheck']
            run(['docker', 'start', cid])
            while True:
                container = inspect(cid, service)
                if container['oomKilled'] or container['status'] not in {'created', 'running', 'restarting'}:
                    raise ValueError()
                if healthcheck and container['health'] not in {'starting', 'healthy'}:
                    raise ValueError()
                if container['status'] == 'running' and (not healthcheck or container['health'] == 'healthy'):
                    remaining()
                    break
                time.sleep(min(0.5, remaining()))
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError):
        raise RuntimeError(f'{service}: source container could not be resumed and verified') from None


def resume_source(stack, stopped, completed, capture_failed):
    if not stopped:
        return
    try:
        storage = ['rustfs'] if 'rustfs' in stopped else []
        application = [service for service in reversed(stopped) if service != 'rustfs']
        start_existing_services(stack, storage + application)
    except Exception as error:
        reason = str(error) if re.fullmatch(r'(rustfs|server|edge): source container could not be resumed and verified', str(error)) else 'source services could not be resumed and verified'
        state = 'the completed Checkpoint is retained' if completed else 'no Checkpoint was completed'
        message = f'{reason}; {state}. Inspect service state and logs; startup may still be verifying stored bytes'
        if capture_failed:
            # Keep the original capture failure as the primary error.
            print(message, file=sys.stderr, flush=True)
        else:
            raise RuntimeError(message) from None


def qualify_tar(stack):
    support = stack.helper('tar --version; tar --help')
    if 'GNU tar' not in support or '--xattrs' not in support or '--numeric-owner' not in support:
        raise ValueError('checkpoint helper requires GNU tar with xattrs and numeric ownership')
    with tempfile.TemporaryDirectory(prefix='.tar-proof-', dir=stack.backups) as root:
        directory = Path(root)
        (directory / 'source').mkdir(); (directory / 'restored').mkdir()
        probe = directory / 'source/probe'; probe.write_bytes(b'checkpoint tar qualification')
        try:
            os.setxattr(probe, 'user.checkpoint', b'preserved')
        except OSError:
            raise ValueError('checkpoint repository cannot store required user xattrs; tar qualification refused') from None
        stack.helper('tar --numeric-owner --xattrs --xattrs-include="*" -cf "$1/probe.tar" -C "$1/source" .; '
                     'tar --numeric-owner --xattrs --xattrs-include="*" -xf "$1/probe.tar" -C "$1/restored"', '/backup/' + directory.name)
        validate_archives(directory, {'probe.tar': {}})
        restored = directory / 'restored/probe'
        if restored.read_bytes() != probe.read_bytes() or os.getxattr(restored, 'user.checkpoint') != b'preserved' or (restored.stat().st_uid, restored.stat().st_gid) != (probe.stat().st_uid, probe.stat().st_gid):
            raise ValueError('checkpoint helper did not preserve xattrs or numeric ownership')


def backup(stack, offline=False, fenced=False, migration=None):
    stack.attest()
    if any('@' not in image['reference'] for name, image in stack.images.items() if name in ('postgres', 'edge')):
        print('Upstream image custody is external: retain the recorded immutable references in a registry or a tested off-host image archive; publication was not checked.', file=sys.stderr, flush=True)
    running = stack.dc('ps', '--status', 'running', '--services').split()
    require_backup_services(running, 'edge' in stack.services, offline)
    if not 180000 <= int(stack.pg('SHOW server_version_num')) < 190000:
        raise ValueError('Checkpoint recovery requires the PostgreSQL 18 data layout')
    if stack.pg('SHOW data_directory') != '/var/lib/postgresql/18/docker':
        raise ValueError('Checkpoint recovery requires data_directory=/var/lib/postgresql/18/docker')
    if stack.pg('SHOW archive_mode') != 'on':
        raise ValueError('WAL archiving is required')
    if stack.pg("SELECT count(*) FROM pg_tablespace WHERE spcname NOT IN ('pg_default','pg_global')") != '0':
        raise ValueError('custom tablespaces are unsupported')
    if not fenced:
        raise ValueError('--fenced must attest exclusion of all external application/operator writers and mutating helpers for the entire command')
    if stack.backend == 's3' and 'rustfs' not in running:
        raise ValueError('S3 capture requires RustFS running on entry, including offline capture')
    mounts = stack.attest_mounts()  # Before any helper mount can create a missing volume.
    qualify_tar(stack)
    sizes = sum(int(stack.helper('du -sb /source | cut -f1',
                    mounts=('-v', f'{stack.volume(volume)}:/source:ro'))) for volume in stack.stores)
    image_size = int(command(['docker', 'image', 'inspect', '--format', '{{.Size}}', stack.images['server']['id']]))
    required = 2 * (sizes + image_size) + 1024 ** 3
    if shutil.disk_usage(stack.backups).free < required:
        raise ValueError('insufficient free space for Checkpoint: need twice the stores and image size plus 1 GiB')
    name = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    dest = stack.backups / 'backups' / name
    target = '/backup/backups/' + name
    stopped = []
    completed = None
    capture_failed = True
    try:
        for service in ('edge', 'server'):
            if service in running:
                stopped.append(service)
                stack.dc('stop', '-t', '60', service)
        check_writers(stack)
        before = stack.snapshot()
        if stack.backend == 's3':
            prove_root_credentials(stack)
        storage = inspect_storage(stack, offline)
        pending = storage.get("migration")
        if pending != migration:
            raise ValueError("pending storage migration requires its explicit offline checkpoint")
        rustfs_exit = None
        if stack.backend == 's3':
            stopped.append('rustfs')
            rustfs_exit = stop_rustfs(stack)
        check_writers(stack)
        stack.dc('exec', '-T', '--user', '0', 'postgres', 'sh', '-ec',
                 'umask 077; mkdir "$1"; pg_basebackup -U postgres -D "$1/postgres" -Ft -X stream --checkpoint=fast', 'sh', target)
        base_manifest = json.loads(stack.dc('exec', '-T', '--user', '0', 'postgres', 'cat', target + '/postgres/backup_manifest'))
        segment_bytes = int(stack.pg("SELECT pg_size_bytes(current_setting('wal_segment_size'))"))
        first = wal_boundary(base_manifest, segment_bytes)[before['timeline']]
        after = stack.snapshot()
        if before != after:
            raise ValueError('fenced database identity or audit heads changed')
        lsn = stack.pg(f"SELECT pg_create_restore_point('{name}')")
        segment = stack.pg(f"SELECT pg_walfile_name('{lsn}'::pg_lsn)")
        stack.pg('SELECT pg_switch_wal()')
        stack.dc('exec', '-T', '--user', '0', 'postgres', 'sh', '-ec', '''
            dest=$1; first=$2; last=$3; mkdir "$dest/wal"; n=0
            while [ ! -f "/backup/archive/$last" ]; do
              n=$((n+1)); [ "$n" -lt 120 ] || exit 1; sleep 1
            done
            for file in /backup/archive/*; do
              name=${file##*/}
              case "$name" in
                *.history) cp "$file" "$dest/wal/";;
                ????????????????????????)
                  if [ "$name" = "$first" ] || [ "$name" = "$last" ] || { [ "$name" \\> "$first" ] && [ "$name" \\< "$last" ]; }; then cp "$file" "$dest/wal/"; fi;;
              esac
            done
            test -f "$dest/wal/$first"
        ''', 'sh', target, first, segment)
        for volume, mount in stack.stores.items():
            if volume != 'postgres-data':
                stack.helper('umask 077; tar --hard-dereference --numeric-owner --xattrs --xattrs-include="*" -C /source -cf "$1" .', f'{target}/{volume}.tar',
                             mounts=('-v', f'{stack.volume(volume)}:/source:ro'))
        stack.helper('chown "$2:$3" /backup/backups; chmod a+rx /backup/backups; chown -R "$2:$3" "$1"; chmod -R u+rwX,go-rwx "$1"', target, str(os.getuid()), str(os.getgid()))
        command(['docker', 'save', '--output', str(dest / 'server-image.tar'), stack.images['server']['id']])
        per_log = (1 << 32) // segment_bytes
        first_number = int(first[8:16], 16) * per_log + int(first[16:], 16)
        last_number = int(segment[8:16], 16) * per_log + int(segment[16:], 16)
        for number in range(first_number, last_number + 1):
            filename = f'{first[:8]}{number // per_log:08X}{number % per_log:08X}'
            if not (dest / 'wal' / filename).is_file():
                raise ValueError('archived WAL has a gap')
        check_writers(stack)
        if stack.backend == 's3':
            start_existing_services(stack, ['rustfs'])
            stopped.remove('rustfs')
        if inspect_storage(stack, offline) != storage:
            raise ValueError('fenced source storage identity or full inventory changed')
        check_writers(stack)
        after = stack.snapshot()
        if before != after:
            raise ValueError('fenced database identity or audit heads changed')
        artifacts = inventory(dest)
        validate_archives(dest, artifacts)
        doc = manifest(before, after, name, lsn, segment, stack.images, list(stack.stores),
                       command(['git', 'rev-parse', 'HEAD']), artifacts)
        doc.update(storage=storage, mounts=mounts, rustfsExitCode=rustfs_exit,
                   archiveValidation='regular-files-and-directories', archiveMetadata='gnu-tar-numeric-owner-xattrs')
        if stack.backend == 's3':
            salt = os.urandom(32).hex()
            doc['credentials'] = dict(kdf='pbkdf2-hmac-sha256', iterations=600000, salt=salt,
                                      digest=credentials_digest(stack, name, salt))
        doc['walSegmentBytes'] = segment_bytes
        doc['captureMode'] = 'offline' if offline else 'coordinated'
        if migration:
            if not offline or migration.get("phase") != "committed_pending_checkpoint":
                raise ValueError("migration checkpoint requires pending cutover and offline capture")
            doc["migration"] = migration
        publish_checkpoint(dest, doc)
        if migration:
            pin_checkpoint(stack.backups / "backups", dest, migration["id"])
        completed = dest
        boundaries = prune_checkpoints(stack.backups / 'backups', stack.keep,
            lambda path: stack.helper('rm -rf -- "$1"', '/backup/backups/' + path.name))
        for timeline, boundary in boundaries.items():
            stack.helper('''
                for file in /backup/archive/"$1"*; do
                  name=${file##*/}
                  case "$name" in
                    ????????????????????????) if [ "$name" \\< "$2" ]; then rm -- "$file"; fi;;
                  esac
                done
            ''', f'{timeline:08X}', boundary)
        print(dest)
        capture_failed = False
        return dest
    finally:
        if capture_failed:
            # An interrupted pg_basebackup/archive may leave a root-owned directory.
            # Preserve it for diagnosis without making the next retention scan fail.
            try:
                stack.helper('if [ -d "$1" ]; then chown -R "$2:$3" "$1"; chmod -R u+rwX,go-rwx "$1"; fi',
                             target, str(os.getuid()), str(os.getgid()))
            except Exception:
                print('Failed Checkpoint permissions could not be normalized; retain it for operator recovery.', file=sys.stderr)
        resume_source(stack, stopped, completed, capture_failed)


def verify(source, stack):
    doc = json.loads((source / 'manifest.json').read_text())
    if doc['version'] != 1 or any(name not in stack.images or any(stack.images[name][key] != image[key] for key in ('reference', 'id')) for name, image in doc['images'].items()) or set(doc['volumes']) != set(stack.stores):
        raise ValueError('restore requires the same images and durable stores')
    if doc['before'] != doc['after'] or not re.fullmatch(r'[0-9]+', doc['after']['systemId']) or not re.fullmatch(r'[0-9]+(?:[.][0-9]+)*', doc['after']['pgmq']):
        raise ValueError('invalid database identity')
    if not re.fullmatch(r'[0-9A-F]{24}', doc['segment']):
        raise ValueError('invalid WAL segment')
    if not re.fullmatch(r'(?:bp_[a-f0-9]{32}|[0-9]{8}T[0-9]{12}Z)', doc['name']) or not re.fullmatch(r'[0-9A-F]+/[0-9A-F]+', doc['targetLsn']):
        raise ValueError('invalid restore target')
    completed = doc.get('completedAt')
    if (not isinstance(completed, str) or not re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?(?:Z|\+00:00)', completed)):
        raise ValueError('invalid checkpoint completion time')
    try:
        datetime.fromisoformat(completed.replace('Z', '+00:00'))
    except ValueError:
        raise ValueError('invalid checkpoint completion time') from None
    required = {'postgres/base.tar', 'postgres/pg_wal.tar', 'postgres/backup_manifest', 'server-data.tar', 'wal/' + doc['segment']}
    if not re.fullmatch(r'bp_[a-f0-9]{32}', doc['name']):
        required.add('server-image.tar')
    if 'rustfs-data' in stack.stores:
        required.add('rustfs-data.tar')
        proof = doc.get('credentials')
        if (not isinstance(proof, dict) or proof.get('kdf') != 'pbkdf2-hmac-sha256' or proof.get('iterations') != 600000
                or not isinstance(proof.get('salt'), str) or not re.fullmatch('[a-f0-9]{64}', proof['salt'])
                or not isinstance(proof.get('digest'), str) or not re.fullmatch('[a-f0-9]{64}', proof['digest'])
                or not hmac.compare_digest(proof['digest'], credentials_digest(stack, doc['name'], proof['salt']))):
            raise ValueError('restore requires the captured RustFS root and scoped credentials')
        if not doc.get('storage') or doc['storage'].get('backend') != 's3' or doc['storage'].get('phase') != 'ready' or doc.get('rustfsExitCode') != 0:
            raise ValueError('S3 checkpoint has no verified source storage proof')
    if 'edge-data' in stack.stores:
        required |= {'edge-data.tar', 'edge-config.tar'}
    if not required <= doc['artifacts'].keys() or doc['artifacts'] != inventory(source):
        raise ValueError('checkpoint artifacts or checksums differ')
    validate_archives(source, doc['artifacts'])
    return doc


def validate_archives(source, artifacts):
    for name in artifacts:
        if name.endswith('.tar') and name != 'server-image.tar':
            with tarfile.open(source / name) as archive:
                for member in archive:
                    path = Path(member.name)
                    if path.is_absolute() or '..' in path.parts or not (member.isfile() or member.isdir()):
                        raise ValueError('unsafe archive member')


def storage_admin(stack, *args, environment=()):
    result = subprocess.run(stack.compose + ['run', '--rm', '--no-deps', '-T',
                            '-e', 'BP_STARTUP_VERIFY_TIMEOUT=' + str(startup_timeout(stack)),
                            *[arg for value in environment for arg in ('-e', value)], 'storage-init',
                            'bun', 'apps/server/blobs/storage-admin.ts', *args],
                            capture_output=True, text=True, cwd=ROOT)
    if result.returncode:
        token = 'diagnostic unavailable; use the fenced storage runbook'
        for line in reversed(result.stderr.splitlines()):
            if len(line) > 256:
                continue
            try:
                doc = json.loads(line)
            except ValueError:
                continue
            if isinstance(doc, dict) and re.fullmatch(r'blob_binding_[a-z_]{1,80}', str(doc.get('error', ''))):
                token = doc['error']
                break
        raise RuntimeError('storage initialization refused: ' + token)
    return result.stdout


def check_writers(stack):
    if stack.pg("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND usename='bp_server'") != '0':
        raise ValueError('stop all bp_server sessions before physical capture')
    if set(stack.dc('ps', '--status', 'running', '--services').split()) & (MUTATING_HELPERS | {'server', 'edge'}):
        raise ValueError('writer fence changed during checkpoint')


def stop_rustfs(stack):
    stack.dc('stop', '-t', '60', 'rustfs')
    containers = stack.dc('ps', '-aq', 'rustfs').split()
    if len(containers) != 1:
        raise ValueError('RustFS stop has no unique container proof')
    state = json.loads(command(['docker', 'inspect', containers[0]]))[0]['State']
    if state.get('Running') or state.get('ExitCode') != 0 or state.get('OOMKilled') or state.get('Error'):
        raise ValueError('RustFS did not stop cleanly; checkpoint refused')
    return 0


def storage_evidence(stack, evidence):
    binding = evidence.get('binding')
    if not binding or binding.get('phase') != 'ready' or binding.get('backend') != stack.backend:
        raise ValueError('storage inspection requires a ready matching binding')
    identity = {key: str(uuid.UUID(binding[key])) for key in ('databaseId', 'storeId', 'generation')}
    digest = evidence['digest']
    if not re.fullmatch('[a-f0-9]{64}', digest):
        raise ValueError('invalid storage inventory digest')
    return dict(**identity, backend=binding['backend'], phase=binding['phase'], inventorySha256=digest,
                objectCount=len(evidence['objects']), bucket=stack.services['server']['environment'].get('BP_BLOB_S3_BUCKET') if stack.backend == 's3' else None,
                **({'migration': evidence['migration']} if evidence.get('migration') else {}))


def inspect_storage(stack, offline=False):
    startup_timeout(stack)
    try:
        return storage_evidence(stack, json.loads(storage_admin(stack, 'inspect', '--fenced')))
    except (RuntimeError, ValueError, KeyError) as error:
        token = str(error).removeprefix('storage initialization refused: ')
        forensic = {'blob_binding_marker_missing', 'blob_binding_marker_mismatch',
                    'blob_binding_content_mismatch', 'blob_binding_inventory_mismatch',
                    'blob_binding_intent_mismatch', 'blob_binding_ambiguous',
                    'blob_binding_intent_missing', 'blob_binding_store_inventory_invalid'}
        if offline and stack.backend == 'filesystem' and token in forensic:
            return {'backend': 'filesystem', 'inspection': 'failed', 'servable': False}
        raise


def credentials_digest(stack, name, salt):
    # RustFS accepts root credentials at process startup. Authentication alone cannot prove
    # they equal the source credentials. Checkpoint-specific commitment prevents silent rotation.
    env = stack.services['blob-bootstrap']['environment']
    values = [env[key] for key in ('BP_RUSTFS_ROOT_USER', 'BP_RUSTFS_ROOT_PASSWORD', 'BP_BLOB_S3_ACCESS_KEY', 'BP_BLOB_S3_SECRET_KEY')]
    return hashlib.pbkdf2_hmac('sha256', json.dumps([name, *values], separators=(',', ':')).encode(), bytes.fromhex(salt), 600000).hex()


def prove_root_credentials(stack, environment=()):
    # Bootstrap's entrypoint mutates IAM. Override it with a read-only signed request.
    command(stack.compose + ['run', '--rm', '--no-deps', '-T', '--entrypoint', 'bun',
                            *[arg for value in environment for arg in ('-e', value)],
                            '-v', str(ROOT / 'scripts/s3-checkpoint-proof.js') + ':/app/scripts/s3-checkpoint-proof.js:ro',
                            '-v', str(ROOT / 'apps/server/blobs/s3-admin-request.ts') + ':/app/apps/server/blobs/s3-admin-request.ts:ro',
                            'blob-bootstrap', '/app/scripts/s3-checkpoint-proof.js'])


def prepare_restored_storage(stack, checkpoint, retain_unreferenced=False, captured=None, mounts=None):
    if 'storage-init' not in stack.services:
        return
    stack.dc('up', '-d', '--wait', '--wait-timeout', str(startup_timeout(stack)),
             '--no-build', '--pull', 'never', '--no-deps', 'postgres')
    if stack.backend == 's3':
        stack.dc('up', '-d', '--wait', '--wait-timeout', str(startup_timeout(stack)),
                 '--no-build', '--pull', 'never', '--no-deps', 'rustfs')
        actual = stack.attest_mounts('rustfs')['rustfs-data']
        recorded = (mounts or {}).get('rustfs-data', {})
        if any(actual[key] != recorded.get(key) for key in ('destination', 'image', 'command', 'entrypoint')):
            raise ValueError('restored RustFS launch or mount evidence differs')
        prove_root_credentials(stack)
    evidence = json.loads(storage_admin(stack, 'inspect', '--fenced'))
    if (evidence.get('intent') or {}).get('phase') != 'ready':
        raise RuntimeError('restored storage has an unfinished binding intent; keep the server stopped and retry its original operator command before starting')
    if evidence.get("migration") and not captured:
        raise RuntimeError("pending migration requires exact captured storage evidence")
    if captured is not None:
        if captured.get('inspection') != 'failed' and storage_evidence(stack, evidence) != captured:
            raise RuntimeError('restored storage differs from source identity or full inventory; keep server and bootstrap stopped')
    elif stack.backend == 's3':
        raise RuntimeError('S3 restore requires source storage evidence')
    if any(ref['classification'] == 'unreferenced' for ref in evidence['objects']):
        if not retain_unreferenced:
            raise RuntimeError('restored storage contains cleanup leftovers; server remains stopped. Reconcile the restored capture with --retain-unreferenced before starting, or restore fresh targets with that explicit flag')
        storage_admin(stack, 'reconcile', '--fenced', '--checkpoint', checkpoint, '--retain-unreferenced')


def restore(stack, source, retain_unreferenced=False):
    source = source.resolve()
    doc = verify(source, stack)
    if source.parent != stack.backups / 'backups' or source.name != doc['name']:
        raise ValueError('preserve the checkpoint name under the recovery repository backups directory')
    if stack.dc('ps', '-aq'):
        raise ValueError('remove target containers before restore; leave the source fenced')
    stack.check_mount_config()
    # Preflight every target before extracting anything. Helpers inspect as root, including dotfiles.
    for volume in stack.stores:
        if command(['docker', 'ps', '-aq', '--filter', 'volume=' + stack.volume(volume)]):
            raise ValueError('restore refuses a volume attached to an existing container')
        command(['docker', 'volume', 'create', '--label', 'com.docker.compose.project=' + stack.project,
                 '--label', 'com.docker.compose.volume=' + volume, stack.volume(volume)])
        stack.helper(EMPTY_TARGET_CHECK, '/target',
                     mounts=('-v', f'{stack.volume(volume)}:/target'))
    require_empty(stack.backups / 'archive')
    relative = source.relative_to(stack.backups)
    target = '/backup/' + relative.as_posix()
    data = '/var/lib/postgresql/18/docker'
    pgmount = ('-v', f'{stack.volume("postgres-data")}:/var/lib/postgresql')
    stack.helper('''
        dest=$2; mkdir -p "$dest"; tar -xf "$1/postgres/base.tar" -C "$dest"
        tar -xf "$1/postgres/pg_wal.tar" -C "$dest/pg_wal"
        cp "$1/postgres/backup_manifest" "$dest/backup_manifest"
        pg_verifybackup "$dest"
        rm -rf "$dest/checkpoint-wal"
        cp "$dest/postgresql.auto.conf" "$dest/checkpoint.auto.conf"
        mkdir "$dest/checkpoint-wal"; cp "$1"/wal/* "$dest/checkpoint-wal/"
        printf "\\nrestore_command = 'cp %s/checkpoint-wal/%%f %%p'\\nrecovery_target_name = '%s'\\nrecovery_target_timeline = '%s'\\nrecovery_target_action = 'promote'\\n" "$dest" "$3" "$4" >> "$dest/postgresql.auto.conf"
        touch "$dest/recovery.signal"; chown -R postgres:postgres /var/lib/postgresql; chmod 700 "$dest"
    ''', target, data, doc['name'], str(int(doc['after']['timeline'])), mounts=pgmount)
    for volume in stack.stores:
        if volume != 'postgres-data':
            stack.helper('tar --numeric-owner --xattrs --xattrs-include="*" -xf "$1" -C /target', f'{target}/{volume}.tar', mounts=('-v', f'{stack.volume(volume)}:/target'))
    stack.helper('mkdir -p /backup/archive /backup/backups; chown postgres:postgres /backup/archive /backup/backups')
    # Recovery stays isolated until identity, the named target and audit heads are verified and the gate is armed.
    gate = f"""DO $$ DECLARE h record; BEGIN
      IF pg_is_in_recovery() OR NOT (pg_last_wal_replay_lsn()>='{doc['targetLsn']}'::pg_lsn) THEN RAISE EXCEPTION 'restore target missing'; END IF;
      IF (pg_control_system()).system_identifier::text <> '{doc['after']['systemId']}' THEN RAISE EXCEPTION 'restore identity mismatch'; END IF;
      IF current_setting('server_version_num') <> '{int(doc['after']['postgres'])}' OR (SELECT max(version) FROM control.schema_version) <> {int(doc['after']['schema'])} OR (SELECT version FROM pgmq.backplane_install LIMIT 1) <> '{doc['after']['pgmq']}' THEN RAISE EXCEPTION 'restore versions differ'; END IF;
      UPDATE control.restore_gate SET epoch=gen_random_uuid(),active=EXISTS(SELECT FROM audit.cursor),backup_id='{doc['name']}',target_lsn='{doc['targetLsn']}' WHERE singleton;
      INSERT INTO control.restore_workspaces(epoch,workspace_id,minimum_head) SELECT g.epoch,c.workspace_id,c.last_position FROM control.restore_gate g CROSS JOIN audit.cursor c WHERE g.singleton;
      END $$;"""
    # All SQL values below are validated UUIDs/decimal positions from the manifest.
    for head in doc['after']['heads']:
        workspace = str(uuid.UUID(head['workspaceId'])); position = int(head['head'])
        gate += f"DO $$ BEGIN IF NOT EXISTS (SELECT FROM audit.cursor WHERE workspace_id='{workspace}' AND last_position={position}) THEN RAISE EXCEPTION 'restore head missing'; END IF; END $$;"
    expected = dict(systemId=doc['after']['systemId'], postgres=str(int(doc['after']['postgres'])),
                    schema=int(doc['after']['schema']), pgmq=doc['after']['pgmq'],
                    heads=[dict(workspaceId=str(uuid.UUID(h['workspaceId'])), head=str(int(h['head']))) for h in doc['after']['heads']])
    gate = f"DO $$ BEGIN IF (({SNAPSHOT})::jsonb - 'timeline') <> '{json.dumps(expected)}'::jsonb THEN RAISE EXCEPTION 'restored database snapshot differs'; END IF; END $$;" + gate
    stack.helper('''
        pg_ctl -D "$1" -l /tmp/recovery.log -w -t 120 -o "-c listen_addresses='' -c unix_socket_directories=/tmp -c archive_mode=off" start
        trap 'pg_ctl -D "$1" -m fast -w stop' EXIT
        n=0
        while [ "$(psql -X -h /tmp -U postgres -d backplane -Atc 'SELECT pg_is_in_recovery()')" != f ]; do
          n=$((n+1)); [ "$n" -lt 120 ] || exit 1; sleep 1
        done
        psql -X -h /tmp -U postgres -d backplane -v ON_ERROR_STOP=1 -1 -c "$2"
        pg_ctl -D "$1" -m fast -w stop; trap - EXIT
        rm -rf "$1/checkpoint-wal"
        mv "$1/checkpoint.auto.conf" "$1/postgresql.auto.conf"
    ''', data, gate, mounts=pgmount, user='postgres')
    prepare_restored_storage(stack, doc['name'], retain_unreferenced, doc.get('storage'), doc.get('mounts'))
    if doc.get("migration"):
        runpy.run_path(str(ROOT / "scripts/storage-migrate.py"))["finalize_restored_migration"](stack, source, doc)
    stack.dc('up', '-d', '--no-build', '--pull', 'never', 'server')
    deadline = time.monotonic() + startup_timeout(stack)
    while time.monotonic() < deadline:
        try:
            ready = json.loads(stack.dc('exec', '-T', 'server', 'curl', '-sS', 'http://localhost:3000/health/ready'))
            if ready['status'] == 'ready' or ('restore_gated' in ready['problems'] and not set(ready['problems']) - {'insecure_origin', 'restore_gated'}):
                break
        except (RuntimeError, ValueError, KeyError):
            pass
        time.sleep(1)
    else:
        raise RuntimeError('restored server did not expose its recovery API')
    try:
        stack.helper('chown "$1:$2" /backup/backups; chmod a+rx /backup/backups', str(os.getuid()), str(os.getgid()))
        publish_health(stack.backups / 'backups', doc)
    except (RuntimeError, ValueError, OSError, KeyError):
        print('Restored data is gated, but the health receipt could not be published. Repair repository permissions/free space, then take a new fenced Checkpoint; do not repeat restore into these volumes.', file=sys.stderr)
    print('Restore complete. Workspaces remain gated. Release them through the User API, then start the remaining profiles.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['backup', 'restore'])
    parser.add_argument('checkpoint', nargs='?', type=Path)
    parser.add_argument('--env-file', type=Path, default=ROOT / '.env')
    parser.add_argument('--fenced', action='store_true', help='attest exclusive operator control: exclude all external writers and mutating helpers until this command finishes')
    parser.add_argument('--offline', action='store_true', help='capture a fenced stopped server without restarting it')
    parser.add_argument('--retain-unreferenced', action='store_true', help='explicitly retain restored cleanup leftovers before starting the server')
    args = parser.parse_args()
    if args.offline and args.action != 'backup':
        parser.error('--offline is only valid for backup')
    if args.retain_unreferenced and args.action != 'restore':
        parser.error('--retain-unreferenced is only valid for restore')
    if not args.fenced:
        parser.error('--fenced is required; hold the external writer fence throughout capture or restore')
    os.umask(0o077)
    lock_path = args.env_file.with_suffix(args.env_file.suffix + '.lock')
    with lock_path.open('x'):
        try:
            stack = Stack(args.env_file, args.checkpoint.resolve() if args.action == "restore" and args.checkpoint else None)
            with (stack.backups / '.checkpoint.lock').open('w') as repository_lock:
                fcntl.flock(repository_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                if args.action == 'backup':
                    backup(stack, args.offline, fenced=args.fenced)
                else:
                    if args.checkpoint is None:
                        raise ValueError('checkpoint path required')
                    restore(stack, args.checkpoint, args.retain_unreferenced)
        finally:
            lock_path.unlink()



if __name__ == '__main__':
    def interrupted(_signum, _frame):
        raise RuntimeError('interrupted')
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGHUP, interrupted)
    try:
        main()
    except (RuntimeError, ValueError, OSError, KeyError) as error:
        print(f'Checkpoint failed: {error}', file=sys.stderr)
        sys.exit(1)
