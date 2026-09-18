// Storage boundaries use real files and commands without a mocked database or Docker daemon.
import { expect, test } from "bun:test";
async function python(source:string) {
  const child=Bun.spawn(["python3","-c",source],{cwd:import.meta.dir,stdout:"pipe",stderr:"pipe",env:{...Bun.env,PYTHONDONTWRITEBYTECODE:"1"}});
  const [out,err]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text()]);
  expect(await child.exited).toBe(0); expect(err).toBe(""); return out;
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
