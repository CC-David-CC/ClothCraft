"""Package the locked Rust/WASM output for WebOS."""
from hashlib import sha256
from pathlib import Path
import json
import shutil
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
wasm, out = [Path(arg).resolve() for arg in sys.argv[1:]]
def git(*args):
    return subprocess.check_output(['git','-C',str(root),*args],text=True).strip()
if out.exists() or out.is_relative_to(root) or git('status','--porcelain','--untracked-files=no'):
    raise SystemExit('Start from the clean source pin and a new external output path.')
if not (wasm/'clothcraft_bg.wasm').read_bytes().startswith(b'\0asm'):
    raise SystemExit('Build the WASM component first.')
out.mkdir()
sources = {
    'index.mjs':root/'webos/app.mjs',
    'webos/view.mjs':root/'webos/view.mjs',
    'webos/worker.mjs':root/'webos/worker.mjs',
    'webos/workspace.css':root/'webos/workspace.css',
    'webos/native/clothcraft.js':wasm/'clothcraft.js',
    'webos/native/clothcraft_bg.wasm':wasm/'clothcraft_bg.wasm',
    'legal/LICENSE':root/'LICENSE',
    'legal/THIRD_PARTY_NOTICES.md':root/'THIRD_PARTY_NOTICES.md',
    'legal/MAKEHUMAN.md':root/'assets/makehuman/LICENSE.ASSETS.md',
}
rows = []
for name,src in sorted(sources.items()):
    target=out/name
    target.parent.mkdir(parents=True,exist_ok=True)
    shutil.copyfile(src,target)
    data=target.read_bytes()
    rows.append({'path':name,'bytes':len(data),'sha256':sha256(data).hexdigest()})
receipt={'schema':'webos-component-build/1','component':'clothcraft','sourceCommit':git('rev-parse','HEAD'),
         'sourceTree':git('rev-parse','HEAD^{tree}'),'cargoLockSHA256':sha256((root/'Cargo.lock').read_bytes()).hexdigest(),
         'wasmBindgen':'0.2.129','files':rows}
(out/'component-build.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(receipt['sourceCommit'],len(rows),'packaged files')
