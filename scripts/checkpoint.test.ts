// Storage boundaries use real files; image preflights exercise the Docker command boundary.
import { expect, test } from "bun:test";
async function python(source:string) {
  const child=Bun.spawn(["python3","-c",source],{cwd:import.meta.dir,stdout:"pipe",stderr:"pipe",env:{...Bun.env,PYTHONDONTWRITEBYTECODE:"1"}});
  const [out,err]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text()]);
  expect(await child.exited, err).toBe(0); expect(err).toBe(""); return out;
}
test("checkpoint manifest includes checksums and pins without environment values",async()=>{
  const out=await python(`import json, os, tempfile
from pathlib import Path
from checkpoint import manifest
os.environ['BP_AUTH_SECRET']='secret-not-in-manifest'
with tempfile.TemporaryDirectory() as root:
 p=Path(root); (p/'server-data.tar').write_bytes(b'checkpoint')
 print(json.dumps(manifest(p,{}, {},'bp_test','0/1','segment',{'server':{'id':'sha256:pin'}},['server-data'],'revision')))
`);
  expect(out).not.toContain("secret-not-in-manifest"); expect(out).not.toContain("BP_AUTH_SECRET");
  const doc=JSON.parse(out); expect(doc.images.server.id).toBe("sha256:pin");
  expect(doc.artifacts["server-data.tar"].sha256).toBe(new Bun.CryptoHasher("sha256").update("checkpoint").digest("hex"));
});
test("restore refuses a target containing a hidden file",async()=>{
  expect(await python(`import tempfile, subprocess
from pathlib import Path
from checkpoint import require_empty, EMPTY_TARGET_CHECK
with tempfile.TemporaryDirectory() as root:
 p=Path(root); require_empty(p); (p/'.existing').write_text('preserve')
 try: require_empty(p)
 except ValueError as e: print(e)
 else: raise AssertionError('non-empty target accepted')
 result=subprocess.run(['sh','-ec',EMPTY_TARGET_CHECK,'sh',str(p)],capture_output=True,text=True)
 assert result.returncode != 0 and 'refuses non-empty targets' in result.stderr
 assert (p/'.existing').read_text()=='preserve'
`)).toContain("restore refuses non-empty targets");
});

test("retention keeps N complete Checkpoints and uses the earliest retained base backup WAL boundary", async () => {
  expect(await python(`import json, tempfile
from pathlib import Path
from checkpoint import prune_checkpoints
with tempfile.TemporaryDirectory() as root:
 p=Path(root)
 for i in range(1,5):
  d=p/str(i); (d/'postgres').mkdir(parents=True)
  (d/'manifest.json').write_text(json.dumps({'completedAt':str(i), 'walSegmentBytes':16777216}))
  (d/'postgres/backup_manifest').write_text(json.dumps({'WAL-Ranges':[{'Timeline':1,'Start-LSN':f'0/{i:02X}000000'}]}))
 (p/'incomplete').mkdir()
 boundaries=prune_checkpoints(p,2)
 assert sorted(x.name for x in p.iterdir())==['3','4','incomplete']
 assert boundaries=={1:'000000010000000000000003'}
 print('retained 2')
`)).toContain("retained 2");
});

test("destroy refuses a mismatched typed project before accessing Docker", async () => {
  const child = Bun.spawn(["bash", "scripts/destroy.sh", "bp-disposable"], {
    cwd: new URL("..", import.meta.url).pathname, stdin: new Blob(["agent-backplane\n"]), stdout: "pipe", stderr: "pipe",
  });
  const stderr = await new Response(child.stderr).text();
  expect(await child.exited).toBe(1);
  expect(stderr).toContain("Destroy refused: project name does not match");
});

const imageFixture = `import json, tempfile
from pathlib import Path
import checkpoint as cp
root = tempfile.TemporaryDirectory()
p = Path(root.name)
refs = {'postgres':'pg:experiment', 'server':'server:local', 'edge':'caddy:experiment',
        'backup-init':'pg:experiment', 'migrate':'server:local', 'data-init':'server:local', 'storage-init':'server:local'}
ids = {'pg:experiment':'sha256:pg', 'server:local':'sha256:server', 'caddy:experiment':'sha256:edge'}
digests = {'pg:experiment':'pg@sha256:'+'a'*64, 'caddy:experiment':'caddy@sha256:'+'b'*64}
ids.update({digest:ids[ref] for ref,digest in digests.items()})
services = {name:{'image':ref} for name,ref in refs.items()}
services['server']['environment'] = {}
services['postgres']['volumes'] = [{'source':str(p),'target':'/backup'}]
config = {'name':'fixture','services':services}
running = True
drift = None
missing = None
local_missing = set()
pulled = []
def command(args, env=None):
 if args[:2] == ['docker','compose']:
  if 'config' in args: return json.dumps(config)
  if 'ps' in args: return args[-1] if running and args[-1] in refs else ''
 elif args[:2] == ['docker','inspect']:
  return 'sha256:drift' if args[-1] == drift else ids[refs[args[-1]]]
 elif args[:3] == ['docker','image','inspect']:
  ref = args[-1]
  if ref == missing or ref in local_missing: raise RuntimeError('private registry diagnostics')
  if '--format' in args: return ids[ref]
  return json.dumps([{'Id':ids[ref], 'RepoDigests':[digests[ref]] if ref in digests else []}])
 elif args[:2] == ['docker','pull']:
  if args[-1] == missing: raise RuntimeError('private registry diagnostics')
  pulled.append(args[-1]); local_missing.discard(args[-1]); return ''
 elif args[:2] == ['docker','tag']:
  ids[args[-1]] = args[-2]; return ''
 raise AssertionError('unexpected mutation: '+str(args[:3]))
cp.command = command
`;

test("checkpoint rejects runtime drift, helper drift and irreproducible images before fencing", async () => {
  await python(imageFixture + `
def refused(fragment):
 try: cp.Stack(p/'.env')
 except ValueError as error: assert fragment in str(error), str(error)
 else: raise AssertionError('unsafe capture accepted')
drift = 'postgres'
refused('container differs')
drift = None
running = False
services['data-init']['image'] = 'helper:other'; ids['helper:other'] = 'sha256:other'
refused('helper must use the same content')
services['data-init']['image'] = refs['data-init']
saved = digests.pop('pg:experiment')
refused('no verified RepoDigest')
digests['pg:experiment'] = saved
stack = cp.Stack(p/'.env')
assert stack.images['postgres']['reference'] == 'pg:experiment'
assert stack.images['postgres']['recoveryReference'] == saved
assert stack.images['data-init']['id'] == stack.images['server']['id']
running = True
drift = 'postgres'
try: cp.backup(stack)
except ValueError as error: assert 'container differs' in str(error), str(error)
else: raise AssertionError('reused Stack fenced without fresh container attestation')
root.cleanup()
`);
});

test("restore resolves recorded immutable content and rejects unavailable or different images before writes", async () => {
  await python(imageFixture + `
stack = cp.Stack(p/'.env'); recorded = stack.images
running = False
(p/'manifest.json').write_text(json.dumps({'images':recorded,'artifacts':{},'after':{'schema':31}}))
try: cp.Stack(p/'.env', p)
except ValueError as error: assert 'matching pre-upgrade checkout' in str(error)
else: raise AssertionError('old runtime was sent through newer initialization')
(p/'manifest.json').write_text(json.dumps({'images':recorded,'artifacts':{}}))
def refused(fragment):
 try: cp.Stack(p/'.env', p)
 except ValueError as error:
  assert fragment in str(error), str(error)
  assert 'private registry diagnostics' not in str(error)
 else: raise AssertionError('unsafe restore accepted')
services['server']['image'] = 'other-server'
refused('recorded image reference')
services['server']['image'] = refs['server']
recovery = recorded['postgres'].pop('recoveryReference')
(p/'manifest.json').write_text(json.dumps({'images':recorded,'artifacts':{}}))
refused('no immutable recovery image')
recorded['postgres']['recoveryReference'] = recovery
(p/'manifest.json').write_text(json.dumps({'images':recorded,'artifacts':{}}))
missing = digests['pg:experiment']
refused('pull or load the recorded image')
missing = None
ids[digests['pg:experiment']] = 'sha256:wrong-platform'
refused('recovery image content differs')
ids[digests['pg:experiment']] = recorded['postgres']['id']
ids['pg:experiment'] = 'sha256:moved-tag'
restored = cp.Stack(p/'.env', p)
assert restored.images == recorded
assert not pulled, 'already loaded immutable content should not need a registry'
local_missing.add(recovery)
cp.Stack(p/'.env', p)
assert pulled == [recovery]
# Version-1 manifests without recoveryReference still accept their original digest pins.
for service in ('postgres','edge'):
 ref = digests[refs[service]]
 services[service]['image'] = ref
 recorded[service] = {'reference':ref, 'id':recorded[service]['id']}
 digests[ref] = ref
services['backup-init']['image'] = services['postgres']['image']
for helper in ('backup-init','migrate','data-init'): del recorded[helper]
(p/'manifest.json').write_text(json.dumps({'images':recorded,'artifacts':{}}))
cp.Stack(p/'.env', p)
root.cleanup()
`);
});


test("capture refuses a PostgreSQL 18 experiment with a different data directory before fencing", async () => {
  await python(`from types import SimpleNamespace
import checkpoint as cp
calls = []
def pg(sql):
 calls.append(sql)
 return {'SHOW server_version_num':'180006', 'SHOW data_directory':'/custom/data'}[sql]
stack = SimpleNamespace(attest=lambda: calls.append('attest'), services={}, images={},
 dc=lambda *args: 'postgres server', pg=pg)
try: cp.backup(stack)
except ValueError as error: assert 'data_directory=/var/lib/postgresql/18/docker' in str(error)
else: raise AssertionError('unsupported data directory was captured')
assert calls == ['attest', 'SHOW server_version_num', 'SHOW data_directory']
`);
});

test("offline checkpoint refuses live writers and permits a stopped server recovery capture", async () => {
  expect(await python(`from checkpoint import require_backup_services
require_backup_services(['postgres'], True, True)
for running in ([], ['postgres','server'], ['postgres','edge'], ['postgres','storage-init']):
 try: require_backup_services(running, True, True)
 except ValueError: pass
 else: raise AssertionError('offline fence missing')
try: require_backup_services(['postgres'], False, False)
except ValueError: pass
else: raise AssertionError('normal backup accepted a stopped server')
print('offline fence checked')
`)).toContain('offline fence checked');
});


test("restore gates leftovers before server startup and only retains with explicit consent", async () => {
  await python(`import json
from types import SimpleNamespace
from checkpoint import prepare_restored_storage
import checkpoint as cp
calls=[]
evidence={'intent':{'phase':'ready'},'objects':[{'classification':'unreferenced'}]}
def dc(*args):
 calls.append(args)
 if 'inspect' in args: assert args == ('inspect','--fenced'), args
 return json.dumps(evidence) if 'inspect' in args else ''
stack=SimpleNamespace(services={'storage-init':{}}, dc=dc)
cp.storage_admin=lambda stack,*args: dc(*args)
try: prepare_restored_storage(stack,'capture-1')
except RuntimeError as error: assert 'cleanup leftovers' in str(error)
else: raise AssertionError('leftovers admitted without consent')
assert not any('reconcile' in call or 'server' in call for call in calls)
assert calls[0] == ('up','-d','--wait','--wait-timeout','120','--no-build','--pull','never','postgres')
calls.clear()
prepare_restored_storage(stack,'capture-1',True)
assert any('reconcile' in call and '--retain-unreferenced' in call for call in calls)
assert not any('server' in call for call in calls)
calls.clear(); evidence['objects'][0]['classification']='retained'
prepare_restored_storage(stack,'capture-2')
assert not any('reconcile' in call for call in calls)
evidence['intent']['phase']='verifying'
try: prepare_restored_storage(stack,'capture-2',True)
except RuntimeError as error: assert 'unfinished binding intent' in str(error)
else: raise AssertionError('unfinished intent overwritten')
`);
});

test("capture preserves its original error if source restart also fails", async () => {
  await python(`import io
from contextlib import redirect_stderr
from types import SimpleNamespace
from checkpoint import resume_source, startup_timeout
calls=[]
def dc(*args):
 calls.append(args)
 raise RuntimeError('private daemon diagnostic')
stack=SimpleNamespace(services={'server':{'environment':{'BP_STARTUP_VERIFY_TIMEOUT':'900'}}},dc=dc)
out=io.StringIO()
try:
 try: raise ValueError('fenced database identity changed')
 finally:
  with redirect_stderr(out): resume_source(stack,['edge','server'],None,True)
except ValueError as error: assert str(error)=='fenced database identity changed'
else: raise AssertionError('capture failure masked')
assert 'no Checkpoint was completed' in out.getvalue()
assert '900' in calls[0] and calls[0][-2:]==('server','edge')
assert 'private daemon' not in out.getvalue()
try: resume_source(stack,['server'],'completed-capture',False)
except RuntimeError as error: assert 'completed Checkpoint is retained' in str(error)
else: raise AssertionError('restart failure ignored')
for value in ('0','-1','1.5','secret', '86401'):
 stack.services['server']['environment']['BP_STARTUP_VERIFY_TIMEOUT']=value
 try: startup_timeout(stack)
 except ValueError: pass
 else: raise AssertionError('invalid budget accepted')
`);
});

test("restore exposes only a sanitized storage refusal token from Compose diagnostics", async () => {
  await python(String.raw`from types import SimpleNamespace
import checkpoint as cp
stack=SimpleNamespace(compose=['docker','compose'])
for diagnostic,expected in [('\n{"error":"blob_binding_content_mismatch"}\nprivate secret', 'blob_binding_content_mismatch'),
                           ('{"error":"/private/secret"}', 'diagnostic unavailable'),
                           ('not JSON private secret', 'diagnostic unavailable')]:
 def run(args,**kwargs):
  assert '-T' in args and '--fenced' in args
  return SimpleNamespace(returncode=1,stdout='secret',stderr=diagnostic)
 cp.subprocess.run=run
 try: cp.storage_admin(stack,'inspect','--fenced')
 except RuntimeError as error:
  assert expected in str(error) and 'private' not in str(error) and 'secret' not in str(error)
 else: raise AssertionError('storage refusal ignored')
`);
});
