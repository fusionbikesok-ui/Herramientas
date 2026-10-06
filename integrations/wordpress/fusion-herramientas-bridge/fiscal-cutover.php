<?php
namespace FusionBikes\HerramientasBridge;
if (!defined('ABSPATH')) exit;
final class FiscalCutover {
    const OPTION='fusion_arca_vps_cutover';
    public static $receiving=false;
    public static function state(): array {global $wpdb;$raw=$wpdb->get_var($wpdb->prepare("SELECT option_value FROM {$wpdb->options} WHERE option_name=%s",self::OPTION));$state=maybe_unserialize($raw);return is_array($state)?$state:[];}
    public static function active(): bool { return (bool)self::state(); }
    public static function settings(): array {
        return array_intersect_key((array)get_option('fusion_arca_settings',[]),array_flip(['company','cuit','address','phone','email','iibb','start_date','point','environment','vat','usd_gateways','bicycle_categories','auto_enabled','auto_statuses','auto_require_paid','auto_scope','production_enabled']));
    }
    public static function permission() {
        $permission=Bridge::allowed();if($permission!==true)return $permission;
        return current_user_can('manage_options')?true:new \WP_Error('fiscal_admin','Se requiere un administrador.',['status'=>403]);
    }
    public static function register(): void {
        register_rest_route('wc/v3','/fusion-herramientas/fiscal-cutover',[
            ['methods'=>'GET','permission_callback'=>[self::class,'permission'],'callback'=>static function(){return ['active'=>self::active(),'ready'=>(self::state()['state']??'')==='stopped','settings'=>self::settings()];}],
            ['methods'=>'POST','permission_callback'=>[self::class,'permission'],'callback'=>[self::class,'stop']],
        ]);
        register_rest_route('wc/v3','/fusion-herramientas/fiscal-receipt',['methods'=>'POST','permission_callback'=>[self::class,'permission'],'callback'=>[self::class,'receipt']]);
    }
    public static function stop($request) {
        if($request->get_param('confirm')!=='ORIGIN_OFF_VPS')return new \WP_Error('fiscal_confirm','Falta confirmar el corte.',['status'=>400]);
        if((self::state()['state']??'')==='stopped')return ['active'=>true,'ready'=>true,'settings'=>self::settings()];
        global $wpdb;$table=$wpdb->prefix.'fusion_arca_invoices';$locks=[];
        try {
            $scopes=$wpdb->get_col("SELECT DISTINCT scope FROM $table WHERE environment='production'");
            $configured=self::settings();$ml=(array)get_option('fusion_arca_ml',[]);
            foreach(array_unique([(int)($configured['point']??0),(int)($ml['point']??$configured['point']??0)]) as $point)foreach([1,3,6,8] as $type)$scopes[]=hash('sha256','production|'.$configured['cuit'].'|'.$point.'|'.$type);
            $scopes[]=hash('sha256','sin-cae|production|'.$configured['cuit'].'|20');$scopes=array_values(array_unique($scopes));sort($scopes);
            foreach($scopes as $scope){$lock='fbarca_emit_'.substr($scope,0,48);if((int)$wpdb->get_var($wpdb->prepare('SELECT GET_LOCK(%s,0)',$lock))!==1)throw new \RuntimeException('Hay una emisión en curso. Reintentá al finalizar.');$locks[]=$lock;}
            if((int)$wpdb->get_var("SELECT COUNT(*) FROM $table WHERE environment='production' AND status='pending'"))throw new \RuntimeException('Hay comprobantes pendientes de ARCA. Recuperalos antes del corte.');
            $s=(array)get_option('fusion_arca_settings',[]);$s['production_enabled']=false;$s['auto_enabled']=false;$s['auto_statuses']=[];
            update_option('fusion_arca_settings',$s,false);
            update_option(self::OPTION,['state'=>'stopped','at'=>gmdate('c'),'user'=>get_current_user_id(),'destination'=>'https://herramientas.fusionbikes.com.ar/herramientas/gestion-vps/?fm_module=facturador'],false);
            if((self::state()['state']??'')!=='stopped')throw new \RuntimeException('No se pudo confirmar el corte en la base de datos. No habilites el VPS hasta reintentar.');
            return ['active'=>self::active(),'ready'=>true,'settings'=>self::settings()];
        }catch(\Throwable $e){return new \WP_Error('fiscal_cutover',$e->getMessage(),['status'=>409]);}
        finally{foreach($locks as $lock)$wpdb->get_var($wpdb->prepare('SELECT RELEASE_LOCK(%s)',$lock));}
    }
    public static function receipt($request) {
        if((self::state()['state']??'')!=='stopped')return new \WP_Error('fiscal_inactive','Primero completá el corte.',['status'=>409]);
        global $wpdb;$v=$request->get_json_params();$row=$v['record']??null;$table=$wpdb->prefix.'fusion_arca_invoices';$s=self::settings();
        if(!is_array($row))return new \WP_Error('fiscal_record','Comprobante inválido.',['status'=>400]);
        $p=$row['payload']??[];
        if(($row['environment']??'')!=='production'||($row['status']??'')!=='authorized'||!is_array($p)||($p['issuer']['cuit']??'')!==($s['cuit']??'')||!preg_match('/^\d{14}$/D',(string)($p['cae']??''))||!in_array((int)($p['type']??0),[1,3,6,8],true)||!empty($p['ml'])||(int)($p['point']??0)!==(int)($s['point']??0)||!\FusionBikes\ARCA\Plugin::matches_request($row,(array)($row['response']??[])))return new \WP_Error('fiscal_scope','El comprobante no corresponde al corte manual.',['status'=>400]);
        $id=(int)($row['id']??0);$oid=(int)($row['order_id']??0);
        $actual=(array)($row['response']??[]);$expectedScope=hash('sha256','production|'.($s['cuit']??'').'|'.($p['point']??0).'|'.($p['type']??0));
        if(($actual['Resultado']??'')!=='A'||(string)($actual['CodAutorizacion']??'')!==$p['cae']||(int)($row['number']??0)<1||(int)$row['number']>99999999||(int)($actual['CbteDesde']??0)!==(int)$row['number']||(int)($actual['CbteHasta']??0)!==(int)$row['number']||($row['scope']??'')!==$expectedScope)return new \WP_Error('fiscal_confirmation','La confirmación no coincide con el comprobante.',['status'=>400]);
        if($id<1||$oid<0||(int)($p['order_id']??0)!==$oid)return new \WP_Error('fiscal_identity','Identidad inválida.',['status'=>400]);
        $lock='fusion_vps_receipt_'.$id;
        if((int)$wpdb->get_var($wpdb->prepare('SELECT GET_LOCK(%s,0)',$lock))!==1)return new \WP_Error('fiscal_busy','Sincronización en curso.',['status'=>409]);
        try {
            self::$receiving=true;
            $order=$oid?wc_get_order($oid):null;if($oid&&(!$order||\FusionBikes\ARCA\Plugin::is_ml_order($order)))throw new \RuntimeException('Pedido no disponible para marcación web.');
            if($order)foreach((array)($p['lines']??[]) as $line){if(empty($line['item_id']))continue;$item=$order->get_item((int)$line['item_id']);if(!$item||(int)$item->get_order_id()!==$oid)throw new \RuntimeException('El renglón fiscal no pertenece a este pedido.');}
            $old=$wpdb->get_row($wpdb->prepare("SELECT * FROM $table WHERE id=%d",$id),ARRAY_A);
            if($old){$op=json_decode($old['payload'],true);if((int)$old['order_id']!==$oid||$old['scope']!==($row['scope']??'')||$old['order_key']!==($row['order_key']??null)||(!in_array($old['status'],['draft','rejected'],true)&&($old['status']!=='authorized'||($op['cae']??'')!==$p['cae']||(int)$old['number']!==(int)($row['number']??0))))throw new \RuntimeException('El ID corresponde a otro comprobante.');}
            if($order&&($order->get_meta('afip_cae')||($order->get_meta('_fusion_arca_cae')&&(string)$order->get_meta('_fusion_arca_cae')!==$p['cae'])))throw new \RuntimeException('El pedido posee otra autorización.');
            if(!$old||$old['status']!=='authorized'){
                $allowed=['id','revision','environment','scope','order_id','order_key','status','number','payload','request','response','error','created_at','updated_at'];$data=array_intersect_key($row,array_flip($allowed));
                foreach(['payload','request','response'] as $key)$data[$key]=wp_json_encode($row[$key]??[]);
                $data['created_by']=0;
                $changed=$old?$wpdb->update($table,$data,['id'=>$id,'status'=>$old['status'],'revision'=>$old['revision']]):$wpdb->insert($table,$data);
                if($changed!==1)throw new \RuntimeException('No se pudo archivar el comprobante del VPS.');
            }
            if(!$order)return ['synced'=>true,'invoice_id'=>$id];
            $order->update_meta_data('_fusion_arca_invoice_id',$id);$order->update_meta_data('_fusion_arca_cae',$p['cae']);$order->update_meta_data('_fusion_arca_vps','1');
            foreach((array)($p['lines']??[]) as $line){if(empty($line['item_id']))continue;$item=$order->get_item((int)$line['item_id']);if($item){\FusionBikes\ARCA\Plugin::write_item_serials($item,(array)($line['serials']??[]));$item->save();}}
            $order->save();return ['synced'=>true,'invoice_id'=>$id];
        }catch(\Throwable $e){return new \WP_Error('fiscal_receipt',$e->getMessage(),['status'=>409]);}
        finally{self::$receiving=false;$wpdb->get_var($wpdb->prepare('SELECT RELEASE_LOCK(%s)',$lock));}
    }
}
add_action('rest_api_init',[FiscalCutover::class,'register']);
// Database-level write guard also catches requests that passed REST permission before the cut.
add_filter('query',static function($sql){$table=preg_quote($GLOBALS['wpdb']->prefix.'fusion_arca_','/');if(!FiscalCutover::$receiving&&preg_match('/^\s*(?:(?:INSERT(?:\s+IGNORE)?|REPLACE)\s+INTO|UPDATE|DELETE\s+FROM)\s+`?'.$table.'(?:invoices|series|ml_sales|whatsapp)`?\b/i',$sql)&&FiscalCutover::active())throw new \RuntimeException('La emisión y edición fiscal se trasladó al VPS.');return $sql;},PHP_INT_MAX);
add_filter('option_fusion_arca_settings',static function($settings){if(FiscalCutover::active()){$settings=(array)$settings;$settings['production_enabled']=false;$settings['auto_enabled']=false;$settings['auto_statuses']=[];}return $settings;});
add_filter('rest_pre_dispatch',static function($result,$server,$r){if(FiscalCutover::active()&&strpos($r->get_route(),'/fusion-arca/v1/')===0&&!in_array($r->get_method(),['GET','HEAD'],true))return new \WP_Error('fiscal_moved','La emisión se realiza en Herramientas → Facturador VPS. Esta web conserva el historial.',['status'=>423]);return $result;},-100,3);
add_action('admin_notices',static function(){if(FiscalCutover::active()&&($_GET['page']??'')==='fusion-arca')echo '<div class="notice notice-info"><p>La emisión se trasladó a <a href="https://herramientas.fusionbikes.com.ar/herramientas/gestion-vps/?fm_module=facturador">Facturador VPS</a>. Esta web conserva el historial.</p></div>';});
