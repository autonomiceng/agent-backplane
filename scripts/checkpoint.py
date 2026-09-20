#!/usr/bin/env python3
"""Compose checkpoints: fence application writes, archive all local durable stores, restore empty volumes."""
import argparse
import fcntl
import hashlib
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
import uuid
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parent.parent


def command(args, env=None):
    result = subprocess.run(args, capture_output=True, text=True, env=env, cwd=ROOT)
    if result.returncode:
        # Compose diagnostics can contain interpolated credentials.
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


def manifest(root, before, after, name, lsn, segment, images, volumes, revision):
    # Deliberate allowlist: resolved Compose environments never enter a checkpoint manifest.
    return dict(version=1, before=before, after=after, name=name, targetLsn=lsn,
                segment=segment, images=images, volumes=volumes, revision=revision,
                completedAt=datetime.now(timezone.utc).isoformat(), artifacts=inventory(root))


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
        if self.services['server']['environment'].get('BP_BLOB_BACKEND', 'filesystem') != 'filesystem':
            raise ValueError('filesystem checkpoints require BP_BLOB_BACKEND=filesystem; coordinate S3 recovery separately')
        self.backups = Path(next(v['source'] for v in self.services['postgres']['volumes'] if v['target'] == '/backup')).resolve()
        if not self.backups.is_dir():
            raise ValueError('backup mount must exist')
        self.stores = {'postgres-data': '/var/lib/postgresql', 'server-data': '/data'}
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
            recorded = doc['images']
            if 'server-image.tar' in doc['artifacts']:
                command(['docker', 'load', '--input', str(source / 'server-image.tar')])
        self.images = {}
        helpers = {'backup-init': 'postgres', 'migrate': 'server', 'data-init': 'server'}
        for service in ('postgres', 'server', *(['edge'] if 'edge' in self.services else []), *helpers):
            ref = self.services[service]['image']
            expected = recorded.get(service, recorded.get(helpers.get(service))) if recorded is not None else None
            try:
                if recorded is not None:
                    if expected is None or expected['reference'] != ref:
                        raise ValueError(f'{service}: restore requires the recorded image reference; check the env file and exported BP_* settings')
                    recovery = expected.get('recoveryReference', ref)
                    if service not in helpers and service != 'server':
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
            elif service != 'server':
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


def prune_checkpoints(root, keep, remove=shutil.rmtree):
    if keep < 1:
        raise ValueError('BP_BACKUP_KEEP must be positive')
    complete = []
    for path in root.iterdir():
        if path.is_dir() and not path.is_symlink() and (path / 'manifest.json').is_file():
            doc = json.loads((path / 'manifest.json').read_text())
            complete.append((doc['completedAt'], path, doc))
    complete.sort(key=lambda item: item[0], reverse=True)
    boundaries = {}
    for _, path, doc in complete[:keep]:
        base = json.loads((path / 'postgres/backup_manifest').read_text())
        segment_bytes = doc.get('walSegmentBytes') or (path / 'wal' / doc['segment']).stat().st_size
        for timeline, name in wal_boundary(base, segment_bytes).items():
            boundaries[timeline] = min(boundaries.get(timeline, name), name)
    for _, path, _ in complete[keep:]:
        remove(path)
    return boundaries


def backup(stack):
    stack.attest()
    if any('@' not in image['reference'] for name, image in stack.images.items() if name in ('postgres', 'edge')):
        print('Upstream image custody is external: retain the recorded immutable references in a registry or a tested off-host image archive; publication was not checked.', file=sys.stderr, flush=True)
    running = stack.dc('ps', '--status', 'running', '--services').split()
    if not {'postgres', 'server', *(['edge'] if 'edge' in stack.services else [])} <= set(running):
        raise ValueError('backup requires running postgres and server')
    if not 180000 <= int(stack.pg('SHOW server_version_num')) < 190000:
        raise ValueError('Checkpoint recovery requires the PostgreSQL 18 data layout')
    if stack.pg('SHOW data_directory') != '/var/lib/postgresql/18/docker':
        raise ValueError('Checkpoint recovery requires data_directory=/var/lib/postgresql/18/docker')
    if stack.pg('SHOW archive_mode') != 'on':
        raise ValueError('WAL archiving is required')
    if stack.pg("SELECT count(*) FROM pg_tablespace WHERE spcname NOT IN ('pg_default','pg_global')") != '0':
        raise ValueError('custom tablespaces are unsupported')
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
    try:
        for service in ('edge', 'server'):
            if service in running:
                stopped.append(service)
                stack.dc('stop', '-t', '60', service)
        before = stack.snapshot()
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
                stack.helper('umask 077; tar -C /source -cf "$1" .', f'{target}/{volume}.tar',
                             mounts=('-v', f'{stack.volume(volume)}:/source:ro'))
        stack.helper('chown -R "$2:$3" "$1"; chmod -R u+rwX,go-rwx "$1"', target, str(os.getuid()), str(os.getgid()))
        command(['docker', 'save', '--output', str(dest / 'server-image.tar'), stack.images['server']['id']])
        per_log = (1 << 32) // segment_bytes
        first_number = int(first[8:16], 16) * per_log + int(first[16:], 16)
        last_number = int(segment[8:16], 16) * per_log + int(segment[16:], 16)
        for number in range(first_number, last_number + 1):
            filename = f'{first[:8]}{number // per_log:08X}{number % per_log:08X}'
            if not (dest / 'wal' / filename).is_file():
                raise ValueError('archived WAL has a gap')
        doc = manifest(dest, before, after, name, lsn, segment, stack.images, list(stack.stores),
                       command(['git', 'rev-parse', 'HEAD']))
        doc['walSegmentBytes'] = segment_bytes
        with (dest / '.manifest.json.tmp').open('x') as file:
            json.dump(doc, file, indent=2); file.write('\n'); file.flush(); os.fsync(file.fileno())
        (dest / '.manifest.json.tmp').chmod(0o644)
        (dest / '.manifest.json.tmp').rename(dest / 'manifest.json')
        dest.chmod(0o711)
        command(['sync', '-f', str(dest)])
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
        return dest
    finally:
        if stopped:
            stack.dc('start', *reversed(stopped))


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
    required = {'postgres/base.tar', 'postgres/pg_wal.tar', 'postgres/backup_manifest', 'server-data.tar', 'wal/' + doc['segment']}
    if not re.fullmatch(r'bp_[a-f0-9]{32}', doc['name']):
        required.add('server-image.tar')
    if 'edge-data' in stack.stores:
        required |= {'edge-data.tar', 'edge-config.tar'}
    if not required <= doc['artifacts'].keys() or doc['artifacts'] != inventory(source):
        raise ValueError('checkpoint artifacts or checksums differ')
    for name in doc['artifacts']:
        if name.endswith('.tar') and name != 'server-image.tar':
            with tarfile.open(source / name) as archive:
                for member in archive:
                    path = Path(member.name)
                    if path.is_absolute() or '..' in path.parts or not (member.isfile() or member.isdir()):
                        raise ValueError('unsafe archive member')
    return doc


def restore(stack, source):
    source = source.resolve()
    doc = verify(source, stack)
    if stack.dc('ps', '-aq'):
        raise ValueError('remove target containers before restore; leave the source fenced')
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
            stack.helper('tar -xf "$1" -C /target', f'{target}/{volume}.tar', mounts=('-v', f'{stack.volume(volume)}:/target'))
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
        gate += f"DO $$ BEGIN IF NOT EXISTS (SELECT FROM audit.cursor WHERE workspace_id='{workspace}' AND last_position>={position}) THEN RAISE EXCEPTION 'restore head missing'; END IF; END $$;"
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
    stack.dc('up', '-d', '--no-build', '--pull', 'never', 'server')
    deadline = time.monotonic() + 120
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
    print('Restore complete. Workspaces remain gated. Release them through the User API, then start the remaining profiles.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['backup', 'restore'])
    parser.add_argument('checkpoint', nargs='?', type=Path)
    parser.add_argument('--env-file', type=Path, default=ROOT / '.env')
    args = parser.parse_args()
    os.umask(0o077)
    lock_path = args.env_file.with_suffix(args.env_file.suffix + '.lock')
    with lock_path.open('x'):
        try:
            stack = Stack(args.env_file, args.checkpoint.resolve() if args.action == "restore" and args.checkpoint else None)
            with (stack.backups / '.checkpoint.lock').open('w') as repository_lock:
                fcntl.flock(repository_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                if args.action == 'backup':
                    backup(stack)
                else:
                    if args.checkpoint is None:
                        raise ValueError('checkpoint path required')
                    restore(stack, args.checkpoint)
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
