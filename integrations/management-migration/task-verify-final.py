import json,subprocess,urllib.request,urllib.error,hashlib,hmac,time,base64
from pathlib import Path
r=Path('/opt/fusion-management-migration')
subprocess.run(['node','--test',str(r/'gateway.test.mjs')],check=True,timeout=30)
subprocess.run(['docker','exec','fusion-management-migration-php-1','php','-l','/var/www/html/wp-content/mu-plugins/fusion-management.php'],check=True,capture_output=True)
subprocess.run(['systemctl','restart','fusion-management-validation.service'],check=True)
env=dict(line.split('=',1) for line in (r/'runtime.env').read_text().splitlines())
info=json.loads(subprocess.check_output(['docker','inspect','fusion-management-migration-php-1'],text=True))[0]
ip=next(iter(info['NetworkSettings']['Networks'].values()))['IPAddress']
def get(url,headers={},method='GET'):
    try:
        with urllib.request.urlopen(urllib.request.Request(url,headers=headers,method=method),timeout=20) as response:return response.status,response.read(100000)
    except urllib.error.HTTPError as e:return e.code,e.read(1000)
results={}
root='https://herramientas.fusionbikes.com.ar/herramientas/gestion-vps/'
for attempt in range(20):
    try:
        if get('http://127.0.0.1:8212/herramientas/gestion-vps/')[0]==401:break
    except OSError:pass
    time.sleep(0.25)
else:raise RuntimeError('Gateway did not become ready')
for key,url,method,expected in [
    ('public_without_session',root,'GET',401),('public_write_block',root+'wp-json/fusion-taller/v1/jobs','POST',423),
    ('private_without_signature','http://'+ip+'/','GET',403),('shop_up','https://fusionbikes.com.ar/','GET',200),
    ('herramientas_up','https://herramientas.fusionbikes.com.ar/herramientas/home/','GET',200)]:
    code,_=get(url,method=method);results[key]=code
    if code!=expected:raise RuntimeError('Unexpected health result: '+key+' '+str(code))
for label,method,uri,stamp,expected in [
    ('valid_taller','GET','/?fm_module=taller',int(time.time()),200),
    ('valid_facturador','GET','/?fm_module=facturador',int(time.time()),200),
    ('valid_pos','GET','/?fm_module=pos',int(time.time()),200),
    ('expired_signature','GET','/?fm_module=taller',int(time.time())-60,403),
    ('signed_write_block','POST','/index.php?rest_route=%2Ffusion-taller%2Fv1%2Fjobs',int(time.time()),423),
    ('signed_method_override_block','GET','/index.php?rest_route=%2Ffusion-taller%2Fv1%2Fjobs&_method=POST',int(time.time()),400)]:
    claim=base64.b64encode(json.dumps({'user':'migration_validation_probe','method':method,'uri':uri,'time':stamp},separators=(',',':')).encode()).decode()
    signature=hmac.new(env['FUSION_MANAGEMENT_SIGNING_KEY'].encode(),claim.encode(),hashlib.sha256).hexdigest()
    code,body=get('http://'+ip+uri,{'X-Fusion-Claim':claim,'X-Fusion-Signature':signature},method)
    results[label]=code
    if code!=expected or b'Fatal error' in body:raise RuntimeError('Private validation failed: '+label)
results['memory']=subprocess.check_output(['free','-m'],text=True).strip()
results['disk']=subprocess.check_output(['df','-h','/'],text=True).strip()
results['ports']=info['NetworkSettings']['Ports']
results['package_sha256']={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in (r/'packages').glob('*.zip')}
(r/'verification.json').write_text(json.dumps(results,indent=2))
print(json.dumps(results))
