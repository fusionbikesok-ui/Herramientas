<?php
/**
 * Plugin Name: Fusion POS — Puente seguro VPS
 * Description: Recibe preparaciones firmadas del VPS y abre el checkout original con validación de WooCommerce y Master Control.
 * Version: 0.3.0
 * Requires PHP: 7.4
 * Author: Fusion Bikes
 */
namespace FusionBikes\PosVpsBridge;
if (!defined('ABSPATH')) exit;
const BRIDGE_KEY = '__FUSION_POS_VPS_KEY__';
const VERSION = '0.3.0';
const TTL = 172800;
function fail($code,$message,$status=409){return new \WP_Error($code,$message,['status'=>$status]);}
function valid_operation($v){return is_string($v)&&preg_match('/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/D',$v);}
function ready(){return class_exists('Fusion_Bikes_POS_Pro')&&class_exists('FusionBikes\\MasterControl\\Services\\PricingEngine')&&function_exists('wc_get_order');}
function auth($r){
 $ts=$r->get_header('x-fusion-pos-time');$sig=$r->get_header('x-fusion-pos-signature');$body=$r->get_body();
 if(strlen(BRIDGE_KEY)<64||strlen($body)>65536||!preg_match('/^[0-9]{10}$/D',$ts)||abs(time()-(int)$ts)>30||!hash_equals(hash_hmac('sha256',$ts."\n".hash('sha256',$body),BRIDGE_KEY),$sig))return fail('bridge_auth','Solicitud no autorizada.',403);
 return true;
}
function load_intent($op){$v=get_option('fusion_vps_pos_'.$op);return is_array($v)?$v:null;}
function record($op){$v=get_option('fbpos_operation_record_'.$op);return is_array($v['record']??null)?$v['record']:[];}
function order_for($op){
 $r=record($op);$o=!empty($r['order_id'])?wc_get_order($r['order_id']):null;
 if(!$o){$rows=wc_get_orders(['limit'=>1,'return'=>'objects','meta_key'=>'_fbpos_operation','meta_value'=>$op]);$o=$rows?$rows[0]:null;}
 return $o;
}
function clean_payload($d){
 $out=['operation'=>$d['operation'],'items'=>[],'quote_id'=>0,'price_key'=>'cash','factor'=>1,'plan'=>'','label'=>'Checkout de la tienda','combine'=>false,'embed'=>false,'gateway'=>'bacs','consumer_final'=>!empty($d['consumer_final']),'customer_id'=>absint($d['customer_id']??0),'billing'=>[]];
 if(!is_array($d['items']??null)||!count($d['items'])||count($d['items'])>100)return fail('items','Agregá productos válidos.',400);
 $seen=[];
 foreach($d['items'] as $x){
  if(!is_array($x)||!is_int($x['id']??null)||$x['id']<1||!is_int($x['qty']??null)||$x['qty']<1||$x['qty']>999||isset($seen[$x['id']]))return fail('items','Producto o cantidad inválida.',400);
  $seen[$x['id']]=true;$serials=[];foreach(array_slice((array)($x['serials']??[]),0,$x['qty']) as $v)$serials[]=substr(sanitize_text_field($v),0,120);
  $out['items'][]=['id'=>$x['id'],'qty'=>$x['qty'],'serials'=>$serials];
 }
 foreach(['customer_name','customer_email','customer_phone','customer_document','note'] as $k)$out[$k]=substr(sanitize_text_field($d[$k]??''),0,1000);
 foreach((array)($d['billing']??[]) as $k=>$v)if(preg_match('/^billing_[a-z_]+$/D',$k)&&is_scalar($v))$out['billing'][$k]=substr(sanitize_text_field($v),0,500);
 if($out['customer_id']&&(!get_userdata($out['customer_id'])||user_can($out['customer_id'],'manage_woocommerce')||user_can($out['customer_id'],'manage_options')))return fail('customer_forbidden','Seleccioná una cuenta de cliente.',403);
 $key=$d['price_key']??'cash';
 if(!in_array($key,['cash','promo3','plan3','plan6','plan9','plan12','plan18','plan24'],true))return fail('pricing_plan','Plan no disponible.',400);
 $out['price_key']=$key;$out['plan']=$key==='cash'?'':($key==='promo3'?'promo3':substr($key,4));
 $out['gateway']=$key==='cash'?'bacs':($key==='promo3'?'woo-mercado-pago-basic':'woo-mercado-pago-custom');
 $out['label']=$key==='cash'?'Contado':($key==='promo3'?'Promoción 3 cuotas':$out['plan'].' cuotas');
 if(isset($d['expected_total'])){if(!is_numeric($d['expected_total'])||!is_finite((float)$d['expected_total']))return fail('pricing_total','Importe inválido.',400);$out['expected_total']=round((float)$d['expected_total'],2);}
 return $out;
}
function pricing($items){
 $clean=clean_payload(['operation'=>'','items'=>$items]);if(is_wp_error($clean))return $clean;
 $data=new \FusionBikes\MasterControl\Services\DataService();$engine=new \FusionBikes\MasterControl\Services\PricingEngine($data);
 $base=0;$promo=true;$totals=array_fill_keys(['3','6','9','12','18','24'],0);$products=[];
 foreach($clean['items'] as $x){
  $p=wc_get_product($x['id']);if(!$p||$p->is_type('variable')||!$p->is_purchasable())return fail('pricing_product','Un producto ya no está disponible.',409);
  $unit=(float)$engine->getBasePrice($p);if(!is_finite($unit)||$unit<=0)return fail('pricing_price','Un producto no tiene un precio válido.',409);
  $line=$unit*$x['qty'];$base+=round($line,2);$products[]=['id'=>$x['id'],'unit'=>$unit];$promo=$promo&&$data->appliesNave($x['id']);
  foreach($totals as $plan=>$total){$coef=(float)$data->getCoefficient($x['id'],(string)$plan);$totals[$plan]=$total===null||!is_finite($coef)||$coef<=0?null:$total+ceil(round($line*$coef,8));}
 }
 $gateways=WC()->payment_gateways()->payment_gateways();$enabled=static function($id)use($gateways){return isset($gateways[$id])&&$gateways[$id]->enabled==='yes';};
 $plans=[];
 if($enabled('bacs'))$plans[]=['key'=>'cash','label'=>'Contado / transferencia','plan'=>'','count'=>1,'total'=>round($base,2),'gateway'=>'bacs'];
 if($promo&&$enabled('woo-mercado-pago-basic'))$plans[]=['key'=>'promo3','label'=>'Promoción 3 cuotas','plan'=>'promo3','count'=>3,'total'=>round($base,2),'gateway'=>'woo-mercado-pago-basic'];
 if($enabled('woo-mercado-pago-custom'))foreach($totals as $plan=>$total)if($total!==null)$plans[]=['key'=>'plan'.$plan,'label'=>$plan.' cuotas','plan'=>(string)$plan,'count'=>(int)$plan,'total'=>$total,'gateway'=>'woo-mercado-pago-custom'];
 if(!$plans)return fail('pricing_gateway','No hay medios de pago disponibles.',409);
 return ['plans'=>$plans,'products'=>$products,'quoted_at'=>time(),'source'=>'master-control'];
}
function summary($op,$intent){
 $o=order_for($op);
 if(!$o)return ['order_id'=>0,'state'=>'pending','status'=>!empty($intent['released'])?'Preparación cerrada':'Pendiente de finalizar en el checkout','paid'=>false,'released'=>!empty($intent['released'])];
 $fulfillment=$o->get_meta('_fbpos_fulfillment')?:null;$split=$o->get_meta('_fusion_split');$complete=!$split||($split['state']??'')==='paid';
 return ['operation'=>$op,'order_id'=>$o->get_id(),'number'=>$o->get_order_number(),'state'=>$o->get_status(),'status'=>wc_get_order_status_name($o->get_status()),'paid'=>$o->is_paid(),'manual_allowed'=>$complete&&$o->has_status('on-hold')&&in_array($o->get_payment_method(),['bacs','cheque','cod','fusion_custom_payment'],true),'retry_url'=>$o->needs_payment()?$o->get_checkout_payment_url():'','edit_url'=>$o->get_edit_order_url(),'total'=>html_entity_decode(wp_strip_all_tags($o->get_formatted_order_total()),ENT_QUOTES|ENT_HTML5,'UTF-8'),'invoice_url'=>'','can_invoice'=>$o->is_paid()&&(bool)$fulfillment&&$complete,'has_cae'=>(bool)$o->get_meta('afip_cae'),'fulfillment'=>$fulfillment,'receipts'=>[],'message'=>!$o->is_paid()?'El pedido está pendiente de confirmar el cobro.':(!$fulfillment?'Registrá el retiro o envío para continuar con la factura.':'Cobro y entrega registrados. Podés abrir el facturador del VPS.')];
}
function native_order_action($action,$op,$intent,$d){
 $o=order_for($op);$uid=(int)($intent['user_id']??0);
 if(!$uid||!$o||!$o->get_meta('_fbpos_source')||(int)$o->get_meta('_fbpos_user_id')!==$uid||(!user_can($uid,'manage_woocommerce')&&!user_can($uid,'manage_options')))return fail('order_owner','No se pudo verificar al operador de este pedido.',403);
 if($action==='manual-receipt'&&($d['confirmed']??null)!==true)return fail('receipt_confirm','Confirmá que recibiste el dinero.',400);
 if($action==='fulfillment'&&!in_array($d['mode']??'',['pickup','shipping'],true))return fail('fulfillment_mode','Elegí retiro o envío.',400);
 $before=get_current_user_id();wp_set_current_user($uid);
 try{
  $route=$action==='manual-receipt'?'/fbpos/v2/manual-receipt':'/fbpos/v2/fulfillment/'.$o->get_id();
  $request=new \WP_REST_Request('POST',$route);$request->set_header('content-type','application/json');$request->set_body(wp_json_encode(['operation'=>$op,'confirmed'=>true,'mode'=>$d['mode']??'']));
  $result=rest_do_request($request);if($result->is_error())return $result->as_error();
  return summary($op,$intent);
 }finally{wp_set_current_user($before);}
}
function command($r){
 if(!ready())return fail('bridge_dependency','Se requiere POS Pro, WooCommerce y Master Control activos.',503);
 $d=$r->get_json_params();$action=$d['action']??'';$op=$d['operation']??'';$actor=$d['actor']??'';
 if(!is_string($actor)||!preg_match('/^[a-f0-9]{64}$/D',$actor))return fail('bridge_input','Preparación inválida.',400);
 if($action==='pricing')return pricing($d['items']??[]);
 if($action==='order-read'){
  $order=wc_get_order(absint($d['order_id']??0));$op=$order?(string)$order->get_meta('_fbpos_operation'):'';
 }
 if(!valid_operation($op))return fail('operation_missing','No se encontró un pedido del POS VPS.',404);
 $intent=load_intent($op);
 if($intent&&!hash_equals($intent['actor'],$actor))return fail('bridge_owner','Esta operación pertenece a otro operador.',403);
 if($action==='prepare'){
  $payload=clean_payload($d);if(is_wp_error($payload))return $payload;
  $hash=hash('sha256',wp_json_encode($payload));
  if(!$intent){
   $quote=pricing($payload['items']);if(is_wp_error($quote))return $quote;
   $selected=null;foreach($quote['plans'] as $plan)if($plan['key']===$payload['price_key'])$selected=$plan;
   if(!$selected)return fail('pricing_plan','El plan ya no está disponible. Revisá las opciones.',409);
   if(isset($payload['expected_total'])&&abs($selected['total']-$payload['expected_total'])>0.009)return fail('pricing_changed','El precio cambió. Actualizá las opciones antes de cobrar.',409);
   $intent=['actor'=>$actor,'hash'=>$hash,'payload'=>$payload,'expires'=>time()+TTL,'token'=>bin2hex(random_bytes(24)),'released'=>false];
   if(!add_option('fusion_vps_pos_'.$op,$intent,'','no'))$intent=load_intent($op);
  }
  if(!hash_equals($intent['actor'],$actor)||!hash_equals($intent['hash'],$hash))return fail('operation_conflict','La preparación cambió. Cerrala antes de editar.');
  if($intent['released']||$intent['expires']<time())return fail('operation_closed','La preparación está cerrada. Iniciá otra.');
  set_transient('fusion_vps_link_'.$intent['token'],$op,max(1,$intent['expires']-time()));
  return ['order_id'=>0,'operation'=>$op,'payment_url'=>add_query_arg('fbpos_vps_open',$intent['token'],home_url('/')),'status_url'=>'vps','checkout_mode'=>true];
 }
 if(!$intent)return fail('operation_missing','No se encontró la preparación.',404);
 if(in_array($action,['status','order-read'],true))return summary($op,$intent);
 if(in_array($action,['manual-receipt','fulfillment'],true))return native_order_action($action,$op,$intent,$d);
 if($action==='release'){
  $lock='fbpos_checkout_lock_'.$op;
  if(!add_option($lock,time(),'','no'))return fail('release_busy','El checkout está procesando la venta. Actualizá el estado.');
  try{
   if(order_for($op))return fail('release_order','Ya existe un pedido. Consultá su estado antes de iniciar otra venta.');
   $intent['released']=true;update_option('fusion_vps_pos_'.$op,$intent,false);
   $rec=record($op);$rec['released']=true;update_option('fbpos_operation_record_'.$op,['record'=>$rec,'expires'=>$intent['expires']],false);
   return ['released'=>true];
  }finally{delete_option($lock);}
 }
 return fail('bridge_action','Acción no disponible.',400);
}
function open_checkout(){
 if(empty($_GET['fbpos_vps_open']))return;
 nocache_headers();header('Referrer-Policy: no-referrer');
 $token=(string)wp_unslash($_GET['fbpos_vps_open']);
 if(!preg_match('/^[a-f0-9]{48}$/D',$token))wp_die('Enlace inválido.','',['response'=>400]);
 if(!is_user_logged_in()){wp_safe_redirect(wp_login_url(add_query_arg('fbpos_vps_open',$token,home_url('/'))));exit;}
 if(!current_user_can('manage_woocommerce')&&!current_user_can('manage_options'))wp_die('Ingresá con una cuenta de gestión de la tienda.','',['response'=>403]);
 if(!ready())wp_die('El checkout del POS no está disponible.','',['response'=>503]);
 $op=get_transient('fusion_vps_link_'.$token);$intent=$op?load_intent($op):null;
 if(!$intent||$intent['expires']<time()||$intent['released']||!hash_equals($intent['token'],$token))wp_die('La preparación venció o se cerró. Volvé al POS.','',['response'=>410]);
 $lock='fbpos_checkout_lock_'.$op;
 if(!add_option($lock,time(),'','no'))wp_die('El checkout está procesando esta operación. Volvé a intentar.','',['response'=>409]);
 add_action('shutdown',function()use($lock){delete_option($lock);});
 try{
  $intent=load_intent($op);
  if($intent['released'])wp_die('La preparación se cerró.','',['response'=>409]);
  if(!empty($intent['user_id'])&&(int)$intent['user_id']!==get_current_user_id())wp_die('Esta preparación ya está abierta por otro operador.','',['response'=>403]);
  $intent['user_id']=get_current_user_id();update_option('fusion_vps_pos_'.$op,$intent,false);
  $existing=order_for($op);
  if($existing){wp_safe_redirect($existing->needs_payment()?$existing->get_checkout_payment_url():$existing->get_checkout_order_received_url());exit;}
  // Preserve the native POS replay and session checks for opened carts.
  $payload=get_transient('fbpos_checkout_'.$token);
  if(!$payload){
   if(!empty($intent['opened']))wp_die('Esta preparación ya se abrió. Revisá el checkout o cerrala desde el POS.','',['response'=>409]);
   $payload=$intent['payload'];$payload['user_id']=get_current_user_id();
   $engine=new \FusionBikes\MasterControl\Services\PricingEngine(new \FusionBikes\MasterControl\Services\DataService());
   foreach($payload['items'] as &$item){$product=wc_get_product($item['id']);if(!$product)wp_die('Un producto ya no está disponible.');$item['unit']=$engine->getBasePrice($product);}unset($item);
   set_transient('fbpos_checkout_'.$token,$payload,max(1,$intent['expires']-time()));
   update_option('fbpos_operation_record_'.$op,['record'=>['user_id'=>get_current_user_id(),'order_id'=>0],'expires'=>$intent['expires']],false);
   $intent['opened']=true;update_option('fusion_vps_pos_'.$op,$intent,false);
  }
 }finally{delete_option($lock);}
 // Native embedded markup disables Master Control's financing controls. Use the full checkout.
 add_filter('wp_redirect',__NAMESPACE__.'\\full_checkout_redirect',999,2);
 $_GET['fbpos_checkout']=$token;
}
function full_checkout_redirect($url,$status=302){
 if(wp_parse_url($url,PHP_URL_HOST)===wp_parse_url(home_url('/'),PHP_URL_HOST))return remove_query_arg('fbpos_embed',$url);
 return $url;
}
add_filter('woocommerce_get_return_url',function($url,$order){return $order&&load_intent((string)$order->get_meta('_fbpos_operation'))?full_checkout_redirect($url):$url;},100,2);
add_action('rest_api_init',function(){
 register_rest_route('fusion-vps-pos/v1','/health',['methods'=>'GET','permission_callback'=>'__return_true','callback'=>function(){return ['version'=>VERSION,'ready'=>ready()];}]);
 register_rest_route('fusion-vps-pos/v1','/command',['methods'=>'POST','permission_callback'=>__NAMESPACE__.'\\auth','callback'=>__NAMESPACE__.'\\command']);
});
add_filter('rest_post_dispatch',function($response,$server,$request){if(strpos($request->get_route(),'/fusion-vps-pos/v1/')===0){$response=rest_ensure_response($response);$response->header('Cache-Control','private, no-store');}return $response;},10,3);
add_action('template_redirect',__NAMESPACE__.'\\open_checkout',-20);
