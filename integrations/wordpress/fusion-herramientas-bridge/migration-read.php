<?php
namespace FusionBikes\HerramientasBridge;
if (!defined('ABSPATH')) exit;

/** Bounded, administrator-only exports of the three modules. No arbitrary tables or options. */
final class MigrationRead {
    const TABLES = [
        'taller_jobs' => ['fusion_taller_jobs', 'id'],
        'taller_models' => ['fusion_taller_models', 'model_key'],
        'taller_reminders' => ['fusion_taller_reminders', 'id'],
        'taller_documents' => ['fusion_taller_documents', 'document_id'],
        'arca_invoices' => ['fusion_arca_invoices', 'id'],
        'arca_series' => ['fusion_arca_series', 'id'],
        'arca_ml_sales' => ['fusion_arca_ml_sales', 'id'],
        'arca_whatsapp' => ['fusion_arca_whatsapp', 'invoice_id'],
    ];
    const OPTIONS = ['fbpos_barcode_meta','fbpos_order_status','fbpos_installment_plans','fbpos_usd_rate','fbpos_payment_profiles','fbpos_quote_valid_days'];
    public static function register(): void {
        foreach (['migration-inventory' => 'inventory', 'migration-export' => 'export'] as $path => $method) {
            register_rest_route(Bridge::NAMESPACE, Bridge::PREFIX . '/' . $path, [
                'methods' => 'GET', 'permission_callback' => [self::class, 'allowed'], 'callback' => [self::class, $method],
            ]);
        }
    }
    public static function allowed() {
        $base = Bridge::allowed();
        if ($base !== true) return $base;
        return current_user_can('manage_options') ? true : new \WP_Error('fusion_migration_admin', 'La exportación requiere administrador.', ['status' => 403]);
    }
    private static function response(array $data): \WP_REST_Response {
        return new \WP_REST_Response($data, 200, ['Cache-Control' => 'private, no-store, max-age=0', 'X-Robots-Tag' => 'noindex, nofollow']);
    }
    private static function exists(string $table): bool {
        global $wpdb;
        return $wpdb->get_var($wpdb->prepare('SHOW TABLES LIKE %s', $wpdb->esc_like($table))) === $table;
    }
    public static function inventory(): \WP_REST_Response {
        global $wpdb;
        $tables = [];
        foreach (self::TABLES as $name => [$suffix, $key]) {
            $table = $wpdb->prefix . $suffix;
            $tables[$name] = ['exists' => self::exists($table)];
            if ($tables[$name]['exists']) $tables[$name]['rows'] = (int)$wpdb->get_var("SELECT COUNT(*) FROM `$table`");
        }
        $credentials = [];
        foreach (['PROD', 'HOMO'] as $env) {
            $credentials[$env] = [];
            foreach (['CERT','KEY'] as $kind) {
                $constant = 'FUSION_ARCA_' . $kind . '_' . $env;
                $credentials[$env][$kind] = defined($constant) && is_string(constant($constant)) && is_readable(constant($constant));
            }
        }
        $settings = (array)get_option('fusion_arca_settings', []);
        $taller = (array)get_option('fusion_taller_settings', []);
        return self::response(['schema' => 1, 'read_only' => true, 'generated_at' => gmdate('c'), 'tables' => $tables,
            'pos_quotes' => (int)$wpdb->get_var("SELECT COUNT(*) FROM {$wpdb->posts} WHERE post_type='fbpos_quote'"),
            'pos_drafts' => (int)$wpdb->get_var("SELECT COUNT(*) FROM {$wpdb->usermeta} WHERE meta_key='_fbpos_dashboard_draft'"),
            'arca_environment' => $settings['environment'] ?? null, 'arca_production_enabled' => !empty($settings['production_enabled']),
            'arca_automatic_enabled' => !empty($settings['auto_enabled']), 'arca_credentials_readable' => $credentials,
            'taller_reminders_enabled' => !empty($taller['enabled']),
            'versions' => ['pos' => class_exists('Fusion_Bikes_POS_Pro') ? \Fusion_Bikes_POS_Pro::VERSION : null,
                'arca' => defined('FUSION_ARCA_VERSION') ? FUSION_ARCA_VERSION : null,
                'taller' => defined('FUSION_TALLER_VERSION') ? FUSION_TALLER_VERSION : null]]);
    }
    public static function selection($resource, $page): array {
        if (!is_string($resource) || !in_array($resource, array_merge(array_keys(self::TABLES), ['settings', 'pos_quotes', 'pos_drafts']), true)) throw new \InvalidArgumentException('Recurso no permitido.');
        if ($page === null) $page = '1';
        if (!is_scalar($page) || !preg_match('/^[1-9][0-9]{0,5}$/D', (string)$page)) throw new \InvalidArgumentException('Página inválida.');
        return [$resource, (int)$page];
    }
    public static function export($request) {
        global $wpdb;
        try { [$resource, $page] = self::selection($request->get_param('resource'), $request->get_param('page')); }
        catch (\InvalidArgumentException $e) { return new \WP_Error('fusion_migration_input', $e->getMessage(), ['status' => 400]); }
        $offset = ($page - 1) * 50; $rows = [];
        if (isset(self::TABLES[$resource])) {
            [$suffix, $key] = self::TABLES[$resource]; $table = $wpdb->prefix . $suffix;
            if (!self::exists($table)) return new \WP_Error('fusion_migration_missing', 'El módulo todavía no creó esta tabla.', ['status' => 404]);
            $rows = $wpdb->get_results($wpdb->prepare("SELECT * FROM `$table` ORDER BY `$key` ASC LIMIT 51 OFFSET %d", $offset), ARRAY_A);
        } elseif ($resource === 'settings') {
            if ($page === 1) {
                foreach (self::OPTIONS as $name) $rows[] = ['name' => $name, 'value' => get_option($name, null)];
                $allow = [
                    'fusion_taller_settings' => ['enabled','count','unit','hour','end_hour','weekdays','source','template','language'],
                    'fusion_arca_settings' => ['environment','company','cuit','point','vat','production_enabled','auto_enabled','auto_statuses','invoice_type','currency'],
                ];
                foreach ($allow as $name => $keys) $rows[] = ['name' => $name, 'value' => array_intersect_key((array)get_option($name, []), array_flip($keys))];
            }
        } elseif ($resource === 'pos_quotes') {
            $rows = $wpdb->get_results($wpdb->prepare("SELECT ID,post_author,post_date,post_date_gmt,post_modified,post_modified_gmt,post_status,post_title FROM {$wpdb->posts} WHERE post_type='fbpos_quote' ORDER BY ID ASC LIMIT 51 OFFSET %d", $offset), ARRAY_A);
            foreach ($rows as &$row) foreach (['_fbpos_snapshot','_fbpos_token','_fbpos_order_id','_fbpos_sale','_fbpos_request'] as $key) $row['meta'][$key] = get_post_meta((int)$row['ID'], $key, true);
            unset($row);
        } else {
            $rows = $wpdb->get_results($wpdb->prepare("SELECT user_id,meta_value FROM {$wpdb->usermeta} WHERE meta_key='_fbpos_dashboard_draft' ORDER BY umeta_id ASC LIMIT 51 OFFSET %d", $offset), ARRAY_A);
        }
        if (!is_array($rows)) return new \WP_Error('fusion_migration_read', 'No se pudo leer el recurso.', ['status' => 503]);
        $more = count($rows) > 50; $rows = array_slice($rows, 0, 50);
        $json = wp_json_encode($rows);
        if ($json === false || strlen($json) > 8 * 1024 * 1024) return new \WP_Error('fusion_migration_size', 'La página supera el límite seguro de exportación.', ['status' => 413]);
        return self::response(['schema' => 1, 'resource' => $resource, 'page' => $page, 'more' => $more,
            'rows' => $rows, 'sha256' => hash('sha256', $json), 'generated_at' => gmdate('c'), 'read_only' => true,
            'consistent_cutover_snapshot' => false]);
    }
}
