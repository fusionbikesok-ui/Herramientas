from pathlib import Path
import subprocess
r=Path('/opt/fusion-management-migration')
assert (r/'.task-owner').read_text()=='fusion-management-migration-20261004'
js=r'''
import {createRequire} from 'node:module';
import https from 'node:https';
const require=createRequire('/opt/fusionbikes/herramientas/package.json');
const Database=require('better-sqlite3');
const db=new Database('/opt/fusionbikes/herramientas/data/fusion.sqlite',{readonly:true,fileMustExist:true});
const contacts=db.prepare(`SELECT COUNT(*) total,
 SUM(EXISTS(SELECT 1 FROM gestion_pedidos p WHERE p.cliente_id=c.id)) linked,
 SUM(NOT EXISTS(SELECT 1 FROM gestion_pedidos p WHERE p.cliente_id=c.id)) unlinked,
 COUNT(DISTINCT CASE WHEN COALESCE(email,'')<>'' THEN lower(trim(email)) END) distinct_emails,
 SUM(COALESCE(email,'')='' AND COALESCE(telefono,'')='') without_email_and_phone
 FROM gestion_pedido_clientes c`).get();
const duplicatedMirrors=db.prepare(`SELECT COUNT(*) n FROM gestion_pedidos p WHERE p.espejo_ml=1 AND EXISTS (SELECT 1 FROM gestion_pedidos m WHERE m.fuente='mercadolibre' AND m.external_id=p.ml_order_id)`).get().n;
console.log(JSON.stringify({contacts,duplicated_woo_ml_mirrors:duplicatedMirrors}));
db.close();
process.loadEnvFile('/opt/fusionbikes/herramientas/.env');
const origin=new URL(process.env.WOO_URL);
if(origin.protocol!=='https:'||!['fusionbikes.com.ar','www.fusionbikes.com.ar'].includes(origin.hostname)||origin.username||origin.password||origin.port)throw new Error('origin');
async function read(path){return await new Promise((resolve,reject)=>{
 const req=https.get(new URL('/wp-json/wc/v3'+path,origin),{headers:{Accept:'application/json',Authorization:'Basic '+Buffer.from(process.env.WOO_CK+':'+process.env.WOO_CS).toString('base64')},timeout:20000},res=>{
 let size=0,chunks=[];res.on('data',b=>{size+=b.length;if(size>100000)req.destroy(new Error('limit'));else chunks.push(b);});res.on('end',()=>{
  try{const data=JSON.parse(Buffer.concat(chunks));resolve({status:res.statusCode,total:Number(res.headers['x-wp-total'])||null,rows:res.statusCode===200?data:null});}catch{reject(new Error('invalid response'));}
 });});req.on('timeout',()=>req.destroy(new Error('timeout')));req.on('error',()=>reject(new Error('connection')));
});}
console.log(JSON.stringify({source_customers:await read('/customers?per_page=1&role=customer&_fields=id,date_created_gmt,date_modified_gmt')}));
console.log(JSON.stringify({source_orders:await read('/orders?per_page=1&status=any&orderby=date&order=asc&_fields=id,date_created_gmt')}));
'''
p=subprocess.run(['node','--input-type=module','-e',js],check=True,capture_output=True,text=True,timeout=50)
print(p.stdout)
