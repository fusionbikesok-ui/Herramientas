from pathlib import Path
import datetime,json,subprocess,sys,shutil,os,urllib.request,urllib.error,ipaddress
r=Path('/opt/fusion-management-migration');stage=Path(sys.argv[1]).resolve();assert stage.parent==r and stage.name.startswith('andreani-stage-');assert (r/'.task-owner').read_text()=='fusion-management-migration-20261004'
def run(args,**kw):
 p=subprocess.run(args,capture_output=True,text=True,timeout=50,**kw)
 if p.returncode:print(p.stdout,p.stderr);p.check_returncode()
 return p
for name in ['local-catalog.mjs','directory.mjs','metrics.mjs','metrics.test.mjs','directory.test.mjs','local-catalog.test.mjs','assets/catalog-ui.js']:
 shutil.copy2(r/name,stage/name)
for name in ['andreani.mjs','andreani-view.mjs','gateway.mjs','assets/andreani.js']:run(['node','--check',str(stage/name)])
env=dict(os.environ)
for line in (r/'runtime.env').read_text().splitlines():
 if line.startswith('FUSION_MANAGEMENT_SIGNING_KEY='):env['FUSION_MANAGEMENT_SIGNING_KEY']=line.split('=',1)[1].strip()
info=json.loads(run(['docker','inspect','fusion-management-migration-php-1']).stdout)[0];ip=next(iter(info['NetworkSettings']['Networks'].values()))['IPAddress'];assert ipaddress.ip_address(ip).is_private;env['ANDREANI_TEST_HOST']=ip
result=run(['node','--test']+[str(p) for p in stage.glob('*.test.mjs')],env=env);print(result.stdout)
try:urllib.request.urlopen('http://'+ip+'/fusion-andreani-worker/worker.php',timeout=10);raise RuntimeError('Worker anonymous access permitted')
except urllib.error.HTTPError as e:assert e.code==403
files=['gateway.mjs','gateway.test.mjs','andreani.mjs','andreani-view.mjs','andreani.test.mjs','home.html','assets/andreani.js','assets/andreani.css','andreani/data/catalog.json','ANDREANI-PLAN.md']
backup=r/'backups'/('andreani-publish-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'));backup.mkdir(mode=0o700)
for name in files:
 if (r/name).exists():(backup/name).parent.mkdir(parents=True,exist_ok=True);shutil.copy2(r/name,backup/name)
 (r/name).parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(stage/name,r/name);(r/name).chmod(0o644)
drop=Path('/etc/systemd/system/fusion-management-validation.service.d/andreani-state.conf');drop.parent.mkdir(exist_ok=True)
if drop.exists():shutil.copy2(drop,backup/drop.name)
drop.write_text('[Service]\nStateDirectory=fusion-management-validation\nStateDirectoryMode=0700\nUMask=0077\n')
try:
 run(['systemctl','daemon-reload']);run(['systemctl','restart','fusion-management-validation.service'])
 run(['systemctl','is-active','--quiet','fusion-management-validation.service'])
except Exception:
 for name in files:
  if (backup/name).exists():shutil.copy2(backup/name,r/name)
 if (backup/drop.name).exists():shutil.copy2(backup/drop.name,drop)
 else:drop.unlink()
 run(['systemctl','daemon-reload']);run(['systemctl','restart','fusion-management-validation.service']);raise
print(json.dumps({'published':'https://herramientas.fusionbikes.com.ar/herramientas/gestion-vps/andreani/','backup':str(backup),'worker_anonymous':403,'persistent_state':'/var/lib/fusion-management-validation/andreani.sqlite'}))
