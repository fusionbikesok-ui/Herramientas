<?php
defined('ABSPATH') || exit;

class FBAM_Data {
    const DECLARED_VALUE = '30000';

    public static function catalog() {
        static $data;
        if ($data === null) {
            $data = json_decode(file_get_contents(FBAM_PATH . 'data/catalog.json'), true);
            if (!is_array($data)) { throw new RuntimeException('No se pudo leer el catálogo de la plantilla.'); }
        }
        return $data;
    }

    public static function norm($text) {
        return strtoupper(trim(preg_replace('/\s+/', ' ', remove_accents((string) $text))));
    }

    public static function text($value) {
        return is_scalar($value) ? trim(sanitize_text_field((string) $value)) : '';
    }

    public static function decimal($value) {
        $v = str_replace(',', '.', self::text($value));
        return preg_match('/^\d+(?:\.\d+)?$/', $v) && is_finite((float) $v) ? (float) $v : 0;
    }

    public static function meta($order, $keys) {
        foreach ($keys as $key) {
            $v = self::text($order->get_meta($key, true));
            if ($v !== '') { return $v; }
        }
        return '';
    }

    public static function package_profiles() {
        return [
            'bike'=>['profile'=>'bike','saved'=>'','height'=>'30','width'=>'20','depth'=>'40','weight'=>'9000'],
            'other'=>['profile'=>'other','saved'=>'','height'=>'12','width'=>'25','depth'=>'30','weight'=>'1000']
        ];
    }

    public static function bike_categories() {
        static $ids;
        if ($ids !== null) { return $ids; }
        $settings = get_option('fbam_settings', []);
        $configured = array_filter(array_map('absint', (array) ($settings['bike_categories'] ?? [])));
        if ($configured) { return $ids = array_values($configured); }
        $ids = [];
        $terms = get_terms(['taxonomy'=>'product_cat','hide_empty'=>false]);
        if (is_wp_error($terms)) { return $ids; }
        foreach ($terms as $term) {
            if (in_array(self::norm($term->name), ['BICICLETA','BICICLETAS','BICICLETAS ELECTRICAS','E-BIKES','EBIKES'], true) || in_array($term->slug,['bicicletas','bicicleta','bicicletas-electricas','e-bikes','ebikes'],true)) {
                $ids[] = (int) $term->term_id;
            }
        }
        return $ids;
    }

    public static function package_for_order($order) {
        $roots = self::bike_categories();
        static $category_cache = [];
        foreach ($order->get_items() as $item) {
            if ((float) $item->get_quantity() <= 0) { continue; }
            $product = $item->get_product();
            if (!$product) { continue; }
            if ($product->is_virtual()) { continue; }
            $id = $product->get_parent_id() ?: $product->get_id();
            if (!array_key_exists($id,$category_cache)) {
                $terms = wp_get_post_terms($id, 'product_cat', ['fields'=>'ids']);
                if (is_wp_error($terms)) { $category_cache[$id] = null; }
                else {
                    $all = array_map('intval',$terms);
                    foreach ($terms as $term) { $all = array_merge($all, array_map('intval',get_ancestors($term,'product_cat','taxonomy'))); }
                    $category_cache[$id] = array_unique($all);
                }
            }
            if ($category_cache[$id] === null) { continue; }
            if (array_intersect($roots,$category_cache[$id])) { return 'bike'; }
        }
        // Every order without a detected bicycle uses the standard parcel,
        // including multiple products and shops without bicycle categories.
        return 'other';
    }

    public static function complete($order, $d) {
        $profiles = self::package_profiles();
        $automatic = $profiles[self::package_for_order($order)];
        foreach ($d['packages'] as $i => $p) {
            // Repair empty drafts from every earlier version, including manual
            // profiles and multiple parcels. Keep saved boxes and custom sizes.
            if ($p['saved'] === '' && self::decimal($p['height']) <= 0 && self::decimal($p['width']) <= 0 && self::decimal($p['depth']) <= 0) {
                $d['packages'][$i] = array_merge($p, $automatic);
                $d['reviewed'] = false;
            }
        }
        if ($d['number'] === '') {
            $address = FBAM_Address::split($d['street']);
            if ($address) {
                $d['street'] = $address['street'];
                $d['number'] = $address['number'];
                $d['observations'] = FBAM_Address::notes($address['observations'], $d['observations']);
                $d['reviewed'] = false;
            }
        }
        return $d;
    }

    public static function destination($province, $city, $postcode) {
        // Only suggest an exact province + city + postcode match. Never guess by CP alone.
        $postcode = strtoupper(preg_replace('/\s+/', '', $postcode));
        if (preg_match('/^[A-Z](\d{4})[A-Z]{3}$/', $postcode, $m)) { $postcode = $m[1]; }
        $target = self::norm($province . ' / ' . $city . ' / ' . $postcode);
        static $index;
        if ($index === null) {
            $index = [];
            foreach (self::catalog()['destinations'] as $value) {
                $key = self::norm($value);
                $index[$key] = isset($index[$key]) ? '' : $value;
            }
        }
        return $index[$target] ?? '';
    }

    public static function draft($order) {
        $shipping = $order->get_address('shipping');
        $billing = $order->get_address('billing');
        // Use one complete address source: never mix a shipping address with billing fragments.
        $a = !empty($shipping['address_1']) ? $shipping : $billing;
        $states = WC()->countries->get_states($a['country'] ?? 'AR');
        $province = $states[$a['state'] ?? ''] ?? ($a['state'] ?? '');
        $phone = $order->get_shipping_phone() ?: $order->get_billing_phone();
        $split_phone = FBAM_Phone::split($phone);
        $auto_profile = self::package_for_order($order);
        $profiles = self::package_profiles();
        $auto_package = $profiles[$auto_profile] ?? ['profile'=>'manual','saved'=>'','height'=>'','width'=>'','depth'=>'','weight'=>''];
        $address = FBAM_Address::split($a['address_1'] ?? '');
        $dni_keys = ['_shipping_dni', 'shipping_dni', '_billing_dni', 'billing_dni', '_billing_document_number', 'billing_document_number', '_billing_dni_cuit'];
        $settings = get_option('fbam_settings', []);
        if (!empty($settings['dni_key'])) { array_unshift($dni_keys, $settings['dni_key']); }
        $dni = preg_replace('/[.\s-]/', '', self::meta($order, $dni_keys));
        // A CUIT is not silently converted to a recipient DNI.
        $products = [];
        foreach ($order->get_items() as $item) {
            $products[] = $item->get_quantity() . ' × ' . $item->get_name();
        }
        $d = [
            'service' => 'home', 'first_name' => $a['first_name'] ?? '', 'last_name' => $a['last_name'] ?? '',
            'dni' => $dni, 'email' => $order->get_billing_email(), 'phone_code' => $split_phone['code'] ?? '', 'phone_number' => $split_phone['number'] ?? '',
            'street' => $address['street'] ?? ($a['address_1'] ?? ''), 'number' => $address['number'] ?? '', 'floor' => '', 'apartment' => '',
            'destination' => self::destination($province, $a['city'] ?? '', $a['postcode'] ?? ''),
            'branch' => '', 'observations' => FBAM_Address::notes($address['observations'] ?? '', $a['address_2'] ?? ''),
            'packages' => [array_merge($auto_package,['value'=>self::DECLARED_VALUE])],
            'reviewed' => false
        ];
        $stored = $order->get_meta('_fbam_draft', true);
        if (is_array($stored)) {
            $d = array_replace($d, self::clean($stored));
            // Fill missing legacy data without replacing deliberately entered
            // phone fields, saved boxes or manually sized parcels.
            if ($d['phone_code'] === '' && $d['phone_number'] === '' && $split_phone) {
                $d['phone_code'] = $split_phone['code'];
                $d['phone_number'] = $split_phone['number'];
                $d['reviewed'] = false;
            }
            $d = self::complete($order, $d);
        }
        $methods = [];
        foreach ($order->get_shipping_methods() as $method) { $methods[] = $method->get_name(); }
        return [
            'id' => $order->get_id(), 'number' => $order->get_order_number(), 'status' => wc_get_order_status_name($order->get_status()),
            'date' => $order->get_date_created() ? $order->get_date_created()->date_i18n('d/m/Y H:i') : '',
            'currency' => $order->get_currency(), 'products' => $products, 'phone_original' => $phone,
            'auto_package' => $auto_package, 'phone_detected' => $split_phone,
            'address_original' => trim(implode(', ', array_filter([$a['address_1'] ?? '', $a['address_2'] ?? '', $a['city'] ?? '', $province, $a['postcode'] ?? '', $a['country'] ?? '']))),
            'method' => implode(', ', $methods), 'edit_url' => $order->get_edit_order_url(),
            'exported' => $order->get_meta('_fbam_exported_at', true), 'draft' => $d,
            'errors' => self::validate($d), 'country' => $a['country'] ?? ''
        ];
    }

    public static function clean($input) {
        $output = [];
        foreach (['service','first_name','last_name','dni','email','phone_code','phone_number','street','number','floor','apartment','destination','branch','observations'] as $key) {
            $output[$key] = self::text($input[$key] ?? '');
        }
        // Also accept a full national/international number pasted in the number
        // field when the operator has left the area-code field empty.
        if ($output['phone_code'] === '' && $output['phone_number'] !== '') {
            $phone = FBAM_Phone::split($output['phone_number']);
            if ($phone) { $output['phone_code'] = $phone['code']; $output['phone_number'] = $phone['number']; }
        }
        $output['reviewed'] = !empty($input['reviewed']);
        $output['packages'] = [];
        $packages = $input['packages'] ?? [];
        if (is_array($packages)) {
            foreach (array_slice($packages, 0, 20) as $p) {
                if (!is_array($p)) { continue; }
                $parcel = [];
                foreach (['saved','weight','height','width','depth','value'] as $key) { $parcel[$key] = self::text($p[$key] ?? ''); }
                // Fixed business rule for every shipment, including saved drafts.
                $parcel['value'] = self::DECLARED_VALUE;
                $profile = self::text($p['profile'] ?? 'manual');
                $profiles = self::package_profiles();
                $parcel['profile'] = isset($profiles[$profile]) ? $profile : 'manual';
                if (isset($profiles[$profile])) { $parcel = array_merge($parcel,$profiles[$profile]); }
                $output['packages'][] = $parcel;
            }
        }
        return $output;
    }

    public static function validate($d) {
        $errors = [];
        $c = self::catalog();
        if (!in_array($d['service'], ['home','branch','today'], true)) { $errors[] = 'Elegí el servicio.'; }
        foreach (['first_name'=>'nombre','last_name'=>'apellido','dni'=>'DNI','email'=>'email','phone_code'=>'código de área','phone_number'=>'número de celular'] as $key=>$label) {
            if (empty($d[$key])) { $errors[] = 'Falta ' . $label . '.'; }
        }
        if (!empty($d['dni']) && !preg_match('/^\d{7,8}$/', $d['dni'])) { $errors[] = 'DNI: usá 7 u 8 dígitos, sin puntos; no CUIT.'; }
        if (!empty($d['email']) && !is_email($d['email'])) { $errors[] = 'El email no es válido.'; }
        if (!preg_match('/^[1-9]\d{1,3}$/', $d['phone_code']) || !preg_match('/^\d{6,8}$/', $d['phone_number']) || strlen($d['phone_code'] . $d['phone_number']) !== 10) {
            $errors[] = 'Celular: código de área sin 0 y número sin 15; 10 dígitos en total, sin +54 ni 9 internacional.';
        }
        if ($d['service'] === 'branch') {
            if (!in_array($d['branch'], $c['branches'], true)) { $errors[] = 'Seleccioná una sucursal de la plantilla.'; }
        } else {
            if (empty($d['street']) || empty($d['number'])) { $errors[] = 'Completá calle y número.'; }
            $destinations = $d['service'] === 'today' ? $c['today'] : $c['destinations'];
            if (!in_array($d['destination'], $destinations, true)) { $errors[] = 'Seleccioná provincia / localidad / CP de la lista del servicio.'; }
        }
        if (empty($d['packages'])) { $errors[] = 'Agregá al menos un bulto.'; }
        foreach ($d['packages'] as $i => $p) {
            if ($p['saved'] !== '') {
                if (!in_array($p['saved'], $c['packages'], true)) { $errors[] = 'Bulto ' . ($i+1) . ': paquete guardado desconocido.'; }
            } else {
                foreach (['weight'=>'peso en gramos','height'=>'alto','width'=>'ancho','depth'=>'profundidad'] as $key=>$label) {
                    if (self::decimal($p[$key]) <= 0) { $errors[] = 'Bulto ' . ($i+1) . ': completá ' . $label . '.'; }
                }
            }
            if (self::decimal($p['value']) !== (float) self::DECLARED_VALUE) { $errors[] = 'Bulto ' . ($i+1) . ': el valor declarado debe ser $30.000 ARS.'; }
        }
        if (empty($d['reviewed'])) { $errors[] = 'Confirmá la revisión de destinatario y bultos.'; }
        return $errors;
    }

    public static function rows($order, $d) {
        $rows = [];
        $count = count($d['packages']);
        foreach ($d['packages'] as $i=>$p) {
            $saved = $p['saved'] !== '';
            $row = [$p['saved'], $saved ? '' : self::decimal($p['weight']), $saved ? '' : self::decimal($p['height']), $saved ? '' : self::decimal($p['width']), $saved ? '' : self::decimal($p['depth']), (float) self::DECLARED_VALUE, 'FB-' . $order->get_order_number() . ($count > 1 ? '-B' . ($i+1) : ''), $d['first_name'], $d['last_name'], $d['dni'], $d['email'], $d['phone_code'], $d['phone_number']];
            if ($d['service'] === 'branch') { $row[] = $d['branch']; }
            else { $row = array_merge($row, [$d['street'],$d['number'],$d['floor'],$d['apartment'],$d['destination'],$d['observations']]); }
            $rows[] = $row;
        }
        return $rows;
    }
}
