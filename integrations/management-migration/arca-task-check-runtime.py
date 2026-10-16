import subprocess,json
code='''<?php require '/var/www/html/wp-load.php'; require_once FUSION_ARCA_DIR.'includes/class-pdf.php';
$out=['vps_enabled'=>(bool)get_option('fusion_arca_vps_enabled'),'production_enabled'=>\\FusionBikes\\ARCA\\Plugin::settings()['production_enabled']];
try{$products=fusion_arca_source(['action'=>'products','ids'=>[70394]]);$out['product_identity_available']=count($products)>0;\\FusionBikes\\ARCA\\VPS\\WooMirror::hydrateProducts($products);$p=wc_get_product(70394);$out['product_native']=(bool)$p;$out['requires_serial']=$p?\\FusionBikes\\ARCA\\Plugin::is_bicycle($p):null;}catch(Throwable $e){$out['product_error']=$e->getMessage();}
try{fusion_arca_source(['action'=>'gate']);$out['gate']='unexpected-open';}catch(Throwable $e){$out['gate']='closed-before-cutover';}
$p=\\FusionBikes\\ARCA\\Plugin::boot();foreach(['wsfe','padron'] as $service){try{$r=new WP_REST_Request('POST');$r->set_header('Content-Type','application/json');$r->set_body(json_encode(['service'=>$service]));$result=$p->connection($r);$out[$service]=['connected'=>true,'point_ready'=>$result['point_ready']??null];}catch(Throwable $e){$out[$service]=['connected'=>false,'error'=>$e->getMessage()];}}
global $wpdb;$id=(int)$wpdb->get_var("SELECT id FROM ".\\FusionBikes\\ARCA\\Plugin::table()." WHERE status='authorized' AND environment='production' ORDER BY id DESC LIMIT 1");try{$bytes=\\FusionBikes\\ARCA\\InvoicePdf::bytes(\\FusionBikes\\ARCA\\Plugin::record($id));$out['pdf']=['valid'=>str_starts_with($bytes,'%PDF-'),'bytes'=>strlen($bytes)];}catch(Throwable $e){$out['pdf']=['error'=>$e->getMessage()];}
echo json_encode($out,JSON_UNESCAPED_UNICODE);'''
r=subprocess.run(['docker','exec','-i','-u','www-data','fusion-management-migration-php-1','php'],input=code,text=True,capture_output=True,timeout=120);assert r.returncode==0,'Runtime check failed';print(r.stdout)
for unit in ['fusion-arca-egress.service','fusion-arca-source.service','fusion-management-validation.service','fusion-arca-outbox.timer']:
 print(unit,subprocess.check_output(['systemctl','is-active',unit],text=True).strip())
