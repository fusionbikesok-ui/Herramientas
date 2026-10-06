"""Approved cutover: source lock, double export, backed-up transactional reconciliation. No emission."""
from pathlib import Path
import datetime,hashlib,json,os,runpy,subprocess
root=Path('/opt/fusion-management-migration');private=Path('/etc/fusion-arca-private');php='fusion-management-migration-php-1';db='fusion-management-migration-db-1'
assert (root/'.task-owner').read_text()=='fusion-management-migration-20261004'
os.umask(0o077)
for line in (private/'source.env').read_text().splitlines():
 if '=' in line:
  k,v=line.split('=',1);os.environ[k]=v
woo=runpy.run_path('/opt/fusion-arca-egress/arca-source.py')['woo']
def runphp(code):
 r=subprocess.run(['docker','exec','-i',php,'php'],input=code,text=True,capture_output=True,timeout=120)
 assert r.returncode==0,'Private fiscal operation failed: '+r.stderr[-1200:]
 return json.loads(r.stdout)
state=runphp("<?php require '/var/www/html/wp-load.php';echo json_encode(['enabled'=>(bool)get_option('fusion_arca_vps_enabled'),'production'=>\\FusionBikes\\ARCA\\Plugin::settings()['production_enabled']]);")
assert not state['enabled'] and not state['production'],'Destination is already active'
start=datetime.datetime.now(datetime.timezone.utc);stamp=start.strftime('%Y%m%dT%H%M%SZ');backup=root/'backups'/('arca-cutover-'+stamp);backup.mkdir(mode=0o700)
with (backup/'destination.sql').open('wb') as target:
 r=subprocess.run(['docker','exec',db,'sh','-c','exec mysqldump --no-tablespaces --single-transaction --skip-comments -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE"'],stdout=target,stderr=subprocess.PIPE)
assert r.returncode==0 and (backup/'destination.sql').stat().st_size>1000,'Fiscal backup failed'
before=woo('fusion-herramientas/fiscal-cutover');assert before['settings']['environment']=='production' and int(before['settings']['point'])==15
(backup/'source-before.json').write_text(json.dumps(before))
stopped=woo('fusion-herramientas/fiscal-cutover','POST',{'confirm':'ORIGIN_OFF_VPS'})
assert stopped.get('active') is True and stopped.get('ready') is True and stopped['settings']['production_enabled'] is False and stopped['settings']['auto_enabled'] is False,'Source cut not confirmed'
(backup/'source-stopped.json').write_text(json.dumps(stopped));print('Origen detenido; destino todavía deshabilitado.',flush=True)
resources=['arca_invoices','arca_series','arca_ml_sales','arca_whatsapp']
def export():
 result={};inv=woo('fusion-herramientas/migration-inventory')
 for name in resources:
  pages=[]
  for page in range(1,101):
   d=woo('fusion-herramientas/migration-export?resource='+name+'&page='+str(page))
   assert d['resource']==name and d['page']==page and isinstance(d['rows'],list)
   pages.append(d)
   if not d['more']:break
  else:raise RuntimeError('Export page limit')
  count=sum(len(p['rows']) for p in pages);assert count==inv['tables'][name]['rows'],'Unstable count'
  result[name]={'count':count,'pages':pages}
 return result
first=export();second=export()
for name in resources:
 assert first[name]['count']==second[name]['count'] and [p['sha256'] for p in first[name]['pages']]==[p['sha256'] for p in second[name]['pages']],'Source changed after stopping: '+name
archive={'at':start.strftime('%Y-%m-%d %H:%M:%S'),'source_stopped':True,'resources':second}
path=backup/'source-final.json';path.write_text(json.dumps(archive,ensure_ascii=False));path.chmod(0o600)
subprocess.run(['docker','cp',str(path),php+':/tmp/arca-cutover.json'],check=True,capture_output=True)
subprocess.run(['docker','cp',str(root/'arca-production-stage/reconcile.php'),php+':/tmp/arca-reconcile.php'],check=True,capture_output=True)
try:
 r=subprocess.run(['docker','exec',php,'php','/tmp/arca-reconcile.php'],text=True,capture_output=True,timeout=120)
 assert r.returncode==0,'Reconcile failed; source stopped, destination disabled: '+r.stderr[-1400:]
 result=json.loads(r.stdout);result['backup']=str(backup);result['source_snapshot_sha256']=hashlib.sha256(path.read_bytes()).hexdigest()
 (root/'arca-cutover-release.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
finally:
 subprocess.run(['docker','exec',php,'rm','-f','/tmp/arca-cutover.json','/tmp/arca-reconcile.php'],check=True)
