<?php
/**
 * Gateway Posnet: terminal física de tarjeta sin procesamiento online.
 * El cajero elige Posnet, cuotas válidas, se calcula el recargo real,
 * y el pedido se registra como pagado directamente.
 */
if (!defined('ABSPATH')) exit;

class FBPOS_Posnet_Gateway extends WC_Payment_Gateway {

    public function __construct() {
        $this->id = 'fbpos_posnet';
        $this->method_title = 'Posnet (POS)';
        $this->method_description = 'Cobro con terminal física de tarjeta del local — no procesa pagos online.';
        $this->title = 'Posnet (POS)';
        $this->description = 'Terminal de tarjeta física — se registra como pagado.';
        $this->enabled = 'yes';
        $this->has_fields = false;
    }

    /**
     * Nunca disponible en el checkout real de WooCommerce, aunque esté "enabled".
     *
     * Este gateway se registra globalmente (filtro `woocommerce_payment_gateways`), así
     * que sin esto WooCommerce lo listaría como opción seleccionable para cualquier
     * cliente en `/checkout/` — y como `process_payment()` marca el pedido pagado sin
     * cobrar nada, cualquiera podría completar una compra gratis eligiéndolo.
     *
     * El POS nunca consulta `is_available()`: asigna el gateway directo con
     * `$order->set_payment_method()` en `class-order-controller.php`, y `get_gateways()`
     * en `class-payment-gateway-service.php` filtra por `enabled === 'yes'`, no por esto.
     * Devolver siempre false acá no afecta al POS, y cierra el único camino por el que
     * este gateway podría llegar a ofrecerse en el sitio real.
     */
    public function is_available() {
        return false;
    }

    /**
     * Procesa el pago: simplemente marca el pedido como pagado.
     * No hay procesamiento online, sin redirect.
     */
    public function process_payment($order_id) {
        $order = wc_get_order($order_id);

        if (!$order) {
            return [
                'result' => 'failure',
                'messages' => 'Pedido no válido.',
            ];
        }

        $order->payment_complete();

        // Sin `redirect`: a diferencia de un checkout real, acá no hay ninguna pantalla
        // pública a la que mandar al cajero. Devolver una URL de "pedido recibido" hacía
        // que `handle_direct_order_flow()` la tratara como `payment_url` y el frontend
        // del POS abriera esa página en una pestaña nueva en CADA cobro con Posnet, y
        // además saltease la normalización al estado final configurado en Ajustes
        // (`self::OPT_STATUS`) porque esa normalización solo corre cuando no hay redirect
        // (revisor, implementación Posnet: hallazgos altos 2 y 3).
        return [
            'result' => 'success',
        ];
    }
}
