<?php
if (PHP_SAPI !== 'cli') exit(1);
define('WP_INSTALLING', true);
$_SERVER['HTTP_HOST'] = 'herramientas.fusionbikes.com.ar';
require '/var/www/html/wp-load.php';
require_once ABSPATH . 'wp-admin/includes/upgrade.php';
require_once ABSPATH . 'wp-admin/includes/plugin.php';
if (!is_blog_installed()) {
    wp_install('Fusion · Gestión VPS', 'migration_owner', 'admin@example.invalid', 0, '', wp_generate_password(64, true, true), 'es_AR');
    update_option('timezone_string', 'America/Argentina/Buenos_Aires');
    update_option('blog_public', '0');
    // Source IDs remain available for later imports. These are empty, private runtime tables.
    $wpdb->query("ALTER TABLE {$wpdb->posts} AUTO_INCREMENT=1000000000");
    $wpdb->query("ALTER TABLE {$wpdb->users} AUTO_INCREMENT=1000000000");
}
$archives = ['/opt/fusion-downloads/woocommerce.11.1.2.zip',
    '/opt/fusion-packages/pos.zip', '/opt/fusion-packages/facturador.zip', '/opt/fusion-packages/taller.zip'];
foreach ($archives as $file) {
    $zip = new ZipArchive();
    if ($zip->open($file) !== true) throw new RuntimeException('Cannot open plugin archive');
    for ($i = 0; $i < $zip->numFiles; $i++) {
        $name = $zip->getNameIndex($i);
        if (str_starts_with($name, '/') || str_contains($name, '\\') || in_array('..', explode('/', $name), true)) throw new RuntimeException('Unsafe archive');
    }
    if (!$zip->extractTo(WP_PLUGIN_DIR)) throw new RuntimeException('Cannot extract plugin');
    $zip->close();
}
// Activation in separate PHP invocations is required for plugins_loaded dependencies.
$plugins = ['woocommerce/woocommerce.php', 'fusion-bikes-pos-v2/fusion-bikes-pos.php',
    'fusion-facturacion-arca/fusion-facturacion-arca.php', 'fusion-taller/fusion-taller.php'];
$next = $argv[1] ?? '';
if ($next !== '' && in_array($next, $plugins, true) && !is_plugin_active($next)) {
    $result = activate_plugin($next);
    if (is_wp_error($result)) throw new RuntimeException($result->get_error_message());
}
update_option('woocommerce_currency', 'ARS');
update_option('blogname', 'Fusion Bikes');
update_option('woocommerce_default_country', 'AR:B');
update_option('woocommerce_price_num_decimals', 2);
update_option('woocommerce_allow_tracking', 'no');
update_option('woocommerce_onboarding_profile', ['completed' => true]);
update_option('woocommerce_admin_disabled', 'yes');
echo json_encode(['installed' => true, 'active_plugins' => get_option('active_plugins'), 'soap' => extension_loaded('soap')]) . "\n";
