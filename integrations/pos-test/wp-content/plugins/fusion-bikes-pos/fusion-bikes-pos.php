<?php
/**
 * Plugin Name: Fusion Bikes POS Pro
 * Description: Punto de venta profesional para WooCommerce con opciones comerciales, presupuestos, cobro y facturación.
 * Version: 2.6.0
 * Author: Fusion Bikes
 * Requires PHP: 7.4
 * Requires Plugins: woocommerce
 */
if (!defined('ABSPATH')) exit;

// [FBPOS-DEBUG] Log plugin loading
file_put_contents('/tmp/fbpos-plugin-load.log', "[" . date('Y-m-d H:i:s') . "] Plugin loaded (fusion-bikes-pos.php included)\n", FILE_APPEND);

// Definir constantes del plugin
if (!defined('FBPOS_PLUGIN_FILE')) {
    define('FBPOS_PLUGIN_FILE', __FILE__);
}

/**
 * Clase principal del plugin: bootstrap y registro de hooks.
 */
final class Fusion_Bikes_POS_Pro {
    const VERSION = '2.6.0';
    const OPT_BARCODE = 'fbpos_barcode_meta';
    const OPT_STATUS = 'fbpos_order_status';
    const OPT_INSTALLMENTS = 'fbpos_installment_plans';
    const OPT_USD = 'fbpos_usd_rate';
    const OPT_PROFILES = 'fbpos_payment_profiles';
    const OPT_QUOTE_DAYS = 'fbpos_quote_valid_days';

    private $booted = false;

    // Servicios
    private $master_control_bridge;
    private $pricing_service;
    private $payment_gateway_service;
    private $customer_service;
    private $order_service;

    // Controllers
    private $search_controller;
    private $customer_controller;
    private $quote_controller;
    private $order_controller;
    private $mixed_leg_controller;

    // Admin
    private $settings_page;
    private $shortcode_renderer;

    public function __construct() {
        register_activation_hook(__FILE__, [$this, 'activate']);

        // El shortcode se registra siempre para que WordPress no lo imprima como texto
        add_shortcode('fusion_bikes_pos', [$this, 'render_shortcode']);

        add_action('plugins_loaded', [$this, 'boot'], 20);
        add_action('init', [$this, 'boot'], 1);
    }

    /**
     * Boot: inicializa todos los servicios y registra hooks cuando WooCommerce está disponible.
     */
    public function boot() {
        if ($this->booted || !class_exists('WooCommerce')) {
            return;
        }

        $this->booted = true;

        // Inicializar servicios
        $this->master_control_bridge = new FBPOS_Master_Control_Bridge();
        $this->pricing_service = new FBPOS_Pricing_Service();
        $this->payment_gateway_service = new FBPOS_Payment_Gateway_Service();
        $this->customer_service = new FBPOS_Customer_Service();
        $this->order_service = new FBPOS_Order_Service(
            $this->customer_service,
            $this->payment_gateway_service,
            $this->master_control_bridge
        );

        // Inicializar controllers
        $this->search_controller = new FBPOS_Search_Controller($this->order_service);
        $this->customer_controller = new FBPOS_Customer_Controller($this->customer_service);
        $this->quote_controller = new FBPOS_Quote_Controller($this->order_service);
        $this->order_controller = new FBPOS_Order_Controller(
            $this->order_service,
            $this->payment_gateway_service,
            $this->customer_service,
            $this->master_control_bridge
        );
        $this->mixed_leg_controller = new FBPOS_Mixed_Leg_Controller($this->order_service);

        // Inicializar admin
        $this->settings_page = new FBPOS_Settings_Page($this->pricing_service);
        $this->shortcode_renderer = new FBPOS_Shortcode_Renderer(
            $this->pricing_service,
            $this->payment_gateway_service
        );

        // Registrar hooks frontend
        add_action('wp_enqueue_scripts', [$this->shortcode_renderer, 'enqueue_assets']);
        add_action('rest_api_init', [$this, 'register_routes']);

        // Registrar hooks admin
        add_action('admin_menu', [$this->settings_page, 'register_admin_menu']);
        add_action('admin_init', [$this->settings_page, 'register_settings']);
        add_action('admin_footer', [$this->settings_page, 'inject_invoice_autoclick']);

        // Registrar hooks template
        add_filter('template_include', [$this->shortcode_renderer, 'filter_template'], 999);
        add_filter('show_admin_bar', [$this->shortcode_renderer, 'filter_admin_bar']);

        // Registrar gateways de pago
        add_filter('woocommerce_payment_gateways', [$this, 'register_payment_gateways']);

        // Registrar hooks de checkout (flow de carrito)
        add_action('init', [$this, 'register_quote_type']);
        add_action('init', [$this, 'register_rewrite_rules']);
        add_filter('query_vars', fn($vars) => array_merge($vars, ['fbpos_quote']));
        add_action('template_redirect', [$this->order_service, 'prepare_checkout'], 0);
        add_action('template_redirect', [$this->order_service, 'prepare_native_payment'], 1);
        add_action('template_redirect', [$this->quote_controller, 'render_public_quote']);
        add_action('woocommerce_before_calculate_totals', [$this->order_service, 'apply_checkout_prices'], 5);
        add_action('woocommerce_checkout_create_order', [$this->order_service, 'decorate_checkout_order'], 10, 2);
        add_action('woocommerce_thankyou', [$this->order_service, 'clear_checkout_session'], 20);
        add_filter('wp_sitemaps_posts_query_args', [$this->order_service, 'exclude_synthetic_from_sitemap'], 10, 2);
        add_action('wp_footer', [$this->order_service, 'render_native_payment_ui'], 99);
    }

    /**
     * Renderiza el shortcode.
     */
    public function render_shortcode() {
        return $this->shortcode_renderer ? $this->shortcode_renderer->render_shortcode() : '';
    }

    /**
     * Registra los endpoints REST.
     */
    public function register_routes() {
        // GET /fbpos/v2/search
        register_rest_route(
            'fbpos/v2',
            '/search',
            [
                'methods' => 'GET',
                'callback' => [$this->search_controller, 'search'],
                'permission_callback' => fn() => $this->is_user_allowed(),
                'args' => ['q' => ['required' => true, 'sanitize_callback' => 'sanitize_text_field']],
            ]
        );

        // POST /fbpos/v2/quote
        register_rest_route(
            'fbpos/v2',
            '/quote',
            [
                'methods' => 'POST',
                'callback' => [$this->quote_controller, 'create_quote'],
                'permission_callback' => fn() => $this->is_user_allowed(),
            ]
        );

        // GET /fbpos/v2/quotes
        register_rest_route(
            'fbpos/v2',
            '/quotes',
            [
                'methods' => 'GET',
                'callback' => [$this->quote_controller, 'list_quotes'],
                'permission_callback' => fn() => $this->is_user_allowed(),
            ]
        );

        // GET /fbpos/v2/customers
        register_rest_route(
            'fbpos/v2',
            '/customers',
            [
                'methods' => 'GET',
                'callback' => [$this->customer_controller, 'search_customers'],
                'permission_callback' => fn() => $this->is_user_allowed(),
                'args' => ['q' => ['required' => true, 'sanitize_callback' => 'sanitize_text_field']],
            ]
        );

        // POST /fbpos/v2/customer
        register_rest_route(
            'fbpos/v2',
            '/customer',
            [
                'methods' => 'POST',
                'callback' => [$this->customer_controller, 'save_customer'],
                'permission_callback' => fn() => $this->is_user_allowed(),
            ]
        );

        // POST /fbpos/v2/order
        register_rest_route(
            'fbpos/v2',
            '/order',
            [
                'methods' => 'POST',
                'callback' => [$this->order_controller, 'create_order'],
                'permission_callback' => fn() => $this->is_user_allowed(),
            ]
        );

        // GET /fbpos/v2/mixed-leg-status
        register_rest_route(
            'fbpos/v2',
            '/mixed-leg-status',
            [
                'methods' => 'GET',
                'callback' => [$this->mixed_leg_controller, 'get_mixed_leg_status'],
                'permission_callback' => fn() => $this->is_user_allowed(),
                'args' => ['row_id' => ['required' => true, 'sanitize_callback' => 'sanitize_text_field']],
            ]
        );
    }

    /**
     * Registra el custom post type para presupuestos.
     */
    public function register_quote_type() {
        register_post_type('fbpos_quote', [
            'labels' => [
                'name' => 'Presupuestos POS',
                'singular_name' => 'Presupuesto POS',
            ],
            'public' => false,
            'show_ui' => true,
            'show_in_menu' => 'woocommerce',
            'supports' => ['title', 'author'],
            'capability_type' => 'shop_order',
            'map_meta_cap' => true,
        ]);
    }

    /**
     * Registra las rewrite rules para presupuestos públicos.
     */
    public function register_rewrite_rules() {
        add_rewrite_rule('^presupuesto/([^/]+)/?$', 'index.php?fbpos_quote=$matches[1]', 'top');
    }

    /**
     * Hook de activación: crea opciones por defecto y la página de POS.
     */
    public function activate() {
        // Crear/actualizar opciones
        update_option(self::OPT_BARCODE, get_option(self::OPT_BARCODE, '_barcode'));
        update_option(self::OPT_STATUS, get_option(self::OPT_STATUS, 'completed'));
        update_option(
            self::OPT_INSTALLMENTS,
            get_option(self::OPT_INSTALLMENTS, "1|Contado|1.000\n3|3 cuotas|1.100\n6|6 cuotas|1.150\n9|9 cuotas|1.250\n12|12 cuotas|1.350\n18|18 cuotas|1.460\n24|24 cuotas|1.530")
        );
        update_option(self::OPT_USD, get_option(self::OPT_USD, '0'));
        update_option(
            self::OPT_PROFILES,
            get_option(self::OPT_PROFILES, "Contado efectivo|0.700|ARS\nTransferencia pesos|0.700|ARS\nTransferencia dólares|0.700|USD")
        );
        update_option(self::OPT_QUOTE_DAYS, get_option(self::OPT_QUOTE_DAYS, '7'));

        // Crear página de POS si no existe
        $page = get_page_by_path('punto-de-venta');
        if (!$page) {
            wp_insert_post([
                'post_title' => 'Punto de Venta',
                'post_name' => 'punto-de-venta',
                'post_status' => 'publish',
                'post_type' => 'page',
                'post_content' => '[fusion_bikes_pos]',
            ]);
        }

        // Registrar custom post type y rewrite rules
        $this->register_quote_type();
        $this->register_rewrite_rules();
        flush_rewrite_rules();
    }

    /**
     * Registra los gateways de pago del POS.
     */
    public function register_payment_gateways($gateways) {
        // Se requiere acá (no en el nivel superior del archivo) porque este filtro solo
        // corre una vez que WooCommerce ya cargó `WC_Payment_Gateway` — requerirlo antes
        // (ej. junto a los demás require_once de arriba) es un fatal error garantizado en
        // cada request, ya que WordPress carga este plugin antes que WooCommerce por orden
        // alfabético (revisor, implementación Posnet: hallazgo crítico).
        if (!class_exists('FBPOS_Posnet_Gateway')) {
            require_once plugin_dir_path(__FILE__) . 'includes/gateways/class-posnet-gateway.php';
        }

        $gateways[] = 'FBPOS_Posnet_Gateway';
        return $gateways;
    }

    /**
     * Verifica si el usuario actual tiene permisos para usar POS.
     */
    private function is_user_allowed() {
        return is_user_logged_in() && current_user_can('manage_woocommerce');
    }
}

// Cargar archivos de servicios, controllers y admin
require_once plugin_dir_path(__FILE__) . 'includes/services/class-master-control-bridge.php';
require_once plugin_dir_path(__FILE__) . 'includes/services/class-pricing-service.php';
require_once plugin_dir_path(__FILE__) . 'includes/services/class-payment-gateway-service.php';
require_once plugin_dir_path(__FILE__) . 'includes/services/class-customer-service.php';
require_once plugin_dir_path(__FILE__) . 'includes/services/class-order-service.php';

require_once plugin_dir_path(__FILE__) . 'includes/rest/class-search-controller.php';
require_once plugin_dir_path(__FILE__) . 'includes/rest/class-customer-controller.php';
require_once plugin_dir_path(__FILE__) . 'includes/rest/class-quote-controller.php';
require_once plugin_dir_path(__FILE__) . 'includes/rest/class-order-controller.php';
require_once plugin_dir_path(__FILE__) . 'includes/rest/class-mixed-leg-controller.php';

require_once plugin_dir_path(__FILE__) . 'includes/admin/class-settings-page.php';
require_once plugin_dir_path(__FILE__) . 'includes/class-shortcode-renderer.php';

// Instanciar el plugin
new Fusion_Bikes_POS_Pro();
