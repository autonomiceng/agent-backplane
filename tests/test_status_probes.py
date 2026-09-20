from pathlib import Path
import json
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'scripts'))
import status_io
import status_probes as probes


class StatusProbeTests(unittest.TestCase):
    def test_primary_version_sources_and_private_operations_projection(self):
        calls = []
        outputs = {
            'caddy': 'v2.11.4 h1:private-build-hash\n',
            'rustfs': 'rustfs 1.0.0\n',
            'workerd': 'workerd 2026-09-18\n',
        }
        def workerd_runner(argv, **_options):
            calls.append(argv)
            return outputs['workerd']
        self.assertEqual(probes.probe('workerd', 'container', None, workerd_runner),
                         ('unknown', '2026-09-18'))
        self.assertEqual(probes.probe(
            'workerd', 'container', None,
            lambda *_args, **_options: (_ for _ in ()).throw(status_io.Unavailable())),
            ('unknown', None))
        for service in ('caddy', 'rustfs'):
            responses = iter([json.dumps([200, '']), outputs[service]])
            self.assertEqual(probes.probe(service, 'container', '172.20.0.3',
                                          lambda *_args, **_options: next(responses)),
                             ('healthy', '2.11.4' if service == 'caddy' else '1.0.0'))

        def capability_runner(argv, **_options):
            calls.append(argv)
            return json.dumps({'capabilities': {
                'files': {'state': 'healthy', 'observedAt': '2026-09-20T12:00:00Z',
                          'backend': 'filesystem'},
                'functions': {'state': 'disabled', 'observedAt': None, 'backend': None}}})
        projected = probes.capabilities('container', capability_runner)
        self.assertEqual(set(projected), {'files', 'functions'})
        flattened = '\n'.join(' '.join(call) for call in calls)
        self.assertNotIn('operator-secret-value', flattened)
        self.assertIn('process.env.BP_OPERATIONS_TOKEN', flattened)
        self.assertNotIn('Bun.version', flattened)
        self.assertEqual(probes.configured_image('server', 'server:private@sha256:' + 'a' * 64),
                         {'configuredDigest': 'sha256:' + 'a' * 64})
        self.assertEqual(probes.configured_image('caddy', 'caddy:customer-private'),
                         {'configuredVersion': 'custom'})
