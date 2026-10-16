<?php
/**
 * Página de configuración del admin.
 * Menú, registro de settings, renderizado de formularios.
 */
if (!defined('ABSPATH')) exit;

class FBPOS_Settings_Page {
    private $pricing_service;

    const OPT_BARCODE = 'fbpos_barcode_meta';
    const OPT_STATUS = 'fbpos_order_status';
    const OPT_INSTALLMENTS = 'fbpos_installment_plans';
    const OPT_PROFILES = 'fbpos_payment_profiles';
    const OPT_QUOTE_DAYS = 'fbpos_quote_valid_days';

    public function __construct(FBPOS_Pricing_Service $pricing_service) {
        $this->pricing_service = $pricing_service;
    }

    /**
     * Registra el menú de administración en WooCommerce.
     */
    public function register_admin_menu() {
        add_submenu_page(
            'woocommerce',
            'Fusion Bikes POS',
            'Fusion Bikes POS',
            'manage_woocommerce',
            'fbpos-settings',
            [$this, 'render_settings_page']
        );
    }

    /**
     * Registra los settings para persistencia.
     */
    public function register_settings() {
        foreach ([
            self::OPT_BARCODE,
            self::OPT_STATUS,
            self::OPT_INSTALLMENTS,
            self::OPT_QUOTE_DAYS,
        ] as $option) {
            register_setting('fbpos_settings', $option);
        }

        register_setting('fbpos_settings', self::OPT_PROFILES, [
            'sanitize_callback' => [$this, 'sanitize_profiles'],
        ]);
    }

    /**
     * Valida los perfiles de pago directos (contado/transferencia/etc.) al guardar:
     * ningún perfil puede tener un coeficiente menor a 1.0 — no existen descuentos por
     * debajo del precio de lista registrado, solo recargos por financiación (eso lo maneja
     * la sección de Cuotas). Un factor < 1.0 acá vendería por debajo del precio registrado.
     * Las líneas inválidas se descartan (no se guardan) y se avisa al admin cuáles y por qué.
     */
    public function sanitize_profiles($raw_value) {
        $lines = preg_split('/\R/', (string) $raw_value);
        $valid_lines = [];
        $rejected = [];

        foreach ($lines as $line) {
            $trimmed = trim($line);
            if ($trimmed === '') {
                continue;
            }

            $parts = array_map('trim', explode('|', $trimmed));

            if (count($parts) < 3) {
                $valid_lines[] = $line;
                continue;
            }

            $factor = (float) str_replace(',', '.', $parts[1]);

            if ($factor > 0 && $factor < 1.0) {
                $rejected[] = sprintf('"%s" (coeficiente %s)', $parts[0], $parts[1]);
                continue;
            }

            $valid_lines[] = $line;
        }

        if (!empty($rejected)) {
            add_settings_error(
                self::OPT_PROFILES,
                'fbpos_profile_discount_blocked',
                'No se guardaron estas opciones porque tenían un coeficiente menor a 1.0 '
                . '(venderían por debajo del precio de lista registrado, no está permitido): '
                . implode(', ', $rejected) . '. Si necesitás un recargo por financiación, usá la sección de Cuotas.',
                'error'
            );
        }

        return implode("\n", $valid_lines);
    }

    /**
     * Renderiza la página de configuración.
     */
    public function render_settings_page() {
        ?>
        <div class="wrap">
            <h1>Fusion Bikes POS Pro</h1>
            <form method="post" action="options.php">
                <?php settings_fields('fbpos_settings'); ?>
                <table class="form-table">
                    <tr>
                        <th>Código de barras (meta)</th>
                        <td>
                            <input
                                name="<?php echo self::OPT_BARCODE; ?>"
                                value="<?php echo esc_attr(get_option(self::OPT_BARCODE)); ?>"
                            >
                        </td>
                    </tr>
                    <tr>
                        <th>Estado final</th>
                        <td>
                            <select name="<?php echo self::OPT_STATUS; ?>">
                                <?php
                                $current_status = get_option(self::OPT_STATUS);
                                foreach (wc_get_order_statuses() as $key => $label) {
                                    $key = str_replace('wc-', '', $key);
                                    $selected = selected($current_status, $key, false);
                                    echo '<option value="' . esc_attr($key) . '" ' . $selected . '>' . esc_html($label) . '</option>';
                                }
                                ?>
                            </select>
                        </td>
                    </tr>
                    <tr>
                        <th>Cotización USD</th>
                        <td>
                            <strong>$<?php echo esc_html(number_format($this->pricing_service->get_usd_rate(), 0, ',', '.')); ?></strong>
                            <p class="description">
                                Se toma automáticamente de Master Control: valor manual
                                <code>fusion_dolar_manual</code> o DolarApi Blue (compra),
                                usando el mismo caché <code>fusion_dolar_v60</code>.
                            </p>
                        </td>
                    </tr>
                    <tr>
                        <th>Vigencia presupuesto</th>
                        <td>
                            <input
                                type="number"
                                min="1"
                                name="<?php echo self::OPT_QUOTE_DAYS; ?>"
                                value="<?php echo esc_attr(get_option(self::OPT_QUOTE_DAYS)); ?>"
                            > días
                        </td>
                    </tr>
                    <tr>
                        <th>Opciones directas</th>
                        <td>
                            <textarea
                                rows="5"
                                cols="55"
                                name="<?php echo self::OPT_PROFILES; ?>"
                            ><?php echo esc_textarea(get_option(self::OPT_PROFILES)); ?></textarea>
                            <p>Nombre|coeficiente|ARS o USD</p>
                        </td>
                    </tr>
                    <tr>
                        <th>Cuotas</th>
                        <td>
                            <textarea
                                rows="8"
                                cols="55"
                                name="<?php echo self::OPT_INSTALLMENTS; ?>"
                            ><?php echo esc_textarea(get_option(self::OPT_INSTALLMENTS)); ?></textarea>
                            <p>cantidad|nombre|coeficiente</p>
                        </td>
                    </tr>
                </table>
                <?php submit_button(); ?>
            </form>
        </div>
        <?php
    }

    /**
     * Inyecta JavaScript para auto-clicar el botón de factura.
     * Se ejecuta en admin_footer cuando se pasa ?fbpos_invoice=1
     */
    public function inject_invoice_autoclick() {
        if (!is_admin() || empty($_GET['fbpos_invoice'])) {
            return;
        }

        ?>
        <script>
        (function() {
            let attempts = 0;
            const maxAttempts = 50;
            const interval = setInterval(function() {
                attempts++;
                let button = document.querySelector('a.invoice-button, .invoice-button');
                if (button) {
                    clearInterval(interval);
                    button.click();
                } else if (attempts > maxAttempts) {
                    clearInterval(interval);
                }
            }, 250);
        })();
        </script>
        <?php
    }
}
