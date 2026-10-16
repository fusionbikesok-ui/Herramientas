from pathlib import Path
import datetime,hashlib,hmac,json,os,re,shutil,subprocess,time,urllib.request,urllib.error,uuid
r=Path('/opt/fusion-management-migration');s=r/'pos-stage-v2'
assert (r/'.task-owner').read_text()=='fusion-management-migration-20261004'
assert hashlib.sha256((r/'gateway.mjs').read_bytes()).hexdigest()=='209f00552175645b195599669bcc72f38671d5ca069638801cc18406971d7aad'
assert hashlib.sha256((r/'mu-plugins/fusion-management.php').read_bytes()).hexdigest()=='d67dec91386fca381fba680933b61e3b9aaadb12096dbfb0231c3b00033dbab2'
env=(r/'gateway.env').read_text();key=re.search(r'^FUSION_POS_VPS_BRIDGE_KEY=(.+)$',env,re.M).group(1).strip().strip('"')
origin='https://fusionbikes.com.ar/wp-json/fusion-vps-pos/v1/'
def http(url,body=None,headers=None):
 try:
  with urllib.request.urlopen(urllib.request.Request(url,data=body,headers=headers or {}),timeout=25) as response:return response.status,json.load(response)
 except urllib.error.HTTPError as error:return error.code,json.load(error)
code,health=http(origin+'health');assert code==200 and health=={'version':'0.2.0','ready':True},(code,health)
body=json.dumps({'action':'status','operation':str(uuid.uuid4()),'actor':'a'*64},separators=(',',':')).encode();stamp=str(int(time.time()))
signature=hmac.new(key.encode(),(stamp+'\n'+hashlib.sha256(body).hexdigest()).encode(),hashlib.sha256).hexdigest()
code,result=http(origin+'command',body,{'Content-Type':'application/json','X-Fusion-Pos-Time':stamp,'X-Fusion-Pos-Signature':signature});assert code==404 and result.get('code')=='operation_missing',(code,result)
code,result=http(origin+'command',body,{'Content-Type':'application/json'});assert code==403,(code,result)
files=['gateway.mjs','pos-vps.mjs','pos-vps.test.mjs','local-catalog.mjs','assets/pos.js','mu-plugins/fusion-management.php']
backup=r/'backups'/('pos-active-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'));backup.mkdir(mode=0o700)
for name in files+['gateway.env']:
 if (r/name).exists():
  dest=backup/name;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(r/name,dest)
def wp_flag(value):
 subprocess.run(['docker','exec','fusion-management-migration-php-1','php','-r',"require '/var/www/html/wp-load.php'; update_option('fusion_pos_vps_enabled',"+value+",false); echo get_option('fusion_pos_vps_enabled')?'POS enabled':'POS disabled';"],check=True,timeout=30)
def replace(src,dst):
 tmp=dst.with_name(dst.name+'.pos-next');shutil.copy2(src,tmp);os.replace(tmp,dst)
try:
 for name in files:replace(s/name,r/name)
 updated=re.sub(r'^FUSION_POS_VPS_ENABLED=.*$','FUSION_POS_VPS_ENABLED=1',env,flags=re.M)
 assert updated!=env and 'FUSION_POS_VPS_ENABLED=1' in updated
 tmp=r/'gateway.env.pos-next';tmp.write_text(updated);tmp.chmod(0o600);os.replace(tmp,r/'gateway.env')
 wp_flag('true')
 subprocess.run(['systemctl','restart','fusion-management-validation.service'],check=True,timeout=30)
 subprocess.run(['systemctl','is-active','--quiet','fusion-management-validation.service'],check=True)
 for attempt in range(10):
  try:
   code,result=http('http://127.0.0.1:8212/herramientas/gestion-vps/wp-json/fbpos/v2/draft');assert code==401,(code,result);break
  except (ConnectionError,urllib.error.URLError):time.sleep(0.5)
 else:raise RuntimeError('Gateway failed startup')
 print(json.dumps({'published':True,'bridge_version':health['version'],'signed_store_auth':True,'unsigned_blocked':True,'gateway_unauthenticated':code,'backup':str(backup),'files':{n:hashlib.sha256((r/n).read_bytes()).hexdigest() for n in files}}))
except Exception:
 for name in files+['gateway.env']:
  if (backup/name).exists():replace(backup/name,r/name)
 wp_flag('false');subprocess.run(['systemctl','restart','fusion-management-validation.service'],check=True,timeout=30)
 raise
