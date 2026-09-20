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


class StatusTimerTests(unittest.TestCase):
    def fixture(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name) / 'checkout %$"'
        (root / 'scripts').mkdir(parents=True)
        (root / 'scripts/status_observer.py').write_text('')
        (root / 'compose.yaml').write_text('services: {}\n')
        (root / 'compose.edge.yaml').write_text('services: {}\n')
        (root / '.env').write_text('SECRET=preserved\n')
        state = root / 'host state'
        config = {'name': 'selected_project', 'networks': {}, 'services': {'edge': {
            'volumes': [{'type': 'bind', 'source': str(state / 'console'),
                         'target': '/srv/status', 'read_only': True}]}}}
        calls = []

        def runner(argv, **options):
            calls.append((argv, options))
            if argv[:2] == ['docker', 'compose']:
                return json.dumps(config)
            return ''
        return root, state, calls, runner

    def test_exact_edge_selection_is_reconciled_and_systemd_escaped(self):
        root, state, calls, runner = self.fixture()
        with patch.dict(os.environ, {'BP_SECRET': 'leak', 'COMPOSE_FILE': 'wrong',
                                     'DOCKER_HOST': 'unix:///selected.sock'}, clear=False):
            selected = installer.installation(
                root, root / '.env', 'selected_project',
                ['compose.yaml', 'compose.edge.yaml'], ['blobs', 'edge'], None, runner)
        service = installer.units(*selected)[installer.NAME + '.service']
        compose = calls[0]
        self.assertEqual(selected[-1], state)
        self.assertEqual(compose[0], [
            'docker', 'compose', '--project-name', 'selected_project', '--project-directory', str(root),
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
        with self.assertRaises(Unavailable):
            installer.installation(root, root / '.env', 'selected_project',
                                   ['compose.yaml', 'compose.edge.yaml'], ['edge'], root / 'other', runner)

    def test_install_refuses_overwrite_cleans_pre_activation_partial_and_retains_activation_failure(self):
        root, _, _, runner = self.fixture()
        unit_dir = root / 'units'
        with self.assertRaises(Unavailable):
            def failed_activation(argv, **options):
                if argv[:2] == ['docker', 'compose']:
                    return runner(argv, **options)
                if 'enable' in argv:
                    raise Unavailable()
                return ''
            installer.install(root, root / '.env', 'selected_project',
                              ['compose.yaml', 'compose.edge.yaml'], ['edge'], None,
                              unit_dir, failed_activation)
        self.assertEqual({path.name for path in unit_dir.iterdir()},
                         {installer.NAME + '.service', installer.NAME + '.timer'})
        activation_calls = []
        with self.assertRaises(Unavailable):
            installer.install(root, root / '.env', 'selected_project',
                              ['compose.yaml', 'compose.edge.yaml'], ['edge'], None,
                              unit_dir, lambda argv, **options: activation_calls.append(argv) or runner(argv, **options))
        self.assertFalse(any(call[0] == 'systemctl' for call in activation_calls))

        partial_dir = root / 'partial-units'
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
