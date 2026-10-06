from pathlib import Path
import datetime,hashlib,json,os,shutil,sqlite3,subprocess,sys,time,urllib.request,urllib.error
root=Path('/opt/fusion-management-migration');stage=Path(sys.argv[1]).resolve()
assert stage.parent==root and stage.name.startswith('metrics-stage-');assert (root/'.task-owner').read_text()=='fusion-management-migration-20261004'
baseline=json.loads((stage/'baseline.json').read_text(encoding='utf-8-sig'))
for name,sha in baseline.items():assert hashlib.sha256((root/name).read_bytes()).hexdigest()==sha,'Concurrent change: '+name
subprocess.run(['node','--test','gateway.test.mjs','local-catalog.test.mjs','directory.test.mjs','metrics.test.mjs'],cwd=stage,check=True,timeout=45)
subprocess.run(['node','--check',str(stage/'assets/metrics.js')],check=True,timeout=10)
db=sqlite3.connect(f'file:{root}/directory-cache/metrics.sqlite?mode=ro',uri=True)
assert db.execute('PRAGMA quick_check').fetchone()[0]=='ok';orders=db.execute('SELECT COUNT(*) FROM facts').fetchone()[0];assert orders>0;db.close()
names=[n for n in json.loads((stage/'files.json').read_text()) if not n.startswith('ops/')]
backup=root/'backups'/('metrics-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'));backup.mkdir(mode=0o700);existing=[]
for name in names:
 if (root/name).exists():
  dest=backup/name;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(root/name,dest);existing.append(name)
def restart():
 subprocess.run(['systemctl','restart','fusion-management-validation.service'],check=True,timeout=25)
 for _ in range(30):
  try:urllib.request.urlopen('http://127.0.0.1:8212/herramientas/gestion-vps/ventas/api?kind=options',timeout=2)
  except urllib.error.HTTPError as e:
   if e.code==401:return
  except OSError:pass
  time.sleep(.25)
 raise RuntimeError('gateway_not_ready')
try:
 for name in names:
  dest=root/name;dest.parent.mkdir(parents=True,exist_ok=True);temp=dest.with_name(dest.name+'.release');shutil.copyfile(stage/name,temp);temp.chmod(0o644);os.replace(temp,dest)
 restart()
 subprocess.run(['runuser','-u','fusion-management-validation','-g','fusion-management-read','--','node','--input-type=module','-e',"import {createMetrics} from '/opt/fusion-management-migration/metrics.mjs';const s=createMetrics()(new URLSearchParams('kind=options')).data.snapshot;if(!s.orders)process.exit(1);console.log(JSON.stringify({metrics_readable:true,snapshot:s}));"],check=True,timeout=15)
except Exception:
 for name in existing:shutil.copy2(backup/name,root/name)
 restart();raise
subprocess.run(['systemctl','enable','--now','fusion-management-metrics-sync.timer'],check=True,timeout=15)
report={'published':True,'backup':str(backup),'orders':orders,'main_application_restarted':False,'master_control_changed':False,'url':'/herramientas/gestion-vps/ventas/'}
(root/'metrics-release.json').write_text(json.dumps(report,indent=2));print(json.dumps(report))
