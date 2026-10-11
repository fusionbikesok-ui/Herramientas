<?php
declare(strict_types=1);

/** Entirely synthetic. IDs are deliberately parameterized for a disposable WordPress test DB. */
function fusion_arca_mirror_fixture(int $base = 920000): array
{
    $meta = static fn(string $key, $value): array => ['id' => 1, 'key' => $key, 'value' => $value];
    $products = [
        ['id_woo' => $base + 1, 'nombre' => 'Bicicleta de prueba', 'tipo' => 'variable', 'id_padre' => 0,
            'sku' => 'TEST-PARENT', 'category_ids' => [25]],
        ['id_woo' => $base + 2, 'nombre' => 'Bicicleta de prueba — Negro / S', 'tipo' => 'variation', 'id_padre' => $base + 1,
            'sku' => 'TEST-VARIATION', 'price' => '1210.00', 'regular_price' => '1210.00', 'sale_price' => '',
            'vat' => '21', 'stock_status' => 'instock'],
    ];
    $line = ['id' => $base + 201, 'name' => 'Bicicleta de prueba — Negro / S', 'product_id' => $base + 1,
        'variation_id' => $base + 2, 'quantity' => 1, 'tax_class' => '', 'subtotal' => '1000.00', 'subtotal_tax' => '210.00',
        'total' => '1000.00', 'total_tax' => '210.00', 'taxes' => [['id' => 1, 'total' => '210.00', 'subtotal' => '210.00']],
        'meta_data' => [$meta('_fusion_arca_serials', ['SERIE-PRUEBA']), $meta('Numero de Serie', 'SERIE-PRUEBA'),
            $meta('Color', 'Negro'), $meta('Nota repetida', 'A'), $meta('Nota repetida', 'B')]];
    $order = ['id' => $base + 101, 'parent_id' => 0, 'number' => 'WEB-PRUEBA', 'status' => 'processing', 'currency' => 'ARS',
        'total' => '1210.00', 'total_tax' => '210.00', 'cart_tax' => '189.00', 'shipping_total' => '100.00',
        'shipping_tax' => '21.00', 'discount_total' => '0.00', 'discount_tax' => '0.00',
        'payment_method' => 'cheque', 'payment_method_title' => 'Dólares', 'transaction_id' => 'transaccion-sintetica',
        'customer_id' => $base + 50, 'order_key' => 'wc_order_synthetic', 'version' => '11.1.2', 'created_via' => 'checkout',
        'prices_include_tax' => true, 'customer_note' => 'Retira en sucursal',
        'date_created' => '2026-10-01T12:34:56', 'date_created_gmt' => '2026-10-01T15:34:56',
        'date_modified' => '2026-10-05T12:34:56', 'date_modified_gmt' => '2026-10-05T15:34:56',
        'date_paid' => '2026-10-01T12:40:00', 'date_paid_gmt' => '2026-10-01T15:40:00',
        'date_completed' => null, 'date_completed_gmt' => null,
        'billing' => ['first_name' => 'Cliente', 'last_name' => 'Sintético', 'company' => '', 'address_1' => 'Calle de prueba 1',
            'address_2' => '', 'city' => 'Córdoba', 'state' => 'X', 'postcode' => '5000', 'country' => 'AR',
            'email' => 'cliente@example.invalid', 'phone' => '+5493510000000'],
        'shipping' => ['first_name' => 'Cliente', 'last_name' => 'Sintético', 'address_1' => 'Calle de prueba 1', 'country' => 'AR'],
        'meta_data' => [$meta('_billing_dni_cuit', '12345678'), $meta('_fusion_arca_vat_condition', '5'),
            $meta('_fusion_arca_sale', ['version' => 1, 'currency' => 'USD', 'total' => 10,
                'lines' => [['product_id' => $base + 2, 'total' => 10, 'rate' => 121]],
                'source' => 'master-control-checkout', 'captured_at' => '2026-10-01T15:34:56Z', 'review' => true,
                'signature' => 'preserved-source-signature'])],
        'line_items' => [$line],
        'fee_lines' => [['id' => $base + 202, 'name' => 'Ajuste de la venta', 'tax_class' => '', 'tax_status' => 'taxable',
            'total' => '-100.00', 'total_tax' => '-21.00', 'taxes' => [['id' => 1, 'total' => '-21.00']], 'meta_data' => []]],
        'shipping_lines' => [['id' => $base + 203, 'method_title' => 'Andreani', 'method_id' => 'flat_rate', 'instance_id' => '2',
            'total' => '100.00', 'total_tax' => '21.00', 'taxes' => [['id' => 1, 'total' => '21.00']], 'meta_data' => []]],
        'tax_lines' => [['id' => $base + 204, 'rate_id' => 1, 'label' => 'IVA 21%', 'rate_percent' => 21,
            'compound' => false, 'tax_total' => '189.00', 'shipping_tax_total' => '21.00', 'meta_data' => []]],
        'coupon_lines' => [['id' => $base + 205, 'code' => 'PRUEBA', 'discount' => '0.00', 'discount_tax' => '0.00', 'meta_data' => []]],
        'refunds' => [],
    ];
    $refundLine = $line;
    $refundLine['id'] = $base + 301;
    $refundLine['quantity'] = -1;
    foreach (['subtotal', 'total'] as $key) $refundLine[$key] = '-1000.00';
    foreach (['subtotal_tax', 'total_tax'] as $key) $refundLine[$key] = '-210.00';
    $refundLine['taxes'] = [['id' => 1, 'total' => '-210.00', 'subtotal' => '-210.00']];
    $refundLine['meta_data'] = [$meta('_refunded_item_id', $line['id'])];
    $refund = ['id' => $base + 102, 'amount' => '1210.00', 'reason' => 'Devolución sintética', 'refunded_payment' => true,
        'refunded_by' => 1, 'date_created' => '2026-10-05T13:00:00', 'date_created_gmt' => '2026-10-05T16:00:00',
        'line_items' => [$refundLine], 'meta_data' => []];
    return ['products' => $products, 'order' => $order, 'refund' => $refund];
}
