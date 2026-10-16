"""Reverse cutover phase 1: preserve data, stop VPS writes, compare history. Never emit."""
from pathlib import Path
import datetime, hashlib, json, os, runpy, shutil, sqlite3, subprocess
os.umask(0o077)
r=Path('/opt/fusion-management-migration');assert (r/'.task-owner').read_text()=='fusion-management-migration-20261004'
release=r/'return-web-release.json';assert not release.exists(),'Reverse cutover already started; inspect its release before continuing'
php='fusion-management-migration-php-1';db='fusion-management-migration-db-1'
def runphp(code,timeout=90):
 x=subprocess.run(['docker','exec','-i',php,'php'],input=code,text=True,capture_output=True,timeout=timeout)
 assert x.returncode==0,x.stderr[-1200:]
 return json.loads(x.stdout)
for line in Path('/etc/fusion-arca-private/source.env').read_text().splitlines():
 if '=' in line:
  k,v=line.split('=',1);os.environ[k]=v
woo=runpy.run_path('/opt/fusion-arca-egress/arca-source.py')['woo']
gate=woo('fusion-herramientas/fiscal-cutover');assert gate['active'] and gate['ready'] and not gate['settings']['production_enabled']
stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ');b=r/'backups'/('return-web-'+stamp);b.mkdir(mode=0o700)
with (b/'vps-before.sql').open('wb') as f:
 x=subprocess.run(['docker','exec',db,'sh','-c','exec mysqldump --no-tablespaces --single-transaction --skip-comments -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE"'],stdout=f,stderr=subprocess.PIPE)
 assert x.returncode==0 and (b/'vps-before.sql').stat().st_size>1000,'Backup failed'
for name in ['gateway.env','gateway.mjs','home.html','mu-plugins/fusion-management.php','mu-plugins/fusion-arca-vps.php']:
 p=b/name;p.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(r/name,p)
pos=sqlite3.connect('file:/var/lib/fusion-management-validation/pos.sqlite?mode=ro',uri=True)
with sqlite3.connect(b/'pos.sqlite') as target:pos.backup(target)
pos_state={'drafts':pos.execute('SELECT COUNT(*) FROM drafts').fetchone()[0], 'operations':pos.execute('SELECT released,COUNT(*) FROM operations GROUP BY released').fetchall()};pos.close()
stop=runphp(r'''<?php require '/var/www/html/wp-load.php';global $wpdb;$t=$wpdb->prefix.'fusion_arca_invoices';$locks=[];
try{
 $scopes=$wpdb->get_col("SELECT DISTINCT scope FROM $t");$s=\FusionBikes\ARCA\Plugin::settings();
 foreach([1,3,6,8] as $type)$scopes[]=hash('sha256','production|'.$s['cuit'].'|15|'.$type);
 $scopes[]=hash('sha256','sin-cae|production|'.$s['cuit'].'|20');$scopes=array_unique($scopes);sort($scopes);
 foreach($scopes as $scope){$key='fbarca_emit_'.substr($scope,0,48);if((int)$wpdb->get_var($wpdb->prepare('SELECT GET_LOCK(%s,0)',$key))!==1)throw new RuntimeException('Emission in progress; no change applied');$locks[]=$key;}
 if((int)$wpdb->get_var("SELECT COUNT(*) FROM $t WHERE status='pending'"))throw new RuntimeException('Pending invoice; recover before cutover');
 $s=(array)get_option('fusion_arca_settings');$s['production_enabled']=false;$s['auto_enabled']=false;$s['auto_statuses']=[];
 update_option('fusion_arca_vps_enabled',false,false);update_option('fusion_pos_vps_enabled',false,false);update_option('fusion_arca_settings',$s,false);
 $cut=(array)get_option('fusion_arca_vps_cutover');$cut['state']='returning_to_web';$cut['vps_stopped_at']=gmdate('c');update_option('fusion_arca_vps_cutover',$cut,false);
 if(get_option('fusion_arca_vps_enabled')||\FusionBikes\ARCA\Plugin::settings()['production_enabled'])throw new RuntimeException('VPS disable not persisted');
 echo wp_json_encode(['vps_emission'=>false,'pending'=>0,'cutover'=>$cut]);
}finally{foreach($locks as $key)$wpdb->get_var($wpdb->prepare('SELECT RELEASE_LOCK(%s)',$key));}''')
env=r/'gateway.env';txt=env.read_text();assert 'FUSION_POS_VPS_ENABLED=1' in txt;env.write_text(txt.replace('FUSION_POS_VPS_ENABLED=1','FUSION_POS_VPS_ENABLED=0'));env.chmod(0o600)
subprocess.run(['systemctl','restart','fusion-management-validation.service'],check=True,timeout=30)
release.write_text(json.dumps({'phase':'vps_stopped','backup':str(b),'stop':stop,'pos':pos_state},indent=2))
print('VPS writes disabled. Backup:',b,flush=True)
# Complete previously authorized receipts only; this service never requests a CAE.
subprocess.run(['systemctl','start','fusion-arca-outbox.service'],check=True,timeout=90)
names=['arca_invoices','arca_series','arca_ml_sales','arca_whatsapp']
source={}
for name in names:
 rows=[]
 for page in range(1,50):
  x=woo('fusion-herramientas/migration-export?resource='+name+'&page='+str(page));rows+=x['rows']
  if not x['more']:break
 else:raise RuntimeError('Too many pages')
 source[name]=rows
(b/'source-final.json').write_text(json.dumps(source,ensure_ascii=False))
local=runphp(r'''<?php require '/var/www/html/wp-load.php';global $wpdb;$out=[];foreach(['invoices','series','ml_sales','whatsapp'] as $n)$out['arca_'.$n]=$wpdb->get_results('SELECT * FROM '.$wpdb->prefix.'fusion_arca_'.$n.' ORDER BY id',ARRAY_A);echo wp_json_encode($out);''')
(b/'vps-final.json').write_text(json.dumps(local,ensure_ascii=False))
def canonical(value):
 if isinstance(value,str):
  try:return json.loads(value)
  except ValueError:return value
 return value
diff=[];counts={}
for name in names:
 a={str(x['id']):x for x in source[name]};v={str(x['id']):x for x in local[name]};counts[name]={'web':len(a),'vps':len(v)}
 for i in sorted(set(a)|set(v)):
  if i not in a or i not in v:diff.append([name,i,'missing']);continue
  for k in set(a[i])|set(v[i]):
   if name=='arca_invoices' and k=='created_by' and int(i)>172:continue # Receipt archive deliberately uses author 0 on shop.
   if canonical(a[i].get(k))!=canonical(v[i].get(k)):diff.append([name,i,k])
out=json.loads(release.read_text());out.update({'counts':counts,'differences':diff});release.write_text(json.dumps(out,indent=2))
print('Comparison:',json.dumps({'counts':counts,'differences':diff,'pos':pos_state}),flush=True)
assert not diff,'History differs; keep both emitters stopped and reconcile'
numbers=runphp(r'''<?php require '/var/www/html/wp-load.php';global $wpdb;$s=\FusionBikes\ARCA\Plugin::settings();$c=new \FusionBikes\ARCA\Client('production',$s['cuit']);$out=[];
foreach([15,16] as $point)foreach([1=>'A',6=>'B',3=>'NC_A',8=>'NC_B'] as $type=>$label){$reply=$c->call('FECompUltimoAutorizado',['PtoVta'=>$point,'CbteTipo'=>$type]);$n=\FusionBikes\ARCA\Diagnostics::last_number($reply,$point,$type);$scope=hash('sha256','production|'.$s['cuit'].'|'.$point.'|'.$type);$local=(int)$wpdb->get_var($wpdb->prepare("SELECT COALESCE(MAX(number),0) FROM ".\FusionBikes\ARCA\Plugin::table()." WHERE environment='production' AND status='authorized' AND scope=%s",$scope));$out[$point][$label]=['arca'=>$n,'history'=>$local];if($n!==$local)throw new RuntimeException('Number mismatch '.$point.' '.$label);}
echo wp_json_encode($out);''',120)
out['phase']='reconciled_web_still_disabled';out['numbering']=numbers;out['fiscal_sha256']=hashlib.sha256((b/'source-final.json').read_bytes()).hexdigest();release.write_text(json.dumps(out,indent=2))
subprocess.run(['systemctl','disable','--now','fusion-arca-outbox.timer'],check=True,capture_output=True)
print('READY_FOR_WEB',json.dumps(out))
