<?php
declare(strict_types=1);

require_once __DIR__ . '/woo-mirror.php';
require_once __DIR__ . '/fixture.php';
use FusionBikes\ARCA\VPS\WooMirror;

$checks = 0;
function check($condition, string $message): void
{
    global $checks;
    if (!$condition) throw new RuntimeException('FAIL: ' . $message);
    $checks++;
}
function rejects(callable $fn, string $message): void
{
    try { $fn(); } catch (InvalidArgumentException $e) { check(true, $message); return; }
    throw new RuntimeException('FAIL (accepted): ' . $message);
}
function meta(array $rows): array { return array_column($rows, 'value', 'key'); }

$f = fusion_arca_mirror_fixture();
$p = WooMirror::productPlan($f['products'][1]);
check($p['id'] === 920002 && $p['post']['post_parent'] === 920001, 'source product/parent IDs');
check($p['post']['post_type'] === 'product_variation', 'native variation CPT');
check(meta($p['meta'])['_price'] === '1210.00', 'explicit Woo price unchanged');
$currentOnly = $f['products'][1]; unset($currentOnly['regular_price'], $currentOnly['sale_price']);
$currentOnlyMeta = meta(WooMirror::productPlan($currentOnly)['meta']);
check($currentOnlyMeta['_price'] === '1210.00' && !array_key_exists('_regular_price', $currentOnlyMeta), 'current price never invents a regular price');
check(!array_key_exists('_sale_price', $currentOnlyMeta), 'current price never invents a sale price');
$identity = WooMirror::productPlan($f['products'][0]);
check(!array_key_exists('_price', meta($identity['meta'])), 'missing price remains absent');
check(meta($identity['meta'])['_fusion_arca_vps_category_ids'] === [25], 'source category IDs');
rejects(fn() => WooMirror::productPlan(array_replace($f['products'][1], ['id_padre' => 0])), 'variation requires parent');
rejects(fn() => WooMirror::productPlan(array_replace($f['products'][1], ['price' => '1.234,00'])), 'reject locale-formatted money');
rejects(fn() => WooMirror::productPlan(array_replace($f['products'][1], ['price' => -1])), 'reject negative product price');
rejects(fn() => WooMirror::productPlan(array_replace($f['products'][1], ['id_woo' => '1; DELETE'])), 'reject malformed identity');

$p = WooMirror::orderPlan($f['order']);
$m = meta($p['meta']);
check($p['id'] === 920101 && $p['post']['post_type'] === 'shop_order', 'source order ID');
check($p['post']['post_status'] === 'wc-processing', 'source status');
check($p['post']['post_date'] === '2026-10-01 12:34:56', 'local time unchanged');
check($p['post']['post_date_gmt'] === '2026-10-01 15:34:56', 'UTC time unchanged');
check($m['_date_paid'] === 1790869200, 'payment date UTC epoch');
check($m['_order_total'] === '1210.00' && $m['_order_tax'] === '189.00', 'totals are source amounts');
check($m['_order_shipping'] === '100.00' && $m['_order_shipping_tax'] === '21.00', 'shipping totals');
check($m['_billing_dni_cuit'] === '12345678', 'customer DNI preserved');
check($m['_fusion_arca_sale'] === $f['order']['meta_data'][2]['value'], 'Master Control historical USD snapshot preserved exactly');
check($m['_customer_user'] === 0 && $m['_fusion_arca_vps_source_customer_id'] === 920050, 'source customer cannot impersonate a local WP user');
check($m['_fusion_arca_vps_number'] === 'WEB-PRUEBA', 'display order number retained');
check(array_column($p['items'], 'id') === [920201, 920202, 920203, 920204, 920205], 'item IDs retained across every type');
check(array_column(array_column($p['items'], 'row'), 'order_item_type') === ['line_item', 'fee', 'shipping', 'tax', 'coupon'], 'native Woo item types');
$line = meta($p['items'][0]['meta']);
check($line['_product_id'] === 920001 && $line['_variation_id'] === 920002, 'line product identity');
check($line['_fusion_arca_serials'] === ['SERIE-PRUEBA'] && $line['Numero de Serie'] === 'SERIE-PRUEBA', 'serial metadata preserved');
check(count(array_filter($p['items'][0]['meta'], fn($m) => $m['key'] === 'Nota repetida')) === 2, 'duplicate source metadata retained');
check(meta($p['items'][1]['meta'])['_line_total'] === '-100.00', 'negative fee retained');
check(meta($p['items'][2]['meta'])['cost'] === '100.00', 'shipping uses native Woo cost key');
check($line['_line_tax_data'] === ['total' => [1 => '210.00'], 'subtotal' => [1 => '210.00']], 'native tax map');

$bad = $f['order']; unset($bad['meta_data']);
rejects(fn() => WooMirror::orderPlan($bad), 'reject normalized/incomplete cached order');
$bad = $f['order']; $bad['line_items'][0]['id'] = $bad['fee_lines'][0]['id'];
rejects(fn() => WooMirror::orderPlan($bad), 'duplicate item ID');
$bad = $f['order']; $bad['date_created'] = '2026-02-31T00:00:00';
rejects(fn() => WooMirror::orderPlan($bad), 'invalid calendar date');
$bad = $f['order']; $bad['meta_data'][] = ['key' => WooMirror::OWNER, 'value' => WooMirror::OWNER_VALUE];
rejects(fn() => WooMirror::orderPlan($bad), 'source cannot forge local ownership marker');
$bad = $f['order']; $bad['line_items'][0]['total'] = 'NaN';
rejects(fn() => WooMirror::orderPlan($bad), 'nonfinite money');
$bad = $f['order']; $bad['line_items'][0]['quantity'] = 0;
rejects(fn() => WooMirror::orderPlan($bad), 'zero product quantity');

$refunded = $f['order']; $refunded['refunds'] = [['id' => $f['refund']['id'], 'total' => '-1210.00']];
rejects(fn() => WooMirror::orderPlan($refunded), 'refund summaries require full details');
$p = WooMirror::orderPlan($refunded, [$f['refund']]);
check($p['refunds'][0]['post']['post_parent'] === $refunded['id'], 'refund parent ID');
check(meta($p['refunds'][0]['meta'])['_refund_amount'] === '1210.00', 'refund gross amount');
check(meta($p['refunds'][0]['items'][0]['meta'])['_qty'] === '-1', 'refund negative quantity');
check(meta($p['refunds'][0]['items'][0]['meta'])['_refunded_item_id'] === 920201, 'refund source line relationship');
$badRefund = $f['refund']; $badRefund['amount'] = '1.00';
rejects(fn() => WooMirror::orderPlan($refunded, [$badRefund]), 'mismatched refund amount');
$ml = $f['order']; $ml['meta_data'][] = ['key' => '_ml_order_id', 'value' => '2000000000000001'];
check(meta(WooMirror::orderPlan($ml)['meta'])['_ml_order_id'] === '2000000000000001', 'ML marker retained for original exclusion guard');
$parent = $f['order']; $parent['meta_data'][] = ['key' => '_fusion_parent', 'value' => 88];
check(meta(WooMirror::orderPlan($parent)['meta'])['_fusion_parent'] === 88, 'split-payment parent retained');

echo json_encode(['ok' => true, 'checks' => $checks, 'suite' => 'pure-normalization'], JSON_THROW_ON_ERROR) . PHP_EOL;
