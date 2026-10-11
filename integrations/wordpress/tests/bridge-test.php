<?php
namespace {
define('ABSPATH', '/fixture/');
define('WC_VERSION', 'fixture');
define('FUSION_BIKES_VERSION', '10.5.0-beta.4');
$ssl = true; $cap = false; $logged = false; $routes = []; $options = []; $products = [];
$passed = 0;
function check($condition, $label) { global $passed; if (!$condition) throw new \RuntimeException('FAILED: '.$label); $passed++; }
function is_ssl() { return $GLOBALS['ssl']; }
function current_user_can($cap) { return $cap === 'manage_woocommerce' ? $GLOBALS['cap'] : ($GLOBALS['admin'] ?? false); }
function is_user_logged_in() { return $GLOBALS['logged']; }
function add_action($hook, $fn) { check($hook === 'rest_api_init', 'only REST hook registered'); $fn(); }
function register_rest_route($ns, $path, $args) { $GLOBALS['routes'][$ns.$path]=$args; }
function get_option($key, $default=false) { return $GLOBALS['options'][$key] ?? $default; }
function update_option() { throw new \RuntimeException('Forbidden write'); }
function wp_remote_request() { throw new \RuntimeException('Forbidden network'); }
function wc_get_product($id) { return $GLOBALS['products'][$id] ?? null; }
function wc_get_price_decimals() { return 2; }
function get_woocommerce_currency() { return 'ARS'; }
function wp_get_post_terms() { return []; }
function wp_json_encode($value) { return json_encode($value); }
function is_wp_error($v) { return $v instanceof WP_Error; }
class WP_Error {
    public $code; public $message; private $data;
    function __construct($code,$message,$data) { $this->code=$code;$this->message=$message;$this->data=$data; }
    function get_error_data() { return $this->data; }
}
class WP_REST_Response {
    private $data; private $headers;
    function __construct($data,$code,$headers) { $this->data=$data;$this->headers=$headers; }
    function get_data() { return $this->data; }
    function get_headers() { return $this->headers; }
}
class Request {
    private $ids;
    function __construct($ids) { $this->ids=$ids; }
    function get_param($name) { return $name==='ids'?$this->ids:null; }
}
class WC_Product {
    public $id; public $price='100.01'; public $regular='200.00'; public $sale='100.01'; public $on_sale=true;
    public $status='publish'; public $type='simple'; public $parent=0;
    function __construct($id) { $this->id=$id; }
    function get_id() { return $this->id; }
    function get_status() { return $this->status; }
    function get_type() { return $this->type; }
    function is_type($type) { return $this->type===$type; }
    function get_parent_id() { return $this->parent; }
    function get_children() { return []; }
    function get_price($context='view') { return $this->price; }
    function is_on_sale() { return $this->on_sale; }
    function get_regular_price() { return $this->regular; }
    function get_sale_price() { return $this->sale; }
    function get_sku() { return 'FB-'.$this->id; }
    function get_name() { return 'Producto de prueba'; }
}
}
namespace FusionBikes\MasterControl\Contracts { final class CommercialApi { const VERSION=1; } }
namespace {
require __DIR__.'/DataService.php';
require __DIR__.'/PricingEngine.php';
require __DIR__.'/fusion-herramientas-bridge.php';
use FusionBikes\HerramientasBridge\Bridge;

check(count($routes)===4,'exactly four read routes');
foreach ($routes as $r) { check($r['methods']==='GET','no mutation method');check(in_array($r['permission_callback'],[[Bridge::class,'allowed'],[\FusionBikes\HerramientasBridge\MigrationRead::class,'allowed']],true),'permission callback'); }
check(Bridge::allowed()->get_error_data()['status']===401,'anonymous denied');
$logged=true; check(Bridge::allowed()->get_error_data()['status']===403,'insufficient role denied');
$cap=true; $ssl=false; check(Bridge::allowed()->get_error_data()['status']===403,'HTTP denied');
$ssl=true; check(Bridge::allowed()===true,'HTTPS manager allowed');
check(Bridge::parse_ids('12,34')===[12,34],'valid IDs');
foreach ([null, '', [], '0','-1','1,1','01','1.5','1, 2','1,','1 OR 1=1','1\n','9999999999999999', implode(',', range(1,26))] as $input) {
    $threw=false; try { Bridge::parse_ids($input); } catch (\InvalidArgumentException $e) { $threw=true; }
    check($threw,'invalid ID rejected');
}
check(count(Bridge::parse_ids(implode(',',range(1,25))))===25,'maximum batch');
check(Bridge::products(new Request('1,1'))->get_error_data()['status']===400,'invalid IDs API response');
$products[1]=new WC_Product(1);
$products[2]=new WC_Product(2); $products[2]->on_sale=false;
$products[3]=new WC_Product(3); $products[3]->type='variation'; $products[3]->parent=2;
$options['fusion_excepciones_data']=[2=>['c3'=>'1.25'],3=>['c6'=>'1.5']];
$response=Bridge::products(new Request('1,2,3'));
check($response instanceof WP_REST_Response,'successful snapshot');
$d=$response->get_data();
check($d['currency']==='ARS','currency declared');
check($d['items'][0]['base_amount']==='100.01','sale base retained');
check($d['items'][0]['plans'][0]['unit_amount']==='111.00','whole-peso rounding');
check($d['items'][1]['base_amount']==='200.00','regular base retained');
check($d['items'][1]['plans'][0]['unit_amount']==='250.00','product exception');
check($d['items'][2]['plans'][0]['unit_amount']==='126.00','parent exception inherited');
check($d['items'][2]['plans'][1]['unit_amount']==='151.00','variation exception wins');
check($d['items'][0]['checkout_revalidation_required']===true,'not a payment authorization');
check(in_array('usd',$d['excludes'],true),'unsupported scope explicit');
check($response->get_headers()['Cache-Control']==='private, no-store, max-age=0','no public cache');
$products[4]=new WC_Product(4); $products[4]->status='draft';
$products[5]=new WC_Product(5); $products[5]->parent=4; $products[5]->type='variation';
$products[6]=new WC_Product(6); $products[6]->type='variable';
$products[7]=new WC_Product(7); $products[7]->price='';
$d=Bridge::products(new Request('4,5,6,7,8'))->get_data();
check(array_column($d['items'],'state')===['unavailable','unavailable','not_sellable_type','unpriced','unavailable'],'unavailable products explicit');
$options['fusion_coef_3']=0;
$error=Bridge::products(new Request('1'));
check($error instanceof WP_Error && $error->get_error_data()['status']===503,'invalid coefficient fails closed');
check(strpos($error->message,'Invalid commercial')===false,'no internal error detail');
$options=[];
$products[1]->sale='50050.00'; $options['fusion_coef_3']=1.1;
$d=Bridge::products(new Request('1'))->get_data();
check($d['items'][0]['plans'][0]['unit_amount']==='55055.00','floating point boundary does not add peso');
$status=Bridge::status()->get_data();
check($status['read_only']===true && $status['checkout_migrated']===false,'status does not claim migration');
check($status['commercial_ready']===true,'contract recognized');
check(\FusionBikes\HerramientasBridge\MigrationRead::allowed()->get_error_data()['status']===403,'manager cannot export module records');
$admin=true;check(\FusionBikes\HerramientasBridge\MigrationRead::allowed()===true,'administrator can export bounded records');
foreach ([['wp_users','1'],['settings','0'],['settings','1 OR 1=1'],['settings',[]],['arca_invoices','1000000'],[['arca_invoices'],'1']] as $args) {
    $threw=false;try { \FusionBikes\HerramientasBridge\MigrationRead::selection(...$args); } catch (\InvalidArgumentException $e) {$threw=true;}
    check($threw,'unsafe migration selection denied');
}
check(\FusionBikes\HerramientasBridge\MigrationRead::selection('taller_jobs',null)===['taller_jobs',1],'bounded export default page');
$options['fusion_taller_settings']=['enabled'=>true,'token'=>'SECRET','phone_id'=>'SECRET','count'=>90];
$options['fusion_arca_settings']=['company'=>'Fusion','cuit'=>'fixture','private_key'=>'SECRET','production_enabled'=>true];
$request=new class { function get_param($key){return $key==='resource'?'settings':'1';} };
$export=\FusionBikes\HerramientasBridge\MigrationRead::export($request)->get_data();
check(strpos(json_encode($export),'SECRET')===false,'settings export does not disclose credentials or unknown fields');
check($export['consistent_cutover_snapshot']===false,'live export never claims a consistent cutover');
check($export['sha256']===hash('sha256',json_encode($export['rows'])),'export content hash');
$request=new class { function get_param($key){return $key==='resource'?'wp_users':'1';} };
check(\FusionBikes\HerramientasBridge\MigrationRead::export($request)->get_error_data()['status']===400,'arbitrary table export denied before database access');
echo json_encode(['passed'=>$passed,'commercial_source'=>'original Master Control DataService and PricingEngine','network'=>'disabled'])."\n";
}
