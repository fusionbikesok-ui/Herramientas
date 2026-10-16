<?php
/**
 * Controlador REST: búsqueda de productos.
 * Endpoint: GET /fbpos/v2/search
 */
if (!defined('ABSPATH')) exit;

class FBPOS_Search_Controller {
    private $order_service;

    public function __construct(FBPOS_Order_Service $order_service) {
        $this->order_service = $order_service;
    }

    /**
     * Busca productos por nombre, SKU o código de barras.
     * GET /fbpos/v2/search?q=xyz
     *
     * @param WP_REST_Request $request
     * @return WP_REST_Response
     */
    public function search(WP_REST_Request $request) {
        global $wpdb;

        $query = trim((string) $request['q']);

        if (mb_strlen($query) < 2) {
            return rest_ensure_response([]);
        }

        $barcode_meta_key = sanitize_key(get_option('fbpos_barcode_meta', '_barcode'));
        $like = '%' . $wpdb->esc_like($query) . '%';

        $product_ids = $wpdb->get_col($wpdb->prepare(
            "
            SELECT DISTINCT p.ID
            FROM {$wpdb->posts} p
            LEFT JOIN {$wpdb->postmeta} sku ON sku.post_id = p.ID AND sku.meta_key = '_sku'
            LEFT JOIN {$wpdb->postmeta} bc ON bc.post_id = p.ID AND bc.meta_key = %s
            WHERE p.post_type IN ('product', 'product_variation')
              AND p.post_status = 'publish'
              AND (
                  p.post_title LIKE %s
                  OR sku.meta_value LIKE %s
                  OR bc.meta_value LIKE %s
              )
            ORDER BY
              CASE WHEN sku.meta_value = %s OR bc.meta_value = %s THEN 0 ELSE 1 END,
              p.post_title
            LIMIT 30
            ",
            $barcode_meta_key,
            $like,
            $like,
            $like,
            $query,
            $query
        ));

        $results = [];

        foreach ($product_ids as $id) {
            $product = wc_get_product($id);

            if (!$product || !$product->is_purchasable()) {
                continue;
            }

            $parent = $product->is_type('variation') ? wc_get_product($product->get_parent_id()) : null;
            $image_id = $product->get_image_id() ?: ($parent ? $parent->get_image_id() : 0);

            $results[] = [
                'id' => $product->get_id(),
                'name' => $this->order_service->get_product_display_name($product),
                'variation' => $this->order_service->get_variation_details($product),
                'sku' => $product->get_sku(),
                'barcode' => get_post_meta($product->get_id(), $barcode_meta_key, true),
                'price' => (float) wc_get_price_to_display($product),
                'stock' => $product->managing_stock() ? $product->get_stock_quantity() : null,
                'stock_status' => $product->get_stock_status(),
                'image' => $image_id ? wp_get_attachment_image_url($image_id, 'woocommerce_thumbnail') : wc_placeholder_img_src(),
                'url' => get_permalink($product->is_type('variation') ? $product->get_parent_id() : $product->get_id()),
            ];
        }

        return rest_ensure_response($results);
    }
}
