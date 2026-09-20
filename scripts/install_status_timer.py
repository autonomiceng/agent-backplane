#!/usr/bin/env python3
"""Install periodic status publication for one explicit Compose deployment."""

import argparse
import fcntl
import os
import shutil
import stat
import sys
from pathlib import Path

from status_config import configuration, environment, saved_settings, selection
from status_io import Unavailable, directory, read_json, regular, run

NAME = 'agent-backplane-status'


def quote(value):
    """Quote one systemd command argument, including specifier expansion."""
    value = str(value)
    if any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise Unavailable()
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%').replace('$', '$$') + '"'


def docker_authority(root, runner):
    selected_env = environment()
    if selected_env.get('DOCKER_HOST') and selected_env.get('DOCKER_CONTEXT'):
        raise Unavailable()
    executable = shutil.which('docker', path=selected_env.get('PATH'))
    if not executable:
        raise Unavailable()
    executable = os.path.abspath(executable)
    contexts = read_json(runner([executable, 'context', 'inspect'], timeout=4, limit=65536,
                               cwd=root, env=selected_env))
    try:
        endpoint = contexts[0]['Endpoints']['docker']['Host']
    except (KeyError, IndexError, TypeError):
        raise Unavailable() from None
    if (not isinstance(endpoint, str) or not endpoint.startswith('unix:///')
            or selected_env.get('DOCKER_HOST') not in (None, endpoint)):
        raise Unavailable()
    security = read_json(runner([executable, 'info', '--format', '{{json .SecurityOptions}}'],
                                timeout=4, limit=65536, cwd=root, env=selected_env))
    if not isinstance(security, list) or any('rootless' in str(item) for item in security):
        raise Unavailable()
    home = selected_env.get('HOME') or str(Path.home())
    docker_config = Path(selected_env.get('DOCKER_CONFIG') or os.path.join(home, '.docker'))
    if not docker_config.is_absolute():
        docker_config = root / docker_config
    docker_config = os.path.abspath(docker_config)
    return executable, endpoint, docker_config, selected_env


def prepared_state(state_dir, *, allow_missing=False):
    for path, public in ((state_dir, False), (state_dir / 'status', False), (state_dir / 'console', True)):
        try:
            with directory(path, create=False) as fd:
                if public and stat.S_IMODE(os.fstat(fd).st_mode) != 0o755:
                    raise Unavailable()
        except FileNotFoundError:
            if not allow_missing:
                raise


def installation(root, env_file, project, compose_files, profiles, state_dir=None, runner=run):
    root, env_file, project, compose_files, profiles = selection(
        root, env_file, project, compose_files, profiles)
    if 'edge' in profiles and 'gateway' in profiles:
        raise Unavailable()
    executable, endpoint, docker_config, selected_env = docker_authority(root, runner)
    config = configuration(
        root, env_file, project, compose_files, profiles,
        lambda argv, **options: runner([executable, *argv[1:]], cwd=root,
                                      env=selected_env, **options))
    selected_state = Path(os.path.abspath(state_dir)) if state_dir else None
    if {'edge', 'gateway'} & set(profiles):
        edge = config['services'].get('edge')
        volumes = edge.get('volumes') if isinstance(edge, dict) else None
        if not isinstance(volumes, list):
            raise Unavailable()
        mounts = [volume for volume in volumes if isinstance(volume, dict)
                  and volume.get('target') == '/srv/status']
        if (len(mounts) != 1 or mounts[0].get('type') != 'bind'
                or mounts[0].get('read_only') is not True
                or not isinstance(mounts[0].get('source'), str)):
            raise Unavailable()
        public = Path(os.path.abspath(mounts[0]['source']))
        if public.name != 'console':
            raise Unavailable()
        effective_state = public.parent
        if selected_state is not None and selected_state != effective_state:
            raise Unavailable()
    else:
        if selected_state is None:
            raise Unavailable()
        effective_state = selected_state
    prepared_state(effective_state)
    return (root, env_file, project, compose_files, profiles, endpoint,
            docker_config, selected_env.get('PATH', str(Path(executable).parent)), effective_state)


def units(root, env_file, project, compose_files, profiles, endpoint,
          docker_config, search_path, state_dir):
    argv = [sys.executable, root / 'scripts/status_observer.py', '--checkout', root,
            '--env-file', env_file, '--project-name', project]
    for path in compose_files:
        argv.extend(('--compose-file', path))
    for profile in profiles:
        argv.extend(('--profile', profile))
    argv.extend(('--state-dir', state_dir))
    command = ' '.join(quote(part) for part in argv)
    service = f'''[Unit]
Description=Agent Backplane public status observation

[Service]
Type=oneshot
ExecStart={command}
Environment={quote('DOCKER_HOST=' + endpoint).replace('$$', '$')}
Environment={quote('DOCKER_CONFIG=' + docker_config).replace('$$', '$')}
Environment={quote('PATH=' + search_path).replace('$$', '$')}
UnsetEnvironment=DOCKER_CONTEXT DOCKER_TLS DOCKER_TLS_VERIFY DOCKER_CERT_PATH
TimeoutStartSec=120
UMask=0022
NoNewPrivileges=true
StandardOutput=null
StandardError=journal
'''
    timer = f'''[Unit]
Description=Refresh Agent Backplane public status observations

[Timer]
OnStartupSec=10s
OnUnitInactiveSec=30s
AccuracySec=1s
Unit={NAME}.service

[Install]
WantedBy=timers.target
'''
    return {NAME + '.service': service, NAME + '.timer': timer}


def read_pair(fd):
    names = (NAME + '.service', NAME + '.timer')
    result = {}
    for name in names:
        for drop_in in (name + '.d', name.rsplit('.', 1)[1] + '.d'):
            try:
                os.stat(drop_in, dir_fd=fd, follow_symlinks=False)
            except FileNotFoundError:
                pass
            else:
                raise Unavailable()
        regular(fd, name)
        try:
            handle = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        except FileNotFoundError:
            continue
        with os.fdopen(handle, 'rb') as stream:
            info = os.fstat(stream.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                    or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600
                    or info.st_size > 65536):
                raise Unavailable()
            result[name] = stream.read(65537)
    if result and set(result) != set(names):
        raise Unavailable()
    return result


def existing_pair(unit_dir):
    try:
        with directory(unit_dir, create=False, ancestors=True) as fd:
            return read_pair(fd)
    except FileNotFoundError:
        return {}


def manager_check(unit_dir, present, runner, *, loaded=False):
    runner(['systemctl', '--user', 'show', '--property=Version'], timeout=10)
    for name in (NAME + '.service', NAME + '.timer'):
        if not loaded:
            try:
                installed = runner(['systemctl', '--user', 'list-unit-files', name,
                                    '--no-legend', '--no-pager'], timeout=10)
                active = runner(['systemctl', '--user', 'list-units', '--all', name,
                                 '--no-legend', '--no-pager'], timeout=10)
            except Unavailable:
                # An absent unit can make enumeration exit 1; show must establish absence.
                pass
            else:
                if not installed.strip() and not active.strip():
                    continue
        evidence = runner(['systemctl', '--user', 'show', name, '--property=FragmentPath',
                           '--property=DropInPaths', '--property=LoadState'], timeout=10)
        fields = set(evidence.strip().splitlines())
        if not loaded and fields == {'FragmentPath=', 'DropInPaths=', 'LoadState=not-found'}:
            continue
        expected = {'FragmentPath=' + str(unit_dir / name), 'DropInPaths=', 'LoadState=loaded'}
        if not present or fields != expected:
            raise Unavailable()


def check_units(contents, unit_dir, runner):
    actual = existing_pair(unit_dir)
    expected = {name: text.encode('utf-8') for name, text in contents.items()}
    if actual and actual != expected:
        raise Unavailable()
    manager_check(unit_dir, bool(actual), runner)
    return actual


def activate(contents, unit_dir, runner):
    # Check the manager before creating even an absent destination. A system unit
    # with this name must never be shadowed by a new per-user installation.
    check_units(contents, unit_dir, runner)
    with directory(unit_dir, 0o700, ancestors=True) as fd:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        actual = read_pair(fd)
        expected = {name: text.encode('utf-8') for name, text in contents.items()}
        if actual and actual != expected:
            raise Unavailable()
        if not actual:
            written = []
            try:
                for name, payload in expected.items():
                    handle = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                                     0o600, dir_fd=fd)
                    written.append(name)
                    with os.fdopen(handle, 'wb') as stream:
                        os.fchmod(stream.fileno(), 0o600)
                        stream.write(payload)
                        stream.flush()
                        os.fsync(stream.fileno())
                os.fsync(fd)
            except (OSError, UnicodeError):
                for name in written:
                    os.unlink(name, dir_fd=fd)
                os.fsync(fd)
                raise
        # Retain an exact pair after partial activation; the same selection can retry.
        runner(['systemctl', '--user', 'daemon-reload'], timeout=10)
        manager_check(unit_dir, True, runner, loaded=True)
        runner(['systemctl', '--user', 'enable', '--now', NAME + '.timer'], timeout=10)
        if runner(['systemctl', '--user', 'is-enabled', NAME + '.timer'], timeout=10).strip() != 'enabled':
            raise Unavailable()
        if runner(['systemctl', '--user', 'is-active', NAME + '.timer'], timeout=10).strip() != 'active':
            raise Unavailable()


def matching_contents(selected, profiles, unit_dir):
    contents = units(*selected)
    actual = existing_pair(unit_dir)
    if not actual:
        return contents
    # Older installers preserved explicit profile order. Accept only complete
    # bytes regenerated from a validated native selection or repeated arguments.
    recorded = saved_settings(selected[1]).get('COMPOSE_PROFILES', '').split(',')
    for original in (recorded, profiles or ()):
        ordered = tuple(dict.fromkeys(profile for profile in original if profile))
        if set(ordered) != set(selected[4]):
            continue
        candidate = units(*selected[:4], ordered, *selected[5:])
        if actual == {name: text.encode('utf-8') for name, text in candidate.items()}:
            return candidate
    return contents


def check(root, env_file, project, compose_files, profiles, state_dir, unit_dir, runner=run):
    unit_dir = Path(os.path.abspath(unit_dir))
    present = existing_pair(unit_dir)
    selected = selection(root, env_file, project, compose_files, profiles, allow_missing_env=not present)
    original_profiles = profiles
    root, env_file, project, compose_files, profiles = selected
    if not (root / 'scripts/status_observer.py').is_file():
        raise Unavailable()
    if present:
        # Exact bytes include Docker authority and the effective mount. Existing
        # units require the complete owning installation, never guessed defaults.
        contents = matching_contents(installation(*selected, state_dir, runner), original_profiles, unit_dir)
        check_units(contents, unit_dir, runner)
    else:
        saved = saved_settings(env_file) if env_file.exists() else {}
        recorded_state = (env_file.parent / saved.get('BP_STATUS_DIR', 'data')).absolute()
        effective_state = Path(os.path.abspath(state_dir)) if state_dir else recorded_state
        if state_dir and 'BP_STATUS_DIR' in saved and effective_state != recorded_state:
            raise Unavailable()
        prepared_state(effective_state, allow_missing=True)
        manager_check(unit_dir, False, runner)


def install(root, env_file, project, compose_files, profiles, state_dir, unit_dir, runner=run):
    selected = installation(root, env_file, project, compose_files, profiles, state_dir, runner)
    if not (selected[0] / 'scripts/status_observer.py').is_file():
        raise Unavailable()
    unit_dir = Path(os.path.abspath(unit_dir))
    activate(matching_contents(selected, profiles, unit_dir), unit_dir, runner)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--checkout', required=True, type=Path)
    parser.add_argument('--env-file', required=True, type=Path)
    parser.add_argument('--compose-project', required=True)
    parser.add_argument('--compose-file', action='append', required=True)
    parser.add_argument('--profile', action='append')
    parser.add_argument('--state-dir', type=Path)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument('--install', action='store_true', help='install or retry this exact timer pair')
    action.add_argument('--check', action='store_true', help='check the selection and user units without writes')
    args = parser.parse_args()
    config = Path(os.environ.get('XDG_CONFIG_HOME', ''))
    if not config.is_absolute():
        config = Path.home() / '.config'
    unit_dir = config / 'systemd/user'
    try:
        action = check if args.check else install
        action(args.checkout, args.env_file, args.compose_project, args.compose_file,
               args.profile, args.state_dir, unit_dir)
        if args.check:
            return 0
    except (OSError, UnicodeError, Unavailable):
        print(f"status timer {'check' if args.check else 'installation'} failed; preserve units and retry the same selection. "
              'Foreign or partial pairs require inspection; no existing units were overwritten.', file=sys.stderr)
        return 1
    print('Status timer enabled. An active user manager with Docker access is required; '
          'enable lingering separately for observation after logout.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
