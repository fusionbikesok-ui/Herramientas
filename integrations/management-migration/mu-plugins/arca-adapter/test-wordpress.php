<?php
declare(strict_types=1);

/**
 * Run only against a disposable copy of the private WordPress database.
 * FUSION_ARCA_MIRROR_TEST_DISPOSABLE=1 php test-wordpress.php /path/to/wp-load.php
 * It performs no HTTP, SOAP, invoice emission, mail or stock operations.
 */
if (getenv('FUSION_ARCA_MIRROR_TEST_DISPOSABLE') !== '1' || PHP_SAPI !== 'cli') {
    throw new RuntimeException('Use una copia descartable de WordPress y habilite explícitamente el arnés.');
}
if (!isset($argv[1]) || !is_file($argv[1]) || basename($argv[1]) !== 'wp-load.php') {
    throw new RuntimeException('Falta la ruta explícita de wp-load.php.');
}
define('FUSION_ARCA_VPS_MIRROR', true);
require_once $argv[1];
require_once __DIR__ . '/woo-mirror.php';
require_once __DIR__ . '/fixture.php';
use FusionBikes\ARCA\VPS\WooMirror;

WooMirror::registerFilters();
$checks = 0;
function verify($condition, string $message): void
{
    global $checks;
    if (!$condition) throw new RuntimeException('FAIL: ' . $message);
    $checks++;
}
function denied(callable $fn, string $message): void
{
    try { $fn(); } catch (RuntimeException $e) { verify(true, $message); return; }
    throw new RuntimeException('FAIL (accepted): ' . $message);
}
function verifyAmount($actual, string $expected, string $message): void
{
    $normalize = static function ($value): ?string {
        if (!is_string($value) && !is_int($value) && !is_float($value)) return null;
        $value = (string) $value;
        if (!preg_match('/^(-?)([0-9]+)(?:\.([0-9]+))?$/D', $value, $m)) return null;
        $whole = ltrim($m[2], '0');
        $fraction = rtrim($m[3] ?? '', '0');
        $zero = $whole === '' && $fraction === '';
        return (!$zero ? $m[1] : '') . ($whole === '' ? '0' : $whole) . '.' . $fraction;
    };
    // Only synthetic fixture values are included in diagnostics, never source orders.
    $diagnostic = json_encode(['expected' => $expected, 'actual' => $actual, 'actual_type' => gettype($actual)], JSON_THROW_ON_ERROR);
    verify($normalize($actual) !== null && $normalize($actual) === $normalize($expected), $message . ' ' . $diagnostic);
}
function pluginFingerprint($order): string
{
    $items = [];
    foreach ($order->get_items(['line_item', 'fee', 'shipping']) as $id => $item) {
        $items[] = [$id, $item->get_name(), $item->get_quantity(), $item->get_total(), $item->get_total_tax()];
    }
    return hash('sha256', wp_json_encode([$order->get_currency(), $order->get_payment_method(), $order->get_total(), $items]));
}

global $wpdb;
$itemsTable = $wpdb->prefix . 'woocommerce_order_items';
$itemMetaTable = $wpdb->prefix . 'woocommerce_order_itemmeta';
$base = max((int) $wpdb->get_var("SELECT MAX(ID) FROM {$wpdb->posts}"), (int) $wpdb->get_var("SELECT MAX(order_item_id) FROM $itemsTable")) + 1000;
$f = fusion_arca_mirror_fixture($base);
$postIds = [$base + 1, $base + 2, $base + 101, $base + 102, $base + 900];
$itemIds = [$base + 201, $base + 202, $base + 203, $base + 204, $base + 205, $base + 301];
$postList = implode(',', $postIds);
$itemList = implode(',', $itemIds);
verify((int) $wpdb->get_var("SELECT COUNT(*) FROM {$wpdb->posts} WHERE ID IN ($postList)") === 0, 'fixture posts initially absent');
verify((int) $wpdb->get_var("SELECT COUNT(*) FROM $itemsTable WHERE order_item_id IN ($itemList)") === 0, 'fixture items initially absent');
$hooks = [];
foreach (['woocommerce_new_order', 'woocommerce_update_order', 'woocommerce_order_status_changed', 'woocommerce_reduce_order_stock', 'woocommerce_payment_complete', 'wp_mail'] as $hook) {
    add_action($hook, static function () use (&$hooks, $hook): void { $hooks[] = $hook; });
}
$sourceSnapshot = $f['order']['meta_data'][2]['value'];
$outerFixtureOwned = false;
try {
    $order = WooMirror::hydrateOrder($f['order'], $f['products']);
    verify($order->get_id() === $base + 101 && $order->get_order_number() === 'WEB-PRUEBA', 'native order identity');
    verify($order->get_currency() === 'ARS' && $order->get_payment_method() === 'cheque', 'native currency/payment');
    verify($order->get_status() === 'processing', 'native status');
    verifyAmount($order->get_total(), '1210.00', 'native order total');
    verifyAmount($order->get_shipping_total(), '100.00', 'native shipping total');
    verify($order->get_date_paid()->getTimestamp() === 1790869200, 'native paid time');
    verify($order->get_billing_first_name() === 'Cliente' && $order->get_billing_country() === 'AR', 'native billing');
    verify($order->get_meta('_billing_dni_cuit') === '12345678', 'native billing DNI');
    verify($order->get_customer_id() === 0, 'source customer does not bind local WP user');
    verify($order->get_meta('_fusion_arca_sale') === $sourceSnapshot, 'historical USD snapshot is unchanged');
    $line = $order->get_item($base + 201);
    verify($line instanceof WC_Order_Item_Product, 'native product item');
    verify($line->get_product_id() === $base + 1 && $line->get_variation_id() === $base + 2, 'native item product IDs');
    verify($line->get_product() instanceof WC_Product_Variation, 'native variation class');
    verify($line->get_product()->get_parent_id() === $base + 1, 'native variation parent');
    verify($line->get_product()->get_sku() === 'TEST-VARIATION', 'native SKU');
    $variation = $line->get_product();
    $priceDiagnostic = json_encode(['stored_price' => get_post_meta($variation->get_id(), '_price', true),
        'stored_regular' => get_post_meta($variation->get_id(), '_regular_price', true),
        'stored_sale' => get_post_meta($variation->get_id(), '_sale_price', true),
        'native_regular' => $variation->get_regular_price('edit'), 'native_sale' => $variation->get_sale_price('edit')], JSON_THROW_ON_ERROR);
    verifyAmount($variation->get_price('edit'), '1210.00', 'native explicit Woo price ' . $priceDiagnostic);
    verifyAmount($variation->get_regular_price('edit'), '1210.00', 'native explicit regular Woo price');
    verify($line->get_meta('_fusion_arca_serials') === ['SERIE-PRUEBA'], 'native serials');
    verify($line->get_meta('Numero de Serie') === 'SERIE-PRUEBA', 'legacy serials');
    verifyAmount($order->get_item($base + 202)->get_total(), '-100.00', 'native negative fee');
    verify($order->get_item($base + 203)->get_method_id() === 'flat_rate', 'native shipping method');
    verifyAmount($order->get_item($base + 203)->get_total(), '100.00', 'native shipping gross base');
    verify(count($order->get_items('tax')) === 1 && count($order->get_items('coupon')) === 1, 'native tax and coupon');
    $fingerprint = pluginFingerprint($order);
    $again = WooMirror::hydrateOrder($f['order']);
    verify(pluginFingerprint($again) === $fingerprint, 'repeat hydration preserves fiscal fingerprint');
    verify(count($again->get_items()) === 1, 'repeat hydration does not duplicate items');
    verify(count($again->get_item($base + 201)->get_meta_data()) >= 5, 'custom/duplicate metadata survives Woo read');
    if (class_exists('FusionBikes\\ARCA\\Plugin')) {
        verify(\FusionBikes\ARCA\Plugin::is_bicycle($line->get_product()), 'source bicycle remains serial-required');
    }

    $older = $f['order']; $older['date_modified_gmt'] = '2026-10-04T15:34:56';
    denied(fn() => WooMirror::hydrateOrder($older), 'older source snapshot rejected');
    verify(pluginFingerprint(wc_get_order($f['order']['id'])) === $fingerprint, 'rejected update rolls back');
    $missingProduct = $f['order'];
    $missingProduct['line_items'][0]['product_id'] = $base + 404;
    $missingProduct['line_items'][0]['variation_id'] = 0;
    try {
        WooMirror::hydrateOrder($missingProduct);
        throw new RuntimeException('FAIL: absent positive product ID accepted');
    } catch (RuntimeException $e) {
        verify(str_contains($e->getMessage(), '#' . ($base + 404)), 'deleted or absent positive product ID is reported explicitly');
    }
    verify(pluginFingerprint(wc_get_order($f['order']['id'])) === $fingerprint, 'missing product rejection leaves existing sale unchanged');

    $outerKey = 'fusion_arca_mirror_outer_tx_' . $base;
    verify((int) $wpdb->get_var($wpdb->prepare("SELECT COUNT(*) FROM {$wpdb->options} WHERE option_name=%s", $outerKey)) === 0, 'caller fixture option initially absent');
    $outerFixtureOwned = true;
    verify($wpdb->query('START TRANSACTION') !== false, 'start caller transaction test');
    try {
        verify($wpdb->insert($wpdb->options, ['option_name' => $outerKey, 'option_value' => 'synthetic', 'autoload' => 'no']) !== false, 'insert uncommitted caller fixture');
        WooMirror::hydrateProducts($f['products']);
    } finally {
        $wpdb->query('ROLLBACK');
    }
    verify((int) $wpdb->get_var($wpdb->prepare("SELECT COUNT(*) FROM {$wpdb->options} WHERE option_name=%s", $outerKey)) === 0, 'dedicated mirror connection never commits the caller transaction');
    $collision = $f['products'][1]; $collision['id_woo'] = $f['order']['id'];
    denied(fn() => WooMirror::hydrateProducts([$collision]), 'product cannot overwrite imported order');
    $wpdb->insert($wpdb->posts, ['ID' => $base + 900, 'post_type' => 'page', 'post_status' => 'draft',
        'post_title' => 'Synthetic collision fixture', 'post_content' => '', 'post_excerpt' => '', 'to_ping' => '',
        'pinged' => '', 'post_content_filtered' => '', 'guid' => 'urn:fusion:mirror-test:' . $base]);
    $collision = $f['products'][0]; $collision['id_woo'] = $base + 900;
    denied(fn() => WooMirror::hydrateProducts([$collision]), 'non-adapter local post cannot be overwritten');
    verify(get_post_type($base + 900) === 'page', 'unowned collision post preserved');

    $custom = $f['order']; $custom['status'] = 'enviadoandreani';
    verify(WooMirror::hydrateOrder($custom)->get_status() === 'enviadoandreani', 'custom source order status survives Woo validation');
    $ml = $f['order']; $ml['status'] = 'mercadolibre';
    $mlOrder = WooMirror::hydrateOrder($ml);
    verify($mlOrder->get_status() === 'mercadolibre', 'custom ML status survives');
    if (class_exists('FusionBikes\\ARCA\\Plugin')) verify(\FusionBikes\ARCA\Plugin::is_ml_order($mlOrder), 'original ML mirror exclusion remains effective');

    $refunded = $f['order']; $refunded['refunds'] = [['id' => $f['refund']['id'], 'total' => '-1210.00']];
    $withRefund = WooMirror::hydrateOrder($refunded, [], [$f['refund']]);
    verifyAmount($withRefund->get_total_refunded(), '1210.00', 'native refund total blocks original ARCA emission guard');
    verify(count($withRefund->get_refunds()) === 1, 'native refund relation');
    $refund = $withRefund->get_refunds()[0];
    verify($refund->get_id() === $base + 102 && $refund->get_parent_id() === $base + 101, 'native refund identity');
    verify((int) $refund->get_item($base + 301)->get_meta('_refunded_item_id') === $base + 201, 'native refunded item identity');
    denied(fn() => WooMirror::hydrateOrder($f['order']), 'source refund disappearance blocks instead of erasing local history');

    update_post_meta($f['order']['id'], '_fusion_arca_invoice_id', 9999);
    denied(fn() => WooMirror::hydrateOrder($refunded, [], [$f['refund']]), 'pending local fiscal metadata cannot be erased by stale Woo source');
    verify((int) get_post_meta($f['order']['id'], '_fusion_arca_invoice_id', true) === 9999, 'local fiscal marker remains');
    verify($hooks === [], 'SQL import does not trigger order/payment/stock/mail hooks');
    echo json_encode(['ok' => true, 'checks' => $checks, 'suite' => 'native-woocommerce'], JSON_THROW_ON_ERROR) . PHP_EOL;
} finally {
    // Only IDs proved absent before this test are removed; never perform broad cleanup.
    $wpdb->query("DELETE FROM $itemMetaTable WHERE order_item_id IN ($itemList)");
    $wpdb->query("DELETE FROM $itemsTable WHERE order_item_id IN ($itemList)");
    $wpdb->query("DELETE FROM {$wpdb->postmeta} WHERE post_id IN ($postList)");
    $wpdb->query("DELETE FROM {$wpdb->posts} WHERE ID IN ($postList)");
    if ($outerFixtureOwned) $wpdb->delete($wpdb->options, ['option_name' => $outerKey]);
    wp_cache_flush();
}
