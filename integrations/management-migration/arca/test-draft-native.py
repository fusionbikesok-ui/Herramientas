import subprocess,json,re
db='fusion-management-migration-db-1';php='fusion-management-migration-php-1';qa='fusion_arca_draft_qa_20261005'
def sql(query):
 r=subprocess.run(['docker','exec','-i',db,'sh','-c','exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD"'],input=query,text=True,capture_output=True)
 assert r.returncode==0,'QA SQL failed'
 return r.stdout
info=json.loads(subprocess.check_output(['docker','inspect',db]))[0];env=dict(x.split('=',1) for x in info['Config']['Env'] if '=' in x);user=env['MYSQL_USER'];assert re.fullmatch('[a-zA-Z0-9_]+',user)
assert qa not in sql('SHOW DATABASES;')
dump=subprocess.run(['docker','exec',db,'sh','-c','exec mysqldump --no-tablespaces --single-transaction --skip-comments -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE"'],capture_output=True,text=True);assert dump.returncode==0
sql('CREATE DATABASE '+qa+'; GRANT ALL ON '+qa+'.* TO `'+user+'`@`%`; USE '+qa+';\n'+dump.stdout)
code=r'''<?php
require '/var/www/html/wp-load.php';
if(DB_NAME!=='fusion_arca_draft_qa_20261005')throw new RuntimeException('Wrong DB');
function verify($v,$label){if(!$v)throw new RuntimeException($label);echo 'PASS '.$label."\n";}
update_option('fusion_arca_vps_enabled',true,false);
$users=get_users(['role'=>'administrator','number'=>1]);wp_set_current_user($users[0]->ID);
$before=(int)$wpdb->get_var("SELECT COUNT(*) FROM ".\FusionBikes\ARCA\Plugin::table()." WHERE status='authorized'");
$payload=['authorization'=>'arca','currency'=>'ARS','type'=>6,'date'=>wp_date('Y-m-d'),'concept'=>1,'order_id'=>0,'customer'=>['name'=>'PRUEBA AISLADA','document'=>'12345678','document_type'=>96,'vat_condition'=>5,'address'=>'Prueba 123'],'lines'=>[['product_id'=>70394,'name'=>'Bicicleta de RUTA - TREK DOMANE SL4 - GEN 5 — Negro / S','quantity'=>1,'total'=>4450000,'vat'=>'21','serials'=>['PRUEBA-NO-FISCAL']]],'notes'=>'QA: base descartable'];
function req($path,$body=null){$r=new WP_REST_Request($body===null?'GET':'POST','/fusion-arca/v1/'.$path);if($body!==null){$r->set_header('Content-Type','application/json');$r->set_body(wp_json_encode($body));}return apply_filters('rest_post_dispatch',rest_do_request($r),rest_get_server(),$r);}
$r=req('invoices',['payload'=>$payload]);verify($r->get_status()===200,'guardar borrador nativo');$a=$r->get_data();$id=$a['id'];verify($a['status']==='draft'&&$a['payload']['point']===15,'borrador punto 15');verify($a['payload']['lines'][0]['sku']==='FB-70394','identidad SKU nativa');verify($a['payload']['lines'][0]['requires_serial']===true,'serie obligatoria para bicicleta');verify((float)$a['payload']['totals']['gross']===4450000.0,'precio final sin transformación ML');verify(str_contains($a['print_url'],'/facturador/print?id='),'PDF ruta privada');
$read=req('invoices/'.$id);verify($read->get_status()===200&&$read->get_data()['payload']===$a['payload'],'leer borrador idéntico');
$r=req('invoices',['id'=>$id,'revision'=>$a['revision'],'payload'=>$payload]);verify($r->get_status()===200&&$r->get_data()['revision']===$a['revision']+1,'actualizar con revisión');
$stale=req('invoices',['id'=>$id,'revision'=>$a['revision'],'payload'=>$payload]);verify($stale->get_status()>=400,'bloquear revisión antigua');
$bad=new WP_REST_Request('POST','/fusion-arca/v1/invoices/'.$id.'/recover');$bad->set_query_params(['retry'=>'REENVIAR']);$bad->set_body('{}');$bad->set_header('Content-Type','application/json');verify(rest_do_request($bad)->get_status()>=400,'bloquear mutación por query');
$after=(int)$wpdb->get_var("SELECT COUNT(*) FROM ".\FusionBikes\ARCA\Plugin::table()." WHERE status='authorized'");verify($after===$before,'ninguna factura autorizada durante QA');
echo '11 verificaciones completas; no se invocó emisión.';
'''
try:
 r=subprocess.run(['docker','exec','-i','-e','WORDPRESS_DB_NAME='+qa,php,'php'],input=code,text=True,capture_output=True,timeout=120);print(r.stdout);assert r.returncode==0,r.stderr
finally:
 sql('DROP DATABASE `'+qa+'`; REVOKE ALL ON `'+qa+'`.* FROM `'+user+'`@`%`;');print('Base QA eliminada; base fiscal real intacta.')
