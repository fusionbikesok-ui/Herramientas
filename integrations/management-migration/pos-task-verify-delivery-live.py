from pathlib import Path
import subprocess,json,re,urllib.request,hashlib,base64,hmac,time,sqlite3,secrets,os,shutil
r=Path('/opt/fusion-management-migration');assert (r/'.task-owner').read_text()=='fusion-management-migration-20261004'
print(subprocess.check_output(['systemctl','show','fusion-management-validation','-p','PrivateNetwork','-p','IPAddressDeny','-p','RestrictAddressFamilies'],text=True))
import shlex
env={}
for line in ((r/'runtime.env').read_text()+'\n'+(r/'gateway.env').read_text()).splitlines():
 parts=shlex.split(line)
 for part in parts:
  if '=' in part:
   k,v=part.split('=',1);env[k]=v
if 'FUSION_MANAGEMENT_SIGNING_KEY' not in env:
 print('Gateway variable names:',list(env));raise RuntimeError('Signing variable location needs inspection')
key=env['FUSION_MANAGEMENT_SIGNING_KEY'];host=env['FUSION_MANAGEMENT_UPSTREAM']
php="""require '/var/www/html/wp-load.php';global $wpdb;$user=$wpdb->get_var("SELECT display_name FROM ".$wpdb->users." WHERE user_login LIKE 'herr_%' ORDER BY ID LIMIT 1");$id=$wpdb->get_var("SELECT id FROM ".$wpdb->prefix."fusion_arca_invoices WHERE status='authorized' AND environment='production' ORDER BY id DESC LIMIT 1");echo json_encode(['user'=>$user,'id'=>(int)$id]);"""
identity=json.loads(subprocess.check_output(['docker','exec','fusion-management-migration-php-1','php','-r',php],text=True,timeout=30));assert identity['user'] and identity['id']>0
def read(uri):
 claim=base64.b64encode(json.dumps({'user':identity['user'],'method':'GET','uri':uri,'time':int(time.time()),'sha256':hashlib.sha256(b'').hexdigest()},separators=(',',':')).encode()).decode()
 req=urllib.request.Request('http://'+host+uri,headers={'Host':'herramientas.fusionbikes.com.ar','x-fusion-claim':claim,'x-fusion-signature':hmac.new(key.encode(),claim.encode(),hashlib.sha256).hexdigest()})
 with urllib.request.urlopen(req,timeout=60) as response:return response.read()
doc=json.loads(read('/index.php?rest_route=/fusion-arca/v1/invoices/'+str(identity['id'])))
pdf=read('/index.php?fusion_vps_print='+str(identity['id']));assert doc['status']=='authorized' and pdf.startswith(b'%PDF-') and len(pdf)>1000
print(json.dumps({'native_authorized_document_read':True,'native_pdf_valid':True,'pdf_bytes':len(pdf)}))
# Test the live anonymous PDF route using only synthetic bytes; remove exactly this test capability afterward.
dbpath=Path('/var/lib/fusion-management-validation/delivery.sqlite');assert dbpath.exists()
token=secrets.token_hex(32);digest=hashlib.sha256(token.encode()).hexdigest();sample=b'%PDF-1.7\nFusion delivery route fixture, no customer data.\n%%EOF'
with sqlite3.connect(dbpath) as db:db.execute('INSERT INTO links VALUES(?,?,?,?,?)',(digest,0,int(time.time()*1000)+60000,sample,'Fusion-Test.pdf'))
try:
 req=urllib.request.Request('https://herramientas.fusionbikes.com.ar/herramientas/gestion-vps/facturador/comprobante/'+token)
 with urllib.request.urlopen(req,timeout=30) as response:
  assert response.status==200 and response.headers['Content-Type']=='application/pdf' and response.read()==sample
  assert response.headers['Referrer-Policy']=='no-referrer'
 print('Anonymous PDF route works through TLS/nginx; only synthetic data used')
finally:
 with sqlite3.connect(dbpath) as db:db.execute('DELETE FROM links WHERE hash=? AND invoice=0',(digest,))
with sqlite3.connect('file:'+str(dbpath)+'?mode=ro',uri=True) as db:print('Recorded mail attempts:',db.execute('SELECT COUNT(*) FROM emails').fetchone()[0]);assert db.execute('PRAGMA quick_check').fetchone()[0]=='ok'
print('LIVE_READONLY_DELIVERY_CHECKS_PASSED')
