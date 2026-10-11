<?php
/**
 * Plugin Name: Fusion Herramientas — Puente de lectura
 * Description: Lectura autenticada de versiones y precios comerciales para preparar la integración con Herramientas. No modifica ventas ni stock.
 * Version: 0.4.0
 * Requires at least: 6.4
 * Requires PHP: 7.4
 * Requires Plugins: woocommerce
 * Author: Fusion Bikes
 */
namespace FusionBikes\HerramientasBridge;

if (!defined('ABSPATH')) exit;
require_once __DIR__ . '/migration-read.php';
require_once __DIR__ . '/metrics-read.php';
require_once __DIR__ . '/fiscal-cutover.php';

final class Bridge {
    const VERSION = '0.4.0';
    const NAMESPACE = 'wc/v3';
    const PREFIX = '/fusion-herramientas';
    const MAX_IDS = 25;
    const MC_API = '\\FusionBikes\\MasterControl\\Contracts\\CommercialApi';
    const MC_DATA = '\\FusionBikes\\MasterControl\\Services\\DataService';
    const MC_PRICING = '\\FusionBikes\\MasterControl\\Services\\PricingEngine';

    public static function register(): void {
        MigrationRead::register();
        MetricsRead::register();
        register_rest_route(self::NAMESPACE, self::PREFIX . '/status', [
            'methods' => 'GET', 'permission_callback' => [self::class, 'allowed'],
            'callback' => [self::class, 'status'],
        ]);
        register_rest_route(self::NAMESPACE, self::PREFIX . '/commercial-products', [
            'methods' => 'GET', 'permission_callback' => [self::class, 'allowed'],
            'callback' => [self::class, 'products'],
        ]);
    }

    /** WooCommerce authenticates /wc/v3 and enforces API-key read permissions. */
    public static function allowed() {
        if (!is_ssl()) return new \WP_Error('fusion_bridge_https', 'Se requiere HTTPS.', ['status' => 403]);
        if (!current_user_can('manage_woocommerce')) {
            return new \WP_Error('fusion_bridge_forbidden', 'Se requiere permiso de gestión de WooCommerce.', [
                'status' => is_user_logged_in() ? 403 : 401,
            ]);
        }
        return true;
    }

    private static function response(array $data): \WP_REST_Response {
        return new \WP_REST_Response($data, 200, [
            'Cache-Control' => 'private, no-store, max-age=0',
            'X-Robots-Tag' => 'noindex, nofollow',
        ]);
    }

    private static function ready(): bool {
        return function_exists('wc_get_product') && function_exists('get_woocommerce_currency')
            && class_exists(self::MC_API) && class_exists(self::MC_DATA) && class_exists(self::MC_PRICING)
            && defined(self::MC_API . '::VERSION') && constant(self::MC_API . '::VERSION') === 1;
    }

    public static function status(): \WP_REST_Response {
        return self::response([
            'schema' => 1, 'bridge_version' => self::VERSION, 'read_only' => true,
            'commercial_ready' => self::ready(), 'max_product_ids' => self::MAX_IDS,
            'woocommerce_version' => defined('WC_VERSION') ? WC_VERSION : null,
            'master_control_version' => defined('FUSION_BIKES_VERSION') ? FUSION_BIKES_VERSION : null,
            'features' => self::ready() ? ['commercial_product_snapshot_v1'] : [],
            'checkout_migrated' => false, 'generated_at' => gmdate('c'),
        ]);
    }

    /** IDs only: no arbitrary query, SQL, URL, product mutations or pricing input. */
    public static function parse_ids($value): array {
        if (!is_string($value) || strlen($value) > 400 || !preg_match('/^[1-9][0-9]*(,[1-9][0-9]*)*$/D', $value)) {
            throw new \InvalidArgumentException('Indicá IDs positivos separados por comas.');
        }
        $parts = explode(',', $value);
        if (count($parts) > self::MAX_IDS) throw new \InvalidArgumentException('Máximo 25 productos por consulta.');
        $ids = [];
        foreach ($parts as $part) {
            // IDs must round-trip through PHP and JavaScript without loss of identity.
            if (strlen($part) > 15 || (float)$part > 999999999999999 || (int)$part <= 0 || (string)(int)$part !== $part) {
                throw new \InvalidArgumentException('Hay un ID fuera de rango.');
            }
            $ids[] = (int)$part;
        }
        if (count(array_unique($ids)) !== count($ids)) throw new \InvalidArgumentException('No repitas IDs en la misma consulta.');
        return $ids;
    }

    private static function decimal($amount, int $places): string {
        $amount = (float)$amount;
        if (!is_finite($amount) || $amount < 0 || $amount > 999999999999) {
            throw new \UnexpectedValueException('Invalid commercial amount');
        }
        return number_format($amount, $places, '.', '');
    }

    private static function one(int $id, $data, $pricing, array $plans): array {
        $p = wc_get_product($id);
        if (!$p || $p->get_status() !== 'publish') return ['id' => $id, 'state' => 'unavailable'];
        $type = $p->get_type();
        if (!in_array($type, ['simple', 'variation'], true)) {
            return ['id' => $id, 'state' => 'not_sellable_type', 'type' => $type];
        }
        $parent_id = (int)$p->get_parent_id();
        if ($parent_id) {
            $parent = wc_get_product($parent_id);
            if (!$parent || $parent->get_status() !== 'publish') return ['id' => $id, 'state' => 'unavailable'];
        }
        if ($p->get_price('edit') === '') return ['id' => $id, 'state' => 'unpriced'];
        $base = $pricing->getBasePrice($p);
        $quotes = [];
        foreach ($plans as $plan) {
            $coefficient = (float)$data->getCoefficient($id, $plan);
            if (!is_finite($coefficient) || $coefficient <= 0 || $coefficient > 10) {
                throw new \UnexpectedValueException('Invalid commercial coefficient');
            }
            $quotes[] = [
                'plan' => (string)$plan,
                'coefficient' => self::decimal($coefficient, 10),
                'unit_amount' => self::decimal($pricing->getUnitPrice($id, $p, $plan), wc_get_price_decimals()),
            ];
        }
        return [
            'id' => $id, 'state' => 'ok', 'parent_id' => $parent_id, 'type' => $type,
            'sku' => (string)$p->get_sku(), 'name' => (string)$p->get_name(),
            'base_amount' => self::decimal($base, wc_get_price_decimals()),
            'plans' => $quotes, 'promo_three_installments' => (bool)$data->appliesNave($id),
            'source' => 'master_control_pricing_engine',
            // Quotes are for a single unit, not a rounded unit multiplied by quantity.
            'quantity' => 1, 'checkout_revalidation_required' => true,
        ];
    }

    public static function products($request) {
        try { $ids = self::parse_ids($request->get_param('ids')); }
        catch (\InvalidArgumentException $e) {
            return new \WP_Error('fusion_bridge_ids', $e->getMessage(), ['status' => 400]);
        }
        if (!self::ready()) return new \WP_Error('fusion_bridge_dependency', 'Se requiere el contrato comercial 1 de Master Control.', ['status' => 503]);
        try {
            // Same services used by POS. Never use the standard REST price projection.
            $data_class = self::MC_DATA; $pricing_class = self::MC_PRICING;
            $data = new $data_class(); $pricing = new $pricing_class($data);
            $plans = $data->getAllAllowedTypes();
            if (!is_array($plans) || count($plans) > 20) throw new \UnexpectedValueException('Invalid plans');
            $items = [];
            foreach ($ids as $id) $items[] = self::one($id, $data, $pricing, $plans);
            return self::response([
                'schema' => 1, 'generated_at' => gmdate('c'),
                'master_control_version' => defined('FUSION_BIKES_VERSION') ? FUSION_BIKES_VERSION : null,
                'currency' => get_woocommerce_currency(), 'items' => $items,
                'scope' => 'cash_and_single_unit_financing_only',
                'excludes' => ['cart', 'coupons', 'shipping', 'tax_calculation', 'usd', 'checkout', 'stock_reservation'],
            ]);
        } catch (\Throwable $e) {
            // Do not expose stack traces, database details or configuration in an API error.
            return new \WP_Error('fusion_bridge_commercial', 'No se pudo obtener una cotización comercial válida.', ['status' => 503]);
        }
    }
}

add_action('rest_api_init', [Bridge::class, 'register']);
