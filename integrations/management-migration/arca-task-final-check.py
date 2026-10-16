from pathlib import Path
import subprocess,json,runpy,os
code=r'''<?php require '/var/www/html/wp-load.php';
$s=\FusionBikes\ARCA\Plugin::settings();$cut=(array)get_option('fusion_arca_vps_cutover');$out=['enabled'=>(bool)get_option('fusion_arca_vps_enabled'),'production'=>$s['production_enabled'],'point'=>$s['point'],'cutover_state'=>$cut['state'],'counts'=>$cut['counts']];
$schema=\FusionBikes\ARCA\BillingForm::schema();$out['billing_labels']=array_column($schema['fields'],'label','key');
global $wpdb;$out['pending_fiscal']=(int)$wpdb->get_var("SELECT COUNT(*) FROM ".\FusionBikes\ARCA\Plugin::table()." WHERE status='pending' AND environment='production'");$out['outbox_pending']=(int)$wpdb->get_var($wpdb->prepare("SELECT COUNT(*) FROM {$wpdb->options} WHERE option_name LIKE %s",$wpdb->esc_like('fusion_arca_vps_outbox_').'%'));
$out['opcache_validate_timestamps']=ini_get('opcache.validate_timestamps');$out['cron_disabled']=DISABLE_WP_CRON;echo json_encode($out,JSON_UNESCAPED_UNICODE);
'''
r=subprocess.run(['docker','exec','-i','-u','www-data','fusion-management-migration-php-1','php'],input=code,text=True,capture_output=True,timeout=60);assert r.returncode==0,r.stderr;print(r.stdout)
for line in Path('/etc/fusion-arca-private/source.env').read_text().splitlines():
 if '=' in line:
  k,v=line.split('=',1);os.environ[k]=v
woo=runpy.run_path('/opt/fusion-arca-egress/arca-source.py')['woo'];d=woo('fusion-herramientas/fiscal-cutover');print(json.dumps({'origin_stopped':d['active'] and d['ready'],'origin_production':d['settings']['production_enabled'],'origin_automatic':d['settings']['auto_enabled']}))
for unit in ['fusion-arca-egress.service','fusion-arca-source.service','fusion-management-validation.service','fusion-arca-outbox.timer']:
 print(unit,subprocess.check_output(['systemctl','is-active',unit],text=True).strip())
print('MU runtime sha256:',subprocess.check_output(['sha256sum','/opt/fusion-management-migration/mu-plugins/fusion-arca-vps.php'],text=True).split()[0])
