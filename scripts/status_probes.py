"""Bounded Backplane runtime probes with service-specific public parsers."""

import ipaddress
import json
import re
import sys
from http.client import HTTPConnection, HTTPException
from pathlib import Path

from status_io import Unavailable, Unsupported, read_json, run

SEMVER = r'\d{1,4}\.\d{1,8}\.\d{1,4}'
PATTERNS = {
    'postgres': r'(\d{1,3}\.\d{1,3})(?:-(?:alpine(?:\d+\.\d+)?|bookworm|trixie))?',
    'caddy': rf'v?({SEMVER})(?:-alpine)?',
    'rustfs': rf'v?({SEMVER})',
    'workerd': r'(20\d{2}-\d{2}-\d{2})',
}
CONFIGURED_PATTERNS = {**PATTERNS, 'workerd': r'(1\.\d{8}\.\d{1,4})'}


def version(service, value):
    if not isinstance(value, str):
        return None
    match = re.fullmatch(PATTERNS[service], value, re.ASCII)
    return match[1] if match else None


def configured_image(service, image):
    if not isinstance(image, str):
        return {}
    reference, separator, digest = image.partition('@')
    result = {}
    if service in PATTERNS:
        tag = reference.rsplit('/', 1)[-1].partition(':')[2]
        if tag:
            match = re.fullmatch(CONFIGURED_PATTERNS[service], tag, re.ASCII)
            result['configuredVersion'] = match[1] if match else 'custom'
    if separator and re.fullmatch(r'sha256:[0-9a-f]{64}', digest):
        result['configuredDigest'] = digest
    return result


def http(ip, port, path, runner):
    ipaddress.ip_address(ip)
    text = runner([sys.executable, str(Path(__file__).resolve()), ip, str(port), path],
                  timeout=4, limit=131072)
    response = read_json(text, 131072)
    if (not isinstance(response, list) or len(response) != 2
            or type(response[0]) is not int or not isinstance(response[1], str)):
        raise Unavailable()
    if response[0] in (401, 403, 404):
        return None
    if response[0] != 200:
        raise Unavailable()
    return response[1]


def execute(container, command, runner):
    # The in-container deadline remains effective if the Docker client is terminated.
    return runner(['docker', 'exec', container, 'timeout', '-s', 'KILL', '3', *command],
                  timeout=4, limit=65536)


def readiness(service, container, ip, runner):
    if service == 'postgres':
        text = execute(container, ['sh', '-ec',
                       'export PGCONNECT_TIMEOUT=2 PGOPTIONS="-c statement_timeout=2000"; '
                       'exec psql -X -w -h /var/run/postgresql -p 5432 -U postgres '
                       '-d backplane -Atqc "SHOW server_version"'], runner).strip()
        release = version(service, text.split(' ', 1)[0])
        if not release:
            return 'unknown', None
        return 'healthy', release
    if service == 'workerd':
        try:
            text = execute(container, ['workerd', '--version'], runner).strip()
        except (Unavailable, ValueError, TypeError):
            return 'unknown', None
        value = text.removeprefix('workerd ')
        return 'unknown', version(service, value)
    if not ip:
        return 'unknown', None
    endpoints = {'server': (3000, '/health/ready'), 'caddy': (80, '/health'),
                 'rustfs': (9000, '/health')}
    body = http(ip, *endpoints[service], runner)
    if body is None:
        return 'unknown', None
    if service == 'server':
        doc = read_json(body)
        if not isinstance(doc, dict) or doc.get('status') != 'ready':
            raise Unavailable()
    return 'healthy', None


def runtime_version(service, container, runner):
    commands = {'caddy': ['caddy', 'version'], 'rustfs': ['rustfs', '--version']}
    if service not in commands:
        return None
    text = execute(container, commands[service], runner).strip()
    if service == 'caddy':
        value = text.split(' ', 1)[0]
    else:
        value = text.removeprefix('rustfs ')
    return version(service, value)


def probe(service, container, ip, runner=run):
    try:
        state, observed_version = readiness(service, container, ip, runner)
    except Unsupported:
        state, observed_version = 'unknown', None
    except (Unavailable, ValueError, TypeError):
        state, observed_version = 'unavailable', None
    if observed_version is None:
        try:
            observed_version = runtime_version(service, container, runner)
        except (Unavailable, ValueError, TypeError):
            pass
    return state, observed_version


# This source is passed literally to Bun inside the inspected server container. The token
# is read from that container's environment and never enters host process arguments.
CAPABILITIES_SOURCE = r'''(async()=>{try{
const token=process.env.BP_OPERATIONS_TOKEN;if(!token)process.exit(2);
const response=await fetch("http://127.0.0.1:3000/health/operations",{
headers:{Authorization:`Bearer ${token}`,Accept:"application/json"},redirect:"manual",
signal:AbortSignal.timeout(2500)});
if(response.status!==200&&response.status!==503)process.exit(3);
const reader=response.body.getReader();let size=0,chunks=[];
for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>65536)process.exit(4);chunks.push(value)}
const bytes=new Uint8Array(size);let offset=0;for(const value of chunks){bytes.set(value,offset);offset+=value.length}
const body=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
process.stdout.write(JSON.stringify({capabilities:body.capabilities}));
}catch{process.exit(1)}})()'''


def capabilities(container, runner=run):
    text = execute(container, ['bun', '-e', CAPABILITIES_SOURCE], runner)
    doc = read_json(text)
    value = doc.get('capabilities') if isinstance(doc, dict) else None
    if not isinstance(value, dict):
        raise Unavailable()
    return value


def http_main():
    connection = HTTPConnection(sys.argv[1], int(sys.argv[2]), timeout=3)
    try:
        connection.request('GET', sys.argv[3], headers={'Accept-Encoding': 'identity'})
        response = connection.getresponse()
        body = response.read(65537)
        if len(body) > 65536:
            return 1
        print(json.dumps([response.status, body.decode('utf-8')]))
        return 0
    except (OSError, ValueError, HTTPException, UnicodeError):
        return 1
    finally:
        connection.close()


if __name__ == '__main__':
    raise SystemExit(http_main())
