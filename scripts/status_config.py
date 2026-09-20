"""Explicit Compose selection and conservative Backplane configuration evidence."""

import os
import re
from pathlib import Path

from status_io import Unavailable, read_file, read_json

LIMIT = 1024 * 1024
PROFILES = {'blobs', 'compute', 'edge', 'gateway'}


def environment():
    # Stack selection comes only from observer arguments and the selected env file.
    allowed = {'PATH', 'HOME', 'USER', 'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR', 'SSH_AUTH_SOCK'}
    return {key: value for key, value in os.environ.items()
            if key in allowed or key.startswith('DOCKER_')}


def saved_settings(env_file):
    saved, seen = {}, set()
    for line in read_file(env_file, LIMIT).decode('utf-8').split('\n'):
        name = re.match(r'\s*(?:export\s+)?(COMPOSE_PROJECT_NAME|COMPOSE_FILE|COMPOSE_PROFILES|COMPOSE_PATH_SEPARATOR|COMPOSE_ENV_FILES|BP_STATUS_DIR)\b', line)
        if name is None:
            continue
        key = name[1]
        match = re.fullmatch(r'([A-Z_]+)=(.*)', line)
        if key in seen or match is None:
            raise Unavailable()
        seen.add(key)
        value = match[2]
        if len(value) >= 2 and value[0] in "'\"" and value[-1] == value[0]:
            value = value[1:-1]
        elif re.search(r'\s|#', value):
            raise Unavailable()
        if any(char in value for char in "'\"\\$`\r"):
            raise Unavailable()
        if value or key == 'COMPOSE_PROFILES':
            saved[key] = value
    return saved


def selection(root, env_file=None, project=None, compose_files=(), profiles=None):
    root = Path(root).resolve()
    env_file = Path(env_file).resolve() if env_file else (root / '.env').resolve()
    saved = saved_settings(env_file)
    if saved.get('COMPOSE_PATH_SEPARATOR', ':') != ':' or saved.get('COMPOSE_ENV_FILES'):
        raise Unavailable()
    recorded_files = saved.get('COMPOSE_FILE', '').split(':') if 'COMPOSE_FILE' in saved else []
    if any(not item for item in recorded_files):
        raise Unavailable()
    recorded_files = tuple((env_file.parent / item).resolve() for item in recorded_files)
    files = tuple(Path(item).resolve() if Path(item).is_absolute()
                  else (root / item).resolve() for item in compose_files)
    files = files or recorded_files or ((root / 'compose.yaml').resolve(),)
    recorded_profiles = saved.get('COMPOSE_PROFILES', '').split(',') if saved.get('COMPOSE_PROFILES') else []
    # Existing timers pass explicit files and omit profile flags for an empty selection.
    if profiles is None:
        profiles = [] if compose_files else recorded_profiles
    profiles = () if list(profiles) == [''] else tuple(sorted(set(profiles)))
    project = project if project is not None else saved.get('COMPOSE_PROJECT_NAME', 'agent-backplane')
    if (not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,127}', project)
            or any(profile not in PROFILES for profile in profiles)
            or {'edge', 'gateway'} <= set(profiles)
            or 'COMPOSE_PROJECT_NAME' in saved and saved['COMPOSE_PROJECT_NAME'] != project
            or recorded_files and recorded_files != files
            or 'COMPOSE_PROFILES' in saved and set(recorded_profiles) != set(profiles)
            or not root.is_dir()):
        raise Unavailable()
    # These bounded reads reject directories and FIFOs before Compose.
    for path in files:
        read_file(path, LIMIT)
    return root, env_file, project, files, profiles


def configuration(root, env_file, project, compose_files, profiles, runner):
    argv = ['docker', 'compose', '--project-name', project, '--project-directory', str(compose_files[0].parent),
            '--env-file', str(env_file)]
    for path in compose_files:
        argv.extend(('-f', str(path)))
    for profile in profiles:
        argv.extend(('--profile', profile))
    argv.extend(('config', '--format', 'json'))
    doc = read_json(runner(argv, timeout=10, limit=LIMIT), LIMIT)
    if (not isinstance(doc, dict) or doc.get('name') != project
            or not isinstance(doc.get('services'), dict)
            or not isinstance(doc.get('networks'), dict)
            or not all(isinstance(value, dict) for value in doc['services'].values())):
        raise Unavailable()
    return doc


def service_environment(service):
    value = service.get('environment', {})
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise Unavailable()
    return value


def modes(config, profiles):
    services = config['services']
    server = services.get('server')
    if not isinstance(server, dict):
        return {'files': None, 'functions': None, 'caddy': None}
    env = service_environment(server)
    backend = env.get('BP_BLOB_BACKEND', 'filesystem')
    has_blobs = all(name in services for name in ('rustfs', 'blob-bootstrap'))
    if backend == 'filesystem' and not has_blobs and 'blobs' not in profiles:
        files = 'filesystem'
    elif backend == 's3' and has_blobs and 'blobs' in profiles:
        files = 's3'
    else:
        files = None
    has_workerd = 'workerd' in services
    compute_url = env.get('BP_COMPUTE_URL')
    if has_workerd and compute_url and 'compute' in profiles:
        functions = 'workerd'
    elif not has_workerd and not compute_url and 'compute' not in profiles:
        functions = 'disabled'
    else:
        functions = None
    has_edge = 'edge' in services
    if has_edge and bool({'edge', 'gateway'} & set(profiles)):
        caddy = 'configured'
    elif not has_edge and not {'edge', 'gateway'} & set(profiles):
        caddy = 'disabled'
    else:
        caddy = None
    return {'files': files, 'functions': functions, 'caddy': caddy}


def local_bridges(config, runner, env):
    """Return Compose network keys proven to be host-reachable local bridges."""
    try:
        explicit = env.get('DOCKER_HOST')
        if explicit and not explicit.startswith('unix:///'):
            return {}
        contexts = read_json(runner(['docker', 'context', 'inspect'], timeout=4, limit=65536))
        endpoint = contexts[0]['Endpoints']['docker']['Host']
        if not endpoint.startswith('unix:///') or explicit and endpoint != explicit:
            return {}
        security = read_json(runner(['docker', 'info', '--format', '{{json .SecurityOptions}}'],
                                    timeout=4, limit=65536))
        if not isinstance(security, list) or any('rootless' in str(item) for item in security):
            return {}
        selected = {}
        for key, network in config['networks'].items():
            if (isinstance(network, dict) and isinstance(network.get('name'), str)
                    and re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}', network['name'])):
                selected[key] = network['name']
        if not selected:
            return {}
        result = {}
        # Shipped selections declare at most three networks. Cap custom selections so
        # one observation never grows linearly with arbitrary Compose input.
        for key, name in tuple(selected.items())[:4]:
            try:
                details = read_json(runner(['docker', 'network', 'inspect', name],
                                           timeout=4, limit=LIMIT), LIMIT)
                if (len(details) == 1 and details[0].get('Name') == name
                        and details[0].get('Driver') == 'bridge'
                        and details[0].get('Scope') == 'local'):
                    result[key] = name
            except (Unavailable, KeyError, TypeError, ValueError, AttributeError, IndexError):
                continue
        return result
    except (Unavailable, KeyError, TypeError, ValueError, AttributeError, IndexError):
        return {}
