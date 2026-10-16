<?php
/**
 * Servicio de cliente: normalización de documentos, payload de cliente.
 */
if (!defined('ABSPATH')) exit;

class FBPOS_Customer_Service {
    /**
     * Normaliza un documento: elimina todo lo que no sea dígito.
     */
    public function normalize_document($value) {
        return preg_replace('/\D+/', '', (string) $value);
    }

    /**
     * Construye el payload de un cliente basándose en su user_id.
     * Retorna array con id, name, document, document_type, phone, email,
     * y campos separados (first_name, last_name, company, address_1, city, state, postcode).
     * Retorna null si el usuario no existe.
     */
    public function get_customer_payload($user_id) {
        $user = get_userdata($user_id);

        if (!$user) {
            return null;
        }

        // Buscar el documento (DNI o CUIT) en varios meta fields
        // billing_dni_cuit es la fuente de verdad actual (campo estándar WooCommerce)
        $document = '';
        $document_type = 'DNI';

        foreach (['billing_dni_cuit', 'billing_dni', '_billing_dni', 'dni', 'billing_cuit', '_billing_cuit', 'cuit'] as $key) {
            $value = get_user_meta($user_id, $key, true);

            if ($value !== '') {
                $document = $value;

                // billing_dni_cuit no indica el tipo en el nombre: determinar por longitud
                // CUIT = 11 dígitos, DNI = 7-8 dígitos
                if ($key === 'billing_dni_cuit') {
                    $normalized = $this->normalize_document($value);
                    $document_type = strlen($normalized) === 11 ? 'CUIT' : 'DNI';
                } elseif (stripos($key, 'cuit') !== false) {
                    $document_type = 'CUIT';
                }

                break;
            }
        }

        // Obtener campos separados
        $first_name = trim((string) get_user_meta($user_id, 'billing_first_name', true));
        $last_name = trim((string) get_user_meta($user_id, 'billing_last_name', true));
        $company = trim((string) get_user_meta($user_id, 'billing_company', true));

        // Construir nombre para display: company > first_name + last_name > display_name
        $name = $company ?: trim($first_name . ' ' . $last_name);
        if (!$name) {
            $name = $user->display_name;
        }

        return [
            'id' => $user_id,
            'name' => $name,
            'first_name' => $first_name,
            'last_name' => $last_name,
            'company' => $company,
            'document' => $document,
            'document_type' => $document_type,
            'phone' => get_user_meta($user_id, 'billing_phone', true),
            'email' => $user->user_email,
            'address_1' => get_user_meta($user_id, 'billing_address_1', true),
            'city' => get_user_meta($user_id, 'billing_city', true),
            'state' => get_user_meta($user_id, 'billing_state', true),
            'postcode' => get_user_meta($user_id, 'billing_postcode', true),
        ];
    }
}
