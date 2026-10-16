<?php
/**
 * Controlador REST: creación y visualización de presupuestos.
 * Endpoints:
 * - POST /fbpos/v2/quote
 * - GET /presupuesto/{token}/ (público)
 */
if (!defined('ABSPATH')) exit;

class FBPOS_Quote_Controller {
    private $order_service;

    const OPT_QUOTE_DAYS = 'fbpos_quote_valid_days';

    public function __construct(FBPOS_Order_Service $order_service) {
        $this->order_service = $order_service;
    }

    /**
     * Crea un presupuesto.
     * POST /fbpos/v2/quote
     *
     * @param WP_REST_Request $request
     * @return WP_REST_Response
     */
    public function create_quote(WP_REST_Request $request) {
        try {
            $data = $request->get_json_params();
            $items = $this->order_service->clean_items($data['items'] ?? []);

            if (!$items) {
                throw new Exception('El carrito está vacío.');
            }

            $token = wp_generate_password(20, false, false);
            $number = 'PRE-' . date('ymd') . '-' . wp_rand(1000, 9999);
            $quote_id = wp_insert_post([
                'post_type' => 'fbpos_quote',
                'post_status' => 'publish',
                'post_title' => $number,
                'post_author' => get_current_user_id(),
            ], true);

            if (is_wp_error($quote_id)) {
                throw new Exception($quote_id->get_error_message());
            }

            // MEDIO 9: Recalcular subtotal server-side desde los items
            // No confiar en lo que envía el cliente — recalcular sumando items limpios
            $recalculated_subtotal = 0;
            foreach ($items as $item) {
                $recalculated_subtotal += round((float) $item['unit'] * (int) $item['qty'], 2);
            }

            // Construir snapshot del presupuesto
            $days_valid = max(1, absint(get_option(self::OPT_QUOTE_DAYS, 7)));
            $snapshot = [
                'number' => $number,
                'created' => current_time('mysql'),
                'valid_until' => date_i18n(
                    'Y-m-d',
                    strtotime('+' . $days_valid . ' days', current_time('timestamp'))
                ),
                'customer' => sanitize_text_field($data['customer_name'] ?? 'Consumidor final'),
                'document_type' => sanitize_text_field($data['document_type'] ?? ''),
                'document' => sanitize_text_field($data['customer_document'] ?? ''),
                'phone' => sanitize_text_field($data['customer_phone'] ?? ''),
                'email' => sanitize_email($data['customer_email'] ?? ''),
                'note' => sanitize_textarea_field($data['note'] ?? ''),
                'items' => $items,
                'subtotal' => $recalculated_subtotal, // MEDIO 9: Usar valor recalculado, no del cliente
                'options' => (array) ($data['options'] ?? []),
                'seller' => wp_get_current_user()->display_name,
            ];

            update_post_meta($quote_id, '_fbpos_token', $token);
            update_post_meta($quote_id, '_fbpos_snapshot', $snapshot);

            $base_url = home_url('/presupuesto/' . $token . '/');

            return rest_ensure_response([
                'success' => true,
                'id' => $quote_id,
                'number' => $number,
                'url' => $base_url,
                'print_url' => add_query_arg('print', '1', $base_url),
                'whatsapp' => 'https://wa.me/?text=' . rawurlencode(
                    'Hola, te enviamos el presupuesto ' . $number . ' de Fusion Bikes: ' . $base_url
                ),
            ]);
        } catch (Throwable $e) {
            return new WP_Error('quote_error', $e->getMessage(), ['status' => 400]);
        }
    }

    /**
     * Lista todos los presupuestos.
     * GET /fbpos/v2/quotes
     *
     * MEDIO 8: Límite de 200 últimos presupuestos para evitar degradación con el tiempo.
     * No hace falta paginación completa todavía dado el volumen de este comercio.
     *
     * @return WP_REST_Response
     */
    public function list_quotes() {
        try {
            // MEDIO 8: Limitar a los últimos 200 presupuestos, ordenados por fecha DESC
            // Usar 'fields' => 'ids' para no traer objetos completos de más (N+1 prevention)
            $quote_ids = get_posts([
                'post_type' => 'fbpos_quote',
                'post_status' => 'publish',
                'numberposts' => 200, // Límite duro para evitar degradación
                'orderby' => 'date',
                'order' => 'DESC',
                'fields' => 'ids', // Solo IDs, no objetos completos
            ]);

            $quotes = [];
            $today = date('Y-m-d');

            foreach ($quote_ids as $quote_id) {
                $post = get_post($quote_id);
                if (!$post) {
                    continue;
                }

                $snapshot = get_post_meta($post->ID, '_fbpos_snapshot', true);
                $converted_order_id = get_post_meta($post->ID, '_fbpos_converted_order_id', true);

                if (!$snapshot || !is_array($snapshot)) {
                    continue;
                }

                // Determinar estado: pending, converted o expired
                $valid_until = sanitize_text_field($snapshot['valid_until'] ?? '');
                if ($converted_order_id) {
                    $status = 'converted';
                } elseif ($valid_until && $valid_until < $today) {
                    $status = 'expired';
                } else {
                    $status = 'pending';
                }

                $quote_data = [
                    'id' => $post->ID,
                    'number' => $post->post_title,
                    'customer' => sanitize_text_field($snapshot['customer'] ?? 'Consumidor final'),
                    'customer_email' => sanitize_email($snapshot['email'] ?? ''),
                    'customer_phone' => sanitize_text_field($snapshot['phone'] ?? ''),
                    'customer_document' => sanitize_text_field($snapshot['document'] ?? ''),
                    'document_type' => sanitize_text_field($snapshot['document_type'] ?? ''),
                    'total' => (float) ($snapshot['subtotal'] ?? 0),
                    'created' => sanitize_text_field($snapshot['created'] ?? ''),
                    'valid_until' => $valid_until,
                    'status' => $status,
                ];

                if ($converted_order_id) {
                    $quote_data['converted_order_id'] = (int) $converted_order_id;
                    // MEDIO 8: Evitar N+1 — solo buscar la orden si realmente vamos a usar el número
                    $order = wc_get_order($converted_order_id);
                    if ($order) {
                        $quote_data['converted_order_number'] = $order->get_order_number();
                    }
                }

                $quotes[] = $quote_data;
            }

            return rest_ensure_response([
                'success' => true,
                'quotes' => $quotes,
                'total' => count($quotes),
            ]);
        } catch (Throwable $e) {
            return new WP_Error('quotes_error', $e->getMessage(), ['status' => 400]);
        }
    }

    /**
     * Renderiza la página pública de presupuesto.
     * Se ejecuta en template_redirect.
     * Usado por la URL /presupuesto/{token}
     */
    public function render_public_quote() {
        $token = get_query_var('fbpos_quote');

        if (!$token) {
            return;
        }

        $posts = get_posts([
            'post_type' => 'fbpos_quote',
            'post_status' => 'publish',
            'meta_key' => '_fbpos_token',
            'meta_value' => sanitize_text_field($token),
            'numberposts' => 1,
        ]);

        if (!$posts) {
            status_header(404);
            exit('Presupuesto no encontrado.');
        }

        $s = get_post_meta($posts[0]->ID, '_fbpos_snapshot', true);

        // Incluir el template (relativo a la raíz del plugin)
        $template_path = plugin_dir_path(dirname(dirname(__FILE__))) . 'templates/quote.php';

        if (file_exists($template_path)) {
            include $template_path;
        }

        exit;
    }
}
