import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'scripts'))
import status_io
import status_config
import status_observer as observer
import install_status_timer as installer

AT = '2026-09-20T12:00:00Z'
OLD = '2026-09-20T11:57:59Z'
CONTAINER = 'a' * 64
IMAGE = 'sha256:' + 'b' * 64


def config(project='agent-backplane', token='SECRET-seed'):
    return {'name': project, 'networks': {'default': {'name': project + '_default'}}, 'services': {
        'server': {'image': 'agent-backplane-server:private-tag', 'environment': {
            'BP_OPERATIONS_TOKEN': token}},
        'postgres': {'image': 'postgres:18.6@sha256:' + 'c' * 64},
        'migrate': {}, 'data-init': {},
    }}


class StatusObserverTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / '.env').write_text('BP_AUTH_SECRET=private\n')
        (self.root / 'compose.yaml').write_text('name: agent-backplane\nservices: {}\n')

    def test_bootstrap_record_binds_saved_project_ordered_overlays_and_profiles(self):
        selected = self.root / 'selected'
        selected.mkdir()
        env_file = selected / '.env'
        overlay = selected / 'custom.yaml'
        overlay.write_text('services: {}\n')
        env_file.write_text("COMPOSE_PROJECT_NAME=original\n"
                            "COMPOSE_FILE='../compose.yaml:custom.yaml'\n"
                            "COMPOSE_PROFILES=blobs,compute\nBP_STATUS_DIR=data\n")
        state = selected / 'data'
        command = [sys.executable, str(Path(observer.__file__).with_name('record_status.py')),
                   '--state-dir', str(state), '--checkout', str(self.root),
                   '--env-file', str(env_file), '--started', AT, '--state', 'healthy']
        subprocess.run(command, check=True, capture_output=True)
        record = status_io.read_task(state, self.root, env_file)
        self.assertEqual(record['selection'], {'project': 'original',
                         'composeFiles': [str(self.root / 'compose.yaml'), str(overlay)],
                         'profiles': ['blobs', 'compute']})
        subprocess.run([*command, '--project-name', 'original',
                        '--compose-file', str(self.root / 'compose.yaml'),
                        '--compose-file', str(overlay), '--profile', 'compute', '--profile', 'blobs'],
                       check=True, capture_output=True)
        self.assertEqual(status_io.read_task(state, self.root, env_file), record)
        def runner(argv, **_options):
            return json.dumps(config('original')) if 'config' in argv else ''
        document = observer.observe(self.root, env_file=env_file, runner=runner, clock=lambda: AT)
        bootstrap = next(row for row in document['components'] if row['id'] == 'bootstrap')
        self.assertEqual((bootstrap['state'], bootstrap['lastExecutionAt']), ('healthy', AT))
        self.assertNotIn('selection', json.dumps(document))
        self.assertEqual(json.loads((state / 'console/status.json').read_text()), document)

    def test_bootstrap_health_from_different_overlay_order_is_refused(self):
        first, last = self.root / 'first.yaml', self.root / 'last.yaml'
        first.write_text('services: {}\n')
        last.write_text('services: {}\n')
        files = [str(self.root / 'compose.yaml'), str(first), str(last)]
        (self.root / '.env').write_text(f"COMPOSE_FILE={':'.join(files)}\nCOMPOSE_PROFILES=\n")
        status_io.task_record(self.root / 'data', self.root, self.root / '.env', AT, 'healthy',
                              {'project': 'agent-backplane', 'composeFiles': [files[0], files[2], files[1]],
                               'profiles': []})
        def runner(argv, **_options):
            return json.dumps(config()) if 'config' in argv else ''
        document = observer.observe(self.root, runner=runner, clock=lambda: AT)
        bootstrap = next(row for row in document['components'] if row['id'] == 'bootstrap')
        self.assertEqual((bootstrap['configured'], bootstrap['state'], bootstrap['lastExecutionAt']),
                         (True, 'unknown', None))
        self.assertEqual(document['configurationObservedAt'], AT)

    def test_saved_empty_profiles_remain_empty_in_bare_observer_and_existing_timer(self):
        env_file = self.root / '.env'
        env_file.write_text('COMPOSE_PROJECT_NAME=agent-backplane\nCOMPOSE_FILE=compose.yaml\n'
                            "COMPOSE_PROFILES=''\n")
        bare = status_config.selection(self.root)
        self.assertEqual(bare[-1], ())
        service = installer.units(*bare, 'unix:///selected.sock', str(self.root / 'docker'),
                                  '/usr/bin', self.root / 'data')[installer.NAME + '.service']
        self.assertNotIn('--profile', service)
        explicit = status_config.selection(self.root, env_file, 'agent-backplane', ['compose.yaml'], [''])
        self.assertEqual(explicit, bare)
        def runner(argv, **options):
            effective_profiles = options['env'].get('COMPOSE_PROFILES', '')
            rendered = config()
            if effective_profiles:
                rendered['services']['workerd'] = {}
            return json.dumps(rendered) if 'config' in argv else ''
        with patch.dict('os.environ', {'COMPOSE_PROFILES': 'compute'}, clear=False):
            document = observer.observe(self.root, project='agent-backplane',
                                        compose_files=['compose.yaml'], runner=runner, clock=lambda: AT)
        functions = next(row for row in document['components'] if row['id'] == 'functions')
        self.assertEqual((functions['configured'], functions['state']), (False, 'disabled'))
        env_file.write_text(env_file.read_text().replace("COMPOSE_PROFILES=''", 'COMPOSE_PROFILES=compute'))
        with self.assertRaises(status_io.Unavailable):
            status_config.selection(self.root, profiles=[''])

    def test_explicit_custody_wrong_project_and_malformed_evidence_publish_unknown(self):
        calls = []
        def runner(argv, **options):
            calls.append((argv, options))
            return json.dumps(config('other-project'))
        with patch.dict('os.environ', {'COMPOSE_FILE': '/private/override',
                                       'BP_AUTH_SECRET': 'shell-secret'}, clear=False):
            document = observer.observe(self.root, project='selected-project', runner=runner,
                                        clock=lambda: AT)
        self.assertIsNone(document['configurationObservedAt'])
        self.assertTrue(all(row['state'] == 'unknown' for row in document['components']))
        argv, options = calls[0]
        self.assertEqual(argv[:8], ['docker', 'compose', '--project-name', 'selected-project',
                                   '--project-directory', str(self.root.resolve()), '--env-file',
                                   str((self.root / '.env').resolve())])
        self.assertIn(str((self.root / 'compose.yaml').resolve()), argv)
        self.assertNotIn('COMPOSE_FILE', options['env'])
        self.assertNotIn('BP_AUTH_SECRET', options['env'])
        self.assertEqual(json.loads((self.root / 'data/console/status.json').read_text()), document)

        budget_calls = []
        def budget_runner(argv, **options):
            budget_calls.append((argv, options))
            return json.dumps(config())
        with patch.object(observer.time, 'monotonic', side_effect=(0, 1, 91)):
            bounded = observer.observe(self.root, runner=budget_runner, clock=lambda: AT)
        self.assertEqual(len(budget_calls), 1)
        self.assertEqual(budget_calls[0][1]['timeout'], 10)
        self.assertEqual({row['id']: row for row in bounded['components']}['server']['state'],
                         'unknown')

        network_config = config()
        network_config['networks'] = {
            'missing': {'name': 'missing-network'},
            'invalid': {'name': '--secret-option'},
            'default': {'name': 'selected_default'},
        }
        network_calls = []
        def network_runner(argv, **_options):
            network_calls.append(argv)
            if argv[:3] == ['docker', 'context', 'inspect']:
                return json.dumps([{'Endpoints': {'docker': {'Host': 'unix:///var/run/docker.sock'}}}])
            if argv[:3] == ['docker', 'info', '--format']:
                return '[]'
            if argv[-1] == 'missing-network':
                raise status_io.Unavailable()
            return json.dumps([{'Name': argv[-1], 'Driver': 'bridge', 'Scope': 'local'}])
        self.assertEqual(status_config.local_bridges(network_config, network_runner, {}),
                         {'default': 'selected_default'})
        inspected = [call[-1] for call in network_calls if call[:3] == ['docker', 'network', 'inspect']]
        self.assertEqual(inspected, ['missing-network', 'selected_default'])
        self.assertNotIn('--secret-option', inspected)

        with patch.object(observer, 'configuration', return_value=config()), \
             patch.object(observer, 'inventory', side_effect=status_io.Unavailable):
            malformed = observer.collect(self.root, self.root / '.env', 'agent-backplane',
                                         (self.root / 'compose.yaml',), (), self.root / 'data',
                                         lambda *_args, **_options: '', lambda: AT)
        by_id = {row['id']: row for row in malformed['components']}
        self.assertEqual(by_id['server']['state'], 'unknown')
        self.assertEqual(by_id['server']['configured'], True)

    def test_disabled_stopped_health_version_and_task_clocks(self):
        rows = {name: observer.empty(name) for name in
                (*observer.SERVICES, *observer.CAPABILITIES, *observer.TASKS)}
        observer.configure_rows(rows, config(), AT,
                                {'files': 'filesystem', 'functions': 'disabled', 'caddy': 'disabled'})
        for component in ('caddy', 'rustfs', 'workerd', 'functions', 'blob-bootstrap'):
            self.assertEqual((rows[component]['configured'], rows[component]['state'],
                              rows[component]['observedAt']), (False, 'disabled', AT))

        def inspected(service, state):
            return {'Id': CONTAINER, 'Image': IMAGE,
                    'Config': {'Labels': {'com.docker.compose.project': 'agent-backplane',
                                          'com.docker.compose.service': service,
                                          'com.docker.compose.oneoff': 'false'}},
                    'State': state, 'NetworkSettings': {'Networks': {}}}
        stopped_doc = inspected('postgres', {'Status': 'exited', 'Paused': False})
        stopped = observer.observe_component('postgres', [CONTAINER], config(), AT, {},
                                             lambda *_args, **_options: json.dumps([stopped_doc]),
                                             lambda: AT)
        self.assertEqual((stopped['state'], stopped['observedAt'], stopped['observedImageId']),
                         ('unavailable', AT, IMAGE))

        edge_config = config()
        edge_config['services']['edge'] = {'image': 'caddy:2.11.4', 'networks': {'default': {}}}
        healthy_doc = inspected('edge', {'Status': 'running', 'Paused': False,
                                         'StartedAt': '2026-09-20T11:59:00Z'})
        healthy_doc['NetworkSettings']['Networks']['agent-backplane_default'] = {'IPAddress': '172.20.0.4'}
        with patch.object(observer, 'probe', return_value=('healthy', '2.11.4')):
            healthy = observer.observe_component('caddy', [CONTAINER], edge_config, AT,
                                                 {'default': 'agent-backplane_default'},
                                                 lambda *_args, **_options: json.dumps([healthy_doc]),
                                                 lambda: AT)
        self.assertEqual((healthy['state'], healthy['observedVersion'], healthy['observedAt']),
                         ('healthy', '2.11.4', AT))

        task_config = config()
        task = inspected('migrate', {'Status': 'exited', 'Paused': False, 'ExitCode': 0,
                                     'StartedAt': '2026-09-20T11:50:00Z',
                                     'FinishedAt': '2026-09-20T11:50:03Z'})
        historical = observer.observe_component('migrate', [CONTAINER], task_config, AT, {},
                                                lambda *_args, **_options: json.dumps([task]),
                                                lambda: AT)
        self.assertEqual((historical['state'], historical['observedAt'], historical['lastExecutionAt']),
                         ('healthy', AT, '2026-09-20T11:50:00Z'))
        missing = observer.observe_component('migrate', [], task_config, AT, {},
                                             lambda *_args, **_options: '', lambda: AT)
        self.assertEqual((missing['state'], missing['lastExecutionAt']), ('unknown', None))

    def test_capability_allowlist_expiry_and_failed_refresh_do_not_reuse_health(self):
        current = {'files': {'state': 'healthy', 'observedAt': AT, 'backend': 'filesystem',
                             'workspaceId': 'private-workspace', 'credential': 'private-capability'},
                   'functions': {'state': 'disabled', 'observedAt': None, 'backend': None}}
        expired = {'files': {'state': 'healthy', 'observedAt': OLD, 'backend': 'filesystem'},
                   'functions': current['functions']}
        unavailable = {'files': {'state': 'unavailable', 'observedAt': AT, 'backend': None},
                       'functions': current['functions']}
        capability_results = [current, unavailable, expired, status_io.Unavailable()]

        def capability_sample(*_args):
            result = capability_results.pop(0)
            if isinstance(result, Exception):
                raise result
            return result

        documents = []
        with patch.object(observer, 'configuration', return_value=config()), \
             patch.object(observer, 'inventory', return_value={'server': [CONTAINER]}), \
             patch.object(observer, 'local_bridges', return_value={}), \
             patch.object(observer, 'observe_component', side_effect=lambda name, *_args: observer.empty(name)), \
             patch.object(observer, 'capabilities', side_effect=capability_sample):
            for _ in range(4):
                documents.append(observer.collect(
                    self.root, self.root / '.env', 'agent-backplane',
                    (self.root / 'compose.yaml',), (), self.root / 'data',
                    lambda *_args, **_options: '', lambda: AT))
        states = [{row['id']: row for row in doc['components']}['files']['state']
                  for doc in documents]
        self.assertEqual(states, ['healthy', 'unavailable', 'unknown', 'unknown'])
        expired_row = {row['id']: row for row in documents[2]['components']}['files']
        self.assertEqual(expired_row['observedAt'], OLD)
        public = json.dumps(documents)
        for private in ('SECRET-seed', 'private-tag', 'private-workspace', 'private-capability',
                        str(self.root), 'BP_OPERATIONS_TOKEN'):
            self.assertNotIn(private, public)
