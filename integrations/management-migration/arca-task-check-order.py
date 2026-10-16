import subprocess
code=r'''<?php require '/var/www/html/wp-load.php';
global $wpdb;$records=$wpdb->get_results("SELECT id,order_id,payload FROM ".\FusionBikes\ARCA\Plugin::table()." WHERE environment='production' AND status='authorized' AND order_id>0 ORDER BY id DESC",ARRAY_A);
foreach($records as $r){$p=json_decode($r['payload'],true);if(!empty($p['ml']))continue;$id=(int)$r['order_id'];fusion_arca_vps_hydrate($id);$order=wc_get_order($id);$request=new WP_REST_Request('GET');$request['id']=$id;$row=\FusionBikes\ARCA\Plugin::boot()->order_draft($request);echo json_encode(['order'=>$id,'native_loaded'=>(bool)$order,'customer_fields_present'=>!empty($order->get_billing_first_name()),'lines'=>count($order->get_items()),'already_authorized_returned'=>$row['status']==='authorized','invoice_id'=>$row['id']]);break;}
'''
r=subprocess.run(['docker','exec','-i','-u','www-data','fusion-management-migration-php-1','php'],input=code,text=True,capture_output=True,timeout=100);print(r.stdout);assert r.returncode==0,r.stderr
