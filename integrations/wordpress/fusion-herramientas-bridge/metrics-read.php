<?php
namespace FusionBikes\HerramientasBridge;
if (!defined('ABSPATH')) exit;

/** Non-PII dimensions/refunds for the existing sales panel. No writes or prices. */
final class MetricsRead {
    public static function register(): void {
        foreach (['metrics-options'=>'options','metrics-products'=>'products','metrics-refunds'=>'refunds'] as $path=>$method) {
            register_rest_route(Bridge::NAMESPACE, Bridge::PREFIX.'/'.$path, ['methods'=>'GET',
                'permission_callback'=>[MigrationRead::class,'allowed'],'callback'=>[self::class,$method]]);
        }
    }
    private static function response(array $data): \WP_REST_Response {
        return new \WP_REST_Response(['schema'=>1,'generated_at'=>gmdate('c')]+$data,200,
            ['Cache-Control'=>'private, no-store, max-age=0','X-Robots-Tag'=>'noindex, nofollow']);
    }
    public static function ids($value,int $maximum): array {
        if (!is_string($value) || strlen($value)>1600 || !preg_match('/^[1-9][0-9]*(,[1-9][0-9]*)*$/D',$value)) throw new \InvalidArgumentException('IDs inválidos.');
        $parts=explode(',',$value);
        if(count($parts)>$maximum || count(array_unique($parts))!==count($parts)) throw new \InvalidArgumentException('Lote demasiado grande o IDs repetidos.');
        $ids=[];
        foreach(array_chunk($parts,25) as $chunk) $ids=array_merge($ids,Bridge::parse_ids(implode(',',$chunk)));
        return $ids;
    }
    public static function options() {
        try {
            $taxonomies=[];
            foreach(get_object_taxonomies('product','objects') as $tax) $taxonomies[]=['name'=>$tax->name,'label'=>$tax->label];
            $terms=get_terms(['taxonomy'=>'product_cat','hide_empty'=>false]);
            if(is_wp_error($terms)) throw new \RuntimeException('terms');
            $categories=[];
            foreach($terms as $term) $categories[]=['id'=>(int)$term->term_id,'name'=>$term->name,'slug'=>$term->slug,'parent'=>(int)$term->parent,'default'=>in_array($term->slug,['bicicletas','bicicleta','bikes'],true)];
            $statuses=[];
            foreach(wc_get_order_statuses() as $key=>$label) {
                $norm=remove_accents(strtolower($label));
                $statuses[]=['key'=>$key,'label'=>$label,'default'=>in_array($key,['wc-processing','wc-completed','wc-refunded'],true)||strpos($norm,'andreani')!==false||(strpos($norm,'retirado')!==false&&strpos($norm,'fusion')!==false)];
            }
            return self::response(['timezone'=>wp_timezone_string(),'taxonomies'=>$taxonomies,'categories'=>$categories,'statuses'=>$statuses,'states'=>WC()->countries->get_states(),'source_panel_version'=>'1.1.0']);
        } catch (\Throwable $e) { return new \WP_Error('fusion_metrics_options','No se pudieron leer las opciones del panel.',['status'=>503]); }
    }
    public static function products($request) {
        try { $ids=self::ids($request->get_param('ids'),100); }
        catch(\InvalidArgumentException $e){return new \WP_Error('fusion_metrics_ids',$e->getMessage(),['status'=>400]);}
        try {
            $rows=[];$taxonomies=get_object_taxonomies('product');
            foreach($ids as $id) {
                $p=wc_get_product($id);
                if(!$p){$rows[]=['id'=>$id,'exists'=>false];continue;}
                $terms=[];
                // Variants only supply SKU/description; the panel classifies the parent.
                if(!$p->is_type('variation')) foreach($taxonomies as $tax) {
                    $v=wp_get_post_terms($id,$tax,['fields'=>'names']);
                    if(is_wp_error($v)) throw new \RuntimeException('terms');
                    $terms[$tax]=array_values($v);
                }
                $cats=wp_get_post_terms($id,'product_cat',['fields'=>'ids']);
                if(is_wp_error($cats))throw new \RuntimeException('categories');
                $all=$cats;
                foreach($cats as $cat) $all=array_merge($all,get_ancestors($cat,'product_cat','taxonomy'));
                $rows[]=['id'=>$id,'exists'=>true,'name'=>$p->get_name(),'sku'=>$p->get_sku(),'parent_id'=>$p->get_parent_id(),'virtual'=>(bool)$p->is_virtual(),
                    'variant'=>$p->is_type('variation')?wc_get_formatted_variation($p,true,true,true):'',
                    'terms'=>$terms,'category_ids'=>array_values(array_unique(array_map('intval',$all)))];
            }
            return self::response(['rows'=>$rows]);
        } catch(\Throwable $e){return new \WP_Error('fusion_metrics_products','No se pudieron leer las dimensiones de productos.',['status'=>503]);}
    }
    public static function refunds($request) {
        try{$ids=self::ids($request->get_param('ids'),25);}
        catch(\InvalidArgumentException $e){return new \WP_Error('fusion_metrics_ids',$e->getMessage(),['status'=>400]);}
        try {
            $rows=[];
            foreach($ids as $id){
                $order=wc_get_order($id);
                if(!$order || $order->get_type()!=='shop_order'){$rows[]=['id'=>$id,'exists'=>false];continue;}
                $allocated=abs((float)$order->get_total_tax_refunded());$items=[];
                foreach($order->get_items('line_item') as $item_id=>$item){
                    $ref=abs((float)$order->get_total_refunded_for_item($item_id));$allocated+=$ref;
                    $items[]=['id'=>(int)$item_id,'quantity'=>abs((float)$order->get_qty_refunded_for_item($item_id)),'amount'=>$ref];
                }
                foreach($order->get_items(['shipping','fee']) as $iid=>$item) $allocated+=abs((float)$order->get_total_refunded_for_item($iid,$item->get_type()));
                $modified=$order->get_date_modified();
                $rows[]=['id'=>$id,'exists'=>true,'modified_at'=>$modified?gmdate('Y-m-d\TH:i:s',$modified->getTimestamp()):'',
                    'items'=>$items,'unassigned'=>((float)$order->get_total_refunded()-$allocated)>0.02];
            }
            return self::response(['rows'=>$rows]);
        } catch(\Throwable $e){return new \WP_Error('fusion_metrics_refunds','No se pudieron leer las devoluciones.',['status'=>503]);}
    }
}
