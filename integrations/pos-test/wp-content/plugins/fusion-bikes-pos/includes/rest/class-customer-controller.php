<?php
/**
 * Controlador REST: búsqueda y creación de clientes.
 * Endpoints:
 * - GET /fbpos/v2/customers
 * - POST /fbpos/v2/customer
 */
if (!defined('ABSPATH')) exit;

class FBPOS_Customer_Controller {
    private $customer_service;

    public function __construct(FBPOS_Customer_Service $customer_service) {
        $this->customer_service = $customer_service;
    }

    /**
     * Busca clientes por DNI/CUIT, nombre, apellido o email.
     * GET /fbpos/v2/customers?q=xyz
     *
     * @param WP_REST_Request $request
     * @return WP_REST_Response
     */
    public function search_customers(WP_REST_Request $request) {
        global $wpdb;

        $query = trim((string) $request['q']);

        if (mb_strlen($query) < 2) {
            return rest_ensure_response([]);
        }

        $normalized_doc = $this->customer_service->normalize_document($query);
        $user_ids = [];

        // Búsqueda por documento (DNI/CUIT)
        // billing_dni_cuit es la fuente de verdad actual
        if (strlen($normalized_doc) >= 5 && preg_match('/^[\d.\-\s]+$/u', $query)) {
            $keys = ['billing_dni_cuit', 'billing_dni', '_billing_dni', 'dni', 'billing_cuit', '_billing_cuit', 'cuit'];
            $placeholders = implode(',', array_fill(0, count($keys), '%s'));
            $args = array_merge($keys, ['%' . $wpdb->esc_like($normalized_doc) . '%']);

            $user_ids = $wpdb->get_col($wpdb->prepare(
                "
                SELECT DISTINCT user_id FROM {$wpdb->usermeta}
                WHERE meta_key IN ($placeholders)
                AND REPLACE(REPLACE(REPLACE(meta_value, '.', ''), '-', ''), ' ', '') LIKE %s
                LIMIT 20
                ",
                $args
            ));
        } else {
            // Búsqueda por nombre, apellido o razón social
            $like = '%' . $wpdb->esc_like($query) . '%';
            $meta_keys = ['billing_first_name', 'billing_last_name', 'billing_company', 'first_name', 'last_name'];
            $placeholders = implode(',', array_fill(0, count($meta_keys), '%s'));
            $args = array_merge([$like, $like, $like], $meta_keys, [$like]);

            $user_ids = $wpdb->get_col($wpdb->prepare(
                "
                SELECT DISTINCT u.ID
                FROM {$wpdb->users} u
                LEFT JOIN {$wpdb->usermeta} um ON um.user_id = u.ID
                WHERE u.display_name LIKE %s
                   OR u.user_email LIKE %s
                   OR u.user_login LIKE %s
                   OR (um.meta_key IN ($placeholders) AND um.meta_value LIKE %s)
                ORDER BY u.display_name ASC
                LIMIT 20
                ",
                $args
            ));
        }

        $payloads = array_filter(
            array_map([$this->customer_service, 'get_customer_payload'], array_map('intval', $user_ids))
        );

        return rest_ensure_response(array_values($payloads));
    }

    /**
     * Guarda o actualiza un cliente.
     * POST /fbpos/v2/customer
     *
     * @param WP_REST_Request $request
     * @return WP_REST_Response
     */
    public function save_customer(WP_REST_Request $request) {
        try {
            $data = $request->get_json_params();

            $document = $this->customer_service->normalize_document($data['document'] ?? '');
            $customer_type = sanitize_text_field($data['customer_type'] ?? 'individual');
            $phone = sanitize_text_field($data['phone'] ?? '');
            $email = sanitize_email($data['email'] ?? '');
            $document_type = strtoupper(sanitize_text_field($data['document_type'] ?? 'DNI')) === 'CUIT' ? 'CUIT' : 'DNI';

            // Campos opcionales de dirección
            $address_1 = sanitize_text_field($data['address_1'] ?? '');
            $city = sanitize_text_field($data['city'] ?? '');
            $state = sanitize_text_field($data['state'] ?? '');
            $postcode = sanitize_text_field($data['postcode'] ?? '');

            // Validar documento
            if (!$document) {
                throw new Exception('Ingresá un documento válido.');
            }

            // Validar longitud según tipo
            if ($document_type === 'CUIT') {
                if (strlen($document) !== 11) {
                    throw new Exception('Ingresá un CUIT válido (11 dígitos).');
                }
            } else {
                if (strlen($document) < 7 || strlen($document) > 8) {
                    throw new Exception('Ingresá un DNI válido (7 u 8 dígitos).');
                }
            }

            // Validar nombre según tipo y teléfono/email
            if ($customer_type === 'company') {
                $company_name = sanitize_text_field($data['company_name'] ?? '');
                if (!$company_name) {
                    throw new Exception('Ingresá la razón social.');
                }
                $display_name = $company_name;
            } else {
                $first_name = sanitize_text_field($data['first_name'] ?? '');
                $last_name = sanitize_text_field($data['last_name'] ?? '');
                if (!$first_name) {
                    throw new Exception('Ingresá el nombre.');
                }
                if (!$last_name) {
                    throw new Exception('Ingresá el apellido.');
                }
                $display_name = trim($first_name . ' ' . $last_name);
            }

            if (!$phone) {
                throw new Exception('Ingresá un teléfono de contacto.');
            }

            if (!$email) {
                throw new Exception('Ingresá un email.');
            }

            // Buscar cliente existente
            $existing_user_id = $this->find_existing_user($document, $email, $display_name);

            // Actualizar o crear usuario
            if (!$existing_user_id) {
                $user_id = wp_insert_user([
                    'user_login' => 'cliente_' . $document . '_' . wp_rand(10, 99),
                    'user_pass' => wp_generate_password(20, true, true),
                    'user_email' => $email,
                    'display_name' => $display_name,
                    'role' => 'customer',
                ]);

                if (is_wp_error($user_id)) {
                    throw new Exception($user_id->get_error_message());
                }
            } else {
                $user_id = $existing_user_id;

                $update_data = ['ID' => $user_id, 'display_name' => $display_name];
                if ($email) {
                    $update_data['user_email'] = $email;
                }

                wp_update_user(array_filter($update_data, fn($v) => $v !== null));
            }

            // Guardar meta fields según tipo de cliente
            if ($customer_type === 'company') {
                // Empresa: guardar razón social como billing_company
                update_user_meta($user_id, 'billing_company', sanitize_text_field($data['company_name'] ?? ''));
                // Limpiar campos de persona física
                delete_user_meta($user_id, 'billing_first_name');
                delete_user_meta($user_id, 'billing_last_name');
            } else {
                // Persona física: guardar nombre y apellido separados
                update_user_meta($user_id, 'billing_first_name', sanitize_text_field($data['first_name'] ?? ''));
                update_user_meta($user_id, 'billing_last_name', sanitize_text_field($data['last_name'] ?? ''));
                // Limpiar campo de empresa
                delete_user_meta($user_id, 'billing_company');
            }

            // Guardar teléfono y email
            update_user_meta($user_id, 'billing_phone', $phone);
            update_user_meta($user_id, 'billing_email', $email);

            // Guardar dirección (campos opcionales)
            // Se guardan incondicionalmente para permitir que se borren cuando el cajero los vacía
            update_user_meta($user_id, 'billing_address_1', $address_1);
            update_user_meta($user_id, 'billing_city', $city);
            update_user_meta($user_id, 'billing_state', $state);
            update_user_meta($user_id, 'billing_postcode', $postcode);

            // Guardar SIEMPRE en billing_dni_cuit (fuente de verdad actual)
            update_user_meta($user_id, 'billing_dni_cuit', $document);

            // Guardar en la key vieja correspondiente para compatibilidad
            $meta_key = $document_type === 'CUIT' ? 'billing_cuit' : 'billing_dni';
            $opposite_meta_key = $document_type === 'CUIT' ? 'billing_dni' : 'billing_cuit';

            update_user_meta($user_id, $meta_key, $document);
            update_user_meta($user_id, '_' . $meta_key, $document);

            // Limpiar keys del tipo contrario para evitar datos inconsistentes
            delete_user_meta($user_id, $opposite_meta_key);
            delete_user_meta($user_id, '_' . $opposite_meta_key);

            $payload = $this->customer_service->get_customer_payload($user_id);

            return rest_ensure_response([
                'success' => true,
                'customer' => $payload,
            ]);
        } catch (Throwable $e) {
            return new WP_Error('customer_error', $e->getMessage(), ['status' => 400]);
        }
    }

    /**
     * Busca un usuario existente por documento o email.
     * Retorna user_id si encuentra, null si no.
     *
     * Nota: Busca el documento normalizado contra todos los meta_values normalizados,
     * para evitar duplicados cuando el cliente tiene el mismo documento con formato
     * diferente (ej. 20-12345678-9 vs 20123456789).
     */
    private function find_existing_user($document, $email, $name) {
        global $wpdb;

        // Buscar por documento (normalizado, para matchear tanto formato crudo como sin formato)
        $keys = ['billing_dni_cuit', 'billing_dni', '_billing_dni', 'dni', 'billing_cuit', '_billing_cuit', 'cuit'];
        $placeholders = implode(',', array_fill(0, count($keys), '%s'));
        $args = array_merge($keys, [$document]);

        $user_id = $wpdb->get_var($wpdb->prepare(
            "
            SELECT user_id FROM {$wpdb->usermeta}
            WHERE meta_key IN ($placeholders)
            AND REPLACE(REPLACE(REPLACE(meta_value, '.', ''), '-', ''), ' ', '') = %s
            LIMIT 1
            ",
            $args
        ));

        // Mismo criterio de seguridad que la búsqueda por email más abajo: nunca devolver
        // un usuario que no sea "customer" (evita pisar una cuenta de staff que también
        // tenga un DNI/CUIT guardado como billing meta, ej. por haber comprado alguna vez).
        if ($user_id) {
            $matched_user = get_user_by('id', (int) $user_id);
            if ($matched_user && in_array('customer', (array) $matched_user->roles, true)) {
                return (int) $user_id;
            }
        }

        // Buscar por email — SOLO entre usuarios con rol "customer". Sin este filtro,
        // si un cajero tipeaba por error el email de un administrador/gerente (una
        // prueba, un typo, un email compartido), get_user_by() devolvía ESE usuario
        // y save_customer() le pisaba display_name y email con los datos del cliente,
        // corrompiendo silenciosamente la cuenta real del staff (bug real reportado:
        // el nombre de un cliente terminó apareciendo como si fuera el del usuario
        // logueado en el encabezado del POS).
        if ($email) {
            $user = get_user_by('email', $email);

            if ($user && in_array('customer', (array) $user->roles, true)) {
                return $user->ID;
            }
        }

        return null;
    }
}
