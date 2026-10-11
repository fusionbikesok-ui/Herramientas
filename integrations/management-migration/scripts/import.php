<?php
if (PHP_SAPI !== 'cli') exit(1);
require '/var/www/html/wp-load.php';
if (getenv('FUSION_MANAGEMENT_MODE') !== 'validation') throw new RuntimeException('Import requires validation mode');
$root = '/tmp/fusion-management-import';
$manifest = json_decode(file_get_contents($root . '/manifest.json'), true, 512, JSON_THROW_ON_ERROR);
$tables = [
    'taller_jobs'=>['fusion_taller_jobs','id'], 'taller_models'=>['fusion_taller_models','model_key'],
    'taller_reminders'=>['fusion_taller_reminders','id'], 'taller_documents'=>['fusion_taller_documents','document_id'],
    'arca_invoices'=>['fusion_arca_invoices','id'], 'arca_series'=>['fusion_arca_series','id'],
    'arca_ml_sales'=>['fusion_arca_ml_sales','id'], 'arca_whatsapp'=>['fusion_arca_whatsapp','invoice_id'],
];
$data = [];
// Table upgrades can change column order; mysqli versions can return integer scalars.
// Compare every named column, preserving NULL and exact decimal/text representations.
function fusion_migration_rows(array $rows): array {
    foreach ($rows as &$row) {
        ksort($row);
        foreach ($row as &$value) if ($value !== null) $value = (string)$value;
        unset($value);
    }
    unset($row);
    return $rows;
}
foreach ($manifest['resources'] as $name => $resource) {
    if (!isset($tables[$name]) && !in_array($name, ['settings','pos_quotes','pos_drafts'], true)) throw new RuntimeException('Unknown resource');
    $data[$name] = [];
    foreach ($resource['pages'] as $page) {
        if (!preg_match('/^' . preg_quote($name, '/') . '-[1-9][0-9]*\.json$/D', $page['file'])) throw new RuntimeException('Invalid import path');
        $bytes = file_get_contents($root . '/' . $page['file']);
        if (!hash_equals($page['sha256'], hash('sha256', $bytes))) throw new RuntimeException('Archive hash mismatch');
        $record = json_decode($bytes, true, 512, JSON_THROW_ON_ERROR);
        if (!hash_equals($record['sha256'], hash('sha256', wp_json_encode($record['rows'])))) throw new RuntimeException('Source row hash mismatch');
        $data[$name] = array_merge($data[$name], $record['rows']);
    }
    if (count($data[$name]) !== $resource['count']) throw new RuntimeException('Source count mismatch');
}
$wpdb->query('START TRANSACTION');
$counts = [];
try {
    foreach ($tables as $name => [$suffix, $key]) {
        if (!isset($data[$name])) continue;
        $table = $wpdb->prefix . $suffix;
        $columns = $wpdb->get_col("SHOW COLUMNS FROM `$table`", 0);
        if (!$columns) throw new RuntimeException('Destination schema missing: '.$name);
        $existing = $wpdb->get_results("SELECT * FROM `$table` ORDER BY `$key` ASC", ARRAY_A);
        if ($existing && fusion_migration_rows($existing) !== fusion_migration_rows($data[$name])) throw new RuntimeException('Destination already contains different records: '.$name);
        if (!$existing) foreach ($data[$name] as $row) {
            if (array_diff(array_keys($row), $columns) || array_diff($columns, array_keys($row))) throw new RuntimeException('Schema mismatch: '.$name);
            if ($wpdb->insert($table, $row) === false) throw new RuntimeException('Could not preserve record: '.$name);
        }
        $stored = $wpdb->get_results("SELECT * FROM `$table` ORDER BY `$key` ASC", ARRAY_A);
        if (fusion_migration_rows($stored) !== fusion_migration_rows($data[$name])) throw new RuntimeException('Record reconciliation failed: '.$name);
        $counts[$name] = count($stored);
    }
    foreach ($data['settings'] ?? [] as $row) {
        $name = $row['name']; $value = $row['value'];
        if (!in_array($name, ['fbpos_barcode_meta','fbpos_order_status','fbpos_installment_plans','fbpos_usd_rate','fbpos_payment_profiles','fbpos_quote_valid_days','fusion_arca_settings','fusion_taller_settings'], true)) throw new RuntimeException('Unexpected option');
        if ($name === 'fusion_arca_settings') { $value['production_enabled']=false; $value['auto_enabled']=false; }
        if ($name === 'fusion_taller_settings') $value['enabled']=false;
        update_option($name, $value, false);
    }
    foreach ($data['pos_quotes'] ?? [] as $row) {
        $id = (int)$row['ID']; $old = get_post($id);
        if ($id >= 1000000000 || $id <= 3) throw new RuntimeException('Source ID collides with reserved range');
        if ($old && $old->post_type !== 'fbpos_quote') throw new RuntimeException('Quote ID collision');
        if (!$old) {
            $post = $row; unset($post['ID'], $post['meta']);
            $post['import_id'] = $id; $post['post_type'] = 'fbpos_quote';
            $inserted = wp_insert_post($post, true);
            if (is_wp_error($inserted) || $inserted !== $id) throw new RuntimeException('Quote ID not preserved');
        }
        foreach ($row['meta'] as $key => $value) {
            if (!in_array($key, ['_fbpos_snapshot','_fbpos_token','_fbpos_order_id','_fbpos_sale','_fbpos_request'], true)) throw new RuntimeException('Unexpected quote metadata');
            update_post_meta($id, $key, $value);
            if (get_post_meta($id, $key, true) != $value) throw new RuntimeException('Quote metadata mismatch');
        }
    }
    $counts['pos_quotes'] = count($data['pos_quotes'] ?? []);
    // Operator mapping must be explicitly reconciled before these become editable drafts.
    update_option('fusion_migration_original_drafts', $data['pos_drafts'] ?? [], false);
    $counts['pos_drafts_preserved_for_mapping'] = count($data['pos_drafts'] ?? []);
    update_option('fusion_migration_import_manifest', ['source'=>$manifest['source'],'created_at'=>$manifest['created_at'],'counts'=>$counts,'mode'=>'validation'], false);
    $wpdb->query('COMMIT');
    echo json_encode(['counts'=>$counts,'hashes_verified'=>true,'mode'=>'read_only_validation','customer_passwords_copied'=>false,'fiscal_credentials_copied'=>false])."\n";
} catch (Throwable $error) { $wpdb->query('ROLLBACK'); throw $error; }
