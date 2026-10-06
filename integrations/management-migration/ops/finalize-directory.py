from pathlib import Path
import hashlib,json,os,shutil,sqlite3,subprocess,sys
root=Path('/opt/fusion-management-migration');stage=Path(sys.argv[1]).resolve()
assert (root/'.task-owner').read_text()=='fusion-management-migration-20261004'
assert stage.parent==root and stage.name.startswith('directory-stage-')
assert subprocess.run(['systemctl','is-active','fusion-management-directory-sync.service'],capture_output=True,text=True).stdout.strip()!='activating','Initial import still active'
subprocess.run(['python3',str(stage/'sync-directory-test.py')],check=True,timeout=30)
subprocess.run(['node','--check',str(stage/'assets/directory.js')],check=True,timeout=10)
subprocess.run(['node','--test',str(stage/'directory.test.mjs')],check=True,timeout=30)
report=json.loads((root/'directory-release.json').read_text());backup=Path(report['backup'])/'finalized';backup.mkdir(exist_ok=True)
for name in ['sync-directory.py','sync-directory-test.py','directory.mjs','directory.test.mjs','assets/directory.js','directory.html','DIRECTORY-PLAN.md']:
 dest=root/name;b=backup/name;b.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(dest,b)
 tmp=dest.with_name(dest.name+'.release');shutil.copyfile(stage/name,tmp);tmp.chmod(0o644);os.replace(tmp,dest)
 p=Path('/opt/fusionbikes/herramientas/integrations/management-migration')/name;p.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(dest,p)
subprocess.run(['systemctl','restart','fusion-management-validation.service'],check=True,timeout=20)
print(json.dumps({'directory_updated':True,'backups':str(backup)}))
