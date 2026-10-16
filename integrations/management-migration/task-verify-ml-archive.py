from pathlib import Path
import json,subprocess,urllib.request,urllib.error,hashlib,hmac,time,base64
r=Path('/opt/fusion-management-migration')
env=dict(line.split('=',1) for line in (r/'runtime.env').read_text().splitlines())
container='fusion-management-migration-php-1'
info=json.loads(subprocess.check_output(['docker','inspect',container],text=True))[0]
ip=next(iter(info['NetworkSettings']['Networks'].values()))['IPAddress']
def query(path,method='GET',signed=True):
 headers={}
 if signed:
  claim=base64.b64encode(json.dumps({'user':'migration_validation_probe','method':method,'uri':path,'time':int(time.time())},separators=(',',':')).encode()).decode()
  headers={'X-Fusion-Claim':claim,'X-Fusion-Signature':hmac.new(env['FUSION_MANAGEMENT_SIGNING_KEY'].encode(),claim.encode(),hashlib.sha256).hexdigest()}
 try:
  with urllib.request.urlopen(urllib.request.Request('http://'+ip+path,headers=headers,method=method),timeout=15) as res:return res.status,json.loads(res.read(2000000))
 except urllib.error.HTTPError as e:return e.code,None
path='/index.php?rest_route=%2Ffusion-arca%2Fv1%2Fml%2Factivity'
status,data=query(path)
assert status==200 and data['archive_only'] is True and data['archive_count']==221 and len(data['rows'])==30
assert data['config']['enabled'] is False and data['config']['automatic'] is False and data['config']['connection']['connected'] is False
ids={str(row['id']) for row in data['rows']}
status2,data2=query(path+'&page=2')
assert status2==200 and not ids.intersection(str(row['id']) for row in data2['rows'])
number=str(data['rows'][0]['ml_id'])
_,filtered=query(path+'&number='+number)
assert filtered['rows'] and all(str(row['ml_id'])==number or str(row['pack_id'])==number for row in filtered['rows'])
anonymous,_=query(path,signed=False);write,_=query(path,method='POST')
assert anonymous==403 and write==423
print(json.dumps({'archive_count':data['archive_count'],'first_page':len(data['rows']),'second_page_disjoint':True,'number_filter':True,'anonymous':anonymous,'write':write,'active_oauth':False,'business_writes':False}))
