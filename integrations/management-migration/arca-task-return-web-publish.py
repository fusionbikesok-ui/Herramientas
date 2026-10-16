from pathlib import Path
import datetime,hashlib,json,os,re,runpy,shutil,sqlite3,subprocess
os.umask(0o077)
r=Path('/opt/fusion-management-migration');repo=Path('/opt/fusionbikes/herramientas');stage=r/'return-web-stage';release=r/'return-web-release.json';out=json.loads(release.read_text());assert out['phase']=='reconciled_web_still_disabled'
b=Path(out['backup']);assert not out['differences']
for line in Path('/etc/fusion-arca-private/source.env').read_text().splitlines():
 if '=' in line:
  k,v=line.split('=',1);os.environ[k]=v
woo=runpy.run_path('/opt/fusion-arca-egress/arca-source.py')['woo'];gate=woo('fusion-herramientas/fiscal-cutover')
assert not gate['active'] and not gate['ready'] and gate['settings']['production_enabled'] and gate['settings']['point']==15,'Web not enabled'
x=subprocess.run(['docker','exec','-i','fusion-management-migration-php-1','php'],input="<?php require '/var/www/html/wp-load.php';echo json_encode(['enabled'=>(bool)get_option('fusion_arca_vps_enabled'),'production'=>\\FusionBikes\\ARCA\\Plugin::settings()['production_enabled']]);",text=True,capture_output=True,timeout=45)
assert x.returncode==0 and json.loads(x.stdout)=={'enabled':False,'production':False}
assert (r/'gateway.mjs').read_bytes()==(b/'gateway.mjs').read_bytes(),'Gateway changed during reverse cutover'
assert (r/'home.html').read_bytes()==(b/'home.html').read_bytes(),'Management home changed'
main=repo/'public/home/index.html';assert "t: 'Gestión VPS — POS, Facturador y Taller'" in main.read_text()
shutil.copy2(main,b/'main-home-before.html')
for name in ['gateway.mjs','sales-web.mjs']:
 subprocess.run(['node','--check',str(stage/name)],check=True)
for script in re.findall(r'<script\b[^>]*>(.*?)</script>',(stage/'main-home.html').read_text(),re.S|re.I):
 if script.strip():
  x=subprocess.run(['node','--check'],input=script,text=True,capture_output=True);assert x.returncode==0,x.stderr
canonical=repo/'integrations/management-migration'
for name in ['gateway.mjs','home.html','sales-web.mjs','sales-web.test.mjs']:
 shutil.copy2(stage/name,r/name);(r/name).chmod(0o644)
 shutil.copy2(stage/name,canonical/name);(canonical/name).chmod(0o644)
shutil.copy2(stage/'main-home.html',main);main.chmod(0o644)
env=r/'gateway.env';text=env.read_text();assert 'FUSION_POS_VPS_ENABLED=0' in text
assert 'FUSION_SALES_LOCATION=' not in text;env.write_text(text.rstrip()+'\nFUSION_SALES_LOCATION=web\n');env.chmod(0o600)
subprocess.run(['systemctl','restart','fusion-management-validation.service'],check=True,timeout=30)
subprocess.run(['systemctl','is-active','--quiet','fusion-management-validation.service'],check=True)
subprocess.run(['systemctl','disable','--now','fusion-arca-egress.service','fusion-arca-source.service','fusion-arca-outbox.timer'],check=True,capture_output=True,timeout=30)
note='''## Operación vigente POS y ARCA — regreso a la web, 2026-10-06

POS y Facturador ARCA vuelven a operar exclusivamente en fusionbikes.com.ar, por decisión del usuario. Herramientas ofrece accesos directos; los informes, directorio y etiquetas Andreani/corrector PDF permanecen en el VPS. Los enlaces antiguos ?fm_module=pos/facturador redirigen a la web. El gateway con FUSION_SALES_LOCATION=web bloquea las API antiguas de POS, facturación y envíos manuales del VPS; los enlaces PDF ya compartidos conservan su vigencia original.

Antes de habilitar la web se deshabilitó fusion_arca_vps_enabled y production_enabled en la copia privada y FUSION_POS_VPS_ENABLED en gateway.env; se conciliaron 173 comprobantes, 14 series, 225 ventas ML y 6 registros WhatsApp sin diferencias fiscales. La factura nueva 173/pedido 70706 ya estaba archivada en Woo. Numeración confirmada con ARCA: punto 15 A1/B15/NC_A0/NC_B1; punto16 A7/B135/NC_A0/NC_B0. Ningún pendiente ni CAE solicitado durante las pruebas. El autor del recibo 173 es 0 en la tienda por el contrato del archivo original.

En la web fusion_arca_vps_cutover queda vacío, respaldado junto con settings/ML en opciones fusion_return_web_20261006_*. La emisión manual del punto15 está habilitada y el usuario autorizó recuperar el automatismo ML del punto16. La automatización web por cambio de estado conserva su pausa. Certificados originales y conexión Meta for WooCommerce permanecen en la web. No se cambió Master Control ni precios.

Servicios privados VPS fusion-arca-egress/source y timer outbox detenidos y deshabilitados. El backup fiscal diario conserva el archivo y los borradores/operaciones anteriores. Respaldo del regreso: /opt/fusion-management-migration/backups/return-web-20261006T184545Z. No volver a habilitar VPS ni restaurar una base antigua después de nuevas emisiones web sin otro corte y conciliación. Historial anterior de migración que contradiga esta sección queda superado.

'''
for name in ['operations-vps.md','integrations-ml-woo.md','ui-ux.md']:
 p=repo/'docs/memory/modules'/name;body=p.read_text();first,rest=body.split('\n',1);p.write_text(first+'\n\n'+note+rest.lstrip())
for name in ['README-POS.md','arca/README-ARCA.md']:
 p=canonical/name
 if p.exists():p.write_text(note+'\n## Archivo del traslado anterior\n\n'+p.read_text())
pos=sqlite3.connect('file:/var/lib/fusion-management-validation/pos.sqlite?mode=ro',uri=True);rows=[]
for user,version,sale in pos.execute('SELECT user,version,sale FROM drafts'):
 s=json.loads(sale);rows.append({'version':version,'items':len(s.get('items',[])),'phase':s.get('phase'),'has_operation':bool(s.get('operation'))})
pos.close();out.update({'phase':'web_active_navigation_published','published_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'web_production':True,'vps_production':False,'pos_drafts_preserved':rows,'hashes':{n:hashlib.sha256((r/n).read_bytes()).hexdigest() for n in ['gateway.mjs','home.html','sales-web.mjs']}});release.write_text(json.dumps(out,indent=2));print(json.dumps(out))
