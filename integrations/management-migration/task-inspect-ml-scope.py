from pathlib import Path
import subprocess
r=Path('/opt/fusion-management-migration')
assert (r/'.task-owner').read_text()=='fusion-management-migration-20261004'
php=r'''
require '/var/www/html/wp-load.php';
$s=\FusionBikes\ARCA\Plugin::settings();
$m=(array)get_option('fusion_arca_ml',[]);
$scope=$wpdb->get_results($wpdb->prepare('SELECT seller_id,COUNT(*) n FROM '.$wpdb->prefix.'fusion_arca_ml_sales WHERE environment=%s AND cuit=%s GROUP BY seller_id',$s['environment'],$s['cuit']),ARRAY_A);
$status=\FusionBikes\ARCA\MlClient::status();
echo json_encode(['scope_count'=>count($scope),'matching_rows'=>array_sum(array_column($scope,'n')),'configured_seller_matches'=>count($scope)===1 && ($m['seller_id']??'')===$scope[0]['seller_id'],'environment'=>$s['environment'],'production_enabled'=>$s['production_enabled'],'connected'=>$status['connected'],'has_secret'=>$status['has_secret'],'has_app_id'=>$status['app_id']!=='','automatic'=>$m['automatic']??false,'sync_enabled'=>$m['enabled']??false]);
'''
p=subprocess.run(['docker','exec','fusion-management-migration-php-1','php','-r',php],capture_output=True,text=True,check=True,timeout=25)
print(p.stdout)
