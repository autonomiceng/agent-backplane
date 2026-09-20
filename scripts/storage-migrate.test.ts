// Pure operator boundaries: real private files, no PostgreSQL or Docker processes.
import { expect, test } from "bun:test";

test("migration preflight leaves no custody debris and retries freeze budget and both source and target image roles", async () => {
  const child = Bun.spawn(["python3", "-c", `import copy, hashlib, json, runpy, tempfile
from pathlib import Path
from types import SimpleNamespace
op=runpy.run_path('storage-migrate.py'); g=op['run'].__globals__
class Boundary(Exception): pass
with tempfile.TemporaryDirectory() as root:
 p=Path(root); repository=p/'repository'; checkpoint=repository/'backups/capture'; checkpoint.mkdir(parents=True)
 env=p/'source.env'; target_env=p/'target.env'
 for path in (env,target_env): path.write_text(path.name); path.chmod(0o600)
 source_images={name:{'reference':'app:local','id':'sha256:original'} for name in ('server','storage-init','postgres')}
 target_images={**copy.deepcopy(source_images), 'rustfs':{'reference':'rustfs@sha256:pinned','id':'sha256:rustfs'},
                'blob-bootstrap':{'reference':'bootstrap:local','id':'sha256:bootstrap'}}
 services={name:{'environment':{}} for name in ('server','storage-init','postgres','blob-bootstrap')}
 services['server']['environment']['BP_STARTUP_VERIFY_TIMEOUT']='7'
 common=dict(project='fixture',backups=repository,services=services,volume=lambda name:name)
 source=SimpleNamespace(**common,backend='filesystem',stores={'server-data':'server'},images=source_images,env_file=env)
 target=SimpleNamespace(**common,backend='s3',stores={'server-data':'server','rustfs-data':'rustfs'},images=target_images,env_file=target_env,
                        config={'networks':{},'volumes':{}})
 doc={'captureMode':'offline','storage':{'backend':'filesystem','phase':'ready'},'images':copy.deepcopy(source_images),'artifacts':{}}
 (checkpoint/'manifest.json').write_text(json.dumps(doc))
 args=SimpleNamespace(state=p/'state',env_file=env,target_env=target_env,action='migrate',checkpoint=checkpoint,budget=7100)
 g['stack_from_env']=lambda path:source if path==env else target
 g['target_identity']=lambda *args:{'volume':'rustfs-data','credentialsSha256':'fixed'}
 g['command']=lambda args:''
 def writers(stack):
  if stack is target: raise Boundary()
 g['check_writers']=writers
 g['verify']=lambda *args:doc
 g['storage_admin']=lambda *args:json.dumps({'objects':[{'classification':'unreferenced'}]})
 try: op['run'](args)
 except ValueError as error: assert str(error)=='blob_binding_migration_unreferenced_reconcile_required'
 else: raise AssertionError('unreferenced source accepted')
 assert not args.state.exists() and not (repository/'backups/.pins').exists()
 g['storage_admin']=lambda *args:json.dumps({'objects':[{'classification':'retained'}]})
 try: op['run'](args)
 except Boundary: pass
 else: raise AssertionError('passed external command boundary')
 state_path=args.state/'intent.json'; saved=state_path.read_bytes(); state=json.loads(saved)
 assert state['budget']==7100 and set(state['targetImages'])=={'rustfs','blob-bootstrap'}
 assert state_path.stat().st_mode & 0o777==0o600 and args.state.stat().st_mode & 0o777==0o700
 args.budget=None
 try: op['run'](args)
 except Boundary: pass
 else: raise AssertionError('plain custom-budget retry failed boundary')
 assert state_path.read_bytes()==saved
 args.budget=3600
 try: op['run'](args)
 except ValueError as error: assert str(error)=='blob_binding_migration_budget_changed'
 else: raise AssertionError('retry budget changed')
 args.budget=None
 for role in ('storage-init','blob-bootstrap'):
  original=target.images[role]['id']; target.images[role]['id']='sha256:rebuilt'
  try: op['run'](args)
  except ValueError as error: assert str(error)=='blob_binding_migration_image_custody'
  else: raise AssertionError('rebuilt image accepted')
  target.images[role]['id']=original
 assert state_path.read_bytes()==saved
 for invalid in (0,86401):
  args.budget=invalid
  try: op['run'](args)
  except ValueError as error: assert str(error)=='blob_binding_migration_budget_invalid'
  else: raise AssertionError('invalid budget accepted')
 args.budget=None; args.state=p/'default-state'
 try: op['run'](args)
 except Boundary: pass
 assert json.loads((args.state/'intent.json').read_text())['budget']==3600
 # Inspect the real private helper handoff at its subprocess boundary; execute no Docker command.
 def helper(argv, **kwargs):
  model=json.loads((args.state/'helper.json').read_text())
  assert set(model['services'])=={'storage-init'}
  helper=model['services']['storage-init']
  assert helper['environment']['BP_STORAGE_MIGRATION_TIMEOUT']=='7100'
  assert helper['environment']['BP_STARTUP_VERIFY_TIMEOUT']=='7'
  assert helper['image']=='sha256:original' and helper['pull_policy']=='never'
  assert (args.state/'helper.json').stat().st_mode & 0o777==0o600
  return SimpleNamespace(returncode=0,stdout='{"phase":"copying"}',stderr='')
 original_run=g['subprocess'].run
 try:
  g['subprocess'].run=helper
  assert op['engine'](target,args.state,'prepare',state['id'],state['target'],checkpoint,budget=7100)=={'phase':'copying'}
 finally: g['subprocess'].run=original_run
 assert not (args.state/'request.json').exists() and not (args.state/'helper.json').exists()
`], { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe", env: { ...Bun.env, PYTHONDONTWRITEBYTECODE: "1" } });
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(await child.exited, err).toBe(0);
  expect(out + err).toBe("");
});
