from pathlib import Path
import json,os,runpy,subprocess
r=Path('/opt/fusion-management-migration');repo=Path('/opt/fusionbikes/herramientas');release=r/'return-web-release.json';out=json.loads(release.read_text());assert out['phase']=='web_active_navigation_published'
for line in Path('/etc/fusion-arca-private/source.env').read_text().splitlines():
 if '=' in line:
  k,v=line.split('=',1);os.environ[k]=v
woo=runpy.run_path('/opt/fusion-arca-egress/arca-source.py')['woo'];gate=woo('fusion-herramientas/fiscal-cutover');assert not gate['active'] and gate['settings']['production_enabled']
code=r'''<?php require '/var/www/html/wp-load.php';global $wpdb;$s=\FusionBikes\ARCA\Plugin::settings();if(get_option('fusion_arca_vps_enabled')||$s['production_enabled'])throw new RuntimeException('VPS active');$cut=(array)get_option('fusion_arca_vps_cutover');$cut['state']='returned_to_web';update_option('fusion_arca_vps_cutover',$cut,false);echo wp_json_encode(['vps_emission'=>false,'pending'=>(int)$wpdb->get_var("SELECT COUNT(*) FROM ".\FusionBikes\ARCA\Plugin::table()." WHERE status='pending'"),'history'=>(int)$wpdb->get_var('SELECT COUNT(*) FROM '.\FusionBikes\ARCA\Plugin::table())]);'''
x=subprocess.run(['docker','exec','-i','fusion-management-migration-php-1','php'],input=code,text=True,capture_output=True,timeout=45);assert x.returncode==0,x.stderr[-500:];state=json.loads(x.stdout);assert state['pending']==0
services={}
for name in ['fusion-management-validation.service','fusion-arca-egress.service','fusion-arca-source.service','fusion-arca-outbox.timer','fusion-arca-backup.timer']:
 x=subprocess.run(['systemctl','show',name,'--property=ActiveState,UnitFileState'],capture_output=True,text=True);services[name]=dict(l.split('=',1) for l in x.stdout.splitlines() if '=' in l)
assert services['fusion-management-validation.service']['ActiveState']=='active'
for name in ['fusion-arca-egress.service','fusion-arca-source.service','fusion-arca-outbox.timer']:assert services[name]['ActiveState']=='inactive' and services[name]['UnitFileState']=='disabled'
verified='\nVerificación del regreso: 33 pruebas focalizadas de gateway, desvíos, bloqueo de API, POS, catálogo, transporte fiscal y entrega aprobadas en copia aislada sin credenciales productivas. UI real: WordPress WSFE y Padrón conectados; POS encuentra FB-70394 con stock1/contado ARS4.450.000 y ofrece 3/6/9/12/18/24 cuotas antes del cobro. Se retiró el producto de prueba, borrador web guardado vacío; no se creó un pedido ni se solicitó CAE de prueba. SQL confirmó ML enabled/automatic true, punto16, producción web true; tareas ML recientes completas. Informes VPS cargan 10.140 líneas y Andreani consulta el historial sincronizado. No se probó un envío real de correo/WhatsApp ni un cobro. Las 33 pruebas no constituyen la suite completa del proyecto.\n'
for name in ['operations-vps.md','integrations-ml-woo.md','ui-ux.md']:
 p=repo/'docs/memory/modules'/name;body=p.read_text();marker='Historial anterior de migración que contradiga esta sección queda superado.\n';assert marker in body;body=body.replace(marker,marker+verified,1);p.write_text(body)
for name in ['README-POS.md','arca/README-ARCA.md']:
 p=repo/'integrations/management-migration'/name
 if p.exists():
  text=p.read_text();text=text.replace('## Archivo del traslado anterior',verified+'\n## Archivo del traslado anterior',1);p.write_text(text)
  if name=='README-POS.md':(r/name).write_text(text)
out['phase']='complete';out['checks']={'web_emission':True,'vps':state,'services':services,'focused_tests':33,'ml_automatic':True,'ml_point':16,'web_point':15,'test_invoice_issued':False,'test_order_created':False};release.write_text(json.dumps(out,indent=2));print(json.dumps(out['checks']))
