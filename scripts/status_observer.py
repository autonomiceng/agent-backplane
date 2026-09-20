#!/usr/bin/env python3
"""Publish Backplane's version 1 public status from bounded host observations."""

import argparse
import fcntl
import ipaddress
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

from status_config import configuration, environment, local_bridges, modes, selection
from status_io import Unavailable, directory, now, publish, read_json, read_task, regular, run
from status_probes import capabilities, configured_image, probe

SERVICES = ('server', 'postgres', 'caddy', 'rustfs', 'workerd')
CAPABILITIES = ('files', 'functions')
TASKS = ('bootstrap', 'migrate', 'data-init', 'blob-bootstrap')
SERVICE_NAMES = {'caddy': 'edge'}
TTL = 120
CONFIGURATION_TTL = 300
LIMIT = 1024 * 1024
COLLECTION_TIMEOUT = 90


def timestamp(value, at):
    if not isinstance(value, str) or not re.fullmatch(
            r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z', value):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        ceiling = datetime.fromisoformat(at.replace('Z', '+00:00'))
        if parsed.year < 1970 or (parsed - ceiling).total_seconds() > 5:
            return None
        return parsed.isoformat().replace('+00:00', 'Z')
    except ValueError:
        return None


def empty(component):
    kind = 'capability' if component in CAPABILITIES else 'task' if component in TASKS else 'service'
    result = {'id': component, 'kind': kind, 'configured': None, 'state': 'unknown',
              'observedAt': None, 'validForSeconds': TTL}
    if kind == 'task':
        result['lastExecutionAt'] = None
    return result


def inventory(project, runner):
    text = runner(['docker', 'ps', '--all', '--no-trunc', '--filter',
                   'label=com.docker.compose.project=' + project,
                   '--format', '{{.ID}} {{.Label "com.docker.compose.service"}} {{.Label "com.docker.compose.oneoff"}}'],
                  timeout=4, limit=65536)
    result = {}
    for line in text.splitlines():
        fields = line.split()
        if len(fields) != 3 or not re.fullmatch(r'[0-9a-f]{64}', fields[0]):
            raise Unavailable()
        container, service, oneoff = fields
        if oneoff.lower() == 'true':
            continue
        if oneoff.lower() != 'false':
            raise Unavailable()
        result.setdefault(service, []).append(container)
    return result


def inspect(container, service, config, runner):
    docs = read_json(runner(['docker', 'inspect', container], timeout=4, limit=LIMIT), LIMIT)
    if not isinstance(docs, list) or len(docs) != 1:
        raise Unavailable()
    doc = docs[0]
    labels = doc['Config']['Labels']
    if (doc['Id'] != container or labels['com.docker.compose.project'] != config['name']
            or labels['com.docker.compose.service'] != service
            or str(labels.get('com.docker.compose.oneoff', '')).lower() != 'false'):
        raise Unavailable()
    if not isinstance(doc.get('State'), dict):
        raise Unavailable()
    return doc


def address(doc, service, config, bridges):
    networks = doc.get('NetworkSettings', {}).get('Networks', {})
    selected = config['services'].get(service, {}).get('networks', {})
    if isinstance(selected, list):
        selected = {name: None for name in selected}
    if not isinstance(networks, dict) or not isinstance(selected, dict):
        return None
    keys = [key for key in ('default', *selected) if key in selected and key in bridges]
    for key in dict.fromkeys(keys):
        value = networks.get(bridges[key], {}).get('IPAddress')
        if not value:
            continue
        parsed = ipaddress.ip_address(value)
        if parsed.is_loopback or parsed.is_unspecified or parsed.is_multicast or parsed.is_link_local:
            raise Unavailable()
        return value
    return None


def observe_component(component, candidates, config, inventory_at, bridges, runner, clock):
    row = empty(component)
    service = SERVICE_NAMES.get(component, component)
    configured = config['services'].get(service)
    if configured is None:
        return row
    row['configured'] = True
    if component in SERVICES:
        row.update(configured_image(component, configured.get('image')))
    if candidates is None or len(candidates) > 1:
        return row
    if not candidates:
        if component not in TASKS:
            row.update(state='absent', observedAt=inventory_at)
        return row
    container = candidates[0]
    at = clock()
    try:
        doc = inspect(container, service, config, runner)
        state = doc['State']
        if component in TASKS:
            started = timestamp(state.get('StartedAt'), at)
            if not started:
                return row
            row.update(observedAt=at, lastExecutionAt=started)
            if state.get('Status') == 'running' and state.get('Paused') is not True:
                row['state'] = 'starting'
            elif (state.get('Status') == 'exited' and timestamp(state.get('FinishedAt'), at)
                  and datetime.fromisoformat(timestamp(state['FinishedAt'], at))
                  >= datetime.fromisoformat(started) and type(state.get('ExitCode')) is int):
                row['state'] = 'healthy' if state['ExitCode'] == 0 else 'unavailable'
            return row
        if re.fullmatch(r'sha256:[0-9a-f]{64}', str(doc.get('Image', ''))):
            row['observedImageId'] = doc['Image']
        row['observedAt'] = at
        if state.get('Status') in ('exited', 'dead') or state.get('Paused') is True:
            row['state'] = 'unavailable'
        elif state.get('Status') == 'restarting':
            row['state'] = 'starting'
        elif state.get('Status') == 'running':
            ip = address(doc, service, config, bridges)
            row['state'], release = probe(component, container, ip, runner)
            if release:
                row['observedVersion'] = release
            after = inspect(container, service, config, runner)
            if (after.get('Image') != doc.get('Image') or
                    any(after['State'].get(key) != state.get(key)
                        for key in ('StartedAt', 'Status', 'Paused'))):
                raise Unavailable()
        return row
    except (Unavailable, KeyError, TypeError, ValueError, AttributeError, OSError):
        row.pop('observedImageId', None)
        row.pop('observedVersion', None)
        row.update(state='unknown', observedAt=None)
        return row


def project_capability(row, source, expected_backend, at):
    if not isinstance(source, dict):
        return
    observed = timestamp(source.get('observedAt'), at)
    state = source.get('state')
    if state not in ('healthy', 'unavailable', 'unknown'):
        return
    if state == 'healthy' and source.get('backend') != expected_backend:
        return
    if state == 'unavailable' and source.get('backend') is not None:
        return
    if state in ('healthy', 'unavailable') and not observed:
        return
    if observed:
        age = (datetime.fromisoformat(at.replace('Z', '+00:00'))
               - datetime.fromisoformat(observed.replace('Z', '+00:00'))).total_seconds()
        if age > TTL:
            state = 'unknown'
    row.update(state=state, observedAt=observed)


def configure_rows(rows, config, configured_at, selected_modes):
    services = config['services']
    for component in ('server', 'postgres'):
        if component in services:
            rows[component]['configured'] = True
            rows[component].update(configured_image(component, services[component].get('image')))
    for component, mode in (('caddy', selected_modes['caddy']),
                            ('rustfs', 'configured' if selected_modes['files'] == 's3'
                             else 'disabled' if selected_modes['files'] == 'filesystem' else None),
                            ('workerd', 'configured' if selected_modes['functions'] == 'workerd'
                             else 'disabled' if selected_modes['functions'] == 'disabled' else None)):
        if mode == 'configured':
            service = SERVICE_NAMES.get(component, component)
            rows[component]['configured'] = True
            rows[component].update(configured_image(component, services[service].get('image')))
        elif mode == 'disabled':
            rows[component].update(configured=False, state='disabled', observedAt=configured_at, validForSeconds=CONFIGURATION_TTL)
    if selected_modes['files'] in ('filesystem', 's3'):
        rows['files']['configured'] = True
    if selected_modes['functions'] == 'workerd':
        rows['functions']['configured'] = True
    elif selected_modes['functions'] == 'disabled':
        rows['functions'].update(configured=False, state='disabled', observedAt=configured_at, validForSeconds=CONFIGURATION_TTL)
    rows['bootstrap']['configured'] = True
    for task in ('migrate', 'data-init'):
        if task in services:
            rows[task]['configured'] = True
    if selected_modes['files'] == 's3':
        rows['blob-bootstrap']['configured'] = True
    elif selected_modes['files'] == 'filesystem':
        rows['blob-bootstrap'].update(configured=False, state='disabled', observedAt=configured_at, validForSeconds=CONFIGURATION_TTL)


def collect(root, env_file, project, compose_files, profiles, state_dir, runner, clock=now):
    rows = {name: empty(name) for name in (*SERVICES, *CAPABILITIES, *TASKS)}
    configured_at = clock()
    try:
        config = configuration(root, env_file, project, compose_files, profiles, runner)
        selected_modes = modes(config, profiles)
        configure_rows(rows, config, configured_at, selected_modes)
    except (OSError, Unavailable, TypeError, ValueError):
        config = None
        configured_at = None
    if config is not None:
        inventory_at = clock()
        try:
            resources = inventory(project, runner) or None
        except Unavailable:
            resources = None
        bridges = local_bridges(config, runner, environment()) if resources is not None else {}
        observed = (*SERVICES, 'migrate', 'data-init', 'blob-bootstrap')
        with ThreadPoolExecutor(max_workers=4) as pool:
            futures = {}
            for component in observed:
                if rows[component]['configured'] is not True:
                    continue
                service = SERVICE_NAMES.get(component, component)
                candidates = resources.get(service, []) if resources is not None else None
                futures[component] = pool.submit(observe_component, component, candidates, config,
                                                 inventory_at, bridges, runner, clock)
            for component, future in futures.items():
                try:
                    rows[component] = future.result()
                except Exception:
                    pass
        server_candidates = resources.get('server', []) if resources is not None else []
        server_env = config['services'].get('server', {}).get('environment', {})
        if (len(server_candidates) == 1 and isinstance(server_env, dict)
                and isinstance(server_env.get('BP_OPERATIONS_TOKEN'), str)
                and server_env['BP_OPERATIONS_TOKEN']):
            try:
                at = clock()
                projected = capabilities(server_candidates[0], runner)
                if rows['files']['configured'] is True:
                    project_capability(rows['files'], projected.get('files'), selected_modes['files'], at)
                if rows['functions']['configured'] is True:
                    project_capability(rows['functions'], projected.get('functions'), 'workerd', at)
            except (OSError, Unavailable, TypeError, ValueError):
                pass
        try:
            at = clock()
            record = read_task(state_dir, root, env_file)
            started = timestamp(record.get('lastExecutionAt'), at)
            if started and record.get('state') in ('healthy', 'unavailable', 'unknown'):
                rows['bootstrap'].update(state=record['state'], observedAt=at,
                                         lastExecutionAt=started)
        except (OSError, Unavailable, TypeError, ValueError):
            pass
    return {'schemaVersion': 1, 'stack': 'backplane', 'generatedAt': clock(),
            'configurationObservedAt': configured_at, 'configurationValidForSeconds': CONFIGURATION_TTL,
            'telemetry': 'unknown', 'components': list(rows.values())}


def observe(root, env_file=None, project='agent-backplane', compose_files=(), profiles=(),
            state_dir=None, runner=run, clock=now):
    root, env_file, project, compose_files, profiles = selection(
        root, env_file, project, compose_files, profiles)
    # Keep explicit path components so descriptor walking can reject symlinks.
    state_dir = Path(os.path.abspath(state_dir)) if state_dir else root / 'data'
    env = environment()
    deadline = time.monotonic() + COLLECTION_TIMEOUT

    def selected(argv, **options):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise Unavailable()
        options['timeout'] = min(options.get('timeout', remaining), remaining)
        return runner(argv, cwd=root, env=env, **options)

    with directory(state_dir / 'status', 0o700) as private:
        regular(private, 'observer.lock')
        lock = os.open('observer.lock', os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW,
                       0o600, dir_fd=private)
        try:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return None
            document = collect(root, env_file, project, compose_files, profiles,
                               state_dir, selected, clock)
            if len(document['components']) > 32:
                raise Unavailable()
            with directory(state_dir / 'console') as public:
                publish(public, 'status.json', document, serialized=True)
        finally:
            os.close(lock)
    return document


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--checkout', type=Path, required=True)
    parser.add_argument('--env-file', type=Path)
    parser.add_argument('--project-name', default='agent-backplane')
    parser.add_argument('--compose-file', action='append', default=[])
    parser.add_argument('--profile', action='append', default=[])
    parser.add_argument('--state-dir', type=Path)
    args = parser.parse_args()
    try:
        observe(args.checkout, args.env_file, args.project_name, args.compose_file,
                args.profile, args.state_dir)
    except (OSError, Unavailable, ValueError, TypeError):
        print('status observer: observation or publication failed', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
