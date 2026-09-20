"""Pure installation tests. No systemd or Docker mutation."""

import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'scripts'))
import install_status_timer as installer
from status_io import Unavailable
from test_status_timer_retry import FakeManager


class StatusTimerTests(unittest.TestCase):
    def fixture(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name) / 'checkout %$"'
        (root / 'scripts').mkdir(parents=True)
        root.chmod(0o755)
        (root / 'scripts/status_observer.py').write_text('')
        (root / 'compose.yaml').write_text('services: {}\n')
        (root / 'compose.edge.yaml').write_text('services: {}\n')
        (root / '.env').write_text('SECRET=preserved\n')
        state = root / 'host state'
        (state / 'status').mkdir(parents=True, mode=0o700)
        (state / 'console').mkdir(mode=0o755)
        state.chmod(0o755)
        config = {'name': 'selected_project', 'networks': {}, 'services': {'edge': {
            'volumes': [{'type': 'bind', 'source': str(state / 'console'),
                         'target': '/srv/status', 'read_only': True}]}}}
        calls = []

        def runner(argv, **options):
            calls.append((argv, options))
            if argv[0] == 'systemctl':
                return runner.manager(argv, **options)
            if argv[1:3] == ['context', 'inspect']:
                return json.dumps([{'Endpoints': {'docker': {'Host': 'unix:///selected.sock'}}}])
            if argv[1:3] == ['info', '--format']:
                return '[]'
            if argv[1] == 'compose':
                return json.dumps(config)
            return ''
        runner.manager = FakeManager(root / 'units')
        return root, state, calls, runner

    def test_exact_edge_selection_is_reconciled_and_systemd_escaped(self):
        root, state, calls, runner = self.fixture()
        selected_environment = {'PATH': '/selected/bin:/usr/bin', 'HOME': str(root),
                                'DOCKER_CONTEXT': 'selected', 'DOCKER_CONFIG': str(root / 'docker config'),
                                'DOCKER_TLS_VERIFY': '1', 'BP_SECRET': 'leak', 'COMPOSE_FILE': 'wrong'}
        with patch.dict(os.environ, selected_environment, clear=True), \
                patch.object(installer.shutil, 'which', return_value='/selected/bin/docker'):
            selected = installer.installation(root, root / '.env', 'selected_project',
                                              ['compose.yaml', 'compose.edge.yaml'],
                                              ['blobs', 'edge'], None, runner)
        service = installer.units(*selected)[installer.NAME + '.service']
        compose = next(call for call in calls if call[0][1] == 'compose')
        self.assertEqual(selected[-1], state)
        self.assertEqual(compose[0], [
            '/selected/bin/docker', 'compose', '--project-name', 'selected_project', '--project-directory', str(root),
            '--env-file', str(root / '.env'), '-f', str(root / 'compose.yaml'),
            '-f', str(root / 'compose.edge.yaml'), '--profile', 'blobs', '--profile', 'edge',
            'config', '--format', 'json'])
        self.assertNotIn('BP_SECRET', compose[1]['env'])
        self.assertNotIn('COMPOSE_FILE', compose[1]['env'])
        self.assertIn('TimeoutStartSec=120', service)
        self.assertIn('OnUnitInactiveSec=30s', installer.units(*selected)[installer.NAME + '.timer'])
        self.assertIn('%%', service)
        self.assertIn('$$', service)
        self.assertIn('\\"', service)
        self.assertIn('Environment="DOCKER_HOST=unix:///selected.sock"', service)
        config_line = next(line for line in service.splitlines() if line.startswith('Environment="DOCKER_CONFIG='))
        self.assertIn('%%$', config_line)
        self.assertNotIn('$$', config_line)
        self.assertIn('Environment="PATH=/selected/bin:/usr/bin"', service)
        self.assertIn('UnsetEnvironment=DOCKER_CONTEXT DOCKER_TLS DOCKER_TLS_VERIFY DOCKER_CERT_PATH', service)
        with patch.dict(os.environ, selected_environment, clear=True), \
                patch.object(installer.shutil, 'which', return_value='/selected/bin/docker'):
            with self.assertRaises(Unavailable):
                installer.installation(root, root / '.env', 'selected_project',
                                       ['compose.yaml', 'compose.edge.yaml'], ['edge'], root / 'other', runner)
            with self.assertRaises(Unavailable):
                installer.installation(root, root / '.env', 'selected_project',
                                       ['compose.yaml'], [], None, runner)
            core = installer.installation(root, root / '.env', 'selected_project',
                                          ['compose.yaml'], [], state, runner)
            self.assertEqual(core[-1], state)
            (state / 'console').chmod(0o700)
            with self.assertRaises(Unavailable):
                installer.installation(root, root / '.env', 'selected_project',
                                       ['compose.yaml'], [], state, runner)
            (state / 'console').chmod(0o755)
            (state / 'status').rmdir()
            with self.assertRaises(OSError):
                installer.installation(root, root / '.env', 'selected_project',
                                       ['compose.yaml'], [], state, runner)
            (state / 'status').mkdir(mode=0o700)
            def rootless(argv, **options):
                if argv[1:3] == ['info', '--format']:
                    return json.dumps(['name=rootless'])
                return runner(argv, **options)
            with self.assertRaises(Unavailable):
                installer.installation(root, root / '.env', 'selected_project',
                                       ['compose.yaml'], [], state, rootless)
        conflict = {**selected_environment, 'DOCKER_HOST': 'unix:///other.sock'}
        with patch.dict(os.environ, conflict, clear=True), \
                patch.object(installer.shutil, 'which', return_value='/selected/bin/docker'), \
                self.assertRaises(Unavailable):
            installer.installation(root, root / '.env', 'selected_project',
                                   ['compose.yaml'], [], state, runner)

        (root / '.env').write_text("COMPOSE_PROFILES='blobs,edge'\n")
        install = installer.install
        unit_config = root / 'user-config'
        runner.manager.unit_dir = unit_config / 'systemd/user'
        argv = ['install_status_timer.py', '--install', '--checkout', str(root),
                '--env-file', str(root / '.env'), '--compose-project', 'selected_project',
                '--compose-file', 'compose.yaml', '--compose-file', 'compose.edge.yaml']
        with patch.dict(os.environ, {**selected_environment, 'XDG_CONFIG_HOME': str(unit_config)}, clear=True), \
                patch.object(installer.shutil, 'which', return_value='/selected/bin/docker'), \
                patch.object(sys, 'argv', argv), \
                patch.object(installer, 'install', side_effect=lambda *args: install(*args, runner=runner)):
            self.assertEqual(installer.main(), 0)
        inherited = (unit_config / 'systemd/user' / (installer.NAME + '.service')).read_text()
        self.assertIn('"--profile" "blobs" "--profile" "edge"', inherited)
        self.assertIn('"--state-dir" ' + installer.quote(state), inherited)

    def test_install_refuses_overwrite_cleans_pre_activation_partial_and_retains_activation_failure(self):
        root, _, _, runner = self.fixture()
        environment = patch.dict(os.environ, {'PATH': '/usr/bin', 'HOME': str(root)}, clear=True)
        executable = patch.object(installer.shutil, 'which', return_value='/selected/bin/docker')
        environment.start()
        executable.start()
        self.addCleanup(environment.stop)
        self.addCleanup(executable.stop)
        unit_dir = root / 'units'
        with self.assertRaises(Unavailable):
            def failed_activation(argv, **options):
                if argv[0].endswith('/docker'):
                    return runner(argv, **options)
                if 'enable' in argv:
                    raise Unavailable()
                return runner(argv, **options)
            installer.install(root, root / '.env', 'selected_project',
                              ['compose.yaml', 'compose.edge.yaml'], ['edge'], None,
                              unit_dir, failed_activation)
        self.assertEqual({path.name for path in unit_dir.iterdir()},
                         {installer.NAME + '.service', installer.NAME + '.timer'})
        activation_calls = []
        before = {path: (path.read_bytes(), path.stat().st_mtime_ns) for path in unit_dir.iterdir()}
        installer.install(root, root / '.env', 'selected_project',
                          ['compose.yaml', 'compose.edge.yaml'], ['edge'], None,
                          unit_dir, lambda argv, **options: activation_calls.append(argv) or runner(argv, **options))
        self.assertEqual(before, {path: (path.read_bytes(), path.stat().st_mtime_ns) for path in unit_dir.iterdir()})

        self.assertIn(['systemctl', '--user', 'daemon-reload'], activation_calls)

        partial_dir = root / 'partial-units'
        runner.manager.unit_dir = partial_dir
        original_open = installer.os.open
        def fail_timer(path, flags, *args, **kwargs):
            if path == installer.NAME + '.timer' and flags & os.O_CREAT:
                raise OSError()
            return original_open(path, flags, *args, **kwargs)
        with patch.object(installer.os, 'open', side_effect=fail_timer), self.assertRaises(OSError):
            installer.install(root, root / '.env', 'selected_project',
                              ['compose.yaml', 'compose.edge.yaml'], ['edge'], None,
                              partial_dir, runner)
        self.assertEqual(list(partial_dir.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
