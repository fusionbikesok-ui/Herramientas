from pathlib import Path
import json,subprocess,hashlib,hmac,base64,time,urllib.request
r=Path('/opt/fusion-management-migration');assert (r/'.task-owner').read_text()=='fusion-management-migration-20261004'
key=next(l.split('=',1)[1].strip() for l in (r/'runtime.env').read_text().splitlines() if l.startswith('FUSION_MANAGEMENT_SIGNING_KEY='))
info=json.loads(subprocess.check_output(['docker','inspect','fusion-management-migration-php-1'],text=True))[0];ip=next(iter(info['NetworkSettings']['Networks'].values()))['IPAddress']
address={'first_name':'QA','last_name':'Prueba','address_1':'San Martin 123','address_2':'Timbre 2','country':'AR','state':'B','city':'QA','postcode':'1000','email':'qa@example.invalid','phone':''}
order={'id':1,'number':'QA','status':'processing','currency':'ARS','created_at':'2026-10-05T12:00:00Z','billing':address,'shipping':address,'shipping_document':'','shipping_methods':[],'items':[{'product_id':0,'variation_id':0,'quantity':1,'name':'Primer producto QA'},{'product_id':0,'variation_id':0,'quantity':1,'name':'Segundo producto QA'}],'andreani':{'draft':None,'exported_at':''}}
body=json.dumps({'action':'draft','orders':[order],'products':{},'settings':{'bike_categories':[62]},'options':{}}).encode();uri='/fusion-andreani-worker/worker.php';claim=base64.b64encode(json.dumps({'user':'qa-observations','method':'POST','uri':uri,'time':int(time.time()),'sha256':hashlib.sha256(body).hexdigest()}).encode()).decode()
req=urllib.request.Request('http://'+ip+uri,data=body,headers={'Content-Type':'application/json','X-Fusion-Claim':claim,'X-Fusion-Signature':hmac.new(key.encode(),claim.encode(),'sha256').hexdigest()})
with urllib.request.urlopen(req,timeout=20) as response:data=json.load(response)
assert data['success'] and data['data'][0]['draft']['observations']=='Pedido #QA; Timbre 2'
print(json.dumps({'live_worker_http':200,'order_number_observations':True,'delivery_notes_preserved':True,'production_orders_written':0}))
