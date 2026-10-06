<?php
/** Isolated contract tests. No WordPress bootstrap, network or persistent writes. */
namespace FusionBikes\HerramientasBridge {
    final class Bridge { public static function allowed(){return $GLOBALS['bridge_permission'];} }
}
namespace FusionBikes\ARCA {
    final class Plugin {
        public static function matches_request(array $row,array $actual): bool {return $GLOBALS['matches_request'];}
        public static function is_ml_order($order): bool {return $order->ml;}
        public static function write_item_serials($item,array $serials): void {$item->serials=$serials;}
    }
}
namespace {
    define('ABSPATH',__DIR__.'/');define('ARRAY_A','ARRAY_A');
    $hooks=[];$routes=[];$tests=0;
    class WP_Error {public function __construct(public $code,public $message,public $data=[]){} }
    function add_filter($tag,$callback,$priority=10,$args=1){$GLOBALS['hooks'][$tag][$priority][]=[$callback,$args];}
    function add_action($tag,$callback,$priority=10,$args=1){add_filter($tag,$callback,$priority,$args);}
    function apply_filters($tag,$value,...$args){$groups=$GLOBALS['hooks'][$tag]??[];ksort($groups);foreach($groups as $callbacks)foreach($callbacks as [$callback,$count])$value=$callback(...array_slice([$value,...$args],0,$count));return $value;}
    function get_option($key,$default=false){return apply_filters('option_'.$key,$GLOBALS['options'][$key]??$default);}
    function update_option($key,$value,$autoload=null){if(($GLOBALS['fail_option']??'')===$key)return false;$GLOBALS['options'][$key]=$value;$GLOBALS['option_writes'][]=['key'=>$key,'held'=>array_keys($GLOBALS['wpdb']->held)];return true;}
    function maybe_unserialize($value){if($value===null)return false;$decoded=@unserialize($value);return $decoded===false?$value:$decoded;}
    function wp_json_encode($value){return json_encode($value,JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES);}
    function current_user_can($cap){return $GLOBALS['admin_permission'];}
    function get_current_user_id(){return 42;}
    function wc_get_order($id){return $GLOBALS['orders'][$id]??null;}
    function register_rest_route($namespace,$route,$definition){$GLOBALS['routes'][$route]=$definition;}
    final class Request {
        public function __construct(private array $body=[],private string $route='/fusion-arca/v1/invoices/1/emit',private string $method='POST'){}
        public function get_param($key){return $this->body[$key]??null;}
        public function get_json_params(){return $this->body;}
        public function get_route(){return $this->route;}
        public function get_method(){return $this->method;}
    }
    final class Item {
        public array $serials=[];public int $saves=0;
        public function __construct(public int $orderId){}
        public function get_order_id(){return $this->orderId;}
        public function save(){$this->saves++;}
    }
    final class Order {
        public array $meta=[];public bool $ml=false;public int $saves=0;
        public function get_meta($key){return $this->meta[$key]??'';}
        public function update_meta_data($key,$value){$this->meta[$key]=$value;}
        // Deliberately allows a foreign item, as Woo's lazy factory path does.
        public function get_item($id){return $GLOBALS['items'][$id]??null;}
        public function save(){$this->saves++;}
    }
    final class Database {
        public string $prefix='wp_';public string $options='wp_options';
        public array $held=[],$acquired=[],$released=[],$rows=[],$writes=[];
        public ?string $failLock=null;public bool $failWrite=false;
        public function prepare($sql,...$args){foreach($args as $arg)$sql=preg_replace('/%[sd]/',is_int($arg)?(string)$arg:"'".str_replace("'","''",(string)$arg)."'",$sql,1);return $sql;}
        public function get_var($sql){
            apply_filters('query',$sql);
            if(str_contains($sql,'SELECT option_value'))return isset($GLOBALS['options']['fusion_arca_vps_cutover'])?serialize($GLOBALS['options']['fusion_arca_vps_cutover']):null;
            if(preg_match("/GET_LOCK\('([^']+)'/",$sql,$m)){if($m[1]===$this->failLock)return 0;$this->held[$m[1]]=true;$this->acquired[]=$m[1];return 1;}
            if(preg_match("/RELEASE_LOCK\('([^']+)'/",$sql,$m)){unset($this->held[$m[1]]);$this->released[]=$m[1];return 1;}
            if(str_contains($sql,'SELECT COUNT(*)'))return count(array_filter($this->rows,fn($r)=>$r['environment']==='production'&&$r['status']==='pending'));
            throw new \RuntimeException('Unexpected SQL: '.$sql);
        }
        public function get_col($sql){apply_filters('query',$sql);return array_values(array_unique(array_column(array_filter($this->rows,fn($r)=>$r['environment']==='production'),'scope')));}
        public function get_row($sql,$format){apply_filters('query',$sql);if(!preg_match('/WHERE id=(\d+)/',$sql,$m))throw new \RuntimeException('Unexpected row query');return $this->rows[(int)$m[1]]??null;}
        public function insert($table,$data){apply_filters('query',"INSERT INTO `$table` (id) VALUES (".$data['id'].")");if($this->failWrite)return false;if(isset($this->rows[$data['id']]))return false;$this->rows[$data['id']]=$data;$this->writes[]='insert';return 1;}
        public function update($table,$data,$where){apply_filters('query',"UPDATE `$table` SET status='authorized' WHERE id=".$where['id']);if($this->failWrite)return false;$old=$this->rows[$where['id']]??null;if(!$old)return 0;foreach($where as $k=>$v)if((string)($old[$k]??'')!==(string)$v)return 0;$this->rows[$where['id']]=array_merge($old,$data);$this->writes[]='update';return 1;}
    }
    $source=getenv('FISCAL_CUTOVER_SOURCE_B64');
    if($source!==false&&$source!=='')eval('?>'.base64_decode($source,true));
    else require __DIR__.'/fiscal-cutover.php';
    use FusionBikes\HerramientasBridge\FiscalCutover as Cutover;
    function reset_fixture(){
        $GLOBALS['wpdb']=new Database();$GLOBALS['options']=['fusion_arca_settings'=>['company'=>'Fixture','cuit'=>'30716597489','point'=>15,'environment'=>'production','production_enabled'=>true,'auto_enabled'=>false,'auto_statuses'=>[]],'fusion_arca_ml'=>['point'=>16]];
        $GLOBALS['option_writes']=[];$GLOBALS['orders']=[];$GLOBALS['items']=[];$GLOBALS['fail_option']='';$GLOBALS['bridge_permission']=true;$GLOBALS['admin_permission']=true;$GLOBALS['matches_request']=true;Cutover::$receiving=false;
    }
    function stopped(){$GLOBALS['options'][Cutover::OPTION]=['state'=>'stopped'];}
    function record_fixture(int $id=200,int $oid=0): array {
        return ['id'=>$id,'revision'=>3,'environment'=>'production','scope'=>hash('sha256','production|30716597489|15|6'),'order_id'=>$oid,'order_key'=>$oid?'production|fixture|'.$oid:null,'status'=>'authorized','number'=>15,
            'payload'=>['issuer'=>['cuit'=>'30716597489'],'type'=>6,'point'=>15,'order_id'=>$oid,'cae'=>'12345678901234','cae_expires'=>'20261015','lines'=>[]],
            'request'=>['fixture'=>true],'response'=>['Resultado'=>'A','CodAutorizacion'=>'12345678901234','CbteDesde'=>15,'CbteHasta'=>15],'error'=>'','created_at'=>'2026-10-05 20:00:00','updated_at'=>'2026-10-05 20:00:01'];
    }
    function sql_record(array $row){foreach(['payload','request','response'] as $key)$row[$key]=wp_json_encode($row[$key]);return $row;}
    function check($condition,$message){if(!$condition)throw new \RuntimeException($message);}
    function error_is($actual,$code){check($actual instanceof WP_Error&&$actual->code===$code,'Expected error '.$code);}
    function test($name,$callback){reset_fixture();$callback();$GLOBALS['tests']++;echo "PASS $name\n";}
    function throws($callback){try{$callback();}catch(\RuntimeException $e){return;}throw new \RuntimeException('Expected blocked operation');}
    test('permission rejects unauthenticated and non-admin',function(){
        $GLOBALS['bridge_permission']=new WP_Error('unauthenticated','No');error_is(Cutover::permission(),'unauthenticated');$GLOBALS['bridge_permission']=true;$GLOBALS['admin_permission']=false;error_is(Cutover::permission(),'fiscal_admin');$GLOBALS['admin_permission']=true;check(Cutover::permission()===true,'Admin permitted');
    });
    test('REST write routes have the same admin permission callback',function(){Cutover::register();foreach(['/fusion-herramientas/fiscal-receipt','/fusion-herramientas/fiscal-cutover'] as $route){$defs=$GLOBALS['routes'][$route];if(isset($defs['methods']))$defs=[$defs];foreach($defs as $def)check($def['permission_callback']===[Cutover::class,'permission'],'Missing route permission');}});
    test('stop requires explicit confirmation',function(){error_is(Cutover::stop(new Request()),'fiscal_confirm');check(!Cutover::active()&&!$GLOBALS['option_writes'],'No mutations');});
    test('failed new credit-note scope lock does not pause',function(){
        $GLOBALS['wpdb']->failLock='fbarca_emit_'.substr(hash('sha256','production|30716597489|15|3'),0,48);error_is(Cutover::stop(new Request(['confirm'=>'ORIGIN_OFF_VPS'])),'fiscal_cutover');check(!Cutover::active()&&!$GLOBALS['option_writes'],'No paused option');check(!$GLOBALS['wpdb']->held,'Locks released');check(get_option('fusion_arca_settings')['production_enabled']===true,'Existing issuer can finish');
    });
    test('pending invoice prevents cut and leaves recovery possible',function(){
        $row=record_fixture();$row['status']='pending';$GLOBALS['wpdb']->rows[$row['id']]=sql_record($row);error_is(Cutover::stop(new Request(['confirm'=>'ORIGIN_OFF_VPS'])),'fiscal_cutover');check(!Cutover::active()&&!$GLOBALS['option_writes'],'No paused option');check(!$GLOBALS['wpdb']->held,'Locks released');check(apply_filters('rest_pre_dispatch',null,null,new Request([],'/fusion-arca/v1/invoices/200/recover'))===null,'Recovery not blocked');
    });
    test('successful stop locks web ML and internal scopes before persistence',function(){
        $result=Cutover::stop(new Request(['confirm'=>'ORIGIN_OFF_VPS']));check($result['active']===true&&$result['ready']===true,'Stopped');check(count($GLOBALS['wpdb']->acquired)===9,'All nine configured scopes');foreach($GLOBALS['option_writes'] as $write)check(count($write['held'])===9,'Options changed before full lock');check(!$GLOBALS['wpdb']->held,'Locks released');check(get_option('fusion_arca_settings')['production_enabled']===false,'Production disabled');
    });
    test('failed stop option persistence cannot claim ready',function(){$GLOBALS['fail_option']=Cutover::OPTION;error_is(Cutover::stop(new Request(['confirm'=>'ORIGIN_OFF_VPS'])),'fiscal_cutover');check(!Cutover::active(),'Not falsely stopped');check(!$GLOBALS['wpdb']->held,'Locks released');});
    test('stop replay is idempotent',function(){stopped();$result=Cutover::stop(new Request(['confirm'=>'ORIGIN_OFF_VPS']));check($result['ready']===true&&!$GLOBALS['option_writes']&&!$GLOBALS['wpdb']->acquired,'No replay mutation');});
    test('receipt requires completed cut',function(){error_is(Cutover::receipt(new Request(['record'=>record_fixture()])),'fiscal_inactive');});
    foreach(['result','cae','number','number_zero','number_large','until','scope'] as $bad)test('receipt rejects inconsistent '.$bad,function()use($bad){
        stopped();$row=record_fixture();if($bad==='result')$row['response']['Resultado']='R';if($bad==='cae')$row['response']['CodAutorizacion']='99999999999999';if($bad==='number')$row['number']=16;if($bad==='number_zero')$row['number']=$row['response']['CbteDesde']=$row['response']['CbteHasta']=0;if($bad==='number_large')$row['number']=$row['response']['CbteDesde']=$row['response']['CbteHasta']=100000000;if($bad==='until')$row['response']['CbteHasta']=16;if($bad==='scope')$row['scope']=str_repeat('a',64);error_is(Cutover::receipt(new Request(['record'=>$row])),'fiscal_confirmation');check(!$GLOBALS['wpdb']->writes&&!Cutover::$receiving,'No write or bypass');
    });
    test('receipt honors plugin request validation',function(){stopped();$GLOBALS['matches_request']=false;error_is(Cutover::receipt(new Request(['record'=>record_fixture()])),'fiscal_scope');});
    test('new authorized manual invoice archives then replays without replacement',function(){
        stopped();$row=record_fixture();$r=Cutover::receipt(new Request(['record'=>$row]));check($r['synced']===true,'Archived');$saved=$GLOBALS['wpdb']->rows[$row['id']];$row['payload']['issuer']['name']='Untrusted replay change';$r=Cutover::receipt(new Request(['record'=>$row]));check($r['synced']===true&&$GLOBALS['wpdb']->rows[$row['id']]===$saved,'Replay cannot overwrite');check($GLOBALS['wpdb']->writes===['insert']&&!Cutover::$receiving&&!$GLOBALS['wpdb']->held,'Single write and cleanup');
    });
    foreach(['draft','rejected'] as $status)test('migrated '.$status.' transitions to authorized',function()use($status){
        stopped();$row=record_fixture();$old=$row;$old['status']=$status;$old['revision']=1;$old['number']=null;unset($old['payload']['cae']);$GLOBALS['wpdb']->rows[$old['id']]=sql_record($old);$r=Cutover::receipt(new Request(['record'=>$row]));check($r['synced']===true&&$GLOBALS['wpdb']->rows[$row['id']]['status']==='authorized','Transition');check($GLOBALS['wpdb']->writes===['update'],'Only update');
    });
    test('existing authorized ID with another CAE is immutable',function(){stopped();$row=record_fixture();$old=$row;$old['payload']['cae']='99999999999999';$GLOBALS['wpdb']->rows[$row['id']]=sql_record($old);error_is(Cutover::receipt(new Request(['record'=>$row])),'fiscal_receipt');check(!$GLOBALS['wpdb']->writes&&!Cutover::$receiving,'No replacement');});
    test('new authorized credit note archives without order marking',function(){stopped();$row=record_fixture();$row['payload']['type']=8;$row['payload']['credit_of']=['id'=>199];$row['scope']=hash('sha256','production|30716597489|15|8');check(Cutover::receipt(new Request(['record'=>$row]))['synced']===true,'Credit archived');check(!$GLOBALS['orders'],'No order changes');});
    test('authorized web invoice marks matching order and item',function(){
        stopped();$row=record_fixture(200,77);$row['payload']['lines']=[['item_id'=>3,'serials'=>['FRAME123']]];$GLOBALS['orders'][77]=new Order();$GLOBALS['items'][3]=new Item(77);check(Cutover::receipt(new Request(['record'=>$row]))['synced']===true,'Synced');check($GLOBALS['orders'][77]->meta['_fusion_arca_cae']===$row['payload']['cae'],'Order CAE');check($GLOBALS['items'][3]->serials===['FRAME123'],'Serials');
    });
    test('foreign item fails before archival and order mutation',function(){
        stopped();$row=record_fixture(200,77);$row['payload']['lines']=[['item_id'=>3,'serials'=>['FRAME123']]];$GLOBALS['orders'][77]=new Order();$GLOBALS['items'][3]=new Item(88);error_is(Cutover::receipt(new Request(['record'=>$row])),'fiscal_receipt');check(!$GLOBALS['wpdb']->writes&&!$GLOBALS['orders'][77]->meta&&!$GLOBALS['items'][3]->saves,'No foreign change');check(!Cutover::$receiving&&!$GLOBALS['wpdb']->held,'Cleanup');
    });
    test('ML order cannot be marked',function(){stopped();$row=record_fixture(200,77);$GLOBALS['orders'][77]=new Order();$GLOBALS['orders'][77]->ml=true;error_is(Cutover::receipt(new Request(['record'=>$row])),'fiscal_receipt');check(!$GLOBALS['wpdb']->writes,'No archive');});
    test('archive failure restores SQL guard',function(){stopped();$GLOBALS['wpdb']->failWrite=true;error_is(Cutover::receipt(new Request(['record'=>record_fixture()])),'fiscal_receipt');check(!Cutover::$receiving&&!$GLOBALS['wpdb']->held,'Cleanup');throws(fn()=>apply_filters('query',"UPDATE wp_fusion_arca_invoices SET status='draft'"));});
    test('stopped REST denies POST and preserves read and unrelated routes',function(){stopped();error_is(apply_filters('rest_pre_dispatch',null,null,new Request()),'fiscal_moved');check(apply_filters('rest_pre_dispatch',null,null,new Request([],'/fusion-arca/v1/invoices','GET'))===null,'GET allowed');check(apply_filters('rest_pre_dispatch',null,null,new Request([],'/wc/v3/orders/77','PUT'))===null,'Store operations intact');});
    test('stopped SQL rejects fiscal writes but not reads or unrelated updates',function(){
        stopped();foreach(["UPDATE `wp_fusion_arca_invoices` SET status='draft'","INSERT INTO wp_fusion_arca_series (id) VALUES(1)","INSERT IGNORE INTO `wp_fusion_arca_ml_sales` (id) VALUES(1)","REPLACE INTO wp_fusion_arca_whatsapp (id) VALUES(1)","DELETE FROM wp_fusion_arca_invoices WHERE id=1"] as $sql)throws(fn()=>apply_filters('query',$sql));
        foreach(["SELECT * FROM wp_fusion_arca_invoices","UPDATE wp_posts SET post_content='wp_fusion_arca_invoices' WHERE ID=1","UPDATE wp_fusion_arca_invoices_archive SET status='draft'"] as $sql)check(apply_filters('query',$sql)===$sql,'Unrelated operation blocked');
    });
    echo json_encode(['passed'=>$tests,'isolated'=>true,'external_calls'=>0,'production_invoices_issued'=>0])."\n";
}
