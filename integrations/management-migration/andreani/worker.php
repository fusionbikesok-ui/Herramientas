<?php
// Private data-to-document adapter. Never loads WordPress or executes commerce hooks.
declare(strict_types=1);
define('ABSPATH', __DIR__.'/');
define('FBAM_PATH', __DIR__.'/');
ini_set('display_errors','0');
function fm_reply(array $value,int $status=200):void {http_response_code($status);header('Content-Type: application/json; charset=utf-8');echo json_encode($value,JSON_UNESCAPED_UNICODE|JSON_THROW_ON_ERROR);}
function fm_auth(string $body):bool {
 $key=(string)getenv('FUSION_MANAGEMENT_SIGNING_KEY');$raw=$_SERVER['HTTP_X_FUSION_CLAIM']??'';$signature=$_SERVER['HTTP_X_FUSION_SIGNATURE']??'';
 if(strlen($key)<64||strlen($raw)>2048||!preg_match('/^[a-f0-9]{64}$/D',$signature)||!hash_equals(hash_hmac('sha256',$raw,$key),$signature))return false;
 $claim=json_decode(base64_decode($raw,true)?:'',true);
 return is_array($claim)&&is_string($claim['user']??null)&&$claim['user']!==''&&($claim['method']??'')==='POST'&&($_SERVER['REQUEST_METHOD']??'')==='POST'&&($claim['uri']??'')===($_SERVER['REQUEST_URI']??'')&&abs(time()-(int)($claim['time']??0))<=20&&hash_equals(hash('sha256',$body),(string)($claim['sha256']??''));
}
// Minimal explicit adapters for the unmodified 1.1.2 business classes below.
function remove_accents($text){return transliterator_transliterate('Latin-ASCII',(string)$text);}
function sanitize_text_field($text){$text=strip_tags((string)$text);$text=preg_replace('/[\r\n\t ]+/u',' ',$text);return trim(preg_replace('/%[a-f0-9]{2}/i','',$text));}
function absint($v){return abs((int)$v);}
function is_wp_error($v){return false;}
function is_email($v){return filter_var($v,FILTER_VALIDATE_EMAIL)!==false;}
function get_option($name,$default=[]){return $name==='fbam_settings'?($GLOBALS['fm_context']['settings']??$default):$default;}
function get_terms($args){return array_map(fn($c)=>(object)['term_id'=>$c['id'],'name'=>$c['name'],'slug'=>$c['slug']],$GLOBALS['fm_context']['options']['categories']??[]);}
function wp_get_post_terms($id,$tax,$args){return $GLOBALS['fm_context']['products'][(string)$id]['category_ids']??[];}
function get_ancestors($id,$tax,$type){return []; /* Local dimensions already contain every ancestor. */}
function wp_tempnam($name){return tempnam(sys_get_temp_dir(),'fbam-');}
function wc_get_order_status_name($status){foreach($GLOBALS['fm_context']['options']['statuses']??[] as $s)if($s['key']==='wc-'.$status)return $s['label'];return $status;}
function WC(){return (object)['countries'=>new class{function get_states($country){return $GLOBALS['fm_context']['options']['states'][$country]??[];}}];}
class FM_Product {
 private array $p;
 function __construct(array $p){$this->p=$p;}
 function get_id(){return (int)$this->p['id'];}
 function get_parent_id(){return (int)($this->p['parent_id']??0);}
 function is_virtual(){return (bool)$this->p['virtual'];}
}
class FM_Item {
 private array $item;
 function __construct(array $item){$this->item=$item;}
 function get_quantity(){return $this->item['quantity'];}
 function get_name(){return $this->item['name'];}
 function get_product(){ $id=$this->item['variation_id']?:$this->item['product_id'];$p=$GLOBALS['fm_context']['products'][(string)$id]??null;if(!$p||!$p['exists'])return false;if(!array_key_exists('virtual',$p))throw new RuntimeException('El catálogo de envíos todavía no está sincronizado.');return new FM_Product($p); }
}
class FM_Date {
 private string $date;
 function __construct(string $date){$this->date=$date;}
 function date_i18n(string $format){return (new DateTimeImmutable($this->date,new DateTimeZone('UTC')))->setTimezone(new DateTimeZone($GLOBALS['fm_context']['options']['timezone']??'America/Argentina/Buenos_Aires'))->format($format);}
}
class FM_Order {
 private array $o;
 function __construct(array $order){$this->o=$order;}
 function get_id(){return $this->o['id'];}
 function get_order_number(){return $this->o['number'];}
 function get_status(){return $this->o['status'];}
 function get_currency(){return $this->o['currency'];}
 function get_address($kind){return $this->o[$kind];}
 function get_shipping_phone(){return $this->o['shipping']['phone']??'';}
 function get_billing_phone(){return $this->o['billing']['phone']??'';}
 function get_billing_email(){return $this->o['billing']['email']??'';}
 function get_items(){return array_map(fn($i)=>new FM_Item($i),$this->o['items']);}
 function get_meta($key,$single=true){if($key==='_shipping_dni')return $this->o['shipping_document']??'';return ['_fbam_draft'=>$this->o['andreani']['draft']??null,'_fbam_exported_at'=>$this->o['andreani']['exported_at']??''][$key]??'';}
 function get_date_created(){return empty($this->o['created_at'])?null:new FM_Date($this->o['created_at']);}
 function get_shipping_methods(){return array_map(fn($name)=>new class($name){private string $name;function __construct($name){$this->name=$name;}function get_name(){return $this->name;}},$this->o['shipping_methods']??[]);}
 function get_edit_order_url(){return 'https://fusionbikes.com.ar/wp-admin/admin.php?page=wc-orders&action=edit&id='.(int)$this->o['id'];}
}
require_once __DIR__.'/includes/class-phone.php';require_once __DIR__.'/includes/class-address.php';require_once __DIR__.'/includes/class-data.php';require_once __DIR__.'/includes/class-exporter.php';
function fm_order_observations(FM_Order $order,array $draft):array {
 $notes=FBAM_Data::text($draft['observations']??'');
 // Replace the title inserted by earlier versions, retaining delivery notes.
 foreach($order->get_items() as $item){
  if((float)$item->get_quantity()<=0)continue;
  $product=$item->get_product();if($product&&$product->is_virtual())continue;
  $title=FBAM_Data::text(html_entity_decode($item->get_name(),ENT_QUOTES|ENT_HTML5,'UTF-8'));
  if($title==='')continue;
  $notes=preg_replace('/(^|;\s*)'.preg_quote($title,'/').'(?=\s*;|$)/u','$1',$notes);
  $notes=implode('; ',array_values(array_filter(array_map('trim',explode(';',$notes)),fn($part)=>$part!=='')));
  break;
 }
 $number=FBAM_Data::text($order->get_order_number())?:strval($order->get_id());
 $draft['observations']=FBAM_Address::notes('Pedido #'.$number,$notes);
 return $draft;
}
function fm_order_draft(array $raw):array {
 $order=new FM_Order($raw);$row=FBAM_Data::draft($order);
 $stored=$raw['andreani']['draft']['packages']??null;
 $row['draft']=fm_package_rules($order,fm_order_observations($order,$row['draft']),$stored);
 $row['auto_package']['profile_mode']='auto';$row['errors']=FBAM_Data::validate($row['draft']);return $row;
}
function fm_package_rules(FM_Order $order,array $draft,?array $original):array {
 $automatic=FBAM_Data::package_profiles()[FBAM_Data::package_for_order($order)];
 foreach($draft['packages'] as $i=>&$parcel){
  $raw=$original[$i]??$parcel;$mode=$raw['profile_mode']??'';
  // Earlier single-parcel preset drafts were automatic, but retained an obsolete
  // 'other' profile after migration. Keep custom boxes and multi-parcel choices.
  if(!in_array($mode,['auto','fixed'],true))$mode=($original===null||(count($draft['packages'])===1&&in_array($raw['profile']??'',['bike','other'],true)))?'auto':'fixed';
  if(($parcel['saved']??'')!==''||(($raw['profile']??'')==='manual'&&($raw['profile_mode']??'')!=='auto'))$mode='fixed';
  if($mode==='auto')$parcel=array_merge($parcel,$automatic,['value'=>FBAM_Data::DECLARED_VALUE]);
  $parcel['profile_mode']=$mode;
 }
 unset($parcel);return $draft;
}
function fm_process(array $input){
 $action=$input['action']??'';if(!in_array($action,['draft','normalize','phone','search','export'],true))throw new RuntimeException('Acción inválida.');
 $GLOBALS['fm_context']=$input;
 if($action==='phone')return FBAM_Phone::split($input['phone']??'');
 if($action==='search'){
  $kind=$input['kind']??'';if(!in_array($kind,['destinations','branches','today'],true))throw new RuntimeException('Lista inválida.');$q=FBAM_Data::norm(FBAM_Data::text($input['q']??''));if(strlen($q)<2)return [];
  $tokens=preg_split('/\s+/',$q);$out=[];foreach(FBAM_Data::catalog()[$kind] as $value){$norm=FBAM_Data::norm($value);$ok=true;foreach($tokens as $t)if(strpos($norm,$t)===false){$ok=false;break;}if($ok)$out[]=$value;if(count($out)>=40)break;}return $out;
 }
 $orders=$input['orders']??[];if(!is_array($orders)||count($orders)>100)throw new RuntimeException('Máximo 100 pedidos por tanda.');
 if($action==='draft')return array_map('fm_order_draft',$orders);
 if($action==='normalize'){
  if(count($orders)!==1||!is_array($input['draft']??null)||!is_array($input['draft']['packages']??null)||count($input['draft']['packages'])>20)throw new RuntimeException('Revisá los datos y los bultos.');
  $order=new FM_Order($orders[0]);$draft=fm_package_rules($order,fm_order_observations($order,FBAM_Data::complete($order,FBAM_Data::clean($input['draft']))),$input['draft']['packages']);return ['draft'=>$draft,'errors'=>FBAM_Data::validate($draft)];
 }
 if(!$orders)throw new RuntimeException('Seleccioná al menos un pedido.');$groups=['home'=>[],'branch'=>[],'today'=>[]];
 foreach($orders as $raw){
  $order=new FM_Order($raw);if(in_array($order->get_status(),['cancelled','refunded','failed','trash'],true))throw new RuntimeException('Pedido #'.$order->get_order_number().': estado no apto para enviar.');
  if(!is_array($raw['andreani']['draft']??null))throw new RuntimeException('Revisá y guardá el pedido #'.$order->get_order_number().'.');
  $draft=fm_package_rules($order,fm_order_observations($order,FBAM_Data::clean($raw['andreani']['draft'])),$raw['andreani']['draft']['packages']??[]);$errors=FBAM_Data::validate($draft);if($errors)throw new RuntimeException('Pedido #'.$order->get_order_number().': '.implode(' ',$errors));
  $groups[$draft['service']]=array_merge($groups[$draft['service']],FBAM_Data::rows($order,$draft));
 }
 $file=FBAM_Exporter::generate($groups);try{return ['xlsx'=>file_get_contents($file)];}finally{unlink($file);}
}
if(!defined('FM_ANDREANI_TEST')){
 $body=file_get_contents('php://input',false,null,0,4194305);
 if(strlen($body)>4194304||!fm_auth($body)){fm_reply(['success'=>false,'message'=>'No autorizado.'],403);exit;}
 try{$input=json_decode($body,true,512,JSON_THROW_ON_ERROR);if(!is_array($input))throw new RuntimeException('Datos inválidos.');$out=fm_process($input);
  if(is_array($out)&&isset($out['xlsx'])){header('Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');echo $out['xlsx'];}
  else fm_reply(['success'=>true,'data'=>$out]);
 }catch(Throwable $e){fm_reply(['success'=>false,'message'=>$e instanceof RuntimeException?$e->getMessage():'No se pudo preparar el archivo.'],400);}
}
