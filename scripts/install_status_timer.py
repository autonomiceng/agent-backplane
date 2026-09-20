#!/usr/bin/env python3
"""Install periodic status publication for one explicit Compose deployment."""

import argparse
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


def prepared_state(state_dir):
    for path, public in ((state_dir / 'status', False), (state_dir / 'console', True)):
        info = os.stat(path, follow_symlinks=False)
        mode = stat.S_IMODE(info.st_mode)
        unsafe_mode = mode != 0o755 if public else bool(mode & 0o022)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or unsafe_mode:
            raise Unavailable()


def installation(root, env_file, project, compose_files, profiles, state_dir=None, runner=run):
    if profiles is None:
        profiles = saved_settings(Path(env_file).resolve()).get('COMPOSE_PROFILES', '').split(',')
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


def install(root, env_file, project, compose_files, profiles, state_dir, unit_dir, runner=run):
    selected = installation(root, env_file, project, compose_files, profiles, state_dir, runner)
    root, env_file, project, compose_files, profiles, _, _, _, state_dir = selected
    if not (root / 'scripts/status_observer.py').is_file():
        raise Unavailable()
    contents = units(*selected)
    with directory(unit_dir, 0o700) as fd:
        for name in contents:
            regular(fd, name)
            try:
                os.stat(name, dir_fd=fd, follow_symlinks=False)
            except FileNotFoundError:
                continue
            raise Unavailable()
        written = []
        try:
            for name, contents_text in contents.items():
                handle = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                                 0o600, dir_fd=fd)
                written.append(name)
                with os.fdopen(handle, 'w', encoding='utf-8') as stream:
                    stream.write(contents_text)
                    stream.flush()
                    os.fsync(stream.fileno())
        except (OSError, UnicodeError):
            for name in written:
                os.unlink(name, dir_fd=fd)
            raise
    # Activation can partially succeed. Retain both units so the operator can inspect
    # and explicitly disable the selected timer before removing them.
    runner(['systemctl', '--user', 'daemon-reload'], timeout=10)
    runner(['systemctl', '--user', 'enable', '--now', NAME + '.timer'], timeout=10)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--checkout', required=True, type=Path)
    parser.add_argument('--env-file', required=True, type=Path)
    parser.add_argument('--compose-project', required=True)
    parser.add_argument('--compose-file', action='append', required=True)
    parser.add_argument('--profile', action='append')
    parser.add_argument('--state-dir', type=Path)
    parser.add_argument('--install', action='store_true', required=True,
                        help='write user units and enable the timer now')
    args = parser.parse_args()
    config = Path(os.environ.get('XDG_CONFIG_HOME', ''))
    if not config.is_absolute():
        config = Path.home() / '.config'
    unit_dir = config / 'systemd/user'
    try:
        install(args.checkout, args.env_file, args.compose_project, args.compose_file,
                args.profile, args.state_dir, unit_dir)
    except (OSError, UnicodeError, Unavailable):
        service = unit_dir / (NAME + '.service')
        timer = unit_dir / (NAME + '.timer')
        if service.exists() or timer.exists():
            print(f'status timer installation failed; run systemctl --user disable --now {NAME}.timer, '
                  f'then remove {service} and {timer} before retrying', file=sys.stderr)
        else:
            print('status timer installation failed; no units were written', file=sys.stderr)
        return 1
    print('Status timer enabled. An active user manager with Docker access is required; '
          'enable lingering separately for observation after logout.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
