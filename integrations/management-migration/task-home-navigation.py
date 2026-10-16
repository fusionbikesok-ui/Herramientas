"""Stage and check the small Home navigation change in an isolated copy."""
from pathlib import Path
import hashlib,json,os,shutil,subprocess,time

root=Path('/opt/fusion-management-migration')
assert (root/'.task-owner').read_text()=='fusion-management-migration-20261004'
repo=Path('/opt/fusionbikes/herramientas')
area=root/'home-navigation';area.mkdir(mode=0o700,exist_ok=True)
home=repo/'public/home/index.html'
expected='ac0a4d78b03b4518ed283dbfbc7c51516818d43c41047d26788f2dece1140b23'
assert hashlib.sha256(home.read_bytes()).hexdigest()==expected, 'Home changed: inspect before editing'
qa=area/'qa2'
assert not qa.exists(), 'QA already exists: inspect previous run'
qa.mkdir()
paths=subprocess.check_output(['git','ls-files','-z'],cwd=repo).decode().split('\0')
for name in paths:
    if not name:continue
    p=Path(name)
    assert not p.is_absolute() and '..' not in p.parts
    if p.name=='.env' or p.name.startswith('.env.'):continue
    src=repo/p
    if src.is_file() and not src.is_symlink():
        dst=qa/p;dst.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(src,dst)
new="""    { titulo: 'Gestión en el VPS', color: 'control', adminOnly: true, tools: [
      { tool: 'gestion-vps', href: 'gestion-vps', t: 'Gestión VPS — POS, Facturador y Taller', d: 'Consultá el historial copiado de presupuestos, comprobantes y trabajos. Todavía no se actualiza automáticamente; para operar, usá la web habitual.', tag: 'Presupuestos · Comprobantes · Taller', parcial: 'solo consulta' },
    ]},
"""
source=home.read_text();assert source.count('  var GRUPOS = [\n')==1
candidate=source.replace('  var GRUPOS = [\n','  var GRUPOS = [\n'+new)
(qa/'public/home/index.html').write_text(candidate)
(area/'before.html').write_bytes(home.read_bytes())
(area/'candidate.html').write_text(candidate)
shutil.copytree(repo/'node_modules',qa/'node_modules',symlinks=True)
cmd=['/usr/bin/bwrap','--unshare-net','--die-with-parent','--new-session','--clearenv',
     '--ro-bind','/usr','/usr','--ro-bind','/lib','/lib','--ro-bind','/lib64','/lib64',
     '--symlink','usr/bin','/bin','--dir','/etc','--ro-bind','/etc/ld.so.cache','/etc/ld.so.cache',
     '--proc','/proc','--dev','/dev','--tmpfs','/tmp','--dir','/root',
     '--bind',str(qa),'/app',
     '--chdir','/app','--setenv','PATH','/usr/bin:/bin','--setenv','HOME','/tmp',
     '--setenv','NODE_ENV','test','--setenv','TZ','America/Argentina/Buenos_Aires',
     '/usr/bin/npm','test','--','--reporter=json','--outputFile=/app/test-result.json']
started=time.time()
with (area/'tests.log').open('wb') as log:
    code=subprocess.run(cmd,stdout=log,stderr=subprocess.STDOUT,timeout=850).returncode
result={'exit_code':code,'duration_seconds':round(time.time()-started),'original_sha256':expected,
        'candidate_sha256':hashlib.sha256(candidate.encode()).hexdigest(),'network':'isolated','production_data_mounted':False}
report=qa/'test-result.json'
if report.exists():
    data=json.loads(report.read_text())
    for key in ['numTotalTests','numPassedTests','numFailedTests','numPendingTests','numTotalTestSuites','success']:result[key]=data.get(key)
    result['failures']=[{'file':r.get('name','').replace('/app/',''),'tests':[a.get('fullName') for a in r.get('assertionResults',[]) if a.get('status')=='failed']} for r in data.get('testResults',[]) if r.get('status')=='failed']
else:result['diagnostic']=(area/'tests.log').read_text(errors='replace')[-3000:]
(area/'result.json').write_text(json.dumps(result,indent=2))
print(json.dumps(result,ensure_ascii=False))
raise SystemExit(code)
