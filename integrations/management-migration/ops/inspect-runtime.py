import subprocess,json,urllib.request,urllib.error,os,hashlib,hmac,time,base64
from pathlib import Path
r=Path('/opt/fusion-management-migration')
env=dict(line.split('=',1) for line in (r/'runtime.env').read_text().splitlines())
container='fusion-management-migration-php-1'
info=json.loads(subprocess.check_output(['docker','inspect',container],text=True))[0]
ip=next(iter(info['NetworkSettings']['Networks'].values()))['IPAddress']
def status(url,headers={}):
    try:
        with urllib.request.urlopen(urllib.request.Request(url,headers=headers),timeout=15) as response:return response.status,response.read(50000)
    except urllib.error.HTTPError as e:return e.code,e.read(1000)
results={}
results['direct_php_unauthorized']=status('http://'+ip+'/')[0]
results['gateway_unauthorized']=status('http://127.0.0.1:8212/herramientas/gestion-vps/')[0]
for path in ['/?fm_module=taller','/?fm_module=facturador','/?fm_module=pos','/index.php?rest_route=%2Ffusion-taller%2Fv1%2Fjobs','/index.php?rest_route=%2Ffusion-arca%2Fv1%2Fconfig']:
    claim=base64.b64encode(json.dumps({'user':'migration_validation_probe','method':'GET','uri':path,'time':int(time.time())},separators=(',',':')).encode()).decode()
    sig=hmac.new(env['FUSION_MANAGEMENT_SIGNING_KEY'].encode(),claim.encode(),hashlib.sha256).hexdigest()
    code,body=status('http://'+ip+path,{'X-Fusion-Claim':claim,'X-Fusion-Signature':sig})
    results[path]={'status':code,'bytes':len(body),'has_fatal':b'Fatal error' in body,'has_panel':any(s in body for s in [b'fusion-taller-app',b'fusion-arca-app',b'fbpos-app',b'fbpos-dashboard'])}
    if code>=400:results[path]['error']=body[:800].decode(errors='replace')
results['lint']=subprocess.run(['docker','exec',container,'php','-l','/var/www/html/wp-content/mu-plugins/fusion-management.php'],capture_output=True,text=True).stdout.strip()
results['published_ports']=info['NetworkSettings']['Ports']
print(json.dumps(results))
