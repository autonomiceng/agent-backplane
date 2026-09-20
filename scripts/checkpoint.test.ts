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
from checkpoint import manifest, inventory, publish_checkpoint
os.environ['BP_AUTH_SECRET']='secret-not-in-manifest'
with tempfile.TemporaryDirectory() as root:
 p=Path(root)/('bp_'+'a'*32); p.mkdir(); (p/'server-data.tar').write_bytes(b'checkpoint')
 doc=manifest({'systemId':'1','timeline':1},{'systemId':'1','timeline':1},p.name,'0/1','segment',{'server':{'id':'sha256:pin'}},['server-data'],'revision',inventory(p))
 publish_checkpoint(p,doc)
 assert p.stat().st_mode & 0o777 == 0o700
 assert (p/'manifest.json').stat().st_mode & 0o777 == 0o600
 assert (p.parent/'health.json').stat().st_mode & 0o777 == 0o644
 receipt=json.loads((p.parent/'health.json').read_text())
 assert receipt=={'version':1,'systemId':'1','completedAt':doc['completedAt'],'restorePoint':{'name':p.name,'lsn':'0/1','timeline':1}}
 print(json.dumps(doc))
`);
  expect(out).not.toContain("secret-not-in-manifest"); expect(out).not.toContain("BP_AUTH_SECRET");
  const doc=JSON.parse(out); expect(doc.images.server.id).toBe("sha256:pin");
  expect(doc.artifacts["server-data.tar"].sha256).toBe(new Bun.CryptoHasher("sha256").update("checkpoint").digest("hex"));
// Publication calls sync -f on the real shared filesystem, which can exceed Bun's default five seconds under CI I/O load.
}, 30000);
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

test("retention preserves committed custody, ignores unpublished pin debris and refuses broken pins before deleting bytes", async () => {
  expect(await python(`import json, os, tempfile, uuid
from pathlib import Path
import checkpoint as cp
with tempfile.TemporaryDirectory() as root:
 p=Path(root); migration=str(uuid.uuid4())
 for i in range(1,5):
  d=p/str(i); (d/'postgres').mkdir(parents=True)
  (d/'postgres/backup_manifest').write_text(json.dumps({'WAL-Ranges':[{'Timeline':1,'Start-LSN':f'0/{i:02X}000000'}]}))
  (d/'manifest.json').write_text(json.dumps({'completedAt':str(i), 'walSegmentBytes':16777216, 'artifacts':cp.inventory(d),
   **({'migration':{'id':migration,'phase':'committed_pending_checkpoint'}} if i==2 else {})}))
 pin,_=cp.pin_checkpoint(p,p/'1',migration)
 # Die during the real staging-file fsync, leaving a partial unpublished record.
 child=os.fork()
 if child==0:
  def crash(fd): os.ftruncate(fd,1); os._exit(23)
  cp.os.fsync=crash
  cp.pin_checkpoint(p,None,migration)
  os._exit(24)
 assert os.waitpid(child,0)[1]==23<<8
 assert any(path.name.endswith('.tmp') and path.stat().st_size==1 for path in (p/'.pins').iterdir())
 assert cp.pinned_checkpoints(p)=={'1'}
 reservation,_=cp.pin_checkpoint(p,None,migration)
 assert cp.pinned_checkpoints(p)=={'1','2'}
 original=reservation.read_bytes(); reservation.write_bytes(b'{')
 try: cp.prune_checkpoints(p,1)
 except ValueError as error: assert str(error)=='blob_binding_checkpoint_pin_recovery_required'
 else: raise AssertionError('malformed committed pin allowed pruning')
 assert all((p/str(i)/'postgres/backup_manifest').is_file() for i in range(1,5))
 reservation.write_bytes(original)
 # A moved pinned checkpoint and unrecognized old atomic-write debris also fail closed.
 (p/'1').rename(p/'moved')
 try: cp.prune_checkpoints(p,1)
 except ValueError as error: assert str(error)=='blob_binding_checkpoint_pin_recovery_required'
 else: raise AssertionError('missing pinned checkpoint allowed pruning')
 (p/'moved').rename(p/'1')
 legacy=p/'.pins/.migration-unknown'; legacy.write_bytes(b''); legacy.chmod(0o600)
 try: cp.prune_checkpoints(p,1)
 except ValueError as error: assert str(error)=='blob_binding_checkpoint_pin_recovery_required'
 else: raise AssertionError('unknown pin debris ignored')
 legacy.unlink()
 assert all((p/str(i)/'postgres/backup_manifest').is_file() for i in range(1,5))
 (p/'incomplete').mkdir()
 boundaries=cp.prune_checkpoints(p,1)
 assert sorted(x.name for x in p.iterdir())==['.pins','1','2','4','incomplete']
 assert boundaries=={1:'000000010000000000000001'}
 assert pin.read_bytes() and reservation.read_bytes()==original
 print('custody retained')
`)).toContain("custody retained");
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
for name,destination in [('postgres-data','/var/lib/postgresql'),('server-data','/data'),('edge-data','/data'),('edge-config','/config')]:
 services[name.split('-')[0]].setdefault('volumes',[]).append({'type':'volume','source':name,'target':destination})
services['storage-init']['volumes']=[{'type':'volume','source':'server-data','target':'/data'}]
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
stack=SimpleNamespace(services={'storage-init':{}}, backend='filesystem', dc=dc)
cp.storage_admin=lambda stack,*args: dc(*args)
try: prepare_restored_storage(stack,'capture-1')
except RuntimeError as error: assert 'cleanup leftovers' in str(error)
else: raise AssertionError('leftovers admitted without consent')
assert not any('reconcile' in call or 'server' in call for call in calls)
assert calls[0] == ('up','-d','--wait','--wait-timeout','120','--no-build','--pull','never','--no-deps','postgres')
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
import checkpoint as cp
from checkpoint import resume_source, startup_timeout
calls=[]
def start_existing_services(stack, services):
 calls.append(services)
 raise RuntimeError('private daemon diagnostic')
cp.start_existing_services=start_existing_services
stack=SimpleNamespace(services={'server':{'environment':{'BP_STARTUP_VERIFY_TIMEOUT':'900'}}})
out=io.StringIO()
try:
 try: raise ValueError('fenced database identity changed')
 finally:
  with redirect_stderr(out): resume_source(stack,['edge','server'],None,True)
except ValueError as error: assert str(error)=='fenced database identity changed'
else: raise AssertionError('capture failure masked')
assert 'no Checkpoint was completed' in out.getvalue()
assert startup_timeout(stack)==900 and calls[0]==['server','edge']
assert 'private daemon' not in out.getvalue()
try: resume_source(stack,['server'],'completed-capture',False)
except RuntimeError as error: assert 'completed Checkpoint is retained' in str(error)
else: raise AssertionError('restart failure ignored')
cp.start_existing_services=lambda *_: (_ for _ in ()).throw(ValueError('private configuration error'))
try:
 try: raise ValueError('original capture failure')
 finally:
  with redirect_stderr(out): resume_source(stack,['server'],None,True)
except ValueError as error: assert str(error)=='original capture failure'
assert 'private configuration' not in out.getvalue()
for value in ('0','-1','1.5','secret', '86401'):
 stack.services['server']['environment']['BP_STARTUP_VERIFY_TIMEOUT']=value
 try: startup_timeout(stack)
 except ValueError: pass
 else: raise AssertionError('invalid budget accepted')
`);
});

const restartFixture = `import json, subprocess
from types import SimpleNamespace
import checkpoint as cp
ids={'rustfs':'a'*64,'server':'b'*64,'edge':'c'*64}
stack=SimpleNamespace(project='fixture',compose=['docker','compose','--project-name','fixture'],
 services={'server':{'environment':{'BP_STARTUP_VERIFY_TIMEOUT':'3'}}})
calls=[]; clock=[0.0]; lookup={}; identity={}; states={}; started=set(); timeouts=[]
cp.time.monotonic=lambda: clock[0]
cp.time.sleep=lambda seconds: clock.__setitem__(0,clock[0]+seconds)
def run(args, **kwargs):
 calls.append(args); timeouts.append(kwargs['timeout'])
 assert kwargs['timeout']>0 and kwargs['capture_output'] and kwargs['check']
 clock[0]+=0.1
 if args[:len(stack.compose)]==stack.compose:
  assert args[-3:-1]==['ps','-aq']
  result=lookup.get(args[-1],ids[args[-1]])
 elif args[:2]==['docker','start']:
  assert len(args)==3 and args[-1] in ids.values()
  started.add(args[-1]); result=args[-1]
 elif args[:3]==['docker','inspect','--format']:
  assert len(args)==5 and args[-1] in ids.values()
  service=next(service for service,cid in ids.items() if cid==args[-1])
  state={'status':'running','health':'healthy' if service!='edge' else 'none','oomKilled':False}
  if args[-1] in started:
   sequence=states.get(service,[])
   if sequence: state.update(sequence.pop(0) if len(sequence)>1 else sequence[0])
  result=json.dumps({'id':args[-1],'project':'fixture','service':service,'healthcheck':service!='edge',**state,**identity})
 else: raise AssertionError('unexpected command: '+str(args[:3]))
 return SimpleNamespace(stdout=result)
cp.subprocess.run=run
`;

test("source restart selects one owned exact container and needs no Compose dependencies", async () => {
  await python(restartFixture + `
cp.start_existing_services(stack,['rustfs','edge'])
assert [call[-1] for call in calls if call[:2]==['docker','start']]==[ids['rustfs'],ids['edge']]
assert all(call[-1] in ids.values() for call in calls if call[:2]==['docker','inspect'])
for selection, changed in [('',{}), (ids['rustfs']+' '+ids['server'],{}), (ids['rustfs'],{'project':'other'}),
                          (ids['rustfs'],{'service':'server'}), (ids['rustfs'],{'id':ids['server']})]:
 calls.clear(); lookup['rustfs']=selection; identity=changed
 try: cp.start_existing_services(stack,['rustfs'])
 except RuntimeError as error: assert str(error)=='rustfs: source container could not be resumed and verified'
 else: raise AssertionError('missing, ambiguous or unowned container accepted')
 assert not any(call[:2]==['docker','start'] for call in calls)
`);
});

test("source restart bounds each service and requires RustFS health before ordered application startup", async () => {
  await python(restartFixture + `
states['rustfs']=[{'health':'starting'},{'health':'healthy'}]
cp.resume_source(stack,['edge','server','rustfs'],None,False)
assert [call[-1] for call in calls if call[:2]==['docker','start']]==[ids['rustfs'],ids['server'],ids['edge']]
assert all(0<budget<=3 for budget in timeouts),timeouts
# Each service receives the documented full budget, including its daemon calls.
assert all(abs(timeouts[i]-3)<0.0001 for i,call in enumerate(calls) if call[:len(stack.compose)]==stack.compose),timeouts
for failed in [{'status':'exited'}, {'status':'dead'}, {'oomKilled':True}, {'health':'unhealthy'}, {'health':'none'}, {'health':'starting'}]:
 clock[0]=0; calls.clear(); started.clear(); states['rustfs']=[failed]
 try: cp.start_existing_services(stack,['rustfs','server'])
 except RuntimeError as error: assert str(error)=='rustfs: source container could not be resumed and verified'
 else: raise AssertionError('failed or unready container accepted')
 assert [call[-1] for call in calls if call[:2]==['docker','start']]==[ids['rustfs']]
 assert clock[0]<=3,clock
# A hung Docker command must spend only the remaining budget and keep stderr private.
def hung(args, **kwargs):
 assert 0<kwargs['timeout']<=3
 raise subprocess.TimeoutExpired(args,kwargs['timeout'],stderr='private daemon error')
cp.subprocess.run=hung
try: cp.start_existing_services(stack,['rustfs'])
except RuntimeError as error: assert str(error)=='rustfs: source container could not be resumed and verified'
else: raise AssertionError('command timeout ignored')
`);
});

test("restore exposes only a sanitized storage refusal token from Compose diagnostics", async () => {
  await python(String.raw`from types import SimpleNamespace
import checkpoint as cp
stack=SimpleNamespace(compose=['docker','compose'],services={})
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
cp.subprocess.run=lambda *args,**kwargs: SimpleNamespace(returncode=1,stdout='',stderr='  checkpoint_proof_authentication \r\n')
try: cp.command(['docker','compose'])
except RuntimeError as error: assert str(error)=='checkpoint_proof_authentication'
else: raise AssertionError('credential refusal ignored')
`);
});

const s3Fixture = imageFixture + `
refs.update({'rustfs':'rustfs/rustfs:1.0.0@'+cp.RUSTFS_DIGEST, 'blob-bootstrap':'server:local', 'blob-image-check':'server:local'})
ids[refs['rustfs']]='sha256:rustfs'; digests[refs['rustfs']]=refs['rustfs']
services.update({name:{'image':refs[name]} for name in ('rustfs','blob-bootstrap','blob-image-check')})
selection={'BP_BLOB_BACKEND':'s3','BP_BLOB_S3_ENDPOINT':'http://rustfs:9000','BP_BLOB_S3_REGION':'us-east-1',
 'BP_BLOB_S3_BUCKET':'private-bucket','BP_BLOB_S3_ACCESS_KEY':'scoped','BP_BLOB_S3_SECRET_KEY':'private-scoped-secret'}
services['server']['environment']={**selection,'BP_DATABASE_URL':'postgres://bp_server:secret@postgres:5432/backplane'}
services['storage-init']['environment']={**selection,'BP_ADMIN_DATABASE_URL':'postgres://postgres:secret@postgres:5432/backplane'}
services['rustfs'].update(command=['/data'],volumes=[{'type':'volume','source':'rustfs-data','target':'/data'}],
 environment={'RUSTFS_ADDRESS':':9000','RUSTFS_ACCESS_KEY':'root','RUSTFS_SECRET_KEY':'private-root-secret'})
services['blob-bootstrap']['environment']={**selection,'BP_RUSTFS_ROOT_USER':'root','BP_RUSTFS_ROOT_PASSWORD':'private-root-secret'}
`;

test("S3 capture refuses remote, custom and inconsistent storage selections before volume helpers", async () => {
  await python(s3Fixture + `
assert cp.Stack(p/'.env').backend=='s3'
for service,key,value in [('server','BP_BLOB_S3_ENDPOINT','https://remote.example'),('storage-init','BP_BLOB_S3_BUCKET','different'),
                          ('blob-bootstrap','BP_BLOB_S3_SECRET_KEY','wrong')]:
 old=services[service]['environment'][key]; services[service]['environment'][key]=value
 try: cp.Stack(p/'.env')
 except ValueError: pass
 else: raise AssertionError('different storage selection accepted')
 services[service]['environment'][key]=old
services['rustfs']['command']=['/data','/other']
try: cp.Stack(p/'.env')
except ValueError: pass
else: raise AssertionError('distributed layout accepted')
root.cleanup()
`);
});

test("independent bootstrap images require immutable custody and recover without forced server equality", async () => {
  await python(s3Fixture + `
stack=cp.Stack(p/'.env')
assert 'recoveryReference' not in stack.images['blob-bootstrap']
for name in ('blob-bootstrap','blob-image-check'):
 refs[name]='bootstrap:custom'; services[name]['image']=refs[name]
ids['bootstrap:custom']='sha256:independent'
try: cp.Stack(p/'.env')
except ValueError as error: assert 'no verified RepoDigest' in str(error)
else: raise AssertionError('unrecoverable helper admitted')
digests['bootstrap:custom']='bootstrap@sha256:'+'c'*64
ids[digests['bootstrap:custom']]='sha256:independent'
recorded=cp.Stack(p/'.env').images
assert recorded['blob-bootstrap']['id']!=recorded['server']['id']
running=False
(p/'manifest.json').write_text(json.dumps({'images':recorded,'artifacts':{}}))
local_missing.add(digests['bootstrap:custom'])
restored=cp.Stack(p/'.env',p)
assert restored.images==recorded and pulled==[digests['bootstrap:custom']]
root.cleanup()
`);
});

test("wrong volume prefix and missing volumes fail before any auto-creating helper for every durable store", async () => {
  await python(`import json
import checkpoint as cp
stack=cp.Stack.__new__(cp.Stack)
stack.stores={'postgres-data':'/var/lib/postgresql','server-data':'/data','rustfs-data':'/data','edge-data':'/data','edge-config':'/config'}
stack.config={'volumes':{name:{'name':'expected_'+name} for name in stack.stores}}
stack.services={}
for name,dest in stack.stores.items():
 service=name.split('-')[0]
 stack.services.setdefault(service,{'volumes':[]})['volumes'].append({'type':'volume','source':name,'target':dest})
stack.dc=lambda *args: args[-1]
stack.images={name:{'id':name+'-image'} for name in stack.services}
wrong=None; missing=None
calls=[]
def command(args):
 calls.append(args)
 if args[:3]==['docker','volume','inspect']:
  if args[-1]==missing: raise RuntimeError('volume absent')
  return '{}'
 if args[:3]==['docker','image','inspect']: return json.dumps([{'Config':{}}])
 if args[:2]==['docker','inspect']:
  return json.dumps([{'Image':args[-1]+'-image','Config':{'Cmd':['/data']},'Mounts':[{'Type':'volume','Destination':v['target'],'Name':('wrong_' if v['source']==wrong else 'expected_')+v['source']} for v in stack.services[args[-1]]['volumes']]}])
 raise AssertionError('helper started before volume proof')
cp.command=command
assert len(stack.attest_mounts())==5
for name in stack.stores:
 wrong=name
 try: stack.attest_mounts()
 except ValueError as error: assert 'actual durable mount differs' in str(error)
 else: raise AssertionError('wrong mount archived')
wrong=None; missing='expected_rustfs-data'
try: stack.attest_mounts()
except RuntimeError: pass
else: raise AssertionError('missing volume auto-created')
assert all('run' not in call for call in calls)
`);
});

test("unclean RustFS stop or physical capture failure refuses publication and resumes RustFS before server", async () => {
  await python(`import json, tempfile
from pathlib import Path
from types import SimpleNamespace
import checkpoint as cp
for exit_code in (137,0):
 calls=[]; running={'postgres','server','rustfs'}
 with tempfile.TemporaryDirectory() as root:
  (Path(root)/'backups').mkdir()
  receipt=Path(root)/'backups/health.json'; receipt.write_text('previous completed capture')
  def dc(*args):
   calls.append(args)
   if args[:3]==('ps','--status','running'): return ' '.join(running)
   if args[:2]==('ps','-aq'): return 'rustfs-container'
   if args[0]=='stop': running.remove(args[-1]); return ''
   if 'pg_basebackup' in ' '.join(args): raise RuntimeError('injected physical capture failure')
   raise AssertionError(args)
  stack=SimpleNamespace(backend='s3',services={'server':{}},images={'server':{'id':'server'}},backups=Path(root),
   stores={'postgres-data':'/var/lib/postgresql','rustfs-data':'/data'},attest=lambda:None,attest_mounts=lambda:{},dc=dc,
   helper=lambda script,*args,**kwargs: 'GNU tar --xattrs --numeric-owner' if 'tar --version' in script else '1',
   volume=lambda name:name,snapshot=lambda:{'timeline':1})
  stack.pg=lambda sql: {'SHOW server_version_num':'180006','SHOW data_directory':'/var/lib/postgresql/18/docker','SHOW archive_mode':'on'}.get(sql,'0')
  cp.command=lambda args: json.dumps([{'State':{'Running':False,'ExitCode':exit_code}}]) if args[:2]==['docker','inspect'] else '1'
  cp.qualify_tar=lambda stack: None
  cp.prove_root_credentials=lambda stack: None
  cp.inspect_storage=lambda *args: {'backend':'s3'}
  cp.shutil.disk_usage=lambda path: SimpleNamespace(free=10**15)
  def start_existing_services(stack, services):
   calls.append(('resume',*services)); running.update(services)
  cp.start_existing_services=start_existing_services
  try: cp.backup(stack,fenced=True)
  except (ValueError,RuntimeError) as error:
   assert ('did not stop cleanly' if exit_code else 'injected physical capture failure') in str(error)
  else: raise AssertionError('failed capture published')
  assert not list(Path(root).rglob('manifest.json'))
  assert receipt.read_text()=='previous completed capture'
  starts=[service for call in calls if call[0]=='resume' for service in call[1:]]
  assert starts==['rustfs','server'],starts
`);
});

const evidenceFixture = `import copy, json, uuid
from types import SimpleNamespace
import checkpoint as cp
calls=[]
evidence={'binding':{'databaseId':str(uuid.uuid4()),'storeId':str(uuid.uuid4()),'generation':str(uuid.uuid4()),'backend':'s3','phase':'ready'},
 'intent':{'phase':'ready'},'digest':'a'*64,'objects':[{'classification':'unreferenced'}]}
stack=SimpleNamespace(backend='s3',services={'storage-init':{},'server':{'environment':{'BP_BLOB_S3_BUCKET':'private-bucket'}}},
 dc=lambda *args:calls.append(args))
mounts={'rustfs-data':{'destination':'/data','image':'rustfs-image','command':['/data'],'entrypoint':['entrypoint']}}
stack.attest_mounts=lambda selected: mounts
cp.prove_root_credentials=lambda stack: calls.append(('root-proof',))
cp.storage_admin=lambda stack,*args: (calls.append(args),json.dumps(evidence))[1]
captured=cp.storage_evidence(stack,evidence)
`;

test("restore proves credentials and source equality before reconciling extras or starting bootstrap", async () => {
  await python(evidenceFixture + `
for failure in ('root','scoped','marker_missing','body_missing','body_changed','store_changed','extra_missing'):
 calls.clear(); current=copy.deepcopy(evidence)
 def root(stack):
  if failure=='root': raise RuntimeError('root proof refused')
 def admin(stack,*args):
  calls.append(args)
  if failure in ('scoped','marker_missing','body_missing','body_changed'): raise RuntimeError('storage proof refused')
  return json.dumps(current)
 cp.prove_root_credentials=root; cp.storage_admin=admin
 if failure=='store_changed': current['binding']['storeId']=str(uuid.uuid4())
 if failure=='extra_missing': current['objects']=[]; current['digest']='b'*64
 try: cp.prepare_restored_storage(stack,'capture',True,captured,mounts)
 except RuntimeError: pass
 else: raise AssertionError(failure+' admitted')
 assert not any('reconcile' in call or 'blob-bootstrap' in call or 'server' in call for call in calls)
 assert all('--no-deps' in call for call in calls if call[0]=='up')
cp.prove_root_credentials=lambda stack: None
cp.storage_admin=lambda stack,*args: (calls.append(args),json.dumps(evidence))[1]
cp.prepare_restored_storage(stack,'capture',True,captured,mounts)
assert any('reconcile' in call for call in calls)
evidence['objects'][0]['classification']='retained'
assert cp.storage_evidence(stack,evidence)==captured
`);
});

test("offline S3 inspection failure refuses a checkpoint while filesystem forensic capture remains available", async () => {
  await python(evidenceFixture + `
def fail(*args): raise RuntimeError('blob_binding_marker_missing')
cp.storage_admin=fail
try: cp.inspect_storage(stack,True)
except RuntimeError as error: assert 'marker_missing' in str(error)
else: raise AssertionError('unverified S3 checkpoint admitted')
stack.backend='filesystem'
assert cp.inspect_storage(stack,True)=={'backend':'filesystem','inspection':'failed','servable':False}
try: cp.inspect_storage(stack,False)
except RuntimeError: pass
else: raise AssertionError('normal filesystem capture bypassed proof')
def deadline(*args): raise RuntimeError('storage initialization refused: blob_binding_inspection_timeout')
cp.storage_admin=deadline
try: cp.inspect_storage(stack,True)
except RuntimeError as error: assert 'blob_binding_inspection_timeout' in str(error)
else: raise AssertionError('deadline became a forensic checkpoint')
def config(*args): raise RuntimeError('storage initialization refused: blob_binding_inspection_budget_invalid')
cp.storage_admin=config
try: cp.inspect_storage(stack,True)
except RuntimeError as error: assert 'blob_binding_inspection_budget_invalid' in str(error)
else: raise AssertionError('invalid helper budget became a forensic checkpoint')
for refusal in ['blob_binding_busy','blob_binding_lease_lost','blob_binding_stop_all_servers','blob_binding_operator_failed','docker command failed (exit 137)']:
 def fence(*args): raise RuntimeError(refusal)
 cp.storage_admin=fence
 try: cp.inspect_storage(stack,True)
 except RuntimeError as error: assert str(error)==refusal
 else: raise AssertionError('fence or infrastructure failure became forensic')
stack.services['server']['environment']['BP_STARTUP_VERIFY_TIMEOUT']='0'
try: cp.inspect_storage(stack,True)
except ValueError as error: assert 'BP_STARTUP_VERIFY_TIMEOUT' in str(error)
else: raise AssertionError('invalid operator budget became a forensic checkpoint')
`);
});

test("capture and restore archive validator rejects symlinks and traversal while retaining xattr records", async () => {
  await python(`import io, tarfile, tempfile
from pathlib import Path
from checkpoint import validate_archives
with tempfile.TemporaryDirectory() as root:
 p=Path(root); name='rustfs-data.tar'
 for unsafe in ('link','../escape'):
  with tarfile.open(p/name,'w') as archive:
   member=tarfile.TarInfo(unsafe)
   if unsafe=='link': member.type=tarfile.SYMTYPE; member.linkname='/outside'
   archive.addfile(member)
  try: validate_archives(p,{name:{}})
  except ValueError as error: assert 'unsafe archive member' in str(error)
  else: raise AssertionError('unsafe capture or restore admitted')
 with tarfile.open(p/name,'w',format=tarfile.PAX_FORMAT) as archive:
  member=tarfile.TarInfo('./object'); member.size=4; member.uid=1000
  member.pax_headers={'SCHILY.xattr.user.checkpoint':'retained'}
  archive.addfile(member,io.BytesIO(b'body'))
 validate_archives(p,{name:{}})
 with tarfile.open(p/name) as archive:
  member=archive.getmember('./object')
  assert member.uid==1000 and member.pax_headers['SCHILY.xattr.user.checkpoint']=='retained'
`);
});

test("S3 restore rejects changed credential commitment and nonempty targets before extraction", async () => {
  await python(s3Fixture + `
import subprocess
stack=cp.Stack(p/'.env')
name='bp_'+'a'*32
salt=cp.os.urandom(32).hex()
proof=cp.credentials_digest(stack,name,salt)
assert proof!=cp.credentials_digest(stack,name,cp.os.urandom(32).hex())
assert proof==cp.credentials_digest(stack,name,salt)
snapshot={'systemId':'1','postgres':'180006','schema':32,'pgmq':'1','timeline':1,'heads':[]}
(p/'manifest.json').write_text(json.dumps({'version':1,'completedAt':'2026-09-20T00:00:00Z','name':name,'targetLsn':'0/1','segment':'0'*24,
 'before':snapshot,'after':snapshot,'images':stack.images,'volumes':list(stack.stores),'artifacts':{},'credentials':{'kdf':'pbkdf2-hmac-sha256','iterations':600000,'salt':salt,'digest':proof}}))
valid_manifest=(p/'manifest.json').read_text()
invalid=json.loads(valid_manifest); invalid['completedAt']='2026-02-30T00:00:00Z'
(p/'manifest.json').write_text(json.dumps(invalid))
try: cp.verify(p,stack)
except ValueError as error: assert 'invalid checkpoint completion time' in str(error)
else: raise AssertionError('invalid completion time accepted')
(p/'manifest.json').write_text(valid_manifest)
stack.services['blob-bootstrap']['environment']['BP_RUSTFS_ROOT_PASSWORD']='different-root-secret'
try: cp.verify(p,stack)
except ValueError as error: assert 'captured RustFS root and scoped credentials' in str(error)
else: raise AssertionError('wrong root credentials admitted before restore')
assert 'private' not in proof
stack.services['blob-bootstrap']['environment']['BP_RUSTFS_ROOT_PASSWORD']='private-root-secret'
stack.services['blob-bootstrap']['environment']['BP_BLOB_S3_SECRET_KEY']='changed-scoped-secret'
try: cp.verify(p,stack)
except ValueError as error: assert 'captured RustFS root and scoped credentials' in str(error)
else: raise AssertionError('wrong scoped credentials admitted')
stack.services['blob-bootstrap']['environment']['BP_BLOB_S3_SECRET_KEY']='private-scoped-secret'
doc=json.loads((p/'manifest.json').read_text()); doc['name']='bp_'+'b'*32
(p/'manifest.json').write_text(json.dumps(doc))
try: cp.verify(p,stack)
except ValueError as error: assert 'captured RustFS root and scoped credentials' in str(error)
else: raise AssertionError('commitment spliced into another checkpoint')
doc['name']=name; doc['credentials']['iterations']=10**12
(p/'manifest.json').write_text(json.dumps(doc))
try: cp.verify(p,stack)
except ValueError as error: assert 'captured RustFS root and scoped credentials' in str(error)
else: raise AssertionError('unbounded recorded KDF cost admitted')
doc['credentials']['iterations']=600000; doc['credentials']['salt']='not-a-salt'
(p/'manifest.json').write_text(json.dumps(doc))
try: cp.verify(p,stack)
except ValueError as error: assert 'captured RustFS root and scoped credentials' in str(error)
else: raise AssertionError('invalid commitment admitted')
cp.verify=lambda *args:{'name':p.name}
stack.backups=p.parent.parent
# A renamed/misplaced source must refuse before any target mutation.
try: cp.restore(stack,p)
except ValueError as error: assert 'preserve the checkpoint name' in str(error)
else: raise AssertionError('misplaced checkpoint accepted')
source=p/'backups'/'capture'; source.mkdir(parents=True)
stack.backups=p; cp.verify=lambda *args:{'name':'capture'}
stack.dc=lambda *args:''
stack.volume=lambda name:name
stack.project='owned-project'
(p/'.existing').write_text('preserve')
mutations=[]
def cmd(args):
 if args[:3]==['docker','volume','create']: mutations.append(args); return ''
 if args[:2]==['docker','ps']: return ''
 raise AssertionError('unexpected command')
cp.command=cmd
def helper(script,*args,**kwargs):
 assert script==cp.EMPTY_TARGET_CHECK,'extraction started before all targets were empty'
 result=subprocess.run(['sh','-ec',script,'sh',str(p)],capture_output=True)
 if result.returncode: raise RuntimeError('nonempty target')
stack.helper=helper
try: cp.restore(stack,source)
except RuntimeError as error: assert 'nonempty target' in str(error)
else: raise AssertionError('nonempty restore admitted')
assert (p/'.existing').read_text()=='preserve'
root.cleanup()
`);
});

test("restored RustFS attests actual launch and image while allowing a fresh volume name", async () => {
  await python(`import copy, json
import checkpoint as cp
stack=cp.Stack.__new__(cp.Stack)
stack.stores={'rustfs-data':'/data'}
stack.config={'volumes':{'rustfs-data':{'name':'fresh_rustfs-data'}}}
stack.services={'storage-init':{'volumes':[{'type':'volume','source':'server-data','target':'/data'}]},
 'rustfs':{'volumes':[{'type':'volume','source':'rustfs-data','target':'/data'}]}}
stack.images={'rustfs':{'id':'recorded-image'}}; stack.backend='s3'
stack.dc=lambda *args: 'restored-container' if args[0]=='ps' else ''
actual={'Image':'recorded-image','Config':{'Cmd':['/data'],'Entrypoint':['entrypoint']},
 'Mounts':[{'Type':'volume','Name':'fresh_rustfs-data','Destination':'/data'}]}
recorded={'rustfs-data':{'name':'source_rustfs-data','destination':'/data','image':'recorded-image','command':['/data'],'entrypoint':['entrypoint']}}
def command(args):
 if args[:3]==['docker','volume','inspect']: return '{}'
 if args[:3]==['docker','image','inspect']: return json.dumps([{'Config':{'Entrypoint':['entrypoint']}}])
 return json.dumps([actual])
cp.command=command
cp.prove_root_credentials=lambda stack: None
cp.storage_admin=lambda *args: json.dumps({'intent':{'phase':'ready'},'objects':[]})
captured={'backend':'s3'}; cp.storage_evidence=lambda *args: captured
cp.prepare_restored_storage(stack,'capture',False,captured,recorded)
def premature_auth(stack): raise AssertionError('authentication before actual launch refusal')
cp.prove_root_credentials=premature_auth
actual['Config']['Cmd']=['/data','/other']
try: cp.prepare_restored_storage(stack,'capture',False,captured,recorded)
except ValueError as error: assert 'custom launch or volume layout' in str(error)
else: raise AssertionError('custom launch accepted')
actual['Config']['Cmd']=['/data']; actual['Image']='different-image'
try: cp.prepare_restored_storage(stack,'capture',False,captured,recorded)
except ValueError as error: assert 'actual container image differs' in str(error)
else: raise AssertionError('different actual image accepted')
actual['Image']='recorded-image'; recorded['rustfs-data']['entrypoint']=['different-entrypoint']
try: cp.prepare_restored_storage(stack,'capture',False,captured,recorded)
except ValueError as error: assert 'launch or mount evidence differs' in str(error)
else: raise AssertionError('captured launch evidence ignored')
`);
});
