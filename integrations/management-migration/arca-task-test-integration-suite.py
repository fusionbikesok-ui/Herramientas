from pathlib import Path
import subprocess
root=Path('/opt/fusionbikes/herramientas/integrations/management-migration');tests=sorted(root.glob('*.test.mjs'))+sorted(root.glob('*.test.cjs'))
assert tests,'Integration tests absent'
r=subprocess.run(['node','--test']+[str(p) for p in tests],cwd=root,capture_output=True,text=True,timeout=120)
Path('/opt/fusion-management-migration/arca-integration-tests.log').write_text(r.stdout+r.stderr)
print('\n'.join(line for line in r.stdout.splitlines() if line.startswith(('✔','✖','ℹ','# tests','# pass','# fail'))));assert r.returncode==0,r.stderr[-1500:]
print('Isolated management integration suite passed: '+str(len(tests))+' files.')
