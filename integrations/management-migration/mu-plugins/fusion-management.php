<?php
/** Private migration runtime. Never install this file on the shop. */
if (!defined('ABSPATH')) exit;
if (getenv('FUSION_MANAGEMENT_MODE') !== 'validation') {
    http_response_code(503); exit('Runtime mode unavailable');
}
add_filter('pre_wp_mail', static function () { return false; });
add_filter('pre_http_request', static function () {
    return new WP_Error('migration_offline', 'Las conexiones externas están deshabilitadas durante la validación.');
}, PHP_INT_MAX);
add_filter('action_scheduler_allow_async_request_runner', '__return_false');
add_filter('action_scheduler_queue_runner_concurrent_batches', static function () { return 0; });
add_filter('show_admin_bar', '__return_false');
add_filter('redirect_canonical', '__return_false');
add_filter('rest_url', static function ($url, $path) { return home_url('/wp-json/' . ltrim($path, '/')); }, 10, 2);
add_filter('admin_url', static function ($url, $path) {
    if ($path === '' || $path === 'admin.php?page=fusion-launch-panel') return 'https://herramientas.fusionbikes.com.ar/herramientas/home/';
    if ($path === 'admin.php?page=fusion-arca') return home_url('/?fm_module=facturador');
    return $url;
}, 10, 2);
add_filter('logout_url', static function () { return 'https://herramientas.fusionbikes.com.ar/herramientas/home/'; });

if (PHP_SAPI !== 'cli') {
    $claim = $_SERVER['HTTP_X_FUSION_CLAIM'] ?? '';
    $signature = $_SERVER['HTTP_X_FUSION_SIGNATURE'] ?? '';
    $secret = getenv('FUSION_MANAGEMENT_SIGNING_KEY');
    $payload = json_decode(base64_decode($claim, true) ?: '', true);
    $valid = strlen($secret) >= 64 && strlen($claim) < 2048 && is_array($payload)
        && hash_equals(hash_hmac('sha256', $claim, $secret), $signature)
        && isset($payload['time'], $payload['method'], $payload['uri'], $payload['user'])
        && is_int($payload['time']) && abs(time() - $payload['time']) <= 20
        && $payload['method'] === ($_SERVER['REQUEST_METHOD'] ?? '')
        && $payload['uri'] === ($_SERVER['REQUEST_URI'] ?? '')
        && is_string($payload['user']) && strlen($payload['user']) <= 100;
    if (!$valid) { http_response_code(403); exit('Private runtime'); }
    if (!in_array($_SERVER['REQUEST_METHOD'], ['GET', 'HEAD'], true)) {
        $route=$_GET['rest_route']??'';
        $allowed=$_SERVER['REQUEST_METHOD']==='POST'&&preg_match('~^/fusion-arca/v1/(?:connection|customer-lookup|invoices|invoices/[1-9]\d*/(?:emit|recover|internal|credit-note|credit-note/emit))$~D',$route)
            && get_option('fusion_arca_vps_enabled',false)
            && isset($payload['sha256'])&&hash_equals($payload['sha256'],hash('sha256',file_get_contents('php://input')));
        if(!$allowed){http_response_code(423); exit('Operación no habilitada en VPS');}
    }
    if (isset($_GET['_method']) || isset($_GET['_jsonp'])) { http_response_code(400); exit('Method override blocked'); }
    $_SERVER['HTTPS'] = 'on';
    add_action('wp_head',static function()use($payload){if(!empty($payload['csrf'])&&preg_match('/^[a-f0-9]{64}$/D',$payload['csrf']))echo '<meta name="fusion-csrf" content="'.esc_attr($payload['csrf']).'">';},1);
    add_action('init', static function () {
        if (($_GET['fm_module'] ?? '') === 'pos') {
            $page = get_page_by_path('punto-de-venta');
            if ($page) $_GET['page_id'] = $page->ID;
        }
        if (isset($_GET['fbpos_quote'])) {
            ob_start(static function ($html) {
                $banner = '<div style="padding:14px;background:#fff1c6;color:#533d00;font:600 14px system-ui">Copia de consulta en VPS. Para compartir o convertir este presupuesto, usá la tienda actual.</div>';
                $html = str_replace('<body>', '<body>' . $banner, $html);
                return preg_replace('~<a[^>]+href="https://wa\.me/[^"\r\n]*"[^>]*>.*?</a>~s', '', $html);
            });
        }
    });
    add_filter('determine_current_user', static function () use ($payload) {
        $login = 'herr_' . substr(hash('sha256', $payload['user']), 0, 32);
        $user = get_user_by('login', $login);
        if (!$user) {
            $id = wp_insert_user(['user_login' => $login, 'user_pass' => wp_generate_password(64, true, true),
                'display_name' => $payload['user'], 'role' => 'administrator']);
            if (is_wp_error($id)) return 0;
            return $id;
        }
        return $user->ID;
    }, PHP_INT_MAX);
    // Authentication is performed on every request by Herramientas and signed by its gateway.
    add_filter('rest_authentication_errors', static function ($result) {
        return get_current_user_id() ? true : new WP_Error('migration_auth', 'Sin sesión.', ['status' => 401]);
    }, PHP_INT_MAX);
    // Imported WordPress user IDs are not Herramientas identities. This narrow archive
    // reader is for signed Herramientas administrators, never the operational ML APIs.
    add_filter('rest_pre_dispatch', static function ($result, $server, $request) {
        if ($request->get_route() !== '/fusion-arca/v1/ml/activity' || $request->get_method() !== 'GET') return $result;
        if (!current_user_can('manage_options')) return new WP_Error('migration_ml_permission', 'Se requiere un administrador.', ['status'=>403]);
        global $wpdb;
        $settings = \FusionBikes\ARCA\Plugin::settings();
        $scopes = $wpdb->get_results($wpdb->prepare('SELECT seller_id, COUNT(*) n FROM '.$wpdb->prefix.'fusion_arca_ml_sales WHERE environment=%s AND cuit=%s GROUP BY seller_id', $settings['environment'], $settings['cuit']), ARRAY_A);
        if (count($scopes) !== 1) return new WP_Error('migration_ml_scope', 'No se pudo identificar una única cuenta en el historial importado.', ['status'=>409]);
        $seller = (string)$scopes[0]['seller_id'];
        $scope = static function () use ($seller) { return ['seller_id'=>$seller,'enabled'=>false,'automatic'=>false]; };
        add_filter('pre_option_fusion_arca_ml', $scope);
        try {
            $data = \FusionBikes\ARCA\Plugin::boot()->ml_activity($request);
            $data['archive_count'] = (int)$scopes[0]['n'];
            $data['archive_only'] = true;
            return rest_ensure_response($data);
        } catch (\Throwable $error) {
            return new WP_Error('migration_ml_archive', 'No se pudo consultar el historial. Revisá los filtros.', ['status'=>400]);
        } finally { remove_filter('pre_option_fusion_arca_ml', $scope); }
    }, 10, 3);
    add_action('send_headers', static function () {
        header('Cache-Control: private, no-store');
        header('X-Robots-Tag: noindex, nofollow');
        header('Referrer-Policy: same-origin');
    });
    add_action('template_redirect', static function () {
        $module = $_GET['fm_module'] ?? '';
        if (!in_array($module, ['taller', 'facturador'], true)) return;
        if ($module === 'taller') \FusionBikes\Taller\Plugin::assets();
        else \FusionBikes\ARCA\Plugin::boot()->assets('toplevel_page_fusion-arca');
        $pos_frame=$module==='facturador'&&($_GET['view']??'')==='pos';
        if($pos_frame)wp_add_inline_script('fusion-arca','FusionArca.pos=true;','before');
        status_header(200);
        echo '<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fusion · ' . esc_html(ucfirst($module)) . '</title>';
        wp_head();
        echo '</head><body class="fusion-vps-module'.($pos_frame?' fusion-arca-pos':'').'">';
        do_action('wp_body_open');
        if ($module === 'taller') \FusionBikes\Taller\Plugin::render();
        else \FusionBikes\ARCA\Plugin::boot()->page();
        wp_footer(); echo '</body></html>'; exit;
    }, -50);
    add_action('wp_body_open', static function () {
        if(($_GET['fm_module']??'')==='facturador'&&($_GET['view']??'')==='pos')return;
        if(($_GET['fm_module']??'')==='pos' && get_option('fusion_pos_vps_enabled',false)){
            echo '<div class="fusion-migration-banner" role="status"><a href="'.esc_url(home_url('/')).'">← Módulos</a><strong>POS VPS · Checkout en la tienda</strong><span>Productos y clientes del catálogo sincronizado. El precio final y el pago se confirman en la tienda.</span></div>';return;
        }
        if(($_GET['fm_module']??'')==='facturador'){
            $active=\FusionBikes\ARCA\Plugin::settings()['production_enabled'];
            echo '<div class="fusion-migration-banner" role="status"><a href="'.esc_url(home_url('/')).'">← Módulos</a><strong>'.($active?'Facturador VPS · Producción':'Facturador VPS · Preparación').'</strong><span>'.($active?'Emisión manual · Punto de venta 15 · Catálogo local y control del pedido antes de emitir.':'Conexión ARCA verificada. Emisión todavía deshabilitada.').'</span></div>';return;
        }
        $manifest = (array)get_option('fusion_migration_import_manifest', []);
        $copied = !empty($manifest['created_at']) ? ' · Copia del ' . wp_date('d/m H:i', strtotime($manifest['created_at'])) : '';
        echo '<div class="fusion-migration-banner" role="status"><a href="' . esc_url(home_url('/')) . '">← Módulos</a><strong>Solo consulta</strong><span>Catálogo local sincronizado · Historial' . esc_html($copied) . ' sin actualización automática. Ventas, facturación y cambios pendientes de habilitar.</span></div>';
    });
    add_action('wp_head', static function () {
        echo '<style>body{margin:0;background:#f6f8fa;color:#17202a;font-family:system-ui,sans-serif}.fusion-migration-banner{padding:12px 18px;background:#fff1c6;color:#533d00;font:600 14px/1.5 system-ui;position:relative;z-index:100}.fusion-migration-banner a{color:inherit;display:inline-block;padding:8px 4px}.wrap{margin:16px}.fusion-vps-module #wpadminbar{display:none}</style>';
    }, 100);
    add_action('wp_head', static function () {
        echo '<style>@media(min-width:901px){.fbpos-app{height:calc(100dvh - var(--fusion-migration-banner,60px))!important}}</style>';
        echo '<style>@media(max-width:600px){#fusion-taller-app .ft-table-wrap{overflow:visible}#fusion-taller-app .ft-table-wrap table{min-width:0;width:100%}#fusion-taller-app .ft-table-wrap thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}#fusion-taller-app .ft-table-wrap tbody{display:block}#fusion-taller-app .ft-table-wrap tr{display:grid;grid-template-columns:1fr 1fr;border-bottom:1px solid #dce6df;padding:10px 0}#fusion-taller-app .ft-table-wrap td{display:block;min-width:0;white-space:normal;border:0;padding:10px 12px}#fusion-taller-app .ft-table-wrap td::before{display:block;font-size:11px;color:#526271;margin-bottom:6px}#fusion-taller-app .ft-table-wrap td:nth-child(1)::before{content:"Orden / ingreso"}#fusion-taller-app .ft-table-wrap td:nth-child(2)::before{content:"Cliente y bicicleta"}#fusion-taller-app .ft-table-wrap td:nth-child(3)::before{content:"Estado / responsable"}#fusion-taller-app .ft-table-wrap td:nth-child(4)::before{content:"Entrega prevista"}#fusion-taller-app .ft-table-wrap td:nth-child(5)::before{content:"Presupuesto / saldo"}#fusion-taller-app .ft-table-wrap td:last-child{grid-column:1/-1}#fusion-taller-app .ft-table-wrap td:last-child button{min-height:44px;width:100%}}</style>';
    }, 101);
    add_action('wp_footer', static function () {
        echo '<script>(()=>{const banner=document.querySelector(".fusion-migration-banner");const measure=()=>document.documentElement.style.setProperty("--fusion-migration-banner",(banner?.offsetHeight||0)+"px");measure();if(banner)new ResizeObserver(measure).observe(banner);})();</script>';
        if(($_GET['fm_module']??'')==='facturador'||(($_GET['fm_module']??'')==='pos'&&get_option('fusion_pos_vps_enabled',false)))return;
        echo '<script>(()=>{const blocked=/^(Emitir factura|Emitir nota de crédito|Guardar para después|Guardar presupuesto|Revisar cobro|Confirmar cobro|Nueva venta|Limpiar todo|Nuevo cliente|\+ Nueva orden|Guardar orden|Guardar cambios|Guardar configuración|Consultar datos en ARCA|Usar presupuesto|Cargar venta|Convertir en venta|Compartir por WhatsApp)$/i;const lock=()=>{document.querySelectorAll("button").forEach(b=>{if(blocked.test(b.textContent.trim())){b.disabled=true;b.title="Disponible después del cambio operativo; esta copia es de consulta.";}});};lock();new MutationObserver(lock).observe(document.body,{childList:true,subtree:true});})();</script>';
    }, 999);
    add_action('wp_head', static function () {
        echo '<link rel="stylesheet" href="/herramientas/lib/theme.css"><link rel="stylesheet" href="/herramientas/lib/components.css"><link rel="stylesheet" href="/herramientas/gestion-vps/assets/management.css"><script src="/herramientas/gestion-vps/assets/catalog-ui.js"></script>';
    }, 999);
}
