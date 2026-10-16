import subprocess
code=r'''<?php require '/var/www/html/wp-load.php';global $wpdb;
$rows=$wpdb->get_results("SELECT id,payload FROM ".\FusionBikes\ARCA\Plugin::table()." WHERE environment='production' AND status='authorized' AND order_id=0 ORDER BY id ASC",ARRAY_A);$selected=0;
foreach($rows as $row){$p=json_decode($row['payload'],true);if((int)($p['point']??0)===15&&empty($p['ml'])&&!empty($p['cae'])){$selected=(int)$row['id'];break;}}
if(!$selected)throw new RuntimeException('No unchanged manual invoice available for idempotence check');
$record=\FusionBikes\ARCA\Plugin::record($selected);$reply=fusion_arca_source(['action'=>'sync_invoice','record'=>$record]);
if(empty($reply['synced'])||(int)$reply['invoice_id']!==$selected)throw new RuntimeException('Fiscal archive did not confirm');
echo json_encode(['idempotent_receipt'=>true,'existing_manual_invoice'=>$selected,'order_mutations'=>0,'new_invoices'=>0]);
'''
r=subprocess.run(['docker','exec','-i','-u','www-data','fusion-management-migration-php-1','php'],input=code,text=True,capture_output=True,timeout=60);print(r.stdout);assert r.returncode==0,r.stderr
