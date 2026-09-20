import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'scripts'))
import status_io
import status_config
import status_observer as observer

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
