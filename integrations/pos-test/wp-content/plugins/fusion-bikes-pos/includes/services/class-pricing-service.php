<?php
/**
 * Servicio de precios: planes de cuotas, perfiles de pago, cotización USD.
 */
if (!defined('ABSPATH')) exit;

class FBPOS_Pricing_Service {
    const OPT_INSTALLMENTS = 'fbpos_installment_plans';
    const OPT_USD = 'fbpos_usd_rate';
    const OPT_PROFILES = 'fbpos_payment_profiles';

    /**
     * Obtiene los planes de cuotas desde la configuración.
     * Retorna un array con count, label, factor.
     */
    public function get_plans() {
        $plans = [];
        $lines = preg_split('/\R/', (string) get_option(self::OPT_INSTALLMENTS));

        foreach ($lines as $line) {
            $parts = array_map('trim', explode('|', $line));

            if (count($parts) < 3) {
                continue;
            }

            $count = max(1, absint($parts[0]));
            $label = sanitize_text_field($parts[1]);
            $factor = (float) str_replace(',', '.', $parts[2]);

            if ($factor > 0) {
                $plans[] = [
                    'count' => $count,
                    'label' => $label,
                    'factor' => $factor,
                ];
            }
        }

        return $plans ?: [['count' => 1, 'label' => 'Contado', 'factor' => 1]];
    }

    /**
     * Obtiene los perfiles de pago (opciones directas) desde la configuración.
     * Retorna un array con label, factor, currency (ARS o USD).
     */
    public function get_profiles() {
        $profiles = [];
        $lines = preg_split('/\R/', (string) get_option(self::OPT_PROFILES));

        foreach ($lines as $line) {
            $parts = array_map('trim', explode('|', $line));

            if (count($parts) < 3) {
                continue;
            }

            $factor = (float) str_replace(',', '.', $parts[1]);
            $currency = strtoupper($parts[2]);

            if ($factor > 0 && in_array($currency, ['ARS', 'USD'], true)) {
                $profiles[] = [
                    'label' => sanitize_text_field($parts[0]),
                    'factor' => $factor,
                    'currency' => $currency,
                ];
            }
        }

        return $profiles;
    }

    /**
     * Obtiene la cotización de USD.
     * Prioridad:
     * 1. fusion_get_dolar_v60() si existe (Master Control)
     * 2. Manual: option fusion_dolar_manual
     * 3. Caché: transient fusion_dolar_v60
     * 4. API externa: dolarapi.com (con timeout corto)
     * 5. Fallback: 1150
     */
    public function get_usd_rate() {
        // Fuente 1: función de Master Control
        if (function_exists('fusion_get_dolar_v60')) {
            $rate = (float) fusion_get_dolar_v60();
            if ($rate > 0) {
                return $rate;
            }
        }

        // Fuente 2: valor manual
        $manual = (float) str_replace(',', '.', get_option('fusion_dolar_manual', '0'));
        if ($manual > 0) {
            return $manual;
        }

        // Fuente 3: caché
        $cached = (float) get_transient('fusion_dolar_v60');
        if ($cached > 0) {
            return $cached;
        }

        // Fuente 4: API externa
        $response = wp_remote_get('https://dolarapi.com/v1/dolares/blue', ['timeout' => 1.5]);

        if (is_wp_error($response)) {
            return 1150;
        }

        $body = json_decode(wp_remote_retrieve_body($response), true);
        $rate = isset($body['compra']) ? (float) $body['compra'] : 1150;

        set_transient('fusion_dolar_v60', $rate, HOUR_IN_SECONDS);

        return $rate;
    }
}
