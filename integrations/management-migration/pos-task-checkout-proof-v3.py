from pathlib import Path
import hashlib,hmac,json,re,time,urllib.request,uuid
r=Path('/opt/fusion-management-migration');env=(r/'gateway.env').read_text();key=re.search(r'^FUSION_POS_VPS_BRIDGE_KEY=(.+)$',env,re.M).group(1).strip().strip('"')
op=str(uuid.uuid4());data={'action':'prepare','operation':op,'actor':hmac.new(key.encode(),b'operator:pos-flow-verification',hashlib.sha256).hexdigest(),'items':[{'id':70394,'qty':1}],'price_key':'plan6','expected_total':5117500,'consumer_final':True,'customer_name':'Consumidor final'}
body=json.dumps(data,separators=(',',':')).encode();stamp=str(int(time.time()));sig=hmac.new(key.encode(),(stamp+'\n'+hashlib.sha256(body).hexdigest()).encode(),hashlib.sha256).hexdigest()
req=urllib.request.Request('https://fusionbikes.com.ar/wp-json/fusion-vps-pos/v1/command',data=body,headers={'Content-Type':'application/json','X-Fusion-Pos-Time':stamp,'X-Fusion-Pos-Signature':sig})
with urllib.request.urlopen(req,timeout=25) as response:result=json.load(response)
f=r/'pos-v3-proof-intent.json';f.write_text(json.dumps({'operation':op,'actor':data['actor'],'response':result}));f.chmod(0o600)
print(json.dumps({'payment_url':result['payment_url'],'order_created':result['order_id']}))
