<?php
/**
 * Controlador REST: estado de pierna de pago mixto.
 * Endpoint: GET /fbpos/v2/mixed-leg-status
 */
if (!defined('ABSPATH')) exit;

class FBPOS_Mixed_Leg_Controller {
    private $order_service;

    public function __construct(FBPOS_Order_Service $order_service) {
        $this->order_service = $order_service;
    }

    /**
     * Obtiene el estado de una pierna de pago mixto.
     * GET /fbpos/v2/mixed-leg-status?row_id=...
     *
     * Busca el pedido transitorio por _fbpos_mixed_row_id y retorna su estado
     * junto con datos de la transacción si está completada.
     *
     * @param WP_REST_Request $request
     * @return WP_REST_Response
     */
    public function get_mixed_leg_status(WP_REST_Request $request) {
        try {
            $row_id = sanitize_text_field($request->get_param('row_id'));

            if (empty($row_id)) {
                throw new Exception('Parámetro row_id requerido.');
            }

            // Buscar el pedido por _fbpos_mixed_row_id (M1: usar el servicio centralizado)
            $order = $this->order_service->find_order_by_mixed_row_id($row_id);

            if (!$order) {
                // Pedido aún no existe (el cliente no llegó al checkout)
                return rest_ensure_response([
                    'success' => true,
                    'status' => 'pending',
                    'order_id' => 0,
                    'message' => 'Pedido pendiente de iniciar.',
                ]);
            }

            // Mapear el estado de WooCommerce a los estados de mixed_leg
            $status = $this->map_order_status($order->get_status());

            $response = [
                'success' => true,
                'status' => $status,
                'order_id' => $order->get_id(),
                'order_number' => $order->get_order_number(),
            ];

            // Si está completada, incluir datos de transacción
            if ($status === 'completed') {
                $response['transaction_data'] = $this->extract_transaction_data($order);
            }

            // A3: Si está rechazada, incluir motivo genérico (no exponer notas internas del POS)
            if ($status === 'failed' || $status === 'cancelled') {
                if ($status === 'failed') {
                    $response['failure_reason'] = 'Pago rechazado por el medio de pago. Verifique los datos de la tarjeta e intente nuevamente.';
                } else {
                    $response['failure_reason'] = 'Pago cancelado por el cliente.';
                }
            }

            return rest_ensure_response($response);
        } catch (Throwable $e) {
            return new WP_Error('mixed_leg_error', $e->getMessage(), ['status' => 400]);
        }
    }

    /**
     * Mapea el estado de una orden de WooCommerce al estado de mixed_leg.
     *
     * @param string $wc_status
     * @return string
     */
    private function map_order_status($wc_status) {
        $status_map = [
            'pending' => 'pending',
            'failed' => 'failed',
            'cancelled' => 'cancelled',
            'processing' => 'processing',
            'completed' => 'completed',
            'refunded' => 'failed',
        ];

        return $status_map[$wc_status] ?? 'pending';
    }

    /**
     * Extrae los datos de transacción de una orden completada.
     * Retorna: últimos 4 dígitos, marca, cuotas, monto con recargo.
     * A2: Usa ?: en vez de ?? porque get_meta() devuelve '' (vacío) cuando no existe, no null.
     *
     * @param WC_Order $order
     * @return array
     */
    private function extract_transaction_data(WC_Order $order) {
        $data = [
            'last_four_digits' => '',
            'card_brand' => '',
            'installments' => '',
            'total_amount' => wc_price($order->get_total()),
            'total_amount_raw' => (float) $order->get_total(),
            'transaction_id' => '',
        ];

        // Buscar metadatos de transacción del gateway de Mercado Pago
        // El plugin woo-mercado-pago-custom típicamente guarda:
        // - _Mercado_Pago_Payment_IDs o _mp_payment_id
        // - _mp_card_last_four o similar
        // - _mp_installments

        // A2: Usar ?: en vez de ?? porque get_meta() devuelve '' (vacío string) no null
        $transaction_id = (
            $order->get_meta('_mp_payment_id') ?:
            $order->get_meta('_Mercado_Pago_Payment_IDs') ?:
            $order->get_transaction_id() ?:
            ''
        );

        if ($transaction_id) {
            $data['transaction_id'] = $transaction_id;
        }

        // A2: Intentar extraer últimos 4 dígitos de metadatos (usar ?: en vez de ??)
        $card_last_four = (
            $order->get_meta('_mp_card_last_four') ?:
            $order->get_meta('_Mercado_Pago_Card_Last_Four') ?:
            ''
        );
        if ($card_last_four) {
            $data['last_four_digits'] = $card_last_four;
        }

        // A2: Intentar extraer marca de tarjeta
        $card_brand = (
            $order->get_meta('_mp_card_brand') ?:
            $order->get_meta('_Mercado_Pago_Card_Brand') ?:
            ''
        );
        if ($card_brand) {
            $data['card_brand'] = $card_brand;
        }

        // A2: Intentar extraer cuotas
        $installments = (
            $order->get_meta('_mp_installments') ?:
            $order->get_meta('_Mercado_Pago_Installments') ?:
            ''
        );
        if ($installments) {
            $data['installments'] = (string) $installments;
        }

        return $data;
    }
}
