from pathlib import Path
import json,subprocess,datetime
root=Path('/opt/fusion-management-migration');release=json.loads((root/'arca-cutover-release.json').read_text());assert release['reconciled'] and release['counts']['arca_invoices']>=172
code=r'''<?php require '/var/www/html/wp-load.php';
global $wpdb;$cut=(array)get_option('fusion_arca_vps_cutover',[]);$s=\FusionBikes\ARCA\Plugin::settings();
if(($cut['state']??'')!=='reconciled'||empty($cut['last_source_id'])||get_option('fusion_arca_vps_enabled')||$s['production_enabled'])throw new RuntimeException('Unexpected state before activation');
if($s['environment']!=='production'||(int)$s['point']!==15||$s['auto_enabled'])throw new RuntimeException('Invalid destination configuration');
foreach(['arca_invoices'=>'fusion_arca_invoices','arca_series'=>'fusion_arca_series','arca_ml_sales'=>'fusion_arca_ml_sales','arca_whatsapp'=>'fusion_arca_whatsapp'] as $name=>$suffix)if((int)$wpdb->get_var('SELECT COUNT(*) FROM '.$wpdb->prefix.$suffix)!==$cut['counts'][$name])throw new RuntimeException('History changed before activation');
if((int)$wpdb->get_var("SELECT COUNT(*) FROM ".\FusionBikes\ARCA\Plugin::table()." WHERE status='pending' AND environment='production'"))throw new RuntimeException('Pending fiscal records');
fusion_arca_source(['action'=>'gate']);
$r=new WP_REST_Request('POST');$r->set_header('Content-Type','application/json');$r->set_body('{"service":"wsfe"}');$connection=\FusionBikes\ARCA\Plugin::boot()->connection($r);if(empty($connection['point_ready']))throw new RuntimeException('Point not available');
$client=new \FusionBikes\ARCA\Client('production',$s['cuit']);$last=[];
foreach([1=>'A',6=>'B',3=>'NC_A',8=>'NC_B'] as $type=>$label){
 $reply=$client->call('FECompUltimoAutorizado',['PtoVta'=>15,'CbteTipo'=>$type]);$number=\FusionBikes\ARCA\Diagnostics::last_number($reply,15,$type);
 $scope=hash('sha256','production|'.$s['cuit'].'|15|'.$type);$local=(int)$wpdb->get_var($wpdb->prepare("SELECT COALESCE(MAX(number),0) FROM ".\FusionBikes\ARCA\Plugin::table()." WHERE environment='production' AND status='authorized' AND scope=%s",$scope));
 if($number!==$local)throw new RuntimeException('History and ARCA numbering differ: '.$label);$last[$label]=$number;
}
fusion_arca_source(['action'=>'gate']);
$raw=(array)get_option('fusion_arca_settings');$raw['production_enabled']=true;$raw['auto_enabled']=false;$raw['auto_statuses']=[];$cut['state']='active';$cut['enabled_at']=gmdate('Y-m-d H:i:s');
if($wpdb->query('START TRANSACTION')===false)throw new RuntimeException('Transaction unavailable');
try{
 foreach(['fusion_arca_settings'=>$raw,'fusion_arca_vps_enabled'=>true,'fusion_arca_vps_cutover'=>$cut] as $name=>$value){
  update_option($name,$value,false);$stored=maybe_unserialize($wpdb->get_var($wpdb->prepare("SELECT option_value FROM {$wpdb->options} WHERE option_name=%s",$name)));if(is_bool($value)?(bool)$stored!==$value:$stored!==$value)throw new RuntimeException('Activation not persisted');
 }
 if($wpdb->query('COMMIT')===false)throw new RuntimeException('Activation commit failed');
}catch(Throwable $e){$wpdb->query('ROLLBACK');throw $e;}
echo wp_json_encode(['active'=>true,'environment'=>'production','point'=>15,'last_numbers'=>$last,'automatic'=>false,'history_count'=>$cut['counts']['arca_invoices'],'source_stopped'=>true,'issued_during_validation'=>0]);
'''
r=subprocess.run(['docker','exec','-i','-u','www-data','fusion-management-migration-php-1','php'],input=code,text=True,capture_output=True,timeout=120)
assert r.returncode==0,r.stderr
result=json.loads(r.stdout);release['activation']=result;release['enabled_at']=datetime.datetime.now(datetime.timezone.utc).isoformat();(root/'arca-cutover-release.json').write_text(json.dumps(release,indent=2));print(json.dumps(result))
subprocess.run(['systemctl','start','fusion-arca-outbox.service'],check=True,capture_output=True)
