"""Read-only coverage inventory; never print customer names or contact data."""
from pathlib import Path
import subprocess
r=Path('/opt/fusion-management-migration')
assert (r/'.task-owner').read_text()=='fusion-management-migration-20261004'
js=r'''
import {createRequire} from 'node:module';
const require=createRequire('/opt/fusionbikes/herramientas/package.json');
const Database=require('better-sqlite3');
const db=new Database('/opt/fusionbikes/herramientas/data/fusion.sqlite',{readonly:true,fileMustExist:true});
const tables=['gestion_pedido_clientes','gestion_pedidos','gestion_pedido_items','pedidos_cache','ventas_historial','ordenes_ml_wc_pedidos'];
const out=[];
for(const table of tables){
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))continue;
 out.push({table,count:db.prepare('SELECT COUNT(*) n FROM '+table).get().n,columns:db.prepare('PRAGMA table_info('+table+')').all().map(x=>x.name)});
}
console.log(JSON.stringify({tables:out}));
console.log(JSON.stringify({order_coverage:db.prepare('SELECT fuente,COUNT(*) n,MIN(creado_fuente_en) earliest,MAX(creado_fuente_en) latest FROM gestion_pedidos GROUP BY fuente').all(),
 contacts:db.prepare("SELECT COUNT(*) total,SUM(COALESCE(email,'')<>'') with_email,SUM(COALESCE(documento,'')<>'') with_document,SUM(COALESCE(telefono,'')<>'') with_phone FROM gestion_pedido_clientes").get()}));
db.close();
'''
p=subprocess.run(['node','--input-type=module','-e',js],check=True,capture_output=True,text=True,timeout=20)
print(p.stdout)
php=r'''
require '/var/www/html/wp-load.php';
$users=(int)$wpdb->get_var("SELECT COUNT(*) FROM {$wpdb->users}");
$customers=(int)$wpdb->get_var($wpdb->prepare("SELECT COUNT(*) FROM {$wpdb->usermeta} WHERE meta_key=%s AND meta_value LIKE %s",$wpdb->prefix.'capabilities','%"customer"%'));
$hpos=$wpdb->get_var($wpdb->prepare('SHOW TABLES LIKE %s',$wpdb->esc_like($wpdb->prefix.'wc_orders')));
$orders=$hpos?(int)$wpdb->get_var('SELECT COUNT(*) FROM '.$wpdb->prefix.'wc_orders'):(int)$wpdb->get_var("SELECT COUNT(*) FROM {$wpdb->posts} WHERE post_type='shop_order'");
echo json_encode(['private_runtime'=>['users'=>$users,'customer_accounts'=>$customers,'orders'=>$orders]]);
'''
p=subprocess.run(['docker','exec','fusion-management-migration-php-1','php','-r',php],capture_output=True,text=True,check=True,timeout=20)
print(p.stdout)
