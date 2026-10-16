from pathlib import Path
import json, os, runpy, subprocess, sqlite3
r=Path('/opt/fusion-management-migration')
assert (r/'.task-owner').read_text()=='fusion-management-migration-20261004'
for line in Path('/etc/fusion-arca-private/source.env').read_text().splitlines():
 if '=' in line:
  k,v=line.split('=',1);os.environ[k]=v
woo=runpy.run_path('/opt/fusion-arca-egress/arca-source.py')['woo']
print('SOURCE_GATE',json.dumps(woo('fusion-herramientas/fiscal-cutover')))
print('SOURCE_INVENTORY',json.dumps(woo('fusion-herramientas/migration-inventory')))
code=r'''<?php require '/var/www/html/wp-load.php';global $wpdb;
$s=\FusionBikes\ARCA\Plugin::settings();$ml=(array)get_option('fusion_arca_ml');$t=$wpdb->prefix.'fusion_arca_invoices';
$out=['enabled'=>(bool)get_option('fusion_arca_vps_enabled'),'settings'=>array_intersect_key($s,array_flip(['environment','point','production_enabled','auto_enabled','auto_statuses'])), 'cutover'=>get_option('fusion_arca_vps_cutover'), 'ml'=>array_intersect_key($ml,array_flip(['enabled','automatic','point'])), 'groups'=>$wpdb->get_results("SELECT environment,status,COUNT(*) n,MIN(id) min_id,MAX(id) max_id,MAX(updated_at) latest FROM $t GROUP BY environment,status",ARRAY_A),'after_cutover'=>$wpdb->get_results("SELECT id,order_id,status,environment,number,revision,created_at,updated_at FROM $t WHERE id>172 ORDER BY id",ARRAY_A)];
echo wp_json_encode($out);'''
x=subprocess.run(['docker','exec','-i','fusion-management-migration-php-1','php'],input=code,text=True,capture_output=True,timeout=90)
assert x.returncode==0,x.stderr[-1000:]
print('VPS_STATE',x.stdout)
db=Path('/var/lib/fusion-management-validation/pos.sqlite')
if db.exists():
 c=sqlite3.connect('file:'+str(db)+'?mode=ro',uri=True)
 print('POS_TABLES',c.execute("SELECT name,sql FROM sqlite_master WHERE type='table'").fetchall())
 c.close()
print('ENV_POS', [l for l in (r/'gateway.env').read_text().splitlines() if l.startswith('FUSION_POS_VPS_ENABLED=')])
for n in ['fusion-arca-outbox.timer','fusion-arca-outbox.service','fusion-management-validation.service']:
 x=subprocess.run(['systemctl','show',n,'--property=ActiveState,SubState'],capture_output=True,text=True)
 print(n,x.stdout.strip())
