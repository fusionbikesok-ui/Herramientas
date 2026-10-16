<?php
/**
 * Servicio de pasarelas de pago: lista, detección de Mercado Pago, URLs.
 */
if (!defined('ABSPATH')) exit;

class FBPOS_Payment_Gateway_Service {
    /**
     * Obtiene la lista de pasarelas habilitadas.
     * Retorna array con id, title, description de cada gateway.
     */
    public function get_gateways() {
        $gateways = [];

        if (!WC()->payment_gateways()) {
            return $gateways;
        }

        foreach (WC()->payment_gateways()->payment_gateways() as $gateway) {
            if (!is_object($gateway) || $gateway->enabled !== 'yes') {
                continue;
            }

            $gateways[] = [
                'id' => $gateway->id,
                'title' => wp_strip_all_tags($gateway->get_title()),
                'description' => wp_strip_all_tags($gateway->get_description()),
            ];
        }

        return $gateways;
    }

    /**
     * Detecta si una pasarela es Mercado Pago.
     * Comprueba variantes comunes del ID.
     */
    public function is_mercadopago_gateway($gateway_id) {
        $id = strtolower((string) $gateway_id);

        return strpos($id, 'mercado-pago') !== false
            || strpos($id, 'mercadopago') !== false
            || strpos($id, 'woo-mercado-pago') !== false;
    }

    /**
     * Detecta si una pasarela es Posnet.
     */
    public function is_posnet_gateway($gateway_id) {
        return strtolower((string) $gateway_id) === 'fbpos_posnet';
    }

    /**
     * Construye la URL para pago directo (gatway nativo).
     * Agrega parámetros fbpos_gateway y fbpos_source a la URL de checkout de pago.
     */
    public function get_native_payment_url($order, $gateway_id) {
        $url = $order->get_checkout_payment_url(true);

        return add_query_arg(
            [
                'fbpos_gateway' => sanitize_key($gateway_id),
                'fbpos_source' => 'pos',
            ],
            $url
        );
    }

    /**
     * Construye la URL para checkout con payload (flujo de carrito).
     * Guarda el payload en un transient y retorna la URL del checkout con el token.
     */
    public function get_checkout_payload_url($payload, $gateway_id) {
        $token = wp_generate_password(24, false, false);
        set_transient('fbpos_checkout_' . $token, $payload, 20 * MINUTE_IN_SECONDS);

        return add_query_arg(
            [
                'fbpos_checkout' => $token,
                'fbpos_gateway' => sanitize_key($gateway_id),
                'fbpos_source' => 'pos',
            ],
            wc_get_checkout_url()
        );
    }
}
