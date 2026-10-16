<?php
/**
 * Controlador REST: creación de órdenes.
 * Endpoint: POST /fbpos/v2/order
 */
if (!defined('ABSPATH')) exit;

class FBPOS_Order_Controller {
    private $order_service;
    private $payment_gateway_service;
    private $customer_service;
    private $master_control_bridge;

    const OPT_STATUS = 'fbpos_order_status';

    public function __construct(
        FBPOS_Order_Service $order_service,
        FBPOS_Payment_Gateway_Service $payment_gateway_service,
        FBPOS_Customer_Service $customer_service,
        ?FBPOS_Master_Control_Bridge $master_control_bridge = null
    ) {
        $this->order_service = $order_service;
        $this->payment_gateway_service = $payment_gateway_service;
        $this->customer_service = $customer_service;
        $this->master_control_bridge = $master_control_bridge ?? new FBPOS_Master_Control_Bridge();
    }

    /**
     * Crea una orden.
     * POST /fbpos/v2/order
     *
     * Maneja:
     * 1. Flujo Mercado Pago: genera payload y redirige a checkout
     * 2. Pago simple: crea orden directamente
     * 3. Pago mixto: crea orden con múltiples métodos
     *
     * ORDEN CRÍTICO DEL FLUJO (arreglado en esta ronda):
     * FASE 1 (ANTES del lock): Validaciones puras sin efectos secundarios
     *   - Presupuesto existe y no está convertido
     *   - Snapshot válido
     *   - Presupuesto no vencido
     *   - Items válidos
     *   - Precio congelado
     *   - Mercado Pago rechazado (3 formas)
     * FASE 2: Adquirir lock del presupuesto (CON TTL)
     * FASE 3: try { create orden } finally { liberar lock }
     *
     * @param WP_REST_Request $request
     * @return WP_REST_Response
     */
    public function create_order(WP_REST_Request $request) {
        try {
            $data = $request->get_json_params();
            $quote_id = absint($data['quote_id'] ?? 0);

            // Si viene quote_id, cargar presupuesto y usar su snapshot
            $quote_post = null;
            $snapshot = null;
            $quote_lock_key = null; // Clave del lock a liberar después

            if ($quote_id) {
                // ===== FASE 1: VALIDACIONES PURAS (sin effects, sin lock) =====

                $quote_post = get_post($quote_id);
                if (!$quote_post || $quote_post->post_type !== 'fbpos_quote') {
                    throw new Exception('Presupuesto no encontrado.');
                }

                // Validar que no esté ya convertido
                $converted_order_id = get_post_meta($quote_id, '_fbpos_converted_order_id', true);
                if ($converted_order_id) {
                    throw new Exception('Este presupuesto ya fue convertido a pedido. No se puede volver a convertir.');
                }

                // Cargar snapshot del presupuesto
                $snapshot = get_post_meta($quote_id, '_fbpos_snapshot', true);
                if (!$snapshot || !is_array($snapshot)) {
                    throw new Exception('Snapshot del presupuesto no encontrado o inválido.');
                }

                // ALTO 4: Validar que el presupuesto no esté vencido
                $valid_until = sanitize_text_field($snapshot['valid_until'] ?? '');
                if ($valid_until && $valid_until < date('Y-m-d')) {
                    throw new Exception(
                        sprintf(
                            'Este presupuesto venció el %s. Generá un presupuesto nuevo para cobrar el precio actualizado.',
                            esc_html($valid_until)
                        )
                    );
                }

                // Usar items del snapshot, validarlos
                $items = $this->order_service->clean_items($snapshot['items'] ?? []);
                if (!$items) {
                    throw new Exception('El presupuesto no tiene items válidos.');
                }

                // ALTO 3: Validar que el precio no haya cambiado desde que se cotizó
                // Recalcular el subtotal desde los items limpios
                $recalculated_subtotal = 0;
                foreach ($items as $item) {
                    $recalculated_subtotal += round((float) $item['unit'] * (int) $item['qty'], 2);
                }

                $snapshot_subtotal = (float) ($snapshot['subtotal'] ?? 0);
                $price_tolerance = 1.00; // Tolerancia de $1 por redondeos

                if (abs($recalculated_subtotal - $snapshot_subtotal) > $price_tolerance) {
                    throw new Exception(
                        sprintf(
                            'Los precios cambiaron desde que se generó este presupuesto (antes: $%.2f, ahora: $%.2f). Generá un presupuesto nuevo para cobrar el precio actualizado.',
                            $snapshot_subtotal,
                            $recalculated_subtotal
                        )
                    );
                }

                // Heredad datos del cliente del snapshot si no vienen en el payload
                // CRÍTICO: usar !empty() en vez de ?? para que strings vacíos también usen el snapshot
                $data['customer_name'] = !empty($data['customer_name']) ? $data['customer_name'] : ($snapshot['customer'] ?? 'Consumidor final');
                $data['customer_email'] = !empty($data['customer_email']) ? $data['customer_email'] : ($snapshot['email'] ?? '');
                $data['customer_phone'] = !empty($data['customer_phone']) ? $data['customer_phone'] : ($snapshot['phone'] ?? '');

                // MEDIO 6: Para customer_document y document_type, SIEMPRE usar el snapshot cuando hay quote_id
                // (ignorar lo que venga en el payload para esos dos campos)
                $data['customer_document'] = $snapshot['document'] ?? '';
                $data['document_type'] = $snapshot['document_type'] ?? 'DNI';

                $data['note'] = $data['note'] ?? ($snapshot['note'] ?? '');

                // Factor debe ser 1 para presupuestos (no se aplican recargos adicionales)
                $factor = 1.0;
            } else {
                $items = $this->order_service->clean_items($data['items'] ?? []);
                if (!$items) {
                    throw new Exception('El carrito está vacío.');
                }

                $factor = (float) ($data['factor'] ?? 1);
                if ($factor <= 0) {
                    $factor = 1;
                }
            }

            $gateways = WC()->payment_gateways()->payment_gateways();
            $mixed_payments = (array) ($data['mixed_payments'] ?? []);
            $gateway_id = sanitize_text_field($data['gateway'] ?? '');

            // ===== FASE 1 CONTINÚA: Rechazos de Mercado Pago (validaciones puras) =====

            // CRÍTICO 2: Rechazar explícitamente quote_id + Mercado Pago
            // (pago simple MP o mixed_leg con MP no están soportados hasta que se resuelva tarea #17)
            if ($quote_id) {
                $is_mixed_leg = !empty($data['mixed_leg']) && (bool) $data['mixed_leg'];

                // Validación 1: pago simple con MP
                if ($this->payment_gateway_service->is_mercadopago_gateway($gateway_id) && (!$mixed_payments || $is_mixed_leg)) {
                    throw new Exception(
                        'Este presupuesto no se puede cobrar con Mercado Pago todavía. Usá efectivo, transferencia, Posnet o pago mixto sin Mercado Pago.'
                    );
                }

                // Validación 2: pago mixto con MP en alguna fila
                if (!empty($mixed_payments)) {
                    foreach ($mixed_payments as $payment) {
                        $mp_gateway_id = sanitize_text_field($payment['gateway'] ?? '');
                        if ($this->payment_gateway_service->is_mercadopago_gateway($mp_gateway_id)) {
                            throw new Exception(
                                'Este presupuesto no se puede cobrar con Mercado Pago todavía. Usá efectivo, transferencia, Posnet o pago mixto sin Mercado Pago.'
                            );
                        }
                    }
                }
            }

            // MEDIO 1 (ronda 6): "mixed_leg" (alta de UNA pierna) y "mixed_consolidate" (cerrar
            // el ticket con piernas ya cobradas) son operaciones distintas y no deben compartir
            // flag — mezclarlas hacía que la ruta de consolidación fuera inalcanzable sin violar
            // la regla de handle_mercadopago_flow() que prohíbe mixed_leg junto con mixed_payments.
            $is_mixed_consolidate = !empty($data['mixed_consolidate']) && (bool) $data['mixed_consolidate'];
            if (!empty($mixed_payments) && !$is_mixed_consolidate) {
                foreach ($mixed_payments as $payment) {
                    $mp_gateway_id = sanitize_text_field($payment['gateway'] ?? '');
                    if ($this->payment_gateway_service->is_mercadopago_gateway($mp_gateway_id)) {
                        throw new Exception('Mercado Pago nativo no puede formar parte de un pago combinado. Usalo como pago simple para cargar tarjeta y cuotas.');
                    }
                }
            }

            // Flujo 1: Mercado Pago como pago único, o como alta de UNA pierna de un pago mixto
            $is_mixed_leg = !empty($data['mixed_leg']) && (bool) $data['mixed_leg'];
            if ($this->payment_gateway_service->is_mercadopago_gateway($gateway_id) && (!$mixed_payments || $is_mixed_leg)) {
                return $this->handle_mercadopago_flow(
                    $data,
                    $items,
                    $factor,
                    $gateway_id,
                    $gateways
                );
            }

            // ===== FASE 2: Adquirir lock del presupuesto (CON TTL) =====
            if ($quote_id) {
                $quote_lock_key = $this->acquire_quote_lock($quote_id);
            }

            // ===== FASE 3: Crear orden (con try/finally para liberar lock) =====
            try {
                return $this->handle_direct_order_flow(
                    $data,
                    $items,
                    $factor,
                    $mixed_payments,
                    $gateway_id,
                    $gateways,
                    $quote_id
                );
            } finally {
                // CRÍTICO 1: Liberar el lock del presupuesto si se adquirió
                // (así si la orden falla, no queda el lock pegado para siempre)
                if ($quote_lock_key) {
                    $this->release_quote_lock($quote_lock_key);
                }
            }
        } catch (Throwable $e) {
            return new WP_Error('order_error', $e->getMessage(), ['status' => 400]);
        }
    }

    /**
     * Maneja el flujo de Mercado Pago: retorna URL de checkout online.
     * Soporta tanto pago simple como pierna de un pago mixto (mixed_leg).
     * C4: Rechaza si viene tanto mixed_payments como mixed_leg (son operaciones distintas).
     */
    private function handle_mercadopago_flow($data, $items, $factor, $gateway_id, $gateways) {
        if (!isset($gateways[$gateway_id])) {
            throw new Exception('Medio de pago no válido.');
        }

        // C4: mixed_leg y mixed_payments son operaciones distintas, no pueden venir juntas
        $is_mixed_leg = !empty($data['mixed_leg']) && (bool) $data['mixed_leg'];
        $mixed_payments = (array) ($data['mixed_payments'] ?? []);

        if ($is_mixed_leg && !empty($mixed_payments)) {
            throw new Exception(
                'No se puede enviar mixed_leg y mixed_payments en el mismo request. '
                . 'mixed_leg = iniciar UNA pierna. mixed_payments = cerrar el pago consolidado con todas las piernas.'
            );
        }

        // Validación crucial: no existe "contado con tarjeta"
        // Las cuotas válidas para MP son: 3, 6, 9, 12, 18, 24
        $installments = isset($data['installments']) ? absint($data['installments']) : null;

        if (
            empty($installments)
            || !$this->master_control_bridge->is_valid_installment($installments)
        ) {
            throw new Exception('Para pagar con tarjeta, elegí un plan de cuotas (no está disponible para pago contado).');
        }

        // Normalizar cuota a string
        $normalized_installments = $this->master_control_bridge->normalize_installment($installments);

        // M3: Si es mixed_leg, validar que no exista ya una tercera pierna activa para este ticket
        if ($is_mixed_leg) {
            $mixed_ticket_ref = sanitize_text_field($data['mixed_ticket_ref'] ?? '');
            if ($mixed_ticket_ref) {
                $active_legs = wc_get_orders([
                    'meta_query' => [
                        'relation' => 'AND',
                        [
                            'key' => '_fbpos_mixed_ticket_ref',
                            'value' => $mixed_ticket_ref,
                            'compare' => '=',
                        ],
                        [
                            'key' => '_fbpos_mixed_leg',
                            'value' => 1,
                            'compare' => '=',
                        ],
                    ],
                    'status' => ['pending', 'processing', 'completed'],
                    'limit' => 100,
                ]);

                // Contar cuántas piernas MP activas existen (PUNTO 4: usar gateway_id real, no hardcodeado)
                $mp_leg_count = 0;
                foreach ($active_legs as $leg) {
                    // Leer el gateway real de esta pierna desde su meta, no asumir 'woo-mercado-pago' hardcodeado
                    $leg_gateway = $leg->get_meta('_fbpos_payment_gateway_id');
                    if ($leg_gateway && $this->payment_gateway_service->is_mercadopago_gateway($leg_gateway)) {
                        $mp_leg_count++;
                    }
                }

                // Si ya hay 2 piernas MP activas, rechazar la tercera
                if ($mp_leg_count >= 2) {
                    throw new Exception(
                        'Ya existen 2 piernas de tarjeta activas para este ticket. '
                        . 'Máximo 2 tarjetas permitidas por pago combinado.'
                    );
                }
            }
        }

        // Si es mixed_leg, armar un ítem sintético por el monto de esa pierna
        $payload_items = $items;
        $is_mixed_leg = !empty($data['mixed_leg']) && (bool) $data['mixed_leg'];
        $mixed_ticket_ref = '';
        $mixed_row_id = '';

        if ($is_mixed_leg) {
            $mixed_ticket_ref = sanitize_text_field($data['mixed_ticket_ref'] ?? '');
            $mixed_row_id = sanitize_text_field($data['mixed_row_id'] ?? '');
            $mixed_leg_amount = (float) ($data['mixed_leg_amount'] ?? 0);

            if (!$mixed_ticket_ref || !$mixed_row_id || $mixed_leg_amount <= 0) {
                throw new Exception('Pierna de pago mixto incompleta: falta mixed_ticket_ref, mixed_row_id o mixed_leg_amount.');
            }

            // Decisión de negocio: una pierna de pago mixto cobra exactamente el monto que
            // declaró el cajero, sin recargo adicional (el recargo del plan global, si lo
            // hay, ya está incluido en lo que se está repartiendo). Forzar factor=1 acá
            // server-side, sin confiar en lo que mande el cliente (revisor, ronda 9, hallazgo 4).
            $factor = 1.0;

            // M5: Sanitizar y acotar el ticket_ref en el nombre del ítem sintético (no producto real)
            $ticket_ref_display = substr($mixed_ticket_ref, 0, 50); // Máximo 50 caracteres
            $ticket_ref_display = preg_replace('/[^a-zA-Z0-9\-_]/', '', $ticket_ref_display);

            // Crear ítem sintético para esta pierna (usar el producto placeholder creado por order_service)
            $synthetic_product_id = $this->order_service->get_or_create_synthetic_product_id();

            $payload_items = [
                [
                    'id' => $synthetic_product_id,
                    'name' => 'Pago parcial — Ticket #' . esc_html($ticket_ref_display) . ' — Tarjeta',
                    'variation' => '',
                    'qty' => 1,
                    'unit' => $mixed_leg_amount,
                    'image' => wc_placeholder_img_src(),
                    'url' => '',
                ],
            ];
        }

        $payload = [
            'items' => $payload_items,
            'factor' => $factor,
            'label' => sanitize_text_field($data['label'] ?? ''),
            'gateway' => $gateway_id,
            'installments' => $normalized_installments,
            'customer_id' => absint($data['customer_id'] ?? 0),
            'customer_name' => sanitize_text_field($data['customer_name'] ?? 'Consumidor final'),
            'customer_phone' => sanitize_text_field($data['customer_phone'] ?? ''),
            'customer_email' => sanitize_email($data['customer_email'] ?? ''),
            'customer_document' => $this->customer_service->normalize_document($data['customer_document'] ?? ''),
            'document_type' => sanitize_text_field($data['document_type'] ?? ''),
            'note' => sanitize_textarea_field($data['note'] ?? ''),
            'user_id' => get_current_user_id(),
            'mixed_leg' => $is_mixed_leg,
            'mixed_ticket_ref' => $mixed_ticket_ref,
            'mixed_row_id' => $mixed_row_id,
        ];

        $total = 0;
        foreach ($payload_items as $item) {
            $total += (float) $item['unit'] * (int) $item['qty'] * $factor;
        }

        $payment_url = $this->payment_gateway_service->get_checkout_payload_url($payload, $gateway_id);

        return rest_ensure_response([
            'success' => true,
            'order_id' => 0,
            'number' => 'Checkout online',
            'total' => wc_price($total),
            'status' => 'Pendiente de completar',
            'payment' => wp_strip_all_tags($gateways[$gateway_id]->get_title()),
            'edit_url' => '',
            'invoice_url' => '',
            'payment_url' => $payment_url,
            'requires_native_payment' => true,
            'checkout_mode' => true,
            'mixed_row_id' => $mixed_row_id,
        ]);
    }

    /**
     * Maneja el flujo directo: crea la orden en WooCommerce.
     *
     * ORDEN CRÍTICO (arreglado en ronda 3):
     * 1. Si hay mixed_payments: VALIDACIÓN PURA (Fase 1) ANTES de crear la orden
     * 2. Crear la orden consolidada
     * 3. Agregar items
     * 4. Configurar cliente
     * 5. Ejecutar EFECTOS SECUNDARIOS (Fase 2): trashear piernas validadas, guardar meta
     *
     * ALTO 5 (ronda 4): Pago simple valida gateway DESPUÉS de crear orden → ANTES
     *
     * CRÍTICO 1: Si $quote_id > 0, marca la conversión SOLO si la orden se crea exitosamente.
     * El lock del presupuesto se libera en create_order() en el finally si hay error.
     */
    private function handle_direct_order_flow($data, $items, $factor, $mixed_payments, $gateway_id, $gateways, $quote_id = 0) {
        $customer_id = absint($data['customer_id'] ?? 0);

        // ALTO 5: Validación temprana del gateway para pago simple
        // Si no hay mixed_payments, validar que el gateway existe ANTES de crear orden
        if (!$mixed_payments) {
            if (!isset($gateways[$gateway_id])) {
                throw new Exception('Medio de pago no válido.');
            }

            // Validación crucial: Posnet requiere cuotas obligatorias (igual que MP)
            // Las cuotas válidas para Posnet son: 3, 6, 9, 12, 18 (sin 24)
            if ($this->payment_gateway_service->is_posnet_gateway($gateway_id)) {
                $installments = isset($data['installments']) ? absint($data['installments']) : null;

                if (
                    empty($installments)
                    || !$this->master_control_bridge->is_valid_installment_posnet($installments)
                ) {
                    throw new Exception('Para pagar con Posnet, elegí un plan de cuotas (no está disponible para pago contado).');
                }
            }
        }

        // MEDIO 4: Calcular total esperado de items*factor ANTES de crear orden
        // Necesario para validar suma de mixed_payments en Fase 1.
        // MEDIO 2 (ronda 6): redondear por línea (igual que hace WooCommerce internamente al
        // guardar cada line item) para que este total no diverja del real por acumulación de
        // redondeo en carritos con varias líneas.
        // El factor del plan elegido en "Opciones comerciales" (ej. 6 cuotas -> 1.25) se
        // aplica SIEMPRE al total de los items reales del ticket, sea pago simple o mixto.
        // En pago mixto el cajero reparte ESE total ya financiado entre las filas — cada
        // fila NO vuelve a aplicar un recargo propio (ver decisión "reparte sobre el total
        // ya financiado, la tarjeta NO se recarga de nuevo"). Forzar 1.0 acá rompía toda
        // venta mixta con un plan de cuotas elegido: expected_order_total quedaba en precio
        // base mientras la UI (y el cajero) ya venían sumando los montos sobre el total con
        // recargo, y el pedido se rechazaba con 400 "Suma de pagos mixtos no coincide"
        // (probador-e2e, verificación del fix de Posnet, Caso 3).
        $factor_for_items = $factor;
        $expected_order_total = 0;
        foreach ($items as $item) {
            $expected_order_total += round((float) $item['unit'] * (int) $item['qty'] * $factor_for_items, 2);
        }

        // ALTO 2 (ronda 6): la clave del lock se deriva de las filas reales de mixed_payments,
        // no de $data['mixed_ticket_ref'] top-level (ese campo nunca lo manda ningún cliente —
        // el ref vive por fila. Leerlo del nivel raíz hacía que el lock nunca se tomara).
        // Se adquiere ANTES de validación y se libera en el finally al final de TODO el proceso.
        $mixed_lock_key = null;
        if ($mixed_payments) {
            $mixed_ticket_ref = $this->derive_mixed_ticket_ref($mixed_payments);
            if ($mixed_ticket_ref) {
                $mixed_lock_key = $this->acquire_mixed_lock($mixed_ticket_ref);
            }
        }

        try {
            // FASE 1 (solo si hay mixed_payments): VALIDACIÓN PURA, sin escribir en la base
            // Esta fase lanza excepción si hay problema, ANTES de crear la orden consolidada
            $cleaned_payments = null;
            if ($mixed_payments) {
                $cleaned_payments = $this->validate_mixed_payments_phase($mixed_payments, $gateways, $expected_order_total);
            }

            // FASE 2: Crear la orden consolidada (solo si fase 1 completó sin errores)
            $order = wc_create_order(['created_via' => 'fusion-bikes-pos-pro', 'customer_id' => $customer_id]);

            // Agregar items
            foreach ($items as $item) {
                $product = wc_get_product($item['id']);
                $item_id = $order->add_product($product, $item['qty']);
                // MEDIO 1 (ronda 6, verificación 6): redondear igual que expected_order_total
                // arriba, para que Σround(línea) y no round(Σlínea) sea el valor en ambos lados.
                $line_total = round((float) $item['unit'] * (int) $item['qty'] * $factor_for_items, 2);

                $order_item = $order->get_item($item_id);
                // BUG CRÍTICO FIX: Setear _fbpos_price en metadata para que sea aplicado en calculate_totals
                // (en flujo de carrito se aplica vía hook woocommerce_before_calculate_totals, aquí no hay carrito)
                $order_item->update_meta_data('_fbpos_price', $line_total);
                $order_item->set_subtotal($line_total);
                $order_item->set_total($line_total);
                $order_item->save();
            }

            // Configurar cliente
            $order->set_billing_first_name(sanitize_text_field($data['customer_name'] ?? 'Consumidor final'));

            if (!empty($data['customer_email'])) {
                $order->set_billing_email(sanitize_email($data['customer_email']));
            }

            if (!empty($data['customer_phone'])) {
                $order->set_billing_phone(sanitize_text_field($data['customer_phone']));
            }

            // Guardar documento
            $document = $this->customer_service->normalize_document($data['customer_document'] ?? '');
            $document_type = strtoupper(sanitize_text_field($data['document_type'] ?? 'DNI')) === 'CUIT' ? 'CUIT' : 'DNI';

            if ($document) {
                $meta_key = $document_type === 'CUIT' ? '_billing_cuit' : '_billing_dni';
                $order->update_meta_data($meta_key, $document);
                $order->update_meta_data('_billing_dni_cuit', $document);
                $order->update_meta_data('_fbpos_document_type', $document_type);
                $order->update_meta_data('_fbpos_document', $document);
            }

            // Agregar meta fields de POS
            $order->update_meta_data('_fbpos_plan_label', sanitize_text_field($data['label'] ?? ''));
            $order->update_meta_data('_fbpos_factor', $factor);
            // BUG CRÍTICO FIX: En pago mixto, guardar también el factor que se usó realmente (1.0)
            $order->update_meta_data('_fbpos_factor_items', $factor_for_items);
            $order->update_meta_data('_fbpos_user_id', get_current_user_id());

            if (!empty($data['note'])) {
                $order->add_order_note(sanitize_textarea_field($data['note']));
            }

            // BUG CRÍTICO FIX: Aplicar precios especiales de POS ANTES de calculate_totals()
            // En flujo de carrito se hace vía woocommerce_before_calculate_totals hook,
            // en flujo directo (Posnet) se hace aquí porque no hay carrito
            $this->order_service->apply_direct_order_prices($order);

            // Calcular totales ANTES de guardar, necesario para validar suma en fase 2
            $order->calculate_totals();
            $order->save();

            // FASE 3 (si hay mixed_payments): EJECUTAR EFECTOS SECUNDARIOS
            // Ahora que la orden existe y tiene totales calculados, trashear piernas y guardar meta
            if ($cleaned_payments !== null) {
                $this->execute_mixed_payments_phase(
                    $order,
                    $cleaned_payments,
                    $gateways
                );
            } else {
                // Pago simple (gateway ya fue validado al inicio de handle_direct_order_flow)
                $order->set_payment_method($gateways[$gateway_id]);
            }

            // Procesar pago si es necesario
            $redirect_url = '';

            if (!$mixed_payments && isset($gateways[$gateway_id])) {
                try {
                    // Asegurar que el carrito esté cargado (requerido por algunos gateways)
                    if (!WC()->cart) {
                        wc_load_cart();
                    }

                    $payment_result = $gateways[$gateway_id]->process_payment($order->get_id());

                    if (is_array($payment_result) && !empty($payment_result['redirect'])) {
                        $redirect_url = esc_url_raw($payment_result['redirect']);
                    }
                } catch (Throwable $e) {
                    $order->add_order_note('Gateway POS: ' . $e->getMessage());
                }
            }

            // Actualizar estado si no hay redirect
            if (!$redirect_url && $order->has_status(['pending', 'failed'])) {
                $final_status = sanitize_key(get_option(self::OPT_STATUS, 'completed'));

                if (isset(wc_get_order_statuses()['wc-' . $final_status])) {
                    $order->update_status($final_status, 'Venta POS confirmada.');
                }
            }

            // Construir URLs de edición
            $edit_url = $this->get_order_edit_url($order->get_id());
            $invoice_url = add_query_arg('fbpos_invoice', '1', $edit_url);

            // CRÍTICO 1: Si la orden se creó desde un presupuesto, marcar la conversión SOLO ahora,
            // después de que TODA la creación de orden completó exitosamente y está guardada en la base.
            // El lock se libera en create_order() en el finally, así que acá ya es seguro marcar.
            if ($quote_id && $order->get_id()) {
                update_post_meta($quote_id, '_fbpos_converted_order_id', $order->get_id());
            }

            return rest_ensure_response([
                'success' => true,
                'order_id' => $order->get_id(),
                'number' => $order->get_order_number(),
                'total' => $order->get_formatted_order_total(),
                'status' => wc_get_order_status_name($order->get_status()),
                'payment' => $order->get_payment_method_title(),
                'edit_url' => $edit_url,
                'invoice_url' => $invoice_url,
                'payment_url' => $redirect_url,
                'requires_native_payment' => false,
            ]);
        } finally {
            // ALTO 2: Liberar lock de idempotencia DESPUÉS de que TODAS las fases (validación + ejecución) completan
            if ($mixed_lock_key) {
                $this->release_mixed_lock($mixed_lock_key);
            }
        }
    }

    /**
     * FASE 1: Validación pura de pagos mixtos (SIN efectos secundarios, SIN escribir en la base).
     *
     * Recorre TODAS las filas, valida cada una, y retorna un array limpio listo para persistir.
     * Si CUALQUIER fila falla, lanza excepción ANTES de tocar la base de datos.
     *
     * REGLAS CRÍTICAS (fail-closed):
     * - C1: Pedido transitorio DEBE existir si tiene mixed_row_id (MP)
     * - C2: Pedido transitorio DEBE estar en processing/completed (no pending/failed/cancelled)
     * - C3: El monto se toma del pedido transitorio real, no del payload del cliente
     * - C4: Cada fila MP se valida individualmente (no bypass global por mixed_leg flag)
     * - C6: Idempotencia: verifica si estos row_ids ya fueron consumidos (DENTRO de fase 1, antes de efectos)
     * - ALTO 1: Si fila tiene gateway MP, DEBE traer mixed_row_id Y mixed_ticket_ref no vacíos; todas las filas MP comparten mismo mixed_ticket_ref
     * - MEDIO 4: Suma total de all filas debe cuadrar contra expected_order_total (ANTES de crear orden)
     * - Punto 5: Búsqueda del pedido transitorio se hace UNA SOLA VEZ, no duplicada
     *
     * @param array $mixed_payments Array de pagos del request
     * @param array $gateways Gateways disponibles de WooCommerce
     * @param float $expected_order_total Total esperado de la orden (para MEDIO 4)
     * @return array Array de pagos validados y listos para persistir
     */
    private function validate_mixed_payments_phase($mixed_payments, $gateways, $expected_order_total = 0) {
        $cleaned = [];
        $mp_count = 0;
        $mixed_ticket_ref = '';
        $total_amount = 0;
        $total_rows = 0;

        foreach ($mixed_payments as $payment) {
            $gateway_id = sanitize_text_field($payment['gateway'] ?? '');
            $amount = round((float) ($payment['amount'] ?? 0), 2);
            $mixed_row_id = sanitize_text_field($payment['mixed_row_id'] ?? '');
            $mixed_ticket = sanitize_text_field($payment['mixed_ticket_ref'] ?? '');
            $installments = isset($payment['installments']) ? absint($payment['installments']) : null;

            if (!isset($gateways[$gateway_id]) || $amount <= 0) {
                continue;
            }

            $is_mp = $this->payment_gateway_service->is_mercadopago_gateway($gateway_id);
            $is_posnet = $this->payment_gateway_service->is_posnet_gateway($gateway_id);

            // Validación crucial: Posnet en pago mixto requiere cuotas obligatorias
            if ($is_posnet && (empty($installments) || !$this->master_control_bridge->is_valid_installment_posnet($installments))) {
                throw new Exception('Posnet en pago mixto requiere cuotas válidas (3, 6, 9, 12 o 18). Revisá la fila.');
            }

            // PUNTO 5: Guardar la orden transitoria validada en una variable para reusar
            // (no buscar dos veces como antes)
            $mixed_leg_order = null;

            // C4: VALIDACIÓN POR FILA — Si es MP, es OBLIGATORIO tener mixed_row_id y mixed_ticket_ref
            // ALTO 1: Ambos campos son obligatorios para filas MP
            if ($is_mp) {
                $mp_count++;
                if ($mp_count > 2) {
                    throw new Exception('Máximo 2 tarjetas permitidas por pago combinado.');
                }

                // ALTO 1: Fail-closed si falta mixed_row_id O mixed_ticket_ref
                if (!$mixed_row_id) {
                    throw new Exception(
                        'Pago con Mercado Pago en pago combinado requiere mixed_row_id válido (pierna incompleta o falsa).'
                    );
                }

                // ALTO 1: mixed_ticket_ref es OBLIGATORIO para filas MP
                if (!$mixed_ticket) {
                    throw new Exception(
                        'Falta la referencia del ticket para esta pierna de tarjeta. Reintentá con mixed_ticket_ref completo.'
                    );
                }

                // ALTO 1: Validar que todas las filas MP compartan el mismo mixed_ticket_ref
                if (!$mixed_ticket_ref) {
                    $mixed_ticket_ref = $mixed_ticket;
                } elseif ($mixed_ticket_ref !== $mixed_ticket) {
                    throw new Exception(
                        'Inconsistencia: las filas de pago mixto refieren a tickets distintos. '
                        . 'Todas las tarjetas deben pertenecer al mismo ticket.'
                    );
                }

                // PUNTO 5: BÚSQUEDA ÚNICA del pedido transitorio — se guarda para reusar después
                // ALTO 1: Pasar siempre mixed_ticket_ref (nunca vacío para filas MP)
                $mixed_leg_order = $this->order_service->find_order_by_mixed_row_id($mixed_row_id, $mixed_ticket);

                if (!$mixed_leg_order) {
                    throw new Exception(
                        sprintf(
                            'Pedido transitorio para pierna MP (row_id: %s) no encontrado. Pierna no completada o abandonada.',
                            esc_html($mixed_row_id)
                        )
                    );
                }

                // C2: Validar que el pedido transitorio esté en un estado válido (processing/completed)
                // A4: Timeout — si es pending y lleva más de 10 minutos, rechazar explícitamente con mensaje distinto
                // MEDIO 3: Usar getTimestamp() en vez de strtotime() para evitar desfase de timezone
                $leg_status = $mixed_leg_order->get_status();
                $created_date = $mixed_leg_order->get_date_created();
                if (!$created_date) {
                    throw new Exception('El pedido transitorio de esta pierna no tiene fecha de creación válida.');
                }
                $created_timestamp = $created_date->getTimestamp();
                $is_timeout = ($leg_status === 'pending') && ((time() - $created_timestamp) > 600); // 10 minutos

                if ($is_timeout) {
                    throw new Exception(
                        sprintf(
                            'Pierna de pago (row_id: %s) EXPIRADA por inactividad (>10 minutos en pending). '
                            . 'Iniciá una nueva tarjeta.',
                            esc_html($mixed_row_id)
                        )
                    );
                }

                $valid_leg_statuses = ['processing', 'completed'];
                if (!in_array($leg_status, $valid_leg_statuses, true)) {
                    throw new Exception(
                        sprintf(
                            'Pedido transitorio (row_id: %s) no está en estado válido (esperado: processing/completed, actual: %s).',
                            esc_html($mixed_row_id),
                            esc_html($leg_status)
                        )
                    );
                }

                // C4: Validar que el pedido transitorio sea realmente una pierna (evitar reuso de pedidos normales)
                $is_leg_marked = $mixed_leg_order->get_meta('_fbpos_mixed_leg');
                if (!$is_leg_marked) {
                    throw new Exception(
                        sprintf(
                            'Pedido (row_id: %s) no es una pierna de pago mixto válida (no tiene marcador _fbpos_mixed_leg).',
                            esc_html($mixed_row_id)
                        )
                    );
                }

                // Store first ticket_ref for idempotency check
                if (!$mixed_ticket_ref) {
                    $mixed_ticket_ref = $mixed_ticket;
                }
            }

            $payment_entry = [
                'gateway' => $gateway_id,
                'title' => wp_strip_all_tags($gateways[$gateway_id]->get_title()),
                'amount' => $amount,
            ];

            // Si es Posnet en pago mixto, guardar información de cuotas para tracking
            if ($is_posnet && $installments) {
                $payment_entry['installments'] = $installments;
            }

            // Si tiene mixed_row_id y es MP válido, copiar datos de la orden transitoria real
            // (PERO NO TRASHEAR AÚN — eso es en FASE 2)
            // PUNTO 5: Reusar el $mixed_leg_order que ya validamos arriba, no buscar de nuevo
            if ($mixed_row_id && $is_mp && $mixed_leg_order) {
                // C3: El monto SIEMPRE viene del pedido transitorio real, NO del payload del cliente
                $real_amount = (float) $mixed_leg_order->get_total();
                $amount_tolerance = 0.01; // Tolerancia de 1 centavo por redondeo

                if (abs($real_amount - $amount) > $amount_tolerance) {
                    throw new Exception(
                        sprintf(
                            'Monto de pierna MP (row_id: %s) no coincide: cliente declara %.2f, pedido real %.2f.',
                            esc_html($mixed_row_id),
                            $amount,
                            $real_amount
                        )
                    );
                }

                // Usar el monto real (no el declarado)
                $payment_entry['amount'] = $real_amount;
                $payment_entry['mixed_row_id'] = $mixed_row_id;
                $payment_entry['mixed_order_id'] = $mixed_leg_order->get_id();
                $payment_entry['transaction_id'] = $mixed_leg_order->get_transaction_id();

                // A2: Usar ?: en vez de ?? porque get_meta() devuelve '' no null
                $payment_entry['last_four_digits'] = (
                    $mixed_leg_order->get_meta('_mp_card_last_four') ?:
                    $mixed_leg_order->get_meta('_Mercado_Pago_Card_Last_Four') ?:
                    ''
                );
                $payment_entry['card_brand'] = (
                    $mixed_leg_order->get_meta('_mp_card_brand') ?:
                    $mixed_leg_order->get_meta('_Mercado_Pago_Card_Brand') ?:
                    ''
                );
                $payment_entry['installments'] = (
                    $mixed_leg_order->get_meta('_mp_installments') ?:
                    $mixed_leg_order->get_meta('_Mercado_Pago_Installments') ?:
                    ''
                );
                $payment_entry['total_with_fees'] = $real_amount;
            }

            $cleaned[] = $payment_entry;
            $total_amount += $payment_entry['amount'];
            $total_rows++;
        }

        // MEDIO 4: Validar que suma total de cleaned_payments cuadre contra expected_order_total
        // (antes de crear la orden, fail-closed)
        if ($total_rows > 0 && $expected_order_total > 0) {
            $amount_tolerance = 0.01;
            if (abs($total_amount - $expected_order_total) > $amount_tolerance) {
                throw new Exception(
                    sprintf(
                        'Suma de pagos mixtos (%.2f) no coincide con total esperado de la orden (%.2f). Verifica los montos.',
                        $total_amount,
                        $expected_order_total
                    )
                );
            }
        }

        // C6: Idempotencia — verificar que estos row_ids no hayan sido consumidos ya
        // IMPORTANTE: Esto DEBE ocurrir dentro de fase 1, antes de cualquier efecto secundario
        // Se llama SIEMPRE si hay filas MP con mixed_ticket_ref válido (no depender de condición secundaria)
        if ($mixed_ticket_ref && $total_rows > 0) {
            $this->validate_idempotency_safe($mixed_payments, $mixed_ticket_ref);
        }

        return $cleaned;
    }

    /**
     * FASE 3: Ejecutar efectos secundarios (trashear piernas, guardar meta en orden consolidada).
     * Esta fase SOLO se ejecuta si la orden existe Y la fase 1 de validación completó sin errores.
     *
     * Aquí es donde:
     * - Se valida que la suma de pagos cuadre contra order->get_total()
     * - Se trashean los pedidos transitorios de las piernas MP
     * - Se guarda _fbpos_mixed_payments y _fbpos_consumed_mixed_row_ids en la orden consolidada
     * - Se agregan order_notes visibles de auditoría
     *
     * @param WC_Order $order Orden consolidada recién creada
     * @param array $cleaned_payments Array validado de la fase 1
     * @param array $gateways Gateways disponibles
     */
    private function execute_mixed_payments_phase($order, $cleaned_payments, $gateways) {
        // PUNTO 2: Validar que suma total de cleaned_payments cuadre contra order->get_total()
        $total_payments = array_reduce($cleaned_payments, fn($sum, $p) => $sum + $p['amount'], 0);
        $order_total = (float) $order->get_total();
        $amount_tolerance = 0.01; // Tolerancia de 1 centavo

        if (abs($total_payments - $order_total) > $amount_tolerance) {
            // Rollback: cancelar la orden que acabamos de crear
            $order->update_status('cancelled',
                sprintf(
                    'Validación de pago mixto FALLÓ: suma de pagos (%.2f) no cuadra contra total de orden (%.2f). '
                    . 'Orden cancelada automáticamente.',
                    $total_payments,
                    $order_total
                )
            );
            throw new Exception(
                sprintf(
                    'Suma total de pagos mixtos (%.2f) no coincide con total de la orden (%.2f). Orden cancelada.',
                    $total_payments,
                    $order_total
                )
            );
        }

        // Guardar meta de pagos combinados
        $order->set_payment_method_title('Pago combinado POS');
        $order->update_meta_data('_fbpos_mixed_payments', $cleaned_payments);

        // Guardar row_ids consumidos para validación de idempotencia
        $consumed_row_ids = array_filter(array_map(
            fn($p) => $p['mixed_row_id'] ?? '',
            $cleaned_payments
        ));
        if (!empty($consumed_row_ids)) {
            $order->update_meta_data('_fbpos_consumed_mixed_row_ids', array_values($consumed_row_ids));
        }

        // Trashear piernas MP y agregar auditoría visible
        $trash_audit_notes = [];
        foreach ($cleaned_payments as $payment) {
            $mixed_row_id = $payment['mixed_row_id'] ?? '';
            if (!$mixed_row_id) {
                continue; // No-MP, no trashear
            }

            $mixed_order_id = $payment['mixed_order_id'] ?? 0;
            $mixed_leg_order = wc_get_order($mixed_order_id);

            if (!$mixed_leg_order) {
                continue;
            }

            // C5: Usar update_status('trash') que funciona en HPOS
            $trash_result = $mixed_leg_order->update_status('trash', 'Pedido transitorio trasheado por consolidación.');

            // PUNTO 7: Agregar auditoría visible en order_notes
            if (!$trash_result) {
                $audit_msg = sprintf(
                    'ADVERTENCIA: No se pudo trashear pedido transitorio #%d (row_id: %s). Requiere revisión manual.',
                    $mixed_order_id,
                    esc_html($mixed_row_id)
                );
                $order->add_order_note($audit_msg);
                $trash_audit_notes[] = $audit_msg;
            } else {
                $audit_msg = sprintf(
                    'Pierna de tarjeta trasheada: pedido #%d (row_id: %s) — últimos 4: %s, %s cuotas',
                    $mixed_order_id,
                    esc_html($mixed_row_id),
                    $payment['last_four_digits'] ?? '****',
                    $payment['installments'] ?? '1'
                );
                $order->add_order_note($audit_msg);
            }
        }

        // Agregar resumen de pago combinado
        $payment_notes = implode(' + ', array_map(
            fn($p) => $p['title'] . ' ' . wc_price($p['amount']),
            $cleaned_payments
        ));
        $order->add_order_note('Pago combinado: ' . $payment_notes);

        // Guardar cambios finales
        $order->save();
    }

    /**
     * ALTO 1 (ronda 6): deriva el mixed_ticket_ref real desde las filas de mixed_payments
     * (por fila, que es donde realmente viaja el dato — nunca en el nivel raíz del payload).
     * Se usa para tomar el lock ANTES de la validación completa de fase 1, así el lock
     * protege el ticket real que se está cerrando y no una clave que nadie consulta.
     * Aplica la misma regla de consistencia que fase 1 (todas las filas MP comparten ticket_ref),
     * pero de forma barata (sin tocar la base) para poder ejecutarse antes del lock.
     *
     * @param array $mixed_payments
     * @return string Ref común de las filas MP, o '' si no hay ninguna fila MP
     * @throws Exception Si hay filas MP con ticket_ref inconsistentes entre sí
     */
    private function derive_mixed_ticket_ref($mixed_payments) {
        $ref = '';

        foreach ($mixed_payments as $payment) {
            $gateway_id = sanitize_text_field($payment['gateway'] ?? '');
            if (!$this->payment_gateway_service->is_mercadopago_gateway($gateway_id)) {
                continue;
            }

            $row_ref = sanitize_text_field($payment['mixed_ticket_ref'] ?? '');
            if (!$row_ref) {
                continue; // Fase 1 lo va a rechazar explícitamente más adelante (ALTO 1)
            }

            if (!$ref) {
                $ref = $row_ref;
            } elseif ($ref !== $row_ref) {
                throw new Exception(
                    'Inconsistencia: las filas de pago mixto refieren a tickets distintos. '
                    . 'Todas las tarjetas deben pertenecer al mismo ticket.'
                );
            }
        }

        return $ref;
    }

    /**
     * ALTO 2 (ronda 6): Adquirir lock de idempotencia con un INSERT IGNORE atómico contra
     * wp_options — a diferencia de add_option() (que primero lee y después hace un
     * INSERT ... ON DUPLICATE KEY UPDATE, no es un compare-and-swap real), esto sí es atómico
     * a nivel de MySQL. No se usa wp_cache_add(): sin un object cache persistente
     * (Redis/Memcached) esa caché no sobrevive entre requests HTTP y el lock nunca protegería nada.
     *
     * ALTO 3 (ronda 6): si un proceso anterior murió sin liberar el lock (fatal error,
     * timeout de ejecución, corte de conexión), el lock quedaría pegado para siempre y
     * bloquearía todo reintento futuro de ese ticket. Si el lock existente es más viejo que
     * `$lock_stale_seconds`, se lo considera abandonado y se intenta recuperar con un UPDATE
     * condicionado al valor viejo (para no pisar un lock legítimo tomado en el ínterin).
     *
     * @param string $mixed_ticket_ref Referencia de ticket
     * @return string Lock key (para liberar después)
     * @throws Exception Si no se puede adquirir el lock
     */
    private function acquire_mixed_lock($mixed_ticket_ref) {
        global $wpdb;

        $lock_key = 'fbpos_mixed_lock_' . wp_hash($mixed_ticket_ref);
        $lock_value = wp_json_encode([
            'timestamp' => time(),
            'ticket_ref' => $mixed_ticket_ref,
        ]);

        $inserted = $wpdb->query($wpdb->prepare(
            "INSERT IGNORE INTO {$wpdb->options} (option_name, option_value, autoload) VALUES (%s, %s, 'no')",
            $lock_key,
            $lock_value
        ));

        if ($inserted) {
            return $lock_key;
        }

        // No se pudo insertar: el lock ya existía en ese instante. Puede haberse liberado
        // justo entre el INSERT IGNORE y este SELECT (verificación 6, MEDIO 2) — en ese caso
        // reintentamos el INSERT una vez antes de asumir que sigue ocupado, para no rechazar
        // con un falso "se está procesando en paralelo" cuando en realidad ya quedó libre.
        $existing_raw = $wpdb->get_var($wpdb->prepare(
            "SELECT option_value FROM {$wpdb->options} WHERE option_name = %s",
            $lock_key
        ));

        if ($existing_raw === null) {
            $retry_inserted = $wpdb->query($wpdb->prepare(
                "INSERT IGNORE INTO {$wpdb->options} (option_name, option_value, autoload) VALUES (%s, %s, 'no')",
                $lock_key,
                $lock_value
            ));

            if ($retry_inserted) {
                return $lock_key;
            }

            // Otro proceso lo tomó en el instante entre el SELECT y este segundo INSERT.
            $existing_raw = $wpdb->get_var($wpdb->prepare(
                "SELECT option_value FROM {$wpdb->options} WHERE option_name = %s",
                $lock_key
            ));
        }

        // Evaluar si el lock (ya confirmado existente) está abandonado (ALTO 3).
        $lock_stale_seconds = 120;
        $existing = $existing_raw ? json_decode($existing_raw, true) : null;
        $existing_timestamp = is_array($existing) ? (int) ($existing['timestamp'] ?? 0) : 0;

        if ($existing_timestamp && (time() - $existing_timestamp) > $lock_stale_seconds) {
            $updated = $wpdb->query($wpdb->prepare(
                "UPDATE {$wpdb->options} SET option_value = %s WHERE option_name = %s AND option_value = %s",
                $lock_value,
                $lock_key,
                $existing_raw
            ));

            if ($updated) {
                return $lock_key;
            }
        }

        throw new Exception(
            'Este ticket se está procesando en paralelo. Aguardá unos segundos e intentá nuevamente.'
        );
    }

    /**
     * ALTO 2: Liberar lock de idempotencia.
     *
     * @param string $lock_key Lock key retornado por acquire_mixed_lock()
     */
    private function release_mixed_lock($lock_key) {
        global $wpdb;
        $wpdb->delete($wpdb->options, ['option_name' => $lock_key]);
    }

    /**
     * Adquirir lock del presupuesto con TTL (time-to-live).
     *
     * Sigue el mismo patrón que acquire_mixed_lock() (línea 964):
     * - INSERT IGNORE atómico contra wp_options
     * - Si el lock ya existe pero es más viejo que $lock_stale_seconds (120s),
     *   se lo considera abandonado y se lo reclama con UPDATE condicionado.
     *
     * Previene que dos requests concurrentes creen dos órdenes del mismo presupuesto,
     * y también previene que un lock abandonado (por timeout PHP, fatal error, etc.)
     * bloquee el presupuesto para siempre.
     *
     * @param int $quote_id ID del presupuesto
     * @return string Lock key (para liberar después con release_quote_lock())
     * @throws Exception Si no se puede adquirir el lock
     */
    private function acquire_quote_lock($quote_id) {
        global $wpdb;

        $lock_key = 'fbpos_quote_lock_' . (int) $quote_id;
        $lock_value = wp_json_encode([
            'timestamp' => time(),
            'quote_id' => $quote_id,
        ]);

        // Intento 1: INSERT IGNORE (si no existe el lock, lo crea)
        $inserted = $wpdb->query($wpdb->prepare(
            "INSERT IGNORE INTO {$wpdb->options} (option_name, option_value, autoload) VALUES (%s, %s, 'no')",
            $lock_key,
            $lock_value
        ));

        if ($inserted) {
            return $lock_key;
        }

        // No se pudo insertar: el lock ya existía en ese instante.
        // Verificar si está abandonado y reclamarlo si es necesario.
        $existing_raw = $wpdb->get_var($wpdb->prepare(
            "SELECT option_value FROM {$wpdb->options} WHERE option_name = %s",
            $lock_key
        ));

        if ($existing_raw === null) {
            // El lock se liberó entre el INSERT IGNORE y este SELECT.
            // Reintentar el INSERT una vez más.
            $retry_inserted = $wpdb->query($wpdb->prepare(
                "INSERT IGNORE INTO {$wpdb->options} (option_name, option_value, autoload) VALUES (%s, %s, 'no')",
                $lock_key,
                $lock_value
            ));

            if ($retry_inserted) {
                return $lock_key;
            }

            // Otro proceso lo tomó entre el SELECT y este segundo INSERT.
            $existing_raw = $wpdb->get_var($wpdb->prepare(
                "SELECT option_value FROM {$wpdb->options} WHERE option_name = %s",
                $lock_key
            ));
        }

        // Evaluar si el lock existente está abandonado (TTL de 120 segundos).
        $lock_stale_seconds = 120;
        $existing = $existing_raw ? json_decode($existing_raw, true) : null;
        $existing_timestamp = is_array($existing) ? (int) ($existing['timestamp'] ?? 0) : 0;

        if ($existing_timestamp && (time() - $existing_timestamp) > $lock_stale_seconds) {
            // El lock es viejo, intenta reclamarlo con UPDATE condicionado.
            $updated = $wpdb->query($wpdb->prepare(
                "UPDATE {$wpdb->options} SET option_value = %s WHERE option_name = %s AND option_value = %s",
                $lock_value,
                $lock_key,
                $existing_raw
            ));

            if ($updated) {
                return $lock_key;
            }
        }

        // No se pudo adquirir: está siendo convertido en otro navegador o proceso.
        throw new Exception('Este presupuesto se está convirtiendo en otro navegador. Aguardá unos segundos e intentá nuevamente.');
    }

    /**
     * Liberar lock del presupuesto.
     *
     * @param string $lock_key Lock key retornado por acquire_quote_lock()
     */
    private function release_quote_lock($lock_key) {
        global $wpdb;
        $wpdb->delete($wpdb->options, ['option_name' => $lock_key]);
    }

    /**
     * C6: Validación de idempotencia (PUNTO 3).
     * Verifica que el conjunto de row_ids no haya sido consumido por otro pedido consolidado.
     *
     * NOTA: El lock es adquirido y liberado por handle_direct_order_flow() usando
     * acquire_mixed_lock() y release_mixed_lock(). Esto asegura que el lock se libera
     * DESPUÉS de que ambas fases (validación + ejecución) completen.
     *
     * Esta función solo realiza la búsqueda eficiente de row_ids consumidos.
     *
     * @param array $mixed_payments Array de pagos del request
     * @param string $mixed_ticket_ref Referencia de ticket (para documentación)
     * @throws Exception Si los row_ids ya fueron consumidos
     */
    private function validate_idempotency_safe($mixed_payments, $mixed_ticket_ref) {
        // Extraer todos los row_ids de esta request
        $request_row_ids = array_filter(array_map(
            fn($p) => sanitize_text_field($p['mixed_row_id'] ?? ''),
            $mixed_payments
        ));

        if (empty($request_row_ids)) {
            return; // Sin piernas, sin validación de idempotencia
        }

        // Búsqueda eficiente por row_id específico, no limit genérico
        // En vez de buscar los últimos 100 pedidos y comparar, buscamos directamente por cada row_id
        foreach ($request_row_ids as $row_id) {
            $args = [
                'meta_query' => [
                    'relation' => 'AND',
                    [
                        'key' => '_fbpos_consumed_mixed_row_ids',
                        'value' => sprintf('"%s"', $row_id), // Buscar como valor dentro del array serializado
                        'compare' => 'LIKE',
                    ],
                ],
                'limit' => 10, // Pequeño limit, solo necesitamos confirmar si existe
            ];

            $existing_orders = wc_get_orders($args);

            foreach ($existing_orders as $existing_order) {
                $consumed_ids = (array) $existing_order->get_meta('_fbpos_consumed_mixed_row_ids');

                if (in_array($row_id, $consumed_ids, true)) {
                    throw new Exception(
                        sprintf(
                            'Pierna de pago ya consumida (row_id: %s) por pedido consolidado #%d. Intento de duplicación bloqueado.',
                            esc_html($row_id),
                            $existing_order->get_id()
                        )
                    );
                }
            }
        }
    }

    /**
     * Obtiene la URL de edición de la orden en el admin.
     * Soporta tanto las tablas custom de WooCommerce como el sistema clásico de posts.
     */
    private function get_order_edit_url($order_id) {
        if (class_exists('Automattic\\WooCommerce\\Utilities\\OrderUtil')) {
            $util = new \Automattic\WooCommerce\Utilities\OrderUtil();

            if ($util->custom_orders_table_usage_is_enabled()) {
                return admin_url('admin.php?page=wc-orders&action=edit&id=' . $order_id);
            }
        }

        return admin_url('post.php?post=' . $order_id . '&action=edit');
    }
}
