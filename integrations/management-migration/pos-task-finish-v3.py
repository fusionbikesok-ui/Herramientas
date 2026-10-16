from pathlib import Path
import datetime,hashlib,hmac,json,os,re,shutil,subprocess,time,urllib.request,urllib.error
r=Path('/opt/fusion-management-migration');env=(r/'gateway.env').read_text();key=re.search(r'^FUSION_POS_VPS_BRIDGE_KEY=(.+)$',env,re.M).group(1).strip().strip('"')
intent=json.loads((r/'pos-v3-proof-intent.json').read_text())
def command(action):
 data={'action':action,'operation':intent['operation'],'actor':intent['actor']};body=json.dumps(data,separators=(',',':')).encode();stamp=str(int(time.time()));sig=hmac.new(key.encode(),(stamp+'\n'+hashlib.sha256(body).hexdigest()).encode(),hashlib.sha256).hexdigest()
 req=urllib.request.Request('https://fusionbikes.com.ar/wp-json/fusion-vps-pos/v1/command',data=body,headers={'Content-Type':'application/json','X-Fusion-Pos-Time':stamp,'X-Fusion-Pos-Signature':sig})
 with urllib.request.urlopen(req,timeout=25) as response:return json.load(response)
assert command('status')['order_id']==0,'Unexpected order: do not remove or release'
assert command('release')['released'] is True
print('Checkout verification preparation released; no order or charge was created.')
# Publish the empty-URL guard discovered during UI checks, after verifying the baseline JS.
live=r/'assets/pos.js';staged=r/'pos-stage-v3/assets/pos.js';assert live.read_bytes()==staged.read_bytes()
patch=r/'pos-v3-reviewed.js';subprocess.run(['node','--check',str(patch)],check=True)
backup=r/'backups'/('pos-flow-ui-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'));backup.mkdir(mode=0o700);shutil.copy2(live,backup/'pos.js')
os.replace(patch,live)
print(json.dumps({'reviewed_ui':True,'sha256':hashlib.sha256(live.read_bytes()).hexdigest(),'backup':str(backup)}))
