from pathlib import Path
import subprocess
r=Path('/opt/fusion-management-migration')
assert (r/'.task-owner').read_text()=='fusion-management-migration-20261004'
code=r"""
import {createRequire} from 'node:module';
import https from 'node:https';
const require=createRequire('/opt/fusionbikes/herramientas/package.json');
const Database=require('better-sqlite3');
const db=new Database('/opt/fusionbikes/herramientas/data/fusion.sqlite',{readonly:true,fileMustExist:true});
console.log(JSON.stringify({catalog:db.prepare('SELECT id_woo,nombre,sku,tipo,id_padre,stock,precio,regular_price,img,actualizado_en FROM catalogo_cache WHERE id_woo IN (70393,70394,1045)').all(),
 tables:db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%venta%' OR name LIKE '%order%' OR name LIKE '%ml%' OR name LIKE '%imagen%')").all().map(r=>r.name)}));
for(const name of ['ventas','ml_precios_cache','ml_precio_auditoria']){
console.log(JSON.stringify({table:name,columns:db.prepare('PRAGMA table_info('+name+')').all().map(r=>r.name)}));}
db.close();
process.loadEnvFile('/opt/fusionbikes/herramientas/.env');
const origin=new URL(process.env.WOO_URL);
if(origin.protocol!=='https:'||!['fusionbikes.com.ar','www.fusionbikes.com.ar'].includes(origin.hostname)||origin.username||origin.password||origin.port)throw new Error('origin');
const result=await new Promise((resolve,reject)=>{
 const req=https.get(new URL('/wp-json/wc/v3/fusion-herramientas/commercial-products?ids=70394,1045',origin),{headers:{Accept:'application/json',Authorization:'Basic '+Buffer.from(process.env.WOO_CK+':'+process.env.WOO_CS).toString('base64')},timeout:20000},res=>{
 let bytes=0,chunks=[];res.on('data',b=>{bytes+=b.length;if(bytes>1000000)req.destroy(new Error('limit'));else chunks.push(b);});
 res.on('end',()=>{try{resolve({status:res.statusCode,data:JSON.parse(Buffer.concat(chunks))});}catch{reject(new Error('json'));}});
 });req.on('timeout',()=>req.destroy(new Error('timeout')));req.on('error',()=>reject(new Error('connection')));
});
console.log(JSON.stringify({commercial_read_only:result}));
"""
p=subprocess.run(['node','--input-type=module','-e',code],check=True,capture_output=True,text=True,timeout=35)
print(p.stdout)
