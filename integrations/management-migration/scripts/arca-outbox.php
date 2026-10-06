<?php
if(PHP_SAPI!=='cli')exit;
require '/var/www/html/wp-load.php';
if(!get_option('fusion_arca_vps_enabled')||!\FusionBikes\ARCA\Plugin::settings()['production_enabled'])exit;
global $wpdb;
$cut=(array)get_option('fusion_arca_vps_cutover',[]);if(empty($cut['at'])||!isset($cut['last_source_id']))exit;
// Reconcile the authorized table too: a process can die after persisting CAE and before its hook.
$table=\FusionBikes\ARCA\Plugin::table();$ids=$wpdb->get_col($wpdb->prepare("SELECT i.id FROM $table i LEFT JOIN {$wpdb->options} a ON a.option_name=CONCAT('fusion_arca_vps_ack_',i.id) LEFT JOIN {$wpdb->options} q ON q.option_name=CONCAT('fusion_arca_vps_outbox_',i.id) WHERE i.environment='production' AND i.status='authorized' AND (i.id>%d OR i.updated_at>=%s) AND a.option_id IS NULL AND q.option_id IS NULL ORDER BY i.id LIMIT 50",(int)$cut['last_source_id'],$cut['at']));
foreach($ids as $id){$row=\FusionBikes\ARCA\Plugin::record((int)$id);if(empty($row['payload']['ml']))add_option('fusion_arca_vps_outbox_'.(int)$id,['at'=>gmdate('c')],'','no');}
$names=$wpdb->get_col($wpdb->prepare("SELECT option_name FROM {$wpdb->options} WHERE option_name LIKE %s ORDER BY option_id LIMIT 1000",$wpdb->esc_like('fusion_arca_vps_outbox_').'%'));
$done=0;$examined=0;foreach($names as $name){$pending=(array)get_option($name,[]);if((int)($pending['next_attempt']??0)>time())continue;if($examined>=10)break;$examined++;$id=(int)substr($name,strlen('fusion_arca_vps_outbox_'));if($id&&fusion_arca_vps_sync($id))$done++;}
echo json_encode(['examined'=>$examined,'synchronized'=>$done,'pending_candidates'=>count($names)])."\n";
