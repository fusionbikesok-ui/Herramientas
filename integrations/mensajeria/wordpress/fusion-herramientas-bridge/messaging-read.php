<?php
namespace FusionBikes\HerramientasBridge;
if (!defined('ABSPATH')) exit;

/** Existing receipts only. No emission, delivery, settings, order updates or public URLs. */
final class MessagingRead {
    const MAX_PDF_BYTES = 8388608;
    const MAX_INVOICES = 20;

    public static function register(): void {
        $base = Bridge::PREFIX . '/messaging-orders/(?P<order_id>[1-9][0-9]{0,14})';
        foreach ([$base => 'order', $base . '/invoices/(?P<invoice_id>[1-9][0-9]{0,14})/pdf' => 'pdf'] as $path => $method) {
            register_rest_route(Bridge::NAMESPACE, $path, [
                'methods' => 'GET', 'permission_callback' => [self::class, 'allowed'],
                'callback' => static function($request) use ($method) {
                    try { return self::response(self::$method($request)); }
                    catch (MessagingReadError $e) { return new \WP_Error($e->reason, $e->getMessage(), ['status' => $e->http]); }
                    catch (\Throwable $e) { return new \WP_Error('fusion_message_unavailable', 'No se pudo consultar el comprobante de la tienda.', ['status' => 503]); }
                },
            ]);
        }
    }

    public static function allowed() {
        $base = Bridge::allowed();
        if ($base !== true) return $base;
        return current_user_can('manage_options') ? true : new \WP_Error('fusion_message_forbidden', 'Se requiere una conexión administrativa de lectura.', ['status' => 403]);
    }

    private static function response(array $data): \WP_REST_Response {
        return new \WP_REST_Response($data + ['schema' => 1, 'read_only' => true, 'generated_at' => gmdate('c')], 200, [
            'Cache-Control' => 'private, no-store, max-age=0', 'X-Robots-Tag' => 'noindex, nofollow',
            'X-Content-Type-Options' => 'nosniff', 'Referrer-Policy' => 'no-referrer',
        ]);
    }

    /** Canonical identity, never last-digit/fuzzy matching; no guessing local 15 prefixes. */
    public static function phone(string $raw, string $country = 'AR', bool $international = false): string {
        $raw = trim($raw);
        if ($raw === '' || strlen($raw) > 48 || preg_match('/[^0-9+() .\-]/', $raw)) return '';
        $explicit = strpos($raw, '+') === 0 || strpos($raw, '00') === 0;
        if ($international && !$explicit) return '';
        if (strpos($raw, '+') !== false && (strpos($raw, '+') !== 0 || substr_count($raw, '+') !== 1)) return '';
        $digits = preg_replace('/\D/', '', $raw);
        if (strpos($raw, '00') === 0) $digits = substr($digits, 2);
        if (($explicit || $country === 'AR') && preg_match('/^549([1-9][0-9]{9})$/D', $digits, $m)) return '54' . $m[1];
        if (($explicit || $country === 'AR') && preg_match('/^54([1-9][0-9]{9})$/D', $digits, $m)) return '54' . $m[1];
        if (!$explicit && $country === 'AR') {
            if (preg_match('/^0([1-9][0-9]{9})$/D', $digits, $m)) $digits = $m[1];
            if (preg_match('/^[1-9][0-9]{9}$/D', $digits) && strpos($digits, '15') !== 0) return '54' . $digits;
            return '';
        }
        // A malformed Argentine international number must not fall through as another country.
        if (strpos($digits, '54') === 0) return '';
        return $explicit && preg_match('/^[1-9][0-9]{7,14}$/D', $digits) ? $digits : '';
    }

    private static function id($value): int {
        if (!is_scalar($value) || !preg_match('/^[1-9][0-9]{0,14}$/D', (string)$value)) throw new MessagingReadError('fusion_message_input', 'Pedido o comprobante inválido.', 400);
        return (int)$value;
    }

    private static function verified_order($request): array {
        $id = self::id($request->get_param('order_id'));
        $phone = self::phone((string)$request->get_header('x-fusion-contact-phone'), 'AR', true);
        if ($phone === '') throw new MessagingReadError('fusion_message_phone', 'Falta el teléfono internacional del contacto.', 400);
        $order = function_exists('wc_get_order') ? wc_get_order($id) : null;
        if (!$order || (int)$order->get_id() !== $id) throw new MessagingReadError('fusion_message_order', 'No hay un pedido disponible para ese contacto.', 404);
        $country = (string)($order->get_billing_country() ?: 'AR');
        $actual = self::phone((string)$order->get_billing_phone(), $country);
        if ($actual === '' || !hash_equals($actual, $phone)) throw new MessagingReadError('fusion_message_order', 'No hay un pedido disponible para ese contacto.', 404);
        return [$order, $phone];
    }

    private static function ready(): void {
        if (!class_exists('\\FusionBikes\\ARCA\\Plugin') || !method_exists('\\FusionBikes\\ARCA\\Plugin', 'record')) {
            throw new MessagingReadError('fusion_message_arca', 'El facturador de la tienda no está disponible.', 503);
        }
    }

    private static function authorized_record(int $id, int $orderId): array {
        self::ready();
        try { $row = \FusionBikes\ARCA\Plugin::record($id); }
        catch (\Throwable $e) { throw new MessagingReadError('fusion_message_invoice', 'No hay un comprobante autorizado para ese pedido.', 404); }
        $p = $row['payload'] ?? []; $settings = \FusionBikes\ARCA\Plugin::settings();
        $issuer = preg_replace('/\D/', '', (string)($p['issuer']['cuit'] ?? ''));
        $configured = preg_replace('/\D/', '', (string)($settings['cuit'] ?? ''));
        if ((int)($row['id'] ?? 0) !== $id || (int)($row['order_id'] ?? 0) !== $orderId ||
            (int)($p['order_id'] ?? 0) !== $orderId || ($row['status'] ?? '') !== 'authorized' ||
            ($row['environment'] ?? '') !== 'production' || !preg_match('/^[0-9]{14}$/D', (string)($p['cae'] ?? '')) ||
            strlen($configured) !== 11 || !hash_equals($configured, $issuer) ||
            !in_array((int)($p['type'] ?? 0), [1, 3, 6, 8], true) ||
            (int)($p['point'] ?? 0) < 1 || (int)($row['number'] ?? 0) < 1 ||
            !isset($p['totals']['gross']) || !is_numeric($p['totals']['gross']) ||
            !is_finite((float)$p['totals']['gross']) || (float)$p['totals']['gross'] < 0) {
            throw new MessagingReadError('fusion_message_invoice', 'No hay un comprobante autorizado para ese pedido.', 404);
        }
        return $row;
    }

    private static function summary(array $row): array {
        $p = $row['payload'];
        $number = sprintf('%05d-%08d', (int)$p['point'], (int)$row['number']);
        return ['id' => (int)$row['id'], 'order_id' => (int)$row['order_id'], 'status' => 'authorized', 'environment' => 'production',
            'number' => $number, 'label' => \FusionBikes\ARCA\Plugin::document_label($p) . ' ' . $number,
            'type' => (int)($p['type'] ?? 0), 'date' => (string)($p['date'] ?? ''),
            'customer' => sanitize_text_field((string)($p['customer']['name'] ?? '')),
            'currency' => (string)($p['currency'] ?? 'ARS'), 'total' => (string)$p['totals']['gross'],
            'revision' => (int)($row['revision'] ?? 0)];
    }

    public static function order($request): array {
        [$order] = self::verified_order($request); $id = (int)$order->get_id();
        self::ready(); global $wpdb;
        $table = $wpdb->prefix . 'fusion_arca_invoices';
        $ids = $wpdb->get_col($wpdb->prepare("SELECT id FROM `$table` WHERE order_id=%d AND environment='production' AND status='authorized' ORDER BY id DESC LIMIT 21", $id));
        if (!is_array($ids) || $wpdb->last_error) throw new MessagingReadError('fusion_message_arca', 'No se pudo consultar el historial del pedido.', 503);
        $invoices = [];
        foreach (array_slice($ids, 0, self::MAX_INVOICES) as $invoiceId) {
            try { $invoices[] = self::summary(self::authorized_record((int)$invoiceId, $id)); }
            catch (MessagingReadError $e) { if ($e->http !== 404) throw $e; }
        }
        $tracking = trim((string)$order->get_meta('_andreani_tracking', true));
        if (!preg_match('/^[A-Za-z0-9\-]{5,64}$/D', $tracking)) $tracking = '';
        return ['order_id' => $id, 'order_number' => (string)$order->get_order_number(), 'invoices' => $invoices,
            'has_more' => count($ids) > self::MAX_INVOICES, 'tracking' => $tracking ? ['carrier' => 'Andreani', 'number' => $tracking] : null];
    }

    public static function pdf($request): array {
        [$order] = self::verified_order($request);
        $row = self::authorized_record(self::id($request->get_param('invoice_id')), (int)$order->get_id());
        if (!class_exists('\\FusionBikes\\ARCA\\InvoicePdf')) {
            if (!defined('FUSION_ARCA_DIR') || !is_readable(FUSION_ARCA_DIR . 'includes/class-pdf.php')) throw new MessagingReadError('fusion_message_pdf', 'La tienda no puede preparar el PDF.', 503);
            require_once FUSION_ARCA_DIR . 'includes/class-pdf.php';
        }
        $pdf = \FusionBikes\ARCA\InvoicePdf::bytes($row);
        if (strncmp($pdf, '%PDF-', 5) !== 0 || strlen($pdf) > self::MAX_PDF_BYTES) throw new MessagingReadError('fusion_message_pdf', 'El PDF no es válido o supera el tamaño permitido.', 413);
        // Re-read association after rendering: a changed billing phone cannot release private bytes.
        self::verified_order($request);
        return ['order_id' => (int)$order->get_id(), 'invoice_id' => (int)$row['id'],
            'invoice' => self::summary($row), 'filename' => \FusionBikes\ARCA\InvoicePdf::filename($row),
            'mime' => 'application/pdf', 'size' => strlen($pdf), 'sha256' => hash('sha256', $pdf), 'data_base64' => base64_encode($pdf)];
    }
}

final class MessagingReadError extends \RuntimeException {
    public $reason; public $http;
    public function __construct(string $reason, string $message, int $http) {
        parent::__construct($message); $this->reason = $reason; $this->http = $http;
    }
}
