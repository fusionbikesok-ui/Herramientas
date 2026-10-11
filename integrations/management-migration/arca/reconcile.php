<?php
if(PHP_SAPI!=='cli')exit(1);
require '/var/www/html/wp-load.php';
if(get_option('fusion_arca_vps_enabled')||\FusionBikes\ARCA\Plugin::settings()['production_enabled'])throw new RuntimeException('Destination must remain disabled');
$archive=json_decode(file_get_contents('/tmp/arca-cutover.json'),true,512,JSON_THROW_ON_ERROR);
if(empty($archive['source_stopped'])||!preg_match('/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/D',$archive['at']))throw new RuntimeException('Invalid cutover baseline');
$tables=['arca_invoices'=>['fusion_arca_invoices','id'],'arca_series'=>['fusion_arca_series','id'],'arca_ml_sales'=>['fusion_arca_ml_sales','id'],'arca_whatsapp'=>['fusion_arca_whatsapp','invoice_id']];
function canonical_rows($rows){foreach($rows as &$r){ksort($r);foreach($r as &$v)if($v!==null)$v=(string)$v;unset($v);}unset($r);return $rows;}
$data=[];
foreach($tables as $name=>$spec){
 $data[$name]=[];
 foreach($archive['resources'][$name]['pages'] as $page){if(!hash_equals($page['sha256'],hash('sha256',wp_json_encode($page['rows']))))throw new RuntimeException('Source hash failed: '.$name);$data[$name]=array_merge($data[$name],$page['rows']);}
 if(count($data[$name])!==$archive['resources'][$name]['count'])throw new RuntimeException('Count mismatch');
 $engine=$wpdb->get_var($wpdb->prepare('SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=%s',$wpdb->prefix.$spec[0]));if($engine!=='InnoDB')throw new RuntimeException('Transactional schema required');
}
if(array_filter($data['arca_invoices'],static fn($r)=>$r['environment']==='production'&&$r['status']==='pending'))throw new RuntimeException('Pending fiscal records');
if($wpdb->get_var($wpdb->prepare('SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=%s',$wpdb->options))!=='InnoDB')throw new RuntimeException('Transactional options required');
if($wpdb->query('START TRANSACTION')===false)throw new RuntimeException('Cannot start transaction');$counts=[];$changed=[];
try{
 foreach($tables as $name=>[$suffix,$key]){
  $table=$wpdb->prefix.$suffix;$columns=$wpdb->get_col("SHOW COLUMNS FROM `$table`",0);
  $existing=$wpdb->get_results("SELECT * FROM `$table` ORDER BY `$key` ASC FOR UPDATE",ARRAY_A);$old=array_column($existing,null,$key);$source=array_column($data[$name],null,$key);
  if(count($source)!==count($data[$name])||array_diff_key($old,$source))throw new RuntimeException('Unexpected destination or duplicate source IDs: '.$name);
  $changed[$name]=['before'=>count($existing),'inserted'=>0,'updated'=>0];
  foreach($data[$name] as $row){
   if(array_diff(array_keys($row),$columns)||array_diff($columns,array_keys($row)))throw new RuntimeException('Schema mismatch: '.$name);
   $prior=$old[$row[$key]]??null;
   if($name==='arca_invoices'&&$prior&&in_array($prior['status'],['authorized','internal'],true)){
    foreach(['status','environment','scope','order_id','order_key','number'] as $field)if($prior[$field]!==$row[$field])throw new RuntimeException('Finalized identity differs');
    $p=json_decode($prior['payload'],true);$q=json_decode($row['payload'],true);
    foreach(['cae','point','type','currency','totals','issuer','internal_number'] as $field)if(($p[$field]??null)!==($q[$field]??null))throw new RuntimeException('Finalized fiscal contents differ');
   }
   if(!$prior){if($wpdb->insert($table,$row)!==1)throw new RuntimeException('Insert failed: '.$name);$changed[$name]['inserted']++;}
   elseif(canonical_rows([$prior])!==canonical_rows([$row])){if($wpdb->update($table,$row,[$key=>$row[$key]])===false)throw new RuntimeException('Update failed: '.$name);$changed[$name]['updated']++;}
  }
  $stored=$wpdb->get_results("SELECT * FROM `$table` ORDER BY `$key` ASC",ARRAY_A);
  if(canonical_rows($stored)!==canonical_rows($data[$name]))throw new RuntimeException('Reconciliation mismatch: '.$name);
  $counts[$name]=count($stored);
 }
 $last=max(array_map(static fn($r)=>(int)$r['id'],$data['arca_invoices']));
 $baseline=['at'=>$archive['at'],'last_source_id'=>$last,'state'=>'reconciled','counts'=>$counts];update_option('fusion_arca_vps_cutover',$baseline,false);
 $stored=maybe_unserialize($wpdb->get_var($wpdb->prepare("SELECT option_value FROM {$wpdb->options} WHERE option_name=%s",'fusion_arca_vps_cutover')));if($stored!==$baseline)throw new RuntimeException('Baseline not persisted');
 if($wpdb->query('COMMIT')===false)throw new RuntimeException('Cannot commit reconciliation');echo wp_json_encode(['reconciled'=>true,'counts'=>$counts,'changes'=>$changed,'last_source_id'=>$last,'emission_enabled'=>false]);
}catch(Throwable $e){$wpdb->query('ROLLBACK');throw $e;}
