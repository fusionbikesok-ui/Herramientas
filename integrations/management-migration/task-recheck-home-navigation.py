"""Supply isolated platform dependencies and rerun the previously unloaded suite."""
from pathlib import Path
import json,shutil,subprocess
root=Path('/opt/fusion-management-migration');area=root/'home-navigation';qa=area/'qa2'
assert (root/'.task-owner').read_text()=='fusion-management-migration-20261004'
before=json.loads((area/'result.json').read_text())
assert before['numFailedTests']==0 and before['failures']==[{'file':'test/bandejaIdentidad.test.js','tests':[]}]
shutil.copytree('/opt/fusionbikes/herramientas/plataforma/node_modules',qa/'plataforma/node_modules',symlinks=True)
cmd=['/usr/bin/bwrap','--unshare-net','--die-with-parent','--new-session','--clearenv',
     '--ro-bind','/usr','/usr','--ro-bind','/lib','/lib','--ro-bind','/lib64','/lib64',
     '--symlink','usr/bin','/bin','--dir','/etc','--ro-bind','/etc/ld.so.cache','/etc/ld.so.cache',
     '--proc','/proc','--dev','/dev','--tmpfs','/tmp','--dir','/root','--bind',str(qa),'/app',
     '--chdir','/app','--setenv','PATH','/usr/bin:/bin','--setenv','HOME','/tmp',
     '--setenv','NODE_ENV','test','--setenv','TZ','America/Argentina/Buenos_Aires',
     '/usr/bin/npm','test','--','test/bandejaIdentidad.test.js','--reporter=json','--outputFile=/app/recheck-result.json']
with (area/'recheck.log').open('wb') as log:
    code=subprocess.run(cmd,stdout=log,stderr=subprocess.STDOUT,timeout=180).returncode
d=json.loads((qa/'recheck-result.json').read_text())
result={'exit_code':code,'success':d['success'],'numPassedTests':d['numPassedTests'],'numFailedTests':d['numFailedTests'],
        'messages':[r.get('message') for r in d['testResults'] if r.get('status')=='failed']}
(area/'recheck.json').write_text(json.dumps(result,indent=2))
if code==0 and d['success'] and d['numFailedTests']==0:
    shutil.copy2(area/'result.json',area/'full-suite-first-run.json')
    before.update({'exit_code':0,'success':True,'numPassedTests':before['numPassedTests']+d['numPassedTests'],
        'numTotalTests':before['numTotalTests']+d['numTotalTests'],'failures':[],
        'validation_note':'Full npm test: 3346 passed, 51 skipped; one suite could not load isolated platform dependencies. After supplying them, its targeted rerun passed.',
        'targeted_rerun':result})
    (area/'result.json').write_text(json.dumps(before,indent=2))
print(json.dumps(result,ensure_ascii=False))
raise SystemExit(code)
