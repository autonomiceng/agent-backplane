"""Pure timer custody and retry tests; every external command is a fake."""
import os
import json
from pathlib import Path
import shutil
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'scripts'))
import install_status_timer as installer
from status_io import Unavailable

class FakeManager:
    def __init__(self, unit_dir):
        self.unit_dir = unit_dir
        self.calls = []
        self.foreign = ''
        self.listed = True
        self.drop_ins = ''
        self.fail_at = ''
        self.enabled = 'enabled'
        self.active = 'active'

    def __call__(self, argv, **options):
        self.calls.append(argv)
        if argv[:2] != ['systemctl', '--user']:
            raise AssertionError('unexpected external command: ' + repr(argv))
        action = argv[2]
        if action == self.fail_at:
            raise Unavailable()
        if argv[2:] == ['show', '--property=Version']:
            return 'Version=255\n'
        name = next((arg for arg in argv if arg.endswith(('.service', '.timer'))), '')
        present = bool(self.foreign) or (self.unit_dir / name).is_file()
        if action == 'list-unit-files' and not self.listed:
            return ''
        if action in ('list-unit-files', 'list-units'):
            return name + ' loaded\n' if present else ''
        if action == 'show':
            fragment = self.foreign or str(self.unit_dir / name)
            return 'FragmentPath=' + fragment + '\nDropInPaths=' + self.drop_ins + '\nLoadState=loaded\n'
        if action == 'is-enabled':
            return self.enabled
        if action == 'is-active':
            return self.active
        if action in ('daemon-reload', 'enable'):
            return ''
        raise AssertionError(argv)



class TimerRetryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.host = Path(temporary.name)
        self.root = self.host / 'checkout café %$'
        (self.root / 'scripts').mkdir(parents=True)
        self.root.chmod(0o755)
        (self.root / 'scripts').chmod(0o755)
        (self.root / 'scripts/status_observer.py').touch()
        (self.root / 'compose.yaml').touch()
        self.env = self.root / '.env'
        self.env.write_text('# fixture\n')
        self.env.chmod(0o600)
        self.unit_dir = self.host / 'config/systemd/user'
        self.manager = FakeManager(self.unit_dir)
        self.env.write_text('COMPOSE_PROJECT_NAME=selected_project\nCOMPOSE_FILE=compose.yaml:compose.gateway.yaml\nCOMPOSE_PROFILES=blobs,compute,gateway\n')
        (self.root / 'compose.gateway.yaml').touch()
        self.state = self.root / 'data'
        (self.state / 'status').mkdir(parents=True, mode=0o700)
        (self.state / 'console').mkdir(mode=0o755)
        self.state.chmod(0o755)
        self.addCleanup(patch.stopall)
        patch.dict(os.environ, {'HOME': str(self.host), 'PATH': '/usr/bin'}, clear=True).start()
        patch.object(installer.shutil, 'which', return_value='/fixture/docker').start()

    def runner(self, argv, **options):
        if argv[0] == 'systemctl':
            return self.manager(argv, **options)
        if argv[1:3] == ['context', 'inspect']:
            return json.dumps([{'Endpoints': {'docker': {'Host': 'unix:///fixture.sock'}}}])
        if argv[1:3] == ['info', '--format']:
            return '[]'
        if argv[1] == 'compose':
            return json.dumps({'name': 'selected_project', 'networks': {}, 'services': {'edge': {
                'volumes': [{'type': 'bind', 'source': str(self.state / 'console'),
                             'target': '/srv/status', 'read_only': True}]}}})
        raise AssertionError(argv)

    def invoke(self, *, check=False, **options):
        action = installer.check if check else installer.install
        return action(self.root, self.env, options.get('project', 'selected_project'),
                      options.get('files', ['compose.yaml', 'compose.gateway.yaml']),
                      options.get('profiles'), options.get('state_dir'), self.unit_dir, self.runner)

    def snapshot(self):
        result = {}
        for path in self.host.rglob('*'):
            info = path.lstat()
            contents = path.read_bytes() if stat.S_ISREG(info.st_mode) else str(path.readlink()) if path.is_symlink() else None
            result[str(path)] = (info.st_mode, info.st_ino, info.st_mtime_ns, contents)
        return result

    def test_fresh_check_creates_no_directories_units_or_private_copies(self):
        self.env.unlink()
        shutil.rmtree(self.state)
        before = self.snapshot()
        self.invoke(check=True)
        self.assertEqual(self.snapshot(), before)
        self.assertFalse(self.unit_dir.exists())
        original_check = installer.check
        argv = ['install_status_timer.py', '--check', '--checkout', str(self.root), '--env-file', str(self.env)]
        argv += ['--compose-project', 'selected_project', '--compose-file', 'compose.yaml', '--compose-file', 'compose.gateway.yaml']
        with patch.object(sys, 'argv', argv), patch.dict(os.environ, {'XDG_CONFIG_HOME': str(self.host / 'config')}), \
                patch.object(installer, 'check', side_effect=lambda *args: original_check(*args, runner=self.runner)):
            self.assertEqual(installer.main(), 0)
        self.assertEqual(self.snapshot(), before)
        self.assertTrue(self.manager.calls)
        self.assertTrue(all(call[2] in {'show', 'list-unit-files', 'list-units'} for call in self.manager.calls))
        # A successful preflight is not permission to install without the owning env.
        with self.assertRaises((OSError, Unavailable)):
            self.invoke()
        self.assertEqual(self.snapshot(), before)
        self.env.symlink_to(self.root / 'missing-env')
        before = self.snapshot()
        with self.assertRaises((OSError, Unavailable)):
            self.invoke(check=True)
        self.assertEqual(self.snapshot(), before)

    def test_exact_pair_retries_partial_activation_without_rewriting(self):
        for failure in ('enable', 'is-active'):
            with self.subTest(failure=failure):
                self.manager.fail_at = failure
                with self.assertRaises(Unavailable):
                    self.invoke()
                before = self.snapshot()
                self.manager.fail_at = ''
                self.manager.calls.clear()
                self.invoke(check=True)
                self.assertEqual(self.snapshot(), before)
                self.invoke()
                self.assertEqual(self.snapshot(), before)
                self.assertEqual(self.manager.calls[-2:], [
                    ['systemctl', '--user', 'is-enabled', installer.NAME + '.timer'],
                    ['systemctl', '--user', 'is-active', installer.NAME + '.timer']])
        self.manager.enabled = 'static'
        before = self.snapshot()
        with self.assertRaises(Unavailable):
            self.invoke()
        self.assertEqual(self.snapshot(), before)

    def test_foreign_manager_units_and_unsafe_or_partial_pairs_refuse_without_writes(self):
        for foreign, drop_ins, failure in (('/usr/lib/systemd/user/' + installer.NAME + '.service', '', ''),
                                          ('/run/user/' + installer.NAME + '.service', '/run/user/override.conf', ''),
                                          ('', '', 'show')):
            with self.subTest(foreign=foreign, failure=failure):
                self.manager.foreign, self.manager.drop_ins, self.manager.fail_at = foreign, drop_ins, failure
                self.manager.listed = not foreign.startswith('/run/')
                before = self.snapshot()
                for check in (True, False):
                    with self.assertRaises(Unavailable):
                        self.invoke(check=check)
                    self.assertEqual(self.snapshot(), before)
                self.assertFalse(self.unit_dir.exists())
        self.manager.foreign = self.manager.drop_ins = self.manager.fail_at = ''
        self.manager.listed = True
        self.invoke()
        service = self.unit_dir / (installer.NAME + '.service')
        original = service.read_bytes()
        for case in ('foreign-selection', 'malformed', 'partial', 'symlink', 'hardlink', 'fifo', 'mode', 'drop-in', 'manager-drop-in'):
            with self.subTest(case=case):
                extra = self.unit_dir / (service.name + '.d')
                other = self.host / 'other'
                if case == 'foreign-selection':
                    service.write_bytes(original.replace(installer.quote(self.env).encode(), b'"/foreign/.env"'))
                elif case == 'malformed':
                    service.write_bytes(original + b'Unexpected=directive\n')
                elif case == 'partial':
                    service.unlink()
                elif case == 'symlink':
                    service.unlink()
                    service.symlink_to(self.env)
                elif case == 'hardlink':
                    os.link(service, other)
                elif case == 'fifo':
                    service.unlink()
                    os.mkfifo(service, 0o600)
                elif case == 'mode':
                    service.chmod(0o644)
                elif case == 'drop-in':
                    extra.mkdir()
                else:
                    self.manager.drop_ins = '/run/user/override.conf'
                before = self.snapshot()
                for check in (True, False):
                    with self.assertRaises((OSError, Unavailable)):
                        self.invoke(check=check)
                    self.assertEqual(self.snapshot(), before)
                self.manager.drop_ins = ''
                if extra.exists():
                    extra.rmdir()
                other.unlink(missing_ok=True)
                service.unlink(missing_ok=True)
                service.write_bytes(original)
                service.chmod(0o600)
        for case in ('symlink-parent', 'writable-parent'):
            with self.subTest(case=case):
                real = self.unit_dir
                self.unit_dir = self.host / 'unsafe'
                if case == 'symlink-parent':
                    self.unit_dir.symlink_to(real, target_is_directory=True)
                else:
                    self.unit_dir.mkdir()
                    self.unit_dir.chmod(0o777)
                    self.unit_dir = self.unit_dir / 'missing'
                before = self.snapshot()
                for check in (True, False):
                    with self.assertRaises((OSError, Unavailable)):
                        self.invoke(check=check)
                    self.assertEqual(self.snapshot(), before)
                self.unit_dir = real
                unsafe = self.host / 'unsafe'
                unsafe.unlink() if unsafe.is_symlink() else unsafe.rmdir()

    def test_recorded_selection_and_fresh_state_boundary_preserve_old_explicit_units(self):
        explicit = ['blobs', 'compute', 'gateway']
        self.invoke(profiles=explicit)
        before = self.snapshot()
        self.invoke()
        self.invoke(check=True)
        self.assertEqual(self.snapshot(), before)
        for options in ({'profiles': []}, {'profiles': ['compute']}, {'project': 'foreign'},
                        {'files': ['compose.gateway.yaml', 'compose.yaml']}, {'state_dir': self.root / 'other'}):
            with self.subTest(options=options):
                for check in (True, False):
                    with self.assertRaises(Unavailable):
                        self.invoke(check=check, **options)
                    self.assertEqual(self.snapshot(), before)
        # An older explicit order still matches recorded capabilities and must not
        # require rewriting the original private units to the new canonical order.
        original_profiles = ['gateway', 'compute', 'blobs']
        self.env.write_text(self.env.read_text().replace('blobs,compute,gateway', ','.join(original_profiles)))
        selected = installer.installation(self.root, self.env, 'selected_project',
                                          ['compose.yaml', 'compose.gateway.yaml'], None, None, self.runner)
        legacy = installer.units(*selected[:4], original_profiles, *selected[5:])
        for name, text in legacy.items():
            (self.unit_dir / name).write_text(text)
        before = self.snapshot()
        self.invoke(check=True)
        self.invoke()
        self.invoke(profiles=original_profiles)
        self.assertEqual(self.snapshot(), before)
        shutil.rmtree(self.unit_dir)
        shutil.rmtree(self.state)
        before = self.snapshot()
        self.invoke(check=True)
        self.assertEqual(self.snapshot(), before)
        with self.assertRaises((OSError, Unavailable)):
            self.invoke()
        self.assertEqual(self.snapshot(), before)
        (self.state / 'console').mkdir(parents=True, mode=0o700)
        self.state.chmod(0o755)
        with self.assertRaises(Unavailable):
            self.invoke(check=True)
        (self.state / 'console').chmod(0o755)
        self.invoke(check=True)
        (self.state / 'status').symlink_to(self.state / 'console')
        with self.assertRaises((OSError, Unavailable)):
            self.invoke(check=True)
