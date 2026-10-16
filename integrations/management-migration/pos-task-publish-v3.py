from pathlib import Path
import datetime,hashlib,hmac,json,os,re,shutil,subprocess,time,urllib.request,urllib.error,sqlite3
r=Path('/opt/fusion-management-migration');s=r/'pos-stage-v3'
assert (r/'.task-owner').read_text()=='fusion-management-migration-20261004'
hashes=json.loads((s/'baseline-hashes.json').read_text())
for name,digest in hashes.items():assert hashlib.sha256((r/name).read_bytes()).hexdigest()==digest,'Live file changed: '+name
env=(r/'gateway.env').read_text();key=re.search(r'^FUSION_POS_VPS_BRIDGE_KEY=(.+)$',env,re.M).group(1).strip().strip('"')
assert re.search(r'^FUSION_POS_VPS_ENABLED=1$',env,re.M)
def http(url,body=None,headers=None):
 try:
  with urllib.request.urlopen(urllib.request.Request(url,data=body,headers=headers or {}),timeout=25) as response:return response.status,json.load(response)
 except urllib.error.HTTPError as error:return error.code,json.load(error)
origin='https://fusionbikes.com.ar/wp-json/fusion-vps-pos/v1/'
code,health=http(origin+'health');assert code==200 and health=={'version':'0.3.0','ready':True},(code,health)
def command(data,user='pos-flow-verification'):
 data['actor']=hmac.new(key.encode(),('operator:'+user).encode(),hashlib.sha256).hexdigest()
 body=json.dumps(data,separators=(',',':')).encode();stamp=str(int(time.time()))
 signature=hmac.new(key.encode(),(stamp+'\n'+hashlib.sha256(body).hexdigest()).encode(),hashlib.sha256).hexdigest()
 return http(origin+'command',body,{'Content-Type':'application/json','X-Fusion-Pos-Time':stamp,'X-Fusion-Pos-Signature':signature})
code,quote=command({'action':'pricing','items':[{'id':70394,'qty':1}]});assert code==200 and len(quote['plans'])>1,(code,quote)
print(json.dumps({'live_pricing':quote['plans'],'source':quote['source']}))
db=sqlite3.connect('file:/var/lib/fusion-management-validation/pos.sqlite?mode=ro',uri=True)
users=[row[0] for row in db.execute('select distinct user from operations limit 5')];db.close()
for user in users:
 code,o=command({'action':'order-read','order_id':70704},user)
 if code==200:
  print(json.dumps({'order':{k:o[k] for k in ['order_id','state','paid','manual_allowed','can_invoice','fulfillment']}}));break
else:print(json.dumps({'order70704_lookup':'not_owned_by_existing_POS_operator'}))
files=list(hashes)+['pos-vps.test.mjs']
backup=r/'backups'/('pos-flow-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'));backup.mkdir(mode=0o700)
for name in files:
 dest=backup/name;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(r/name,dest)
def replace(src,dst):
 tmp=dst.with_name(dst.name+'.flow-next');shutil.copy2(src,tmp);os.replace(tmp,dst)
try:
 for name in files:replace(s/name,r/name)
 subprocess.run(['systemctl','restart','fusion-management-validation.service'],check=True,timeout=30)
 subprocess.run(['systemctl','is-active','--quiet','fusion-management-validation.service'],check=True)
 for attempt in range(10):
  try:
   code,result=http('http://127.0.0.1:8212/herramientas/gestion-vps/wp-json/fbpos/v2/session');assert code==401;break
  except (ConnectionError,urllib.error.URLError):time.sleep(.5)
 else:raise RuntimeError('Gateway failed startup')
 print(json.dumps({'published':True,'bridge_version':health['version'],'backup':str(backup),'unauthenticated_blocked':True}))
except Exception:
 for name in files:replace(backup/name,r/name)
 subprocess.run(['systemctl','restart','fusion-management-validation.service'],check=True,timeout=30)
 raise
