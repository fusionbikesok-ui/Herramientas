<?php
/**
 * Renderizador del shortcode y lógica de plantilla.
 */
if (!defined('ABSPATH')) exit;

class FBPOS_Shortcode_Renderer {
    private $pricing_service;
    private $payment_gateway_service;
    private $master_control_bridge;

    public function __construct(
        FBPOS_Pricing_Service $pricing_service,
        FBPOS_Payment_Gateway_Service $payment_gateway_service,
        ?FBPOS_Master_Control_Bridge $master_control_bridge = null
    ) {
        $this->pricing_service = $pricing_service;
        $this->payment_gateway_service = $payment_gateway_service;
        $this->master_control_bridge = $master_control_bridge ?? new FBPOS_Master_Control_Bridge();
    }

    /**
     * Renderiza el shortcode [fusion_bikes_pos].
     */
    public function render_shortcode() {
        if (!class_exists('WooCommerce')) {
            return '<div class="fbpos-denied">WooCommerce todavía no está disponible. Recargá la página.</div>';
        }

        if (!$this->is_user_allowed()) {
            return '<div class="fbpos-denied">Debés iniciar sesión con un usuario autorizado.</div>';
        }

        ob_start();
        $this->render_app_html();
        return ob_get_clean();
    }

    /**
     * Encolaciona los assets (CSS y JS) necesarios para el POS.
     */
    public function enqueue_assets() {
        if (!$this->is_page_pos()) {
            return;
        }

        $plugin_file = defined('FBPOS_PLUGIN_FILE') ? FBPOS_PLUGIN_FILE : __FILE__;
        $plugin_dir = plugin_dir_path($plugin_file);

        // Versión basada en la fecha de modificación de cada archivo, para que el navegador
        // siempre pida la versión más reciente sin depender de bumpear un número a mano.
        $asset_version = function ($relative_path) use ($plugin_dir) {
            $full_path = $plugin_dir . $relative_path;
            return file_exists($full_path) ? (string) filemtime($full_path) : Fusion_Bikes_POS_Pro::VERSION;
        };

        // Enqueue CSS
        wp_enqueue_style(
            'fbpos-pro',
            plugins_url('assets/pos.css', $plugin_file),
            [],
            $asset_version('assets/pos.css')
        );

        // Enqueue JS modules en orden de dependencia
        wp_enqueue_script(
            'fbpos-state',
            plugins_url('assets/js/state.js', $plugin_file),
            [],
            $asset_version('assets/js/state.js'),
            true
        );

        wp_enqueue_script(
            'fbpos-api',
            plugins_url('assets/js/api.js', $plugin_file),
            ['fbpos-state'],
            $asset_version('assets/js/api.js'),
            true
        );

        wp_enqueue_script(
            'fbpos-cart',
            plugins_url('assets/js/cart.js', $plugin_file),
            ['fbpos-api', 'fbpos-pricing'],
            $asset_version('assets/js/cart.js'),
            true
        );

        wp_enqueue_script(
            'fbpos-pricing',
            plugins_url('assets/js/pricing.js', $plugin_file),
            ['fbpos-state'],
            $asset_version('assets/js/pricing.js'),
            true
        );

        wp_enqueue_script(
            'fbpos-checkout',
            plugins_url('assets/js/checkout.js', $plugin_file),
            ['fbpos-pricing', 'fbpos-api'],
            $asset_version('assets/js/checkout.js'),
            true
        );

        wp_enqueue_script(
            'fbpos-customer',
            plugins_url('assets/js/customer.js', $plugin_file),
            ['fbpos-state', 'fbpos-api'],
            $asset_version('assets/js/customer.js'),
            true
        );

        wp_enqueue_script(
            'fbpos-quotes',
            plugins_url('assets/js/quotes.js', $plugin_file),
            ['fbpos-state', 'fbpos-api', 'fbpos-pricing'],
            $asset_version('assets/js/quotes.js'),
            true
        );

        wp_enqueue_script(
            'fbpos-quote-history',
            plugins_url('assets/js/quote-history.js', $plugin_file),
            ['fbpos-state', 'fbpos-api', 'fbpos-checkout'],
            $asset_version('assets/js/quote-history.js'),
            true
        );

        wp_enqueue_script(
            'fbpos-app',
            plugins_url('assets/js/app.js', $plugin_file),
            ['fbpos-state', 'fbpos-cart', 'fbpos-checkout', 'fbpos-customer', 'fbpos-quotes', 'fbpos-quote-history'],
            $asset_version('assets/js/app.js'),
            true
        );

        // Localizar script con datos iniciales (después de wp_enqueue_script)
        wp_localize_script('fbpos-app', 'FBPOS', [
            'rest' => esc_url_raw(rest_url('fbpos/v2')),
            'nonce' => wp_create_nonce('wp_rest'),
            'currency' => get_woocommerce_currency_symbol(),
            'gateways' => $this->payment_gateway_service->get_gateways(),
            'plans' => $this->pricing_service->get_plans(),
            'profiles' => $this->pricing_service->get_profiles(),
            'usdRate' => $this->pricing_service->get_usd_rate(),
            'usdSource' => 'Dólar Blue · compra · Master Control',
            'allowedInstallments' => $this->master_control_bridge->get_allowed_installments(),
            'allowedInstallmentsPosnet' => $this->master_control_bridge->get_allowed_installments_posnet(),
            'installmentCoefficients' => $this->master_control_bridge->get_all_coefficients(),
            'installmentCoefficientsPosnet' => $this->master_control_bridge->get_all_coefficients_posnet(),
            'store' => [
                'name' => get_bloginfo('name'),
                'url' => home_url('/'),
            ],
        ]);
    }

    /**
     * Renderiza la plantilla personalizada del POS en vez de la plantilla estándar.
     * Hook: template_include, prioridad 999
     */
    public function filter_template($template) {
        if ($this->is_page_pos()) {
            $custom_template = plugin_dir_path(dirname(__FILE__)) . 'templates/pos-page.php';

            if (file_exists($custom_template)) {
                return $custom_template;
            }
        }

        return $template;
    }

    /**
     * Oculta la barra de admin en la página de POS.
     * Hook: show_admin_bar
     */
    public function filter_admin_bar($show) {
        return $this->is_page_pos() ? false : $show;
    }

    /**
     * Verifica si estamos en la página de POS.
     */
    private function is_page_pos() {
        if (!is_page()) {
            return false;
        }

        $page = get_queried_object();

        return $page instanceof WP_Post
            && ($page->post_name === 'punto-de-venta'
                || has_shortcode($page->post_content, 'fusion_bikes_pos'));
    }

    /**
     * Verifica si el usuario actual tiene permisos para usar POS.
     */
    private function is_user_allowed() {
        return is_user_logged_in() && current_user_can('manage_woocommerce');
    }

    /**
     * Renderiza el HTML del app POS (todo el contenedor y estructura).
     * Este es el contenido del shortcode.
     */
    private function render_app_html() {
        $plugin_file = defined('FBPOS_PLUGIN_FILE') ? FBPOS_PLUGIN_FILE : __FILE__;
        $tarjetas_url = esc_url(plugins_url('assets/tarjetas-aceptadas.png', $plugin_file));
        ?>
<div id="fbpos-app" class="fbpos-app">
 <header class="fbpos-top"><div><h1>Fusion Bikes POS</h1><p id="fbpos-step-label">1 · Armado de venta</p></div><div class="fbpos-top-actions"><span><?php echo esc_html(wp_get_current_user()->display_name);?></span><button id="fbpos-new" class="fbpos-btn ghost">Nueva venta</button></div></header>
 <nav class="fbpos-steps"><button class="active" data-step="sale">1 Venta</button><button data-step="pricing">2 Opciones de pago</button><button data-step="checkout">3 Cobro</button><button data-step="done">4 Finalización</button><button id="fbpos-to-quotes" data-step="quotes">Presupuestos</button></nav>
 <main class="fbpos-main">
  <section class="fbpos-screen active" data-screen="sale">
   <div class="fbpos-sale-grid"><div class="fbpos-catalog"><div class="fbpos-search"><input id="fbpos-search" placeholder="Buscar nombre, SKU o escanear código..." autocomplete="off" autofocus><span id="fbpos-search-status"></span></div><div id="fbpos-results" class="fbpos-results"></div></div>
   <aside class="fbpos-cart-card"><div class="card-head"><h2>Venta actual</h2><span id="fbpos-cart-count">0 productos</span></div><div id="fbpos-cart" class="fbpos-cart"></div><div class="fbpos-client-summary"><div><small>Cliente</small><strong id="fbpos-customer-summary">Sin identificar</strong><span id="fbpos-customer-meta">Elegí consumidor final o buscá por DNI/CUIT, nombre o apellido</span></div><button id="fbpos-identify-customer" class="fbpos-btn ghost" type="button">Identificar cliente</button></div><div class="fbpos-client"><textarea id="fbpos-note" placeholder="Observaciones de la venta"></textarea></div></aside></div>
   <footer class="fbpos-bottom"><div><small>Total de lista</small><strong id="fbpos-sale-total">$0</strong></div><div class="actions"><button id="fbpos-quote-now" class="fbpos-btn secondary" disabled>Generar presupuesto</button><button id="fbpos-to-pricing" class="fbpos-btn primary" disabled>Ver opciones de pago</button></div></footer>
  </section>
  <section class="fbpos-screen" data-screen="pricing"><div class="fbpos-pricing-layout"><div><div class="screen-title"><span>Opciones comerciales</span><h2>Elegí cómo presentar el total</h2></div><div class="fbpos-cards-banner"><div><strong>Tarjetas aceptadas</strong><span>Visa, Mastercard, American Express, Naranja, Cabal, Tarjeta Shopping, Cencosud y Cordobesa</span></div><img src="<?php echo $tarjetas_url; ?>" alt="Tarjetas aceptadas"></div><div id="fbpos-price-cards" class="fbpos-price-cards"></div></div><aside class="fbpos-selection-card"><span>Opción seleccionada</span><h3 id="fbpos-selected-label">—</h3><strong id="fbpos-selected-total">$0</strong><p id="fbpos-selected-detail">Seleccioná una alternativa.</p><button id="fbpos-quote-pricing" class="fbpos-btn secondary">Generar presupuesto</button><button id="fbpos-to-checkout" class="fbpos-btn primary" disabled>Continuar al cobro</button><button data-back="sale" class="fbpos-link">Volver al carrito</button></aside></div></section>
  <section class="fbpos-screen" data-screen="checkout"><div class="fbpos-checkout-grid"><div class="fbpos-summary-card"><h2>Resumen de la operación</h2><div id="fbpos-checkout-items"></div><div class="summary-line"><span>Modalidad</span><strong id="fbpos-checkout-plan">—</strong></div><div class="summary-line total"><span>Total a cobrar</span><strong id="fbpos-checkout-total">$0</strong></div></div><div class="fbpos-payment-card"><h2>Cobro</h2><div class="fbpos-cards-compact"><span>Podés cobrar con</span><img src="<?php echo $tarjetas_url; ?>" alt="Tarjetas aceptadas"></div><label>Modalidad<select id="fbpos-payment-mode"><option value="single">Pago simple</option><option value="mixed">Pago combinado</option></select></label><div id="fbpos-single-payment"><label>Medio de pago<select id="fbpos-gateway"></select></label><div id="fbpos-gateway-help" class="fbpos-gateway-help"></div></div><div id="fbpos-mixed-payment" hidden><div id="fbpos-mixed-rows"></div><button id="fbpos-add-payment" class="fbpos-btn ghost" type="button">+ Agregar medio</button><div id="fbpos-mixed-balance"></div></div><button id="fbpos-charge" class="fbpos-btn primary big">Confirmar cobro</button><div id="fbpos-message"></div><button data-back="pricing" class="fbpos-link">Volver a opciones</button></div></div></section>
  <section class="fbpos-screen" data-screen="done"><div id="fbpos-done-card" class="fbpos-done-card"></div></section>
  <section class="fbpos-screen" data-screen="quotes"><div class="fbpos-quote-history-layout"><div id="fbpos-quote-history-loading" hidden><p>Cargando presupuestos...</p></div><div id="fbpos-quote-history-error" class="fbpos-error" style="display: none;"></div><div id="fbpos-quote-history-table"></div><button id="fbpos-back-from-quotes" data-back="sale" class="fbpos-link" style="margin-top: 2rem;">Volver al inicio</button></div></section>
 </main>
 <div id="fbpos-quote-modal" class="fbpos-modal" hidden><div class="fbpos-modal-card"><button class="close" id="fbpos-close-quote">×</button><div id="fbpos-quote-content"></div></div></div>
 <div id="fbpos-customer-modal" class="fbpos-modal" hidden><div class="fbpos-modal-card fbpos-customer-modal-card"><button class="close" id="fbpos-close-customer">×</button><div class="customer-modal-head"><span>Identificación fiscal</span><h2>¿A nombre de quién hacemos la operación?</h2></div><div class="customer-choice"><button id="fbpos-final-consumer" class="customer-choice-card" type="button"><strong>Consumidor final</strong><small>Continuar sin datos personales</small></button><button id="fbpos-with-data" class="customer-choice-card" type="button"><strong>Buscar o cargar cliente</strong><small>DNI/CUIT, nombre, apellido y teléfono</small></button></div><div id="fbpos-customer-form" hidden><div class="customer-search-row"><input id="fbpos-customer-document-search" placeholder="Buscar por DNI, CUIT, nombre o apellido" autocomplete="off"><button id="fbpos-search-customer" class="fbpos-btn secondary" type="button">Buscar</button></div><div id="fbpos-customer-results"></div><div id="fbpos-validation-messages" class="validation-messages"></div><div class="customer-form-sections"><div class="form-section"><h3>Datos fiscales</h3><div class="customer-fields"><label>Tipo de documento<select id="fbpos-document-type"><option value="DNI">DNI</option><option value="CUIT">CUIT</option></select></label><label>DNI / CUIT<input id="fbpos-customer-document" inputmode="numeric"></label><label>Tipo de cliente<select id="fbpos-customer-type"><option value="individual">Persona física</option><option value="company">Empresa</option></select></label></div><div id="fbpos-person-fields" class="customer-fields"><label>Nombre<input id="fbpos-customer-first-name" placeholder="Nombre"></label><label>Apellido<input id="fbpos-customer-last-name" placeholder="Apellido"></label></div><div id="fbpos-company-fields" class="customer-fields" hidden><label class="wide">Razón social<input id="fbpos-customer-company" placeholder="Razón social"></label></div></div><div class="form-section"><h3>Contacto</h3><div class="customer-fields"><label>Teléfono / WhatsApp<input id="fbpos-customer-phone" inputmode="tel" placeholder="Teléfono"></label><label>Email<input id="fbpos-customer-email" type="email" placeholder="Email"></label></div></div><div class="form-section"><h3>Dirección</h3><div class="customer-fields"><label class="wide">Dirección<input id="fbpos-customer-address" placeholder="Calle, número y piso (opcional)"></label><label>Ciudad<input id="fbpos-customer-city" placeholder="Ciudad (opcional)"></label><label>Provincia<select id="fbpos-customer-state"><option value="">Seleccionar provincia (opcional)</option><option value="C">Ciudad Autónoma de Buenos Aires</option><option value="B">Buenos Aires</option><option value="K">Catamarca</option><option value="H">Chaco</option><option value="U">Chubut</option><option value="X">Córdoba</option><option value="W">Corrientes</option><option value="E">Entre Ríos</option><option value="P">Formosa</option><option value="Y">Jujuy</option><option value="L">La Pampa</option><option value="F">La Rioja</option><option value="M">Mendoza</option><option value="N">Misiones</option><option value="Q">Neuquén</option><option value="R">Río Negro</option><option value="A">Salta</option><option value="J">San Juan</option><option value="D">San Luis</option><option value="Z">Santa Cruz</option><option value="S">Santa Fe</option><option value="G">Santiago del Estero</option><option value="V">Tierra del Fuego</option><option value="T">Tucumán</option></select></label><label>Código Postal<input id="fbpos-customer-postcode" placeholder="Código Postal (opcional)"></label></div></div></div><label class="save-customer"><input id="fbpos-save-customer" type="checkbox" checked> Guardar o actualizar en clientes de WooCommerce</label><div class="customer-modal-actions"><button id="fbpos-confirm-customer" class="fbpos-btn primary" type="button">Usar estos datos</button></div></div></div></div>
</div>
        <?php
    }
}
