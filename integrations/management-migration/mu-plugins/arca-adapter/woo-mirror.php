<?php
declare(strict_types=1);

namespace FusionBikes\ARCA\VPS;

/**
 * Trusted server-side bridge into the private WooCommerce CPT data store.
 * Never register this as a public REST endpoint and never accept its inputs from a browser.
 * The caller must fetch the complete Woo order immediately before a fiscal operation.
 */
final class WooMirror
{
    public const OWNER = '_fusion_arca_vps_owner';
    public const OWNER_VALUE = 'fusion-arca-woo-mirror-v1';
    private const PREFIX = '_fusion_arca_vps_';
    private static ?\wpdb $writer = null;

    /** Pure validation/normalization; no WordPress or database is required. */
    public static function productPlan(array $p): array
    {
        $id = self::id($p['id_woo'] ?? $p['id'] ?? null, 'producto');
        $parent = self::id($p['id_padre'] ?? $p['parent_id'] ?? 0, 'padre', true);
        $type = (string) ($p['tipo'] ?? $p['type'] ?? ($parent ? 'variation' : 'simple'));
        if (!in_array($type, ['simple', 'variable', 'variation', 'grouped', 'external'], true)) {
            throw new \InvalidArgumentException('Tipo de producto no admitido.');
        }
        if (($type === 'variation') !== ($parent > 0) || $parent === $id) {
            throw new \InvalidArgumentException('La variación debe identificar a su padre de Woo.');
        }
        $name = self::text($p['nombre'] ?? $p['name'] ?? null, 'nombre de producto', 2000, false);
        $meta = self::metadata($p['meta_data'] ?? []);
        $core = [
            '_sku' => self::text($p['sku'] ?? '', 'SKU', 255),
            self::OWNER => self::OWNER_VALUE,
            self::PREFIX . 'source_id' => $id,
            self::PREFIX . 'product_type' => $type,
        ];
        if (array_key_exists('category_ids', $p) || array_key_exists('categories', $p)) {
            $ids = $p['category_ids'] ?? array_column((array) $p['categories'], 'id');
            if (!is_array($ids) || count($ids) > 300) throw new \InvalidArgumentException('Categorías inválidas.');
            $core[self::PREFIX . 'category_ids'] = array_values(array_unique(array_map(
                static fn($v): int => self::id($v, 'categoría'), $ids
            )));
        }
        if (isset($p['category_ancestor_ids'])) {
            if (!is_array($p['category_ancestor_ids']) || count($p['category_ancestor_ids']) > 300) {
                throw new \InvalidArgumentException('Ancestros de categoría inválidos.');
            }
            $core[self::PREFIX . 'category_ancestor_ids'] = array_values(array_unique(array_map(
                static fn($v): int => self::id($v, 'ancestro'), $p['category_ancestor_ids']
            )));
        }
        // Only explicitly supplied Woo amounts are materialized. No current ML price or FX inference.
        foreach (['price' => '_price', 'regular_price' => '_regular_price', 'sale_price' => '_sale_price'] as $key => $metaKey) {
            if (array_key_exists($key, $p)) {
                $core[$metaKey] = $p[$key] === '' || $p[$key] === null ? '' : self::decimal($p[$key], $key);
            }
        }
        if (isset($p['vat'])) $core['_fusion_arca_vat_rate'] = self::decimal($p['vat'], 'IVA');
        if (isset($p['stock_status'])) {
            if (!in_array($p['stock_status'], ['instock', 'outofstock', 'onbackorder'], true)) {
                throw new \InvalidArgumentException('Estado de stock inválido.');
            }
            $core['_stock_status'] = $p['stock_status'];
        }
        if (array_key_exists('stock_quantity', $p)) {
            $core['_stock'] = $p['stock_quantity'] === null ? '' : self::decimal($p['stock_quantity'], 'stock', true);
            $core['_manage_stock'] = $p['stock_quantity'] === null ? 'no' : 'yes';
        }
        return [
            'id' => $id, 'kind' => 'product', 'type' => $type,
            'post' => ['ID' => $id, 'post_type' => $parent ? 'product_variation' : 'product',
                'post_parent' => $parent, 'post_title' => $name, 'post_status' => 'publish'],
            'meta' => self::mergeMeta($meta, $core),
        ];
    }

    /** Input is GET /wc/v3/orders/{id}, plus full /orders/{id}/refunds/{refund_id} objects. */
    public static function orderPlan(array $o, array $refunds = []): array
    {
        foreach (['id', 'status', 'currency', 'total', 'total_tax', 'cart_tax', 'shipping_total',
            'shipping_tax', 'discount_total', 'discount_tax', 'payment_method', 'payment_method_title',
            'date_created', 'date_created_gmt', 'date_modified', 'date_modified_gmt', 'billing', 'shipping',
            'meta_data', 'line_items', 'fee_lines', 'shipping_lines', 'tax_lines', 'coupon_lines', 'refunds'] as $key) {
            if (!array_key_exists($key, $o)) throw new \InvalidArgumentException('Pedido Woo incompleto: falta ' . $key . '.');
        }
        $id = self::id($o['id'], 'pedido');
        $status = (string) $o['status'];
        if (!preg_match('/^[a-z0-9][a-z0-9_-]{0,16}$/D', $status)) throw new \InvalidArgumentException('Estado Woo inválido.');
        if (!preg_match('/^[A-Z]{3}$/D', (string) $o['currency'])) throw new \InvalidArgumentException('Moneda Woo inválida.');
        $core = [self::OWNER => self::OWNER_VALUE, self::PREFIX . 'source_id' => $id,
            self::PREFIX . 'number' => self::text($o['number'] ?? (string) $id, 'número', 100),
            self::PREFIX . 'source_hash' => self::hash($o),
            self::PREFIX . 'source_modified_gmt' => (string) $o['date_modified_gmt'],
            '_order_currency' => $o['currency'], '_customer_user' => 0,
            self::PREFIX . 'source_customer_id' => self::id($o['customer_id'] ?? 0, 'cliente', true),
            '_payment_method' => self::text($o['payment_method'], 'medio de pago', 200),
            '_payment_method_title' => self::text($o['payment_method_title'], 'título de pago', 1000),
            '_transaction_id' => self::text($o['transaction_id'] ?? '', 'transacción', 255),
            '_created_via' => self::text($o['created_via'] ?? '', 'origen', 255),
            '_order_key' => self::text($o['order_key'] ?? '', 'clave de pedido', 255),
            '_order_version' => self::text($o['version'] ?? '', 'versión Woo', 100),
            '_prices_include_tax' => !empty($o['prices_include_tax']) ? 'yes' : 'no',
            '_customer_ip_address' => self::text($o['customer_ip_address'] ?? '', 'IP cliente', 100),
            '_customer_user_agent' => self::text($o['customer_user_agent'] ?? '', 'agente cliente', 2000),
        ];
        foreach (['total' => '_order_total', 'cart_tax' => '_order_tax', 'shipping_total' => '_order_shipping',
            'shipping_tax' => '_order_shipping_tax', 'discount_total' => '_cart_discount', 'discount_tax' => '_cart_discount_tax'] as $key => $metaKey) {
            $core[$metaKey] = self::decimal($o[$key], $key, true);
        }
        self::decimal($o['total_tax'], 'total_tax', true);
        foreach (['billing', 'shipping'] as $address) {
            if (!is_array($o[$address])) throw new \InvalidArgumentException('Domicilio Woo inválido.');
            foreach (['first_name', 'last_name', 'company', 'address_1', 'address_2', 'city', 'state', 'postcode', 'country', 'email', 'phone'] as $key) {
                if ($address === 'shipping' && $key === 'email') continue;
                $core['_' . $address . '_' . $key] = self::text($o[$address][$key] ?? '', 'domicilio', 2000);
            }
        }
        foreach (['paid', 'completed'] as $dateKey) {
            $value = $o['date_' . $dateKey . '_gmt'] ?? null;
            $core['_date_' . $dateKey] = $value ? self::timestamp($value) : '';
        }
        $post = ['ID' => $id, 'post_type' => 'shop_order', 'post_status' => 'wc-' . $status,
            'post_parent' => self::id($o['parent_id'] ?? 0, 'pedido padre', true),
            'post_title' => 'Order ' . $id,
            'post_excerpt' => self::text($o['customer_note'] ?? '', 'nota cliente', 50000),
            'post_date' => self::date($o['date_created']), 'post_date_gmt' => self::date($o['date_created_gmt']),
            'post_modified' => self::date($o['date_modified']), 'post_modified_gmt' => self::date($o['date_modified_gmt'])];
        $items = self::orderItems($o, $id);
        if (!is_array($o['refunds']) || count($o['refunds']) !== count($refunds)) {
            throw new \InvalidArgumentException('Se requieren todos los reembolsos completos del pedido.');
        }
        $expectedRefunds = [];
        foreach ($o['refunds'] as $r) {
            $rid = self::id($r['id'] ?? null, 'reembolso');
            if (isset($expectedRefunds[$rid])) throw new \InvalidArgumentException('Reembolso repetido.');
            $expectedRefunds[$rid] = $r;
        }
        $refundPlans = [];
        foreach ($refunds as $r) {
            $rid = self::id($r['id'] ?? null, 'reembolso');
            if (!isset($expectedRefunds[$rid]) || $rid === $id || isset($refundPlans[$rid])) {
                throw new \InvalidArgumentException('Reembolso fuera del pedido o repetido.');
            }
            if (isset($r['parent_id']) && self::id($r['parent_id'], 'padre reembolso') !== $id) {
                throw new \InvalidArgumentException('Reembolso de otro pedido.');
            }
            $amount = self::decimal($r['amount'] ?? null, 'importe de reembolso');
            if (isset($expectedRefunds[$rid]['total']) && self::unsignedAmount(self::decimal($expectedRefunds[$rid]['total'], 'resumen de reembolso', true)) !== self::unsignedAmount($amount)) {
                throw new \InvalidArgumentException('El detalle del reembolso no coincide con el pedido.');
            }
            $refundPlans[$rid] = ['id' => $rid, 'kind' => 'refund', 'post' => [
                'ID' => $rid, 'post_type' => 'shop_order_refund', 'post_parent' => $id, 'post_status' => 'wc-completed',
                'post_title' => 'Refund ' . $rid, 'post_excerpt' => self::text($r['reason'] ?? '', 'motivo', 50000),
                'post_date' => self::date($r['date_created'] ?? null), 'post_date_gmt' => self::date($r['date_created_gmt'] ?? null),
                'post_modified' => self::date($r['date_created'] ?? null), 'post_modified_gmt' => self::date($r['date_created_gmt'] ?? null)],
                'meta' => self::mergeMeta(self::metadata($r['meta_data'] ?? []), [
                    self::OWNER => self::OWNER_VALUE, self::PREFIX . 'source_id' => $rid,
                    '_refund_amount' => $amount, '_refund_reason' => (string) ($r['reason'] ?? ''),
                    '_refunded_by' => 0, self::PREFIX . 'source_refunded_by' => self::id($r['refunded_by'] ?? 0, 'autor reembolso', true),
                    '_refunded_payment' => !empty($r['refunded_payment']) ? '1' : '', '_order_currency' => $o['currency'],
                    '_order_total' => '-' . $amount]),
                'items' => self::orderItems($r, $rid, true)];
        }
        return ['id' => $id, 'kind' => 'order', 'post' => $post, 'meta' => self::mergeMeta(self::metadata($o['meta_data']), $core),
            'items' => $items, 'refunds' => array_values($refundPlans)];
    }

    private static function orderItems(array $o, int $orderId, bool $refund = false): array
    {
        $out = [];
        foreach (['line_items' => 'line_item', 'fee_lines' => 'fee', 'shipping_lines' => 'shipping', 'tax_lines' => 'tax', 'coupon_lines' => 'coupon'] as $key => $type) {
            $rows = $o[$key] ?? [];
            if (!is_array($rows) || count($rows) > 1000) throw new \InvalidArgumentException('Renglones Woo inválidos.');
            foreach ($rows as $row) {
                $id = self::id($row['id'] ?? null, 'renglón');
                if (isset($out[$id])) throw new \InvalidArgumentException('ID de renglón repetido.');
                $name = self::text($row['name'] ?? $row['method_title'] ?? $row['rate_code'] ?? $row['label'] ?? $row['code'] ?? '', 'renglón', 2000);
                $core = [self::OWNER => self::OWNER_VALUE];
                if (in_array($type, ['line_item', 'fee', 'shipping'], true)) {
                    $total = self::decimal($row['total'] ?? null, 'total renglón', $refund || $type === 'fee');
                    $totalTax = self::decimal($row['total_tax'] ?? null, 'impuesto renglón', true);
                    $taxes = self::taxes($row['taxes'] ?? []);
                    if ($type === 'shipping') {
                        $core += ['method_id' => self::text($row['method_id'] ?? '', 'envío', 255),
                            'instance_id' => self::id($row['instance_id'] ?? 0, 'instancia envío', true),
                            'cost' => $total, 'total_tax' => $totalTax, 'taxes' => ['total' => $taxes['total']]];
                    } else {
                        $core += ['_tax_class' => self::text($row['tax_class'] ?? '', 'clase fiscal', 200),
                            '_line_total' => $total, '_line_tax' => $totalTax, '_line_tax_data' => $taxes];
                        if ($type === 'line_item') {
                            $quantity = self::decimal($row['quantity'] ?? null, 'cantidad', $refund);
                            if (!$refund && (float) $quantity <= 0) throw new \InvalidArgumentException('Cantidad de producto inválida.');
                            $core += ['_product_id' => self::id($row['product_id'] ?? 0, 'producto de renglón', true),
                                '_variation_id' => self::id($row['variation_id'] ?? 0, 'variación de renglón', true),
                                '_qty' => $quantity, '_line_subtotal' => self::decimal($row['subtotal'] ?? null, 'subtotal', $refund),
                                '_line_subtotal_tax' => self::decimal($row['subtotal_tax'] ?? null, 'impuesto subtotal', true)];
                        } else {
                            $core['_tax_status'] = self::text($row['tax_status'] ?? 'taxable', 'estado fiscal', 50);
                        }
                    }
                } elseif ($type === 'tax') {
                    $core += ['rate_id' => self::id($row['rate_id'] ?? 0, 'alícuota', true),
                        'label' => self::text($row['label'] ?? '', 'etiqueta fiscal', 255),
                        'compound' => !empty($row['compound']) ? '1' : '',
                        'tax_amount' => self::decimal($row['tax_total'] ?? null, 'impuesto', true),
                        'shipping_tax_amount' => self::decimal($row['shipping_tax_total'] ?? null, 'impuesto envío', true),
                        'rate_percent' => self::decimal($row['rate_percent'] ?? 0, 'porcentaje fiscal')];
                } else {
                    $core += ['discount_amount' => self::decimal($row['discount'] ?? null, 'descuento', true),
                        'discount_amount_tax' => self::decimal($row['discount_tax'] ?? null, 'impuesto descuento', true)];
                }
                $out[$id] = ['id' => $id, 'row' => ['order_item_id' => $id, 'order_item_name' => $name,
                    'order_item_type' => $type, 'order_id' => $orderId],
                    'meta' => self::mergeMeta(self::metadata($row['meta_data'] ?? []), $core)];
            }
        }
        // Woo's CPT item reader orders by order_item_id, including mixed product / fee / shipping types.
        ksort($out, SORT_NUMERIC);
        return array_values($out);
    }

    private static function taxes($taxes): array
    {
        if (!is_array($taxes) || count($taxes) > 100) throw new \InvalidArgumentException('Impuestos inválidos.');
        $out = ['total' => [], 'subtotal' => []];
        foreach ($taxes as $tax) {
            $id = self::id($tax['id'] ?? null, 'alícuota de renglón');
            if (isset($out['total'][$id])) throw new \InvalidArgumentException('Alícuota repetida.');
            $out['total'][$id] = self::decimal($tax['total'] ?? null, 'total impuesto', true);
            if (array_key_exists('subtotal', $tax)) $out['subtotal'][$id] = self::decimal($tax['subtotal'], 'subtotal impuesto', true);
        }
        return $out;
    }

    /** Apply one fresh order snapshot and the required product identities atomically. */
    public static function hydrateOrder(array $order, array $products = [], array $refunds = []): \WC_Order
    {
        $plan = self::orderPlan($order, $refunds);
        self::apply($products, $plan);
        $result = wc_get_order($plan['id']);
        if (!$result instanceof \WC_Order || $result->get_type() !== 'shop_order') throw new \RuntimeException('Woo no pudo leer el pedido importado.');
        return $result;
    }

    /** For selected manual invoice products. Include variation parents in the same list. */
    public static function hydrateProducts(array $products): array
    {
        $ids = self::apply($products, null);
        $out = [];
        foreach ($ids as $id) {
            $product = wc_get_product($id);
            if (!$product) throw new \RuntimeException('Woo no pudo leer el producto importado.');
            $out[$id] = $product;
        }
        return $out;
    }

    private static function apply(array $products, ?array $order): array
    {
        self::runtimeGuard();
        if (self::$writer !== null) throw new \RuntimeException('No se permite una hidratación recursiva.');
        // MySQL 8 has no @@in_transaction, and standard mysqli exposes no portable
        // server-status transaction bit. A fresh non-persistent connection guarantees
        // that START TRANSACTION cannot commit work owned by another caller.
        $sourceDb = $GLOBALS['wpdb'];
        // wpdb exposes its connection properties through its compatibility __get().
        // Reuse the active connection's credentials (also valid for a disposable test clone).
        $dbHost = $sourceDb->dbhost;
        $dbUser = $sourceDb->dbuser;
        $dbPassword = $sourceDb->dbpassword;
        if (!is_string($dbHost) || !is_string($dbUser) || !is_string($dbPassword)) throw new \RuntimeException('No se pudo identificar la conexión WordPress activa.');
        if (str_starts_with($dbHost, 'p:')) throw new \RuntimeException('El espejo requiere una conexión MySQL no persistente.');
        // Respect a test harness that selected a disposable database after wp-load.
        $database = $sourceDb->get_var('SELECT DATABASE()');
        if (!is_string($database) || $database === '') throw new \RuntimeException('No se pudo identificar la base privada activa.');
        $writer = new \wpdb($dbUser, $dbPassword, $database, $dbHost);
        $writer->hide_errors();
        $writer->suppress_errors(true);
        try {
            if (!$writer->ready || $writer->get_var('SELECT DATABASE()') !== $database) throw new \RuntimeException('No se pudo abrir la conexión a la misma base privada del espejo Woo.');
            $prefixResult = $writer->set_prefix($sourceDb->prefix);
            if (is_wp_error($prefixResult)) throw new \RuntimeException('Prefijo WordPress inválido.');
            self::$writer = $writer;
            return self::applyOnFreshConnection($products, $order);
        } finally {
            self::$writer = null;
            $writer->close();
        }
    }

    private static function db(): \wpdb
    {
        if (self::$writer === null) throw new \LogicException('Falta la conexión privada del adaptador.');
        return self::$writer;
    }

    private static function applyOnFreshConnection(array $products, ?array $order): array
    {
        $wpdb = self::db();
        if (count($products) > 1000) throw new \InvalidArgumentException('Demasiados productos.');
        $productPlans = [];
        foreach ($products as $product) {
            $p = self::productPlan($product);
            if (isset($productPlans[$p['id']])) throw new \InvalidArgumentException('Producto repetido.');
            $productPlans[$p['id']] = $p;
        }
        $plans = $productPlans;
        if ($order) foreach (array_merge([$order], $order['refunds']) as $p) {
            if (isset($plans[$p['id']])) throw new \InvalidArgumentException('ID compartido entre producto y pedido.');
            $plans[$p['id']] = $p;
        }
        $lock = 'fusion-arca-mirror-' . substr(hash('sha256', $wpdb->prefix), 0, 32);
        if ((string) $wpdb->get_var($wpdb->prepare('SELECT GET_LOCK(%s, 10)', $lock)) !== '1') throw new \RuntimeException('El espejo Woo está ocupado.');
        $started = false;
        try {
            self::query('START TRANSACTION');
            $started = true;
            foreach ($plans as $p) self::guardPost($p);
            foreach ($productPlans as $p) if ($p['post']['post_parent']) {
                $parent = $plans[$p['post']['post_parent']] ?? self::ownedProduct($p['post']['post_parent']);
                if (($parent['type'] ?? '') !== 'variable') throw new \RuntimeException('Falta el padre variable del catálogo Woo.');
            }
            if ($order) {
                self::guardFiscalMarkers($order);
                self::guardFreshness($order);
                self::guardItemsAndRefunds($order);
                foreach (array_merge([$order], $order['refunds']) as $p) foreach ($p['items'] as $item) {
                    if ($item['row']['order_item_type'] !== 'line_item') continue;
                    $meta = self::metaMap($item['meta']);
                    $pid = (int) ($meta['_product_id'] ?? 0);
                    $vid = (int) ($meta['_variation_id'] ?? 0);
                    if ($pid) {
                        $product = $productPlans[$pid] ?? self::ownedProduct($pid);
                        if (($product['kind'] ?? '') !== 'product') throw new \RuntimeException('Falta un producto de la venta.');
                    }
                    if ($vid) {
                        $variation = $productPlans[$vid] ?? self::ownedProduct($vid);
                        if (!$pid || ($variation['type'] ?? '') !== 'variation' || (int) $variation['post']['post_parent'] !== $pid) {
                            throw new \RuntimeException('La variación no corresponde al producto de la venta.');
                        }
                    }
                }
            }
            foreach ($plans as $p) self::writePost($p);
            if ($order) foreach (array_merge([$order], $order['refunds']) as $p) self::writeItems($p);
            self::query('COMMIT');
            $started = false;
        } catch (\Throwable $e) {
            if ($started) $wpdb->query('ROLLBACK');
            throw $e;
        } finally {
            $wpdb->get_var($wpdb->prepare('SELECT RELEASE_LOCK(%s)', $lock));
            // This is an isolated local WordPress. Direct SQL bypasses Woo's cache hooks deliberately.
            // Full cache invalidation also evicts cached negative wc_get_order/product results.
            wp_cache_flush();
            foreach (array_keys($plans) as $id) {
                if (class_exists('WC_Cache_Helper')) \WC_Cache_Helper::invalidate_cache_group('product_' . $id);
            }
        }
        return array_keys($productPlans);
    }

    private static function runtimeGuard(): void
    {
        if (!defined('FUSION_ARCA_VPS_MIRROR') || FUSION_ARCA_VPS_MIRROR !== true || !defined('ABSPATH') || !function_exists('wc_get_order')) {
            throw new \RuntimeException('El adaptador sólo puede ejecutarse en el WordPress privado habilitado.');
        }
        if (get_option('woocommerce_custom_orders_table_enabled') === 'yes' || get_option('woocommerce_custom_orders_table_data_sync_enabled') === 'yes') {
            throw new \RuntimeException('Este adaptador exige almacenamiento CPT sin sincronización HPOS.');
        }
        if (!defined('DISABLE_WP_CRON') || DISABLE_WP_CRON !== true) throw new \RuntimeException('WP Cron debe estar deshabilitado en este runtime.');
        global $wpdb;
        foreach ([$wpdb->posts, $wpdb->postmeta, $wpdb->prefix . 'woocommerce_order_items', $wpdb->prefix . 'woocommerce_order_itemmeta'] as $table) {
            $engine = $wpdb->get_var($wpdb->prepare('SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=%s', $table));
            if (strcasecmp((string) $engine, 'InnoDB') !== 0) throw new \RuntimeException('El espejo necesita tablas transaccionales InnoDB.');
        }
    }

    private static function guardPost(array $p): void
    {
        $wpdb = self::db();
        $existing = $wpdb->get_row($wpdb->prepare("SELECT ID,post_type,post_parent FROM {$wpdb->posts} WHERE ID=%d FOR UPDATE", $p['id']), ARRAY_A);
        if ($existing) {
            $owner = $wpdb->get_col($wpdb->prepare("SELECT meta_value FROM {$wpdb->postmeta} WHERE post_id=%d AND meta_key=%s", $p['id'], self::OWNER));
            if ($owner !== [self::OWNER_VALUE] || $existing['post_type'] !== $p['post']['post_type'] || (int) $existing['post_parent'] !== $p['post']['post_parent']) {
                throw new \RuntimeException('Colisión con un ID local ajeno al adaptador.');
            }
        } elseif ((int) $wpdb->get_var($wpdb->prepare("SELECT COUNT(*) FROM {$wpdb->postmeta} WHERE post_id=%d", $p['id'])) > 0) {
            throw new \RuntimeException('El ID tiene metadatos locales huérfanos.');
        }
    }

    private static function ownedProduct(int $id): array
    {
        $wpdb = self::db();
        $post = $wpdb->get_row($wpdb->prepare("SELECT ID,post_type,post_parent FROM {$wpdb->posts} WHERE ID=%d", $id), ARRAY_A);
        $owner = $wpdb->get_col($wpdb->prepare("SELECT meta_value FROM {$wpdb->postmeta} WHERE post_id=%d AND meta_key=%s", $id, self::OWNER));
        if (!$post || !in_array($post['post_type'], ['product', 'product_variation'], true) || $owner !== [self::OWNER_VALUE]) {
            throw new \RuntimeException('Falta la identidad del producto Woo #' . $id . ' en el catálogo local. Si fue eliminado de la tienda, revisá esa venta antes de facturar; no se reemplazó ni se inventó el producto.');
        }
        $type = $wpdb->get_var($wpdb->prepare("SELECT meta_value FROM {$wpdb->postmeta} WHERE post_id=%d AND meta_key=%s", $id, self::PREFIX . 'product_type'));
        return ['kind' => 'product', 'type' => (string) $type, 'post' => $post];
    }

    private static function guardFreshness(array $p): void
    {
        $wpdb = self::db();
        $old = $wpdb->get_var($wpdb->prepare("SELECT meta_value FROM {$wpdb->postmeta} WHERE post_id=%d AND meta_key=%s", $p['id'], self::PREFIX . 'source_modified_gmt'));
        $fresh = self::metaMap($p['meta'])[self::PREFIX . 'source_modified_gmt'];
        if ($old && strcmp((string) $old, (string) $fresh) > 0) throw new \RuntimeException('La copia de Woo es anterior a la ya importada.');
    }

    private static function guardFiscalMarkers(array $p): void
    {
        $wpdb = self::db();
        $fresh = self::metaMap($p['meta']);
        foreach (['_fusion_arca_invoice_id', 'afip_cae'] as $key) {
            $current = $wpdb->get_var($wpdb->prepare("SELECT meta_value FROM {$wpdb->postmeta} WHERE post_id=%d AND meta_key=%s", $p['id'], $key));
            if ($current !== null && $current !== '' && $current !== '0' && (string) $current !== (string) ($fresh[$key] ?? '')) {
                throw new \RuntimeException('El pedido local tiene una factura pendiente de conciliar con Woo.');
            }
        }
    }

    private static function guardItemsAndRefunds(array $order): void
    {
        $wpdb = self::db();
        $itemsTable = $wpdb->prefix . 'woocommerce_order_items';
        $metaTable = $wpdb->prefix . 'woocommerce_order_itemmeta';
        $allIds = [];
        foreach (array_merge([$order], $order['refunds']) as $p) {
            $old = $wpdb->get_results($wpdb->prepare("SELECT order_item_id FROM $itemsTable WHERE order_id=%d FOR UPDATE", $p['id']), ARRAY_A);
            foreach ($old as $row) {
                $owner = $wpdb->get_col($wpdb->prepare("SELECT meta_value FROM $metaTable WHERE order_item_id=%d AND meta_key=%s", $row['order_item_id'], self::OWNER));
                if ($owner !== [self::OWNER_VALUE]) throw new \RuntimeException('El pedido contiene un renglón local no importado.');
            }
            foreach ($p['items'] as $item) {
                if (isset($allIds[$item['id']])) throw new \RuntimeException('ID de renglón compartido por pedido y reembolso.');
                $allIds[$item['id']] = true;
                $existing = $wpdb->get_row($wpdb->prepare("SELECT order_id,order_item_type FROM $itemsTable WHERE order_item_id=%d FOR UPDATE", $item['id']), ARRAY_A);
                if ($existing && ((int) $existing['order_id'] !== $p['id'] || $existing['order_item_type'] !== $item['row']['order_item_type'])) {
                    throw new \RuntimeException('Colisión de ID de renglón con otro pedido local.');
                }
                if (!$existing && (int) $wpdb->get_var($wpdb->prepare("SELECT COUNT(*) FROM $metaTable WHERE order_item_id=%d", $item['id']))) {
                    throw new \RuntimeException('El renglón tiene metadatos huérfanos.');
                }
            }
        }
        $expected = array_column($order['refunds'], 'id');
        $existing = $wpdb->get_col($wpdb->prepare("SELECT ID FROM {$wpdb->posts} WHERE post_parent=%d AND post_type='shop_order_refund' FOR UPDATE", $order['id']));
        foreach ($existing as $id) if (!in_array((int) $id, $expected, true)) {
            throw new \RuntimeException('Hay un reembolso local que ya no aparece en la fuente; requiere conciliación.');
        }
    }

    private static function writePost(array $p): void
    {
        $wpdb = self::db();
        $exists = $wpdb->get_var($wpdb->prepare("SELECT ID FROM {$wpdb->posts} WHERE ID=%d", $p['id']));
        if ($exists) {
            if ($wpdb->update($wpdb->posts, $p['post'], ['ID' => $p['id']]) === false) throw new \RuntimeException('No se pudo actualizar el espejo.');
        } else {
            $defaults = ['post_author' => 0, 'post_content' => '', 'post_excerpt' => '', 'to_ping' => '', 'pinged' => '',
                'post_content_filtered' => '', 'post_password' => '', 'post_name' => 'fusion-woo-' . $p['id'],
                'guid' => 'urn:fusion:woo:' . $p['id'], 'post_mime_type' => '', 'comment_status' => 'closed', 'ping_status' => 'closed',
                'post_date' => gmdate('Y-m-d H:i:s'), 'post_date_gmt' => gmdate('Y-m-d H:i:s'),
                'post_modified' => gmdate('Y-m-d H:i:s'), 'post_modified_gmt' => gmdate('Y-m-d H:i:s')];
            if ($wpdb->insert($wpdb->posts, $p['post'] + $defaults) === false) throw new \RuntimeException('No se pudo crear el espejo.');
        }
        if ($p['kind'] === 'product') {
            // Sparse catalogue identities must not erase previously supplied categories/VAT/prices.
            $keys = array_values(array_unique(array_column($p['meta'], 'key')));
            foreach ($keys as $key) self::deleteMeta($wpdb->postmeta, 'post_id', $p['id'], $key);
        } else {
            if ($wpdb->delete($wpdb->postmeta, ['post_id' => $p['id']]) === false) throw new \RuntimeException('No se pudieron reemplazar los metadatos del pedido.');
        }
        self::insertMeta($wpdb->postmeta, 'post_id', $p['id'], $p['meta']);
    }

    private static function writeItems(array $p): void
    {
        $wpdb = self::db();
        $table = $wpdb->prefix . 'woocommerce_order_items';
        $metaTable = $wpdb->prefix . 'woocommerce_order_itemmeta';
        // Every old row was proven owned before this point. Item IDs are reinserted exactly as in Woo.
        self::query($wpdb->prepare("DELETE im FROM $metaTable im INNER JOIN $table i ON i.order_item_id=im.order_item_id WHERE i.order_id=%d", $p['id']));
        if ($wpdb->delete($table, ['order_id' => $p['id']]) === false) throw new \RuntimeException('No se pudieron reemplazar los renglones.');
        foreach ($p['items'] as $item) {
            if ($wpdb->insert($table, $item['row']) === false) throw new \RuntimeException('No se pudo importar un renglón.');
            self::insertMeta($metaTable, 'order_item_id', $item['id'], $item['meta']);
        }
    }

    private static function insertMeta(string $table, string $idKey, int $id, array $rows): void
    {
        $wpdb = self::db();
        foreach ($rows as $m) if ($wpdb->insert($table, [$idKey => $id, 'meta_key' => $m['key'], 'meta_value' => maybe_serialize($m['value'])]) === false) {
            throw new \RuntimeException('No se pudo guardar un metadato del espejo.');
        }
    }

    private static function deleteMeta(string $table, string $idKey, int $id, string $key): void
    {
        $wpdb = self::db();
        if ($wpdb->delete($table, [$idKey => $id, 'meta_key' => $key]) === false) throw new \RuntimeException('No se pudo actualizar un metadato.');
    }

    private static function query(string $sql): void
    {
        $wpdb = self::db();
        if ($wpdb->query($sql) === false) throw new \RuntimeException('Falló una operación transaccional del espejo Woo.');
    }

    /** These local filters preserve identity/category semantics without importing source taxonomy IDs. */
    public static function registerFilters(): void
    {
        add_filter('wc_order_statuses', static function (array $statuses): array {
            global $wpdb;
            // Source custom statuses must survive WC_Order::set_status() validation.
            // Do not classify an unfamiliar status as paid: date_paid is copied separately.
            $source = $wpdb->get_col($wpdb->prepare("SELECT DISTINCT p.post_status FROM {$wpdb->posts} p
                INNER JOIN {$wpdb->postmeta} m ON m.post_id=p.ID AND m.meta_key=%s AND m.meta_value=%s
                WHERE p.post_type='shop_order'", self::OWNER, self::OWNER_VALUE));
            foreach ($source as $status) if (preg_match('/^wc-[a-z0-9][a-z0-9_-]{0,16}$/D', $status) && !isset($statuses[$status])) {
                $statuses[$status] = substr($status, 3);
            }
            return $statuses;
        });
        add_filter('woocommerce_product_type_query', static function ($type, $id) {
            if (get_post_meta((int) $id, self::OWNER, true) !== self::OWNER_VALUE) return $type;
            return get_post_meta((int) $id, self::PREFIX . 'product_type', true) ?: $type;
        }, 10, 2);
        add_filter('woocommerce_order_number', static function ($number, $order) {
            if ($order->get_meta(self::OWNER) !== self::OWNER_VALUE) return $number;
            return $order->get_meta(self::PREFIX . 'number') ?: $number;
        }, 10, 2);
        add_filter('fusion_arca_requires_serial', static function ($current, $product): bool {
            if ($product->get_meta(self::OWNER) !== self::OWNER_VALUE) return (bool) $current;
            $parent = $product->get_parent_id() ? wc_get_product($product->get_parent_id()) : null;
            $ids = [];
            foreach (array_filter([$product, $parent]) as $p) foreach (['category_ids', 'category_ancestor_ids'] as $key) {
                $ids = array_merge($ids, (array) $p->get_meta(self::PREFIX . $key));
            }
            $settings = \FusionBikes\ARCA\Plugin::settings();
            $selected = array_filter(array_map('intval', explode(',', (string) ($settings['bicycle_categories'] ?? ''))));
            // The original plugin already rejected accessory titles before reaching this filter.
            return (bool) $current || (bool) array_intersect($selected, $ids)
                || \FusionBikes\ARCA\Plugin::bicycle_name($product->get_name());
        }, 10, 2);
    }

    private static function metadata($rows): array
    {
        if (!is_array($rows) || count($rows) > 2000) throw new \InvalidArgumentException('Metadatos Woo inválidos.');
        $out = [];
        foreach ($rows as $row) {
            if (!is_array($row) || !array_key_exists('value', $row)) throw new \InvalidArgumentException('Metadato incompleto.');
            $key = self::text($row['key'] ?? null, 'clave de metadato', 255, false);
            if (str_starts_with($key, self::PREFIX)) throw new \InvalidArgumentException('La fuente contiene una clave reservada del adaptador.');
            if (strlen(json_encode($row['value'], JSON_THROW_ON_ERROR)) > 2 * 1024 * 1024) throw new \InvalidArgumentException('Metadato demasiado grande.');
            $out[] = ['key' => $key, 'value' => $row['value']];
        }
        return $out;
    }

    private static function mergeMeta(array $rows, array $core): array
    {
        $rows = array_values(array_filter($rows, static fn(array $m): bool => !array_key_exists($m['key'], $core)));
        foreach ($core as $key => $value) $rows[] = ['key' => $key, 'value' => $value];
        return $rows;
    }

    private static function metaMap(array $rows): array
    {
        $map = [];
        foreach ($rows as $row) if (!array_key_exists($row['key'], $map)) $map[$row['key']] = $row['value'];
        return $map;
    }

    private static function id($value, string $label, bool $zero = false): int
    {
        if ((!is_int($value) && !is_string($value)) || !preg_match('/^[0-9]{1,15}$/D', (string) $value)) {
            throw new \InvalidArgumentException('ID inválido: ' . $label . '.');
        }
        $id = (int) $value;
        if ($id < ($zero ? 0 : 1)) throw new \InvalidArgumentException('ID inválido: ' . $label . '.');
        return $id;
    }

    private static function decimal($value, string $label, bool $negative = false): string
    {
        if (!is_string($value) && !is_int($value) && !is_float($value)) throw new \InvalidArgumentException('Importe inválido: ' . $label . '.');
        $s = (string) $value;
        if (!preg_match($negative ? '/^-?[0-9]{1,18}(?:\.[0-9]{1,12})?$/D' : '/^[0-9]{1,18}(?:\.[0-9]{1,12})?$/D', $s)) {
            throw new \InvalidArgumentException('Importe inválido: ' . $label . '.');
        }
        return $s;
    }

    private static function unsignedAmount(string $value): string
    {
        $parts = explode('.', ltrim($value, '-'), 2);
        $whole = ltrim($parts[0], '0');
        return ($whole === '' ? '0' : $whole) . '.' . rtrim($parts[1] ?? '', '0');
    }

    private static function text($value, string $label, int $max, bool $empty = true): string
    {
        if (!is_string($value) || strlen($value) > $max || str_contains($value, "\0") || (!$empty && trim($value) === '')) {
            throw new \InvalidArgumentException('Texto inválido: ' . $label . '.');
        }
        return $value;
    }

    private static function date($value): string
    {
        if (!is_string($value) || !preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/D', $value)) throw new \InvalidArgumentException('Fecha Woo incompleta.');
        $date = \DateTimeImmutable::createFromFormat('!Y-m-d\TH:i:s', $value, new \DateTimeZone('UTC'));
        if (!$date || $date->format('Y-m-d\TH:i:s') !== $value) throw new \InvalidArgumentException('Fecha Woo inválida.');
        return str_replace('T', ' ', $value);
    }

    private static function timestamp($value): int
    {
        return (new \DateTimeImmutable(self::date($value), new \DateTimeZone('UTC')))->getTimestamp();
    }

    private static function hash(array $data): string
    {
        return hash('sha256', json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR));
    }
}
