<?php
/** Private, authenticated VPS integration. Never install on the shop. */
if (!defined('ABSPATH')) exit;
define('FUSION_ARCA_VPS_MIRROR',true);
require_once __DIR__.'/arca-adapter/woo-mirror.php';
\FusionBikes\ARCA\VPS\WooMirror::registerFilters();

// Private Woo installation uses its original field contract with Spanish labels.
function fusion_arca_vps_labels(array $fields): array {
    $labels=['first_name'=>'Nombre','last_name'=>'Apellido','company'=>'Razón social','country'=>'País','address_1'=>'Domicilio','address_2'=>'Piso / departamento','city'=>'Localidad','state'=>'Provincia','postcode'=>'Código postal','phone'=>'Teléfono','email'=>'Correo electrónico'];
    foreach($fields as $key=>&$field){$name=preg_replace('/^billing_/','',$key);if(isset($labels[$name])){$field['label']=$labels[$name];if(!empty($field['placeholder']))$field['placeholder']='';}}unset($field);return $fields;
}
add_filter('woocommerce_checkout_fields',static function($fields){if(isset($fields['billing']))$fields['billing']=fusion_arca_vps_labels($fields['billing']);return $fields;},100);
add_filter('woocommerce_get_country_locale',static function($locale){if(isset($locale['AR']))$locale['AR']=fusion_arca_vps_labels($locale['AR']);return $locale;},100);
add_filter('woocommerce_get_country_locale_default','fusion_arca_vps_labels',PHP_INT_MAX);
add_filter('woocommerce_default_address_fields','fusion_arca_vps_labels',PHP_INT_MAX);
add_filter('woocommerce_billing_fields','fusion_arca_vps_labels',PHP_INT_MAX);

function fusion_arca_source(array $data): array {
    $proxy=json_decode(file_get_contents('/opt/fusion-arca-private/proxy.json'),true,512,JSON_THROW_ON_ERROR);
    $body=wp_json_encode($data);$stamp=(string)time();
    $curl=curl_init('http://'.$proxy['host'].':8216/api');
    curl_setopt_array($curl,[CURLOPT_POST=>true,CURLOPT_POSTFIELDS=>$body,CURLOPT_RETURNTRANSFER=>true,CURLOPT_CONNECTTIMEOUT=>5,CURLOPT_TIMEOUT=>65,CURLOPT_FOLLOWLOCATION=>false,CURLOPT_HTTPHEADER=>['Content-Type: application/json','X-Arca-Time: '.$stamp,'X-Arca-Signature: '.hash_hmac('sha256',$stamp."\n".$body,$proxy['password'])]]);
    $raw=curl_exec($curl);$status=curl_getinfo($curl,CURLINFO_RESPONSE_CODE);curl_close($curl);
    $reply=is_string($raw)?json_decode($raw,true):null;
    if($status!==200||!is_array($reply)||empty($reply['ok']))throw new RuntimeException($reply['message']??'No se pudo comprobar el pedido en la tienda. No se emitió desde esta solicitud.');
    return $reply['data'];
}
function fusion_arca_vps_order_lock(int $id): void {
    global $wpdb;static $held=[];if(isset($held[$id]))return;
    $key='fusion_vps_order_'.$id;
    if((int)$wpdb->get_var($wpdb->prepare('SELECT GET_LOCK(%s,0)',$key))!==1)throw new RuntimeException('Este pedido está abierto en otra operación. Esperá y volvé a intentar.');
    $held[$id]=true;register_shutdown_function(static function()use($key){global $wpdb;$wpdb->get_var($wpdb->prepare('SELECT RELEASE_LOCK(%s)',$key));});
}
function fusion_arca_vps_hydrate(int $id): void {
    fusion_arca_vps_order_lock($id);$source=fusion_arca_source(['action'=>'order','id'=>$id]);
    \FusionBikes\ARCA\VPS\WooMirror::hydrateOrder($source['order'],$source['products'],$source['refunds']);
}
function fusion_arca_vps_sync(int $id): bool {
    global $wpdb;$lock='fusion_vps_sync_'.$id;if((int)$wpdb->get_var($wpdb->prepare('SELECT GET_LOCK(%s,0)',$lock))!==1)return false;
    try {$row=\FusionBikes\ARCA\Plugin::record($id);if($row['environment']!=='production'||$row['status']!=='authorized'||!empty($row['payload']['ml']))return false;
        fusion_arca_source(['action'=>'sync_invoice','record'=>$row]);update_option('fusion_arca_vps_ack_'.$id,['at'=>gmdate('c'),'cae_hash'=>hash('sha256',$row['payload']['cae'])],false);delete_option('fusion_arca_vps_outbox_'.$id);return true;
    }catch(Throwable $e){$old=(array)get_option('fusion_arca_vps_outbox_'.$id,[]);$attempts=min(20,(int)($old['attempts']??0)+1);update_option('fusion_arca_vps_outbox_'.$id,['at'=>gmdate('c'),'attempts'=>$attempts,'next_attempt'=>time()+min(3600,60*(2**min(6,$attempts-1))),'message'=>'Pendiente de sincronización con la tienda.'],false);return false;}
    finally{$wpdb->get_var($wpdb->prepare('SELECT RELEASE_LOCK(%s)',$lock));}
}
add_action('fusion_arca_invoice_authorized',static function($id,$payload,$environment){
    if($environment!=='production'||!empty($payload['ml']))return;
    update_option('fusion_arca_vps_outbox_'.(int)$id,['at'=>gmdate('c')],false);fusion_arca_vps_sync((int)$id);
},100,3);

add_filter('rest_pre_dispatch',static function($result,$server,$r){
    if($result!==null||strpos($r->get_route(),'/fusion-arca/v1/')!==0)return $result;
    $route=$r->get_route();$v=(array)$r->get_json_params();
    try {
        if($r->get_method()==='POST'&&array_diff(array_keys($r->get_query_params()),['rest_route']))throw new RuntimeException('Los parámetros fiscales deben enviarse en el cuerpo firmado de la solicitud.');
        if(preg_match('~^/fusion-arca/v1/(?:invoices|orders)/([1-9]\d*)(?:/|$)~',$route,$identity)&&isset($r['id'])&&(string)$r['id']!==$identity[1])throw new RuntimeException('El comprobante de la ruta no coincide con la solicitud.');
        if($r->get_method()==='POST'&&!get_option('fusion_arca_vps_enabled',false))throw new RuntimeException('La operación VPS no está habilitada.');
        if($r->get_method()==='POST'&&preg_match('~/invoices/\d+/(?:emit|internal|credit-note/emit)$~D',$route))fusion_arca_source(['action'=>'gate']);
        if($r->get_method()==='POST'&&str_ends_with($route,'/recover')&&($v['retry']??'')==='REENVIAR')fusion_arca_source(['action'=>'gate']);
        $oid=0;$invoice=null;
        if(preg_match('~^/fusion-arca/v1/orders/([1-9]\d*)$~D',$route,$match))$oid=(int)$match[1];
        elseif(preg_match('~^/fusion-arca/v1/invoices/([1-9]\d*)(?:/(?:emit|recover|internal|credit-note|credit-note/emit))?$~D',$route,$match)){
            $invoice=\FusionBikes\ARCA\Plugin::record((int)$match[1]);
            if(!in_array($invoice['status'],['authorized','internal'],true))$oid=(int)$invoice['order_id'];
            if($r->get_method()==='POST'&&!empty($invoice['payload']['ml']))throw new RuntimeException('La emisión de Mercado Libre todavía no está habilitada en el VPS.');
            if($r->get_method()==='POST'&&str_contains($route,'/credit-note')&&(int)($invoice['payload']['point']??0)!==15)throw new RuntimeException('Este corte habilita notas de crédito del punto de venta 15.');
        }elseif($route==='/fusion-arca/v1/invoices'&&$r->get_method()==='POST'){
            if(!empty($v['payload']['ml']))throw new RuntimeException('La emisión de Mercado Libre todavía no está habilitada en el VPS.');
            $oid=absint($v['payload']['order_id']??0);
            $ids=array_values(array_unique(array_filter(array_map(static fn($l)=>absint($l['product_id']??0),(array)($v['payload']['lines']??[])))));
            if($ids){$products=fusion_arca_source(['action'=>'products','ids'=>$ids]);\FusionBikes\ARCA\VPS\WooMirror::hydrateProducts($products);}
        }
        if($oid)fusion_arca_vps_hydrate($oid);
        return $result;
    }catch(Throwable $e){return new WP_Error('fusion_vps_fiscal',$e->getMessage(),['status'=>409]);}
},-50,3);
add_filter('rest_post_dispatch',static function($response,$server,$request){
    if(strpos($request->get_route(),'/fusion-arca/v1/')!==0||is_wp_error($response))return $response;
    $data=$response->get_data();
    if(is_array($data)&&!empty($data['id'])&&isset($data['print_url'])){
        $data['print_url']=home_url('/facturador/print?id='.(int)$data['id']);
        $cut=(array)get_option('fusion_arca_vps_cutover',[]);
        $new=$cut&&((int)$data['id']>(int)($cut['last_source_id']??PHP_INT_MAX)||($data['updated_at']??'')>=($cut['at']??'9999'));
        $data['source_sync_pending']=$data['status']==='authorized'&&$new&&!get_option('fusion_arca_vps_ack_'.(int)$data['id'],false);
        $response->set_data($data);
    }
    return $response;
},10,3);
add_action('template_redirect',static function(){
    if(!isset($_GET['fusion_vps_print']))return;
    if(!current_user_can('manage_woocommerce')){status_header(403);exit('Sin permiso.');}
    try {$row=\FusionBikes\ARCA\Plugin::record(absint($_GET['fusion_vps_print']));
        if(!in_array($row['status'],['authorized','internal'],true)){nocache_headers();header('Content-Type: text/html; charset=UTF-8');require FUSION_ARCA_DIR.'includes/print.php';exit;}
        require_once FUSION_ARCA_DIR.'includes/class-pdf.php';$bytes=\FusionBikes\ARCA\InvoicePdf::bytes($row);$filename=\FusionBikes\ARCA\InvoicePdf::filename($row);
        nocache_headers();header('Content-Type: application/pdf');header('Content-Disposition: inline; filename="'.sanitize_file_name($filename).'"');header('Content-Length: '.strlen($bytes));echo $bytes;exit;
    }catch(Throwable $e){status_header(409);exit(esc_html('No se pudo preparar el PDF. Abrí el comprobante y revisá su estado.'));}
},-100);
