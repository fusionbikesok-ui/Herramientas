<?php
/**
 * Servicio de órdenes: procesamiento de checkout, decoración de órdenes, pagos.
 */
if (!defined('ABSPATH')) exit;

class FBPOS_Order_Service {
    private $customer_service;
    private $payment_gateway_service;
    private $master_control_bridge;

    public function __construct(
        FBPOS_Customer_Service $customer_service,
        FBPOS_Payment_Gateway_Service $payment_gateway_service,
        ?FBPOS_Master_Control_Bridge $master_control_bridge = null
    ) {
        $this->customer_service = $customer_service;
        $this->payment_gateway_service = $payment_gateway_service;
        $this->master_control_bridge = $master_control_bridge ?? new FBPOS_Master_Control_Bridge();
    }

    /**
     * Obtiene o crea el producto sintético de POS (para piernas de pago mixto).
     * Es un producto WooCommerce real pero oculto del catálogo, con precio base 0.
     * El precio real se sobreescribe vía _fbpos_price en cada ítem.
     *
     * @return int ID del producto sintético
     * @throws Exception Si no se puede crear
     */
    public function get_or_create_synthetic_product_id() {
        // Intentar obtener el ID guardado
        $product_id = get_option('fbpos_synthetic_product_id');

        if ($product_id) {
            $product = wc_get_product(intval($product_id));
            if ($product && $product->get_type() === 'simple') {
                return intval($product_id);
            }
        }

        // Lock corto para evitar crear dos productos sintéticos si dos requests
        // concurrentes llegan acá antes de que exista la opción (revisor, ronda 9, hallazgo 6).
        $lock_acquired = add_option('fbpos_synthetic_product_lock', time(), '', 'no');

        if (!$lock_acquired) {
            // Otro request ya está creando el producto: esperar un instante y reusar el resultado.
            usleep(200000);
            $product_id = get_option('fbpos_synthetic_product_id');
            if ($product_id) {
                return intval($product_id);
            }
        }

        try {
            // Revalidar después de tomar el lock: puede haberse creado mientras esperábamos.
            $product_id = get_option('fbpos_synthetic_product_id');
            if ($product_id) {
                $product = wc_get_product(intval($product_id));
                if ($product && $product->get_type() === 'simple') {
                    return intval($product_id);
                }
            }

            // Crear un nuevo producto si no existe o está inválido.
            // Virtual + sin impuestos: es un placeholder de cobro, no un producto físico —
            // si no es virtual, WooCommerce le exige dirección de envío al cliente en el
            // checkout real y puede sumarle costo de envío al monto de la pierna (revisor,
            // ronda 9, hallazgo 1).
            $product = new WC_Product_Simple();
            $product->set_name('Pago parcial — Punto de venta');
            $product->set_regular_price('0');
            $product->set_price('0');
            $product->set_virtual(true);
            $product->set_tax_status('none');
            $product->set_manage_stock(false);
            $product->set_sold_individually(false);
            $product->set_catalog_visibility('hidden');
            $product->set_status('publish');
            $product->update_meta_data('_fbpos_synthetic', '1');

            $product_id = $product->save();

            if ($product_id) {
                update_option('fbpos_synthetic_product_id', $product_id);
                return $product_id;
            }

            throw new Exception('No se pudo crear el producto sintético de POS.');
        } finally {
            if ($lock_acquired) {
                delete_option('fbpos_synthetic_product_lock');
            }
        }
    }

    /**
     * Excluye el producto sintético de POS del sitemap core de WordPress.
     * `catalog_visibility: hidden` ya lo saca del catálogo y del buscador interno de
     * WooCommerce, pero el post sigue en estado `publish` con URL pública directa, y el
     * sitemap core de WP no filtra por esos términos de visibilidad (revisor, ronda 9,
     * hallazgo 6) — con precio $0 sería comprable por cualquiera que llegue a esa URL.
     * Enganchado en `wp_sitemaps_posts_query_args`.
     */
    public function exclude_synthetic_from_sitemap($args, $post_type) {
        if ($post_type !== 'product') {
            return $args;
        }

        $args['meta_query'] = $args['meta_query'] ?? [];
        $args['meta_query'][] = [
            'key' => '_fbpos_synthetic',
            'compare' => 'NOT EXISTS',
        ];

        return $args;
    }

    /**
     * Obtiene los atributos de variación de un producto (ej: Talla: M, Color: Rojo).
     */
    public function get_variation_details($product) {
        if (!$product || !$product->is_type('variation')) {
            return '';
        }

        $parts = [];

        foreach ($product->get_variation_attributes() as $key => $value) {
            if ($value === '') {
                continue;
            }

            $taxonomy = str_replace('attribute_', '', $key);
            $label = wc_attribute_label($taxonomy, $product);
            $display = $value;

            if (taxonomy_exists($taxonomy)) {
                $term = get_term_by('slug', $value, $taxonomy);

                if ($term && !is_wp_error($term)) {
                    $display = $term->name;
                }
            }

            $parts[] = trim($label) . ': ' . trim($display);
        }

        return implode(' · ', $parts);
    }

    /**
     * Construye el nombre a mostrar de un producto.
     * Si es variación: nombre del padre + detalles de variación.
     */
    public function get_product_display_name($product) {
        if (!$product) {
            return '';
        }

        if (!$product->is_type('variation')) {
            return $product->get_name();
        }

        $parent = wc_get_product($product->get_parent_id());
        $base = $parent ? $parent->get_name() : $product->get_name();
        $details = $this->get_variation_details($product);

        return $base . ($details ? ' — ' . $details : '');
    }

    /**
     * Limpia y valida los items de una orden.
     * Verifica stock y disponibilidad. Lanza Exception si hay problema.
     */
    public function clean_items($items) {
        $out = [];

        foreach ((array) $items as $item) {
            $product_id = absint($item['id'] ?? 0);
            $qty = max(1, absint($item['qty'] ?? 1));
            $product = wc_get_product($product_id);

            if (!$product || !$product->is_purchasable()) {
                throw new Exception('Producto no disponible.');
            }

            if (!$product->is_in_stock()) {
                throw new Exception('Stock insuficiente para ' . $this->get_product_display_name($product));
            }

            if ($product->managing_stock() && $product->get_stock_quantity() < $qty) {
                throw new Exception('Stock insuficiente para ' . $this->get_product_display_name($product));
            }

            $parent = $product->is_type('variation') ? wc_get_product($product->get_parent_id()) : null;
            $image_id = $product->get_image_id() ?: ($parent ? $parent->get_image_id() : 0);

            $out[] = [
                'id' => $product->get_id(),
                'name' => $this->get_product_display_name($product),
                'variation' => $this->get_variation_details($product),
                'qty' => $qty,
                'unit' => (float) wc_get_price_to_display($product),
                'image' => $image_id ? wp_get_attachment_image_url($image_id, 'woocommerce_thumbnail') : wc_placeholder_img_src(),
                'url' => get_permalink($product->is_type('variation') ? $product->get_parent_id() : $product->get_id()),
            ];
        }

        return $out;
    }

    /**
     * Prepara el checkout con payload: vacía el carrito, agrega items, configura cliente y método de pago.
     * Se ejecuta en template_redirect con prioridad 0.
     */
    public function prepare_checkout() {
        if (empty($_GET['fbpos_checkout'])) {
            // Si hay fbpos_gateway pero no fbpos_checkout, solo setear el gateway en sesión
            if (!empty($_GET['fbpos_gateway']) && function_exists('is_checkout') && is_checkout() && WC()->session) {
                WC()->session->set('chosen_payment_method', sanitize_key(wp_unslash($_GET['fbpos_gateway'])));
            }
            return;
        }

        if (!$this->is_user_allowed()) {
            return;
        }

        $token = sanitize_text_field(wp_unslash($_GET['fbpos_checkout']));
        $payload = get_transient('fbpos_checkout_' . $token);

        if (!is_array($payload) || empty($payload['items'])) {
            return;
        }

        delete_transient('fbpos_checkout_' . $token);

        if (!WC()->cart) {
            wc_load_cart();
        }

        WC()->cart->empty_cart();

        // Agregar items al carrito
        foreach ($payload['items'] as $item) {
            $product_id = absint($item['id'] ?? 0);
            $product = wc_get_product($product_id);

            // Si product_id es 0 (ítem sintético de pago mixto), crear/obtener el producto placeholder
            if (!$product && $product_id === 0) {
                try {
                    $product_id = $this->get_or_create_synthetic_product_id();
                    $product = wc_get_product($product_id);
                } catch (Exception $e) {
                    // Si no se puede crear el producto sintético, saltar este ítem
                    continue;
                }
            }

            if (!$product) {
                continue;
            }

            $qty = max(1, absint($item['qty'] ?? 1));
            $unit_price = max(0, (float) ($item['unit'] ?? 0));
            $price = $unit_price * (float) ($payload['factor'] ?? 1);
            $meta = [
                '_fbpos_price' => $price,
                '_fbpos_source' => 'pos',
                '_fbpos_key' => wp_generate_uuid4(),
            ];

            // El plugin externo fusion-bikes-master-control (CartController::beforeCalculateTotals,
            // prioridad 10) IGNORA nuestra metadata _fbpos_price: vuelve a leer el regular_price
            // real del producto desde la base y lo multiplica SIEMPRE por el coeficiente de 24
            // cuotas (precio "de lista" inflado), y recién después su CheckoutController aplica
            // una "Bonificación Plan N Cuotas" (fee negativo) que lo corrige al precio del plan
            // realmente elegido — pero SOLO si hay un plan de financiación activo en sesión
            // (fusion_mp_plan_locked). Sin eso, cae al modo "Bonificación Pago Contado", que
            // además oculta el gateway de Mercado Pago del checkout (probado en e2e: por eso
            // se había suprimido antes esa sesión, y por eso rompió todo). La solución correcta
            // es la inversa: MANTENER esas variables de sesión con las cuotas reales de la
            // pierna (ver más abajo, ya no se suprimen), y ajustar el regular_price del producto
            // sintético usando el coeficiente de ESAS cuotas (no el fijo de 24), para que el
            // monto final — después de que la Bonificación Plan N Cuotas haga su ajuste — dé
            // exactamente lo que queremos cobrar, sin recargo adicional.
            if ((bool) ($payload['mixed_leg'] ?? false) && $product_id === (int) get_option('fbpos_synthetic_product_id')) {
                $leg_installments = (string) ($payload['installments'] ?? '');
                $coef = $leg_installments ? $this->master_control_bridge->get_coefficient($leg_installments) : null;
                $coef = ($coef && $coef > 0) ? $coef : 1.0;
                $adjusted_regular_price = round($price / $coef, 2);

                $product->set_regular_price((string) $adjusted_regular_price);
                $product->set_price((string) $adjusted_regular_price);
                $product->save();
            }

            if ($product->is_type('variation')) {
                WC()->cart->add_to_cart(
                    $product->get_parent_id(),
                    $qty,
                    $product->get_id(),
                    $product->get_variation_attributes(),
                    $meta
                );
            } else {
                WC()->cart->add_to_cart($product->get_id(), $qty, 0, [], $meta);
            }
        }

        // Configurar cliente
        if (WC()->customer) {
            $customer_name = sanitize_text_field($payload['customer_name'] ?? 'Consumidor final');
            $name_parts = preg_split('/\s+/', trim($customer_name), 2);

            WC()->customer->set_billing_first_name($name_parts[0] ?? $customer_name);
            WC()->customer->set_billing_last_name($name_parts[1] ?? '');

            if (!empty($payload['customer_email'])) {
                WC()->customer->set_billing_email(sanitize_email($payload['customer_email']));
            }

            if (!empty($payload['customer_phone'])) {
                WC()->customer->set_billing_phone(sanitize_text_field($payload['customer_phone']));
            }

            WC()->customer->save();
        }

        // Configurar gateway y sesión
        $gateway = sanitize_key($payload['gateway'] ?? '');

        if (WC()->session) {
            WC()->session->set('chosen_payment_method', $gateway);
            WC()->session->set('fbpos_checkout_payload', $payload);

            // Si es Mercado Pago y hay cuota, setear variables de sesión para que Master Control lo procese correctamente.
            // También para piernas de pago mixto: sin esto, Master Control cae en su modo "sin
            // plan" (Bonificación Pago Contado), que además oculta el gateway de MP del checkout
            // por completo — el ajuste de "sin recargo adicional" para la pierna se hace vía el
            // regular_price del producto sintético (ver más arriba), no suprimiendo esta sesión.
            if (
                $this->payment_gateway_service->is_mercadopago_gateway($gateway)
                && !empty($payload['installments'])
            ) {
                $installments = (string) $payload['installments'];
                WC()->session->set('fusion_selected_financing_plan', $installments);
                WC()->session->set('fusion_selected_mp_quota', $installments);
                WC()->session->set('fusion_mp_plan_locked', true);
            }
        }

        WC()->cart->calculate_totals();

        wp_safe_redirect(
            add_query_arg(
                [
                    'fbpos_ready' => '1',
                    'fbpos_gateway' => $gateway,
                    'fbpos_source' => 'pos',
                    'fbpos_installments' => $payload['installments'] ?? '',
                    'fbpos_mixed_leg' => !empty($payload['mixed_leg']) ? '1' : '',
                ],
                wc_get_checkout_url()
            )
        );

        exit;
    }

    /**
     * Aplica los precios especiales de POS a los items del carrito.
     * Se ejecuta en woocommerce_before_calculate_totals con prioridad 5.
     */
    public function apply_checkout_prices($cart) {
        if (is_admin() && !defined('DOING_AJAX')) {
            return;
        }

        foreach ($cart->get_cart() as $item) {
            if (isset($item['_fbpos_price']) && isset($item['data']) && is_object($item['data'])) {
                $item['data']->set_price((float) $item['_fbpos_price']);
            }
        }
    }

    /**
     * BUG CRÍTICO FIX: Aplica los precios especiales de POS a los items de una orden directa.
     * Esta función se debe llamar ANTES de calculate_totals() cuando se crea una orden
     * directamente (sin pasar por el carrito), para asegurar que el factor de cuotas
     * se refleje correctamente en el Order Total.
     *
     * Usa la metadata _fbpos_price que se estableció cuando se añadieron los items.
     */
    public function apply_direct_order_prices($order) {
        foreach ($order->get_items() as $item) {
            $fbpos_price = $item->get_meta('_fbpos_price');
            if ($fbpos_price) {
                $fbpos_price = (float) $fbpos_price;
                $item->set_subtotal($fbpos_price);
                $item->set_total($fbpos_price);
                $item->save();
            }
        }
    }

    /**
     * Decora la orden con datos de POS al crearla.
     * Agrega meta fields: plan_label, factor, user_id, source, documento, etc.
     * Se ejecuta en woocommerce_checkout_create_order con prioridad 10.
     */
    public function decorate_checkout_order($order, $data) {
        if (!WC()->session) {
            return;
        }

        $payload = WC()->session->get('fbpos_checkout_payload');

        if (!is_array($payload)) {
            return;
        }

        $order->update_meta_data('_fbpos_plan_label', sanitize_text_field($payload['label'] ?? ''));
        $order->update_meta_data('_fbpos_factor', (float) ($payload['factor'] ?? 1));
        $order->update_meta_data('_fbpos_user_id', absint($payload['user_id'] ?? get_current_user_id()));
        $order->update_meta_data('_fbpos_source', 'checkout_online');

        // Guardar metadatos de mixed_leg si aplica
        if (!empty($payload['mixed_leg']) && (bool) $payload['mixed_leg']) {
            $order->update_meta_data('_fbpos_mixed_leg', true);
            $order->update_meta_data('_fbpos_mixed_ticket_ref', sanitize_text_field($payload['mixed_ticket_ref'] ?? ''));
            $order->update_meta_data('_fbpos_mixed_row_id', sanitize_text_field($payload['mixed_row_id'] ?? ''));
            // PUNTO 4: Guardar el gateway_id de esta pierna para que M3 pueda leerlo sin hardcodeados
            $order->update_meta_data('_fbpos_payment_gateway_id', sanitize_text_field($payload['gateway'] ?? ''));
        }

        // Guardar documento
        $document = $this->customer_service->normalize_document($payload['customer_document'] ?? '');
        $document_type = strtoupper(sanitize_text_field($payload['document_type'] ?? 'DNI')) === 'CUIT' ? 'CUIT' : 'DNI';

        if ($document) {
            $meta_key = $document_type === 'CUIT' ? '_billing_cuit' : '_billing_dni';
            $order->update_meta_data($meta_key, $document);
            $order->update_meta_data('_billing_dni_cuit', $document);
            $order->update_meta_data('_fbpos_document_type', $document_type);
            $order->update_meta_data('_fbpos_document', $document);
        }

        if (!empty($payload['note'])) {
            $order->add_order_note(sanitize_textarea_field($payload['note']));
        }

        $order->add_order_note('Pedido iniciado desde Fusion Bikes POS y cobrado mediante el checkout online.');
    }

    /**
     * Limpia la sesión de checkout después de que la orden sea completada.
     * Se ejecuta en woocommerce_thankyou con prioridad 20.
     */
    public function clear_checkout_session($order_id) {
        if (WC()->session) {
            WC()->session->__unset('fbpos_checkout_payload');
        }
    }

    /**
     * Prepara el UI para pago nativo (Mercado Pago).
     * Se ejecuta en template_redirect con prioridad 1.
     */
    public function prepare_native_payment() {
        if (empty($_GET['fbpos_gateway'])) {
            return;
        }

        $is_on_checkout = function_exists('is_checkout') && (
            is_checkout()
            || (function_exists('is_wc_endpoint_url') && is_wc_endpoint_url('order-pay'))
        );

        if (!$is_on_checkout) {
            return;
        }

        $gateway_id = sanitize_key(wp_unslash($_GET['fbpos_gateway']));

        if (!$this->payment_gateway_service->is_mercadopago_gateway($gateway_id)) {
            return;
        }

        if (WC()->session) {
            WC()->session->set('chosen_payment_method', $gateway_id);

            // Re-aplicar las variables de sesión de cuotas desde la URL
            // (persistir cuotas entre el Request 1 de prepare_checkout y el Request 2 de esta página).
            // También para piernas de pago mixto — ver comentario en prepare_checkout().
            if (!empty($_GET['fbpos_installments'])) {
                $installments = sanitize_key(wp_unslash($_GET['fbpos_installments']));

                // Solo setear si el parámetro no está vacío
                if ($installments !== '') {
                    if (
                        $this->master_control_bridge
                        && method_exists($this->master_control_bridge, 'is_valid_installment')
                        && $this->master_control_bridge->is_valid_installment($installments)
                    ) {
                        $normalized = $this->master_control_bridge->normalize_installment($installments);
                        WC()->session->set('fusion_selected_financing_plan', $normalized);
                        WC()->session->set('fusion_selected_mp_quota', $normalized);
                        WC()->session->set('fusion_mp_plan_locked', true);
                    }
                }
            }
        }
    }

    /**
     * Renderiza el UI de pago nativo (Mercado Pago).
     * Muestra una nota y selecciona automáticamente el gateway.
     * Se ejecuta en wp_footer con prioridad 99.
     */
    public function render_native_payment_ui() {
        if (empty($_GET['fbpos_gateway'])) {
            return;
        }

        $is_on_checkout = function_exists('is_checkout') && (
            is_checkout()
            || (function_exists('is_wc_endpoint_url') && is_wc_endpoint_url('order-pay'))
        );

        if (!$is_on_checkout) {
            return;
        }

        $gateway_id = sanitize_key(wp_unslash($_GET['fbpos_gateway']));

        if (!$this->payment_gateway_service->is_mercadopago_gateway($gateway_id)) {
            return;
        }

        ?>
        <style>
        .fbpos-native-pay-note {
            max-width: 980px;
            margin: 18px auto;
            padding: 14px 18px;
            border: 1px solid #b9e6f7;
            border-radius: 10px;
            background: #f0fbff;
            color: #17324d;
            font-weight: 700;
        }
        .fbpos-native-pay-note small {
            display: block;
            margin-top: 4px;
            color: #52606d;
            font-weight: 500;
        }
        </style>
        <script>
        document.addEventListener('DOMContentLoaded', function() {
            var id = <?php echo wp_json_encode($gateway_id); ?>;
            var form = document.querySelector('form#order_review, form.woocommerce-checkout');

            if (form && !document.querySelector('.fbpos-native-pay-note')) {
                var note = document.createElement('div');
                note.className = 'fbpos-native-pay-note';
                note.innerHTML = 'Cobro seguro de Fusion Bikes POS<small>Completá los datos de Mercado Pago y elegí las cuotas exactamente igual que en el checkout de la tienda.</small>';
                form.parentNode.insertBefore(note, form);
            }

            var input = document.querySelector('input[name="payment_method"][value="' + CSS.escape(id) + '"]');
            if (input) {
                input.checked = true;
                input.dispatchEvent(new Event('change', { bubbles: true }));
                input.click();
            }
        });
        </script>
        <?php
    }

    /**
     * M1: Búsqueda centralizada de pedido transitorio por mixed_row_id.
     * Usada por FBPOS_Order_Controller y FBPOS_Mixed_Leg_Controller.
     * A1: Valida que sea una pierna válida (_fbpos_mixed_leg = 1) y pertenezca al ticket si se proporciona.
     *
     * @param string $row_id ID de fila de la pierna
     * @param string $mixed_ticket_ref Opcional: validar pertenencia al ticket
     * @return WC_Order|null El pedido transitorio si existe y es válido, null de lo contrario.
     */
    public function find_order_by_mixed_row_id($row_id, $mixed_ticket_ref = '') {
        $meta_query = [
            [
                'key' => '_fbpos_mixed_row_id',
                'value' => $row_id,
                'compare' => '=',
            ],
            [
                'key' => '_fbpos_mixed_leg',
                'value' => 1,
                'compare' => '=', // A1: Confirmar que es una pierna
            ],
        ];

        // A1: Si se pasa ticket_ref, validar que pertenezca al mismo ticket
        if (!empty($mixed_ticket_ref)) {
            $meta_query[] = [
                'key' => '_fbpos_mixed_ticket_ref',
                'value' => $mixed_ticket_ref,
                'compare' => '=',
            ];
        }

        $args = [
            'meta_query' => [
                'relation' => 'AND',
                ...$meta_query,
            ],
            'orderby' => 'date',
            'order' => 'DESC',
            'limit' => 1,
        ];

        $orders = wc_get_orders($args);

        return !empty($orders) ? $orders[0] : null;
    }

    /**
     * Verifica si el usuario actual tiene permisos para usar POS.
     */
    private function is_user_allowed() {
        return is_user_logged_in() && current_user_can('manage_woocommerce');
    }
}
