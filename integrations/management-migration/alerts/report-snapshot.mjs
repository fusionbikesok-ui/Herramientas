import {createStockReport} from '../stock-report.mjs';
import {createCommercial} from '../commercial.mjs';
import {DatabaseSync} from 'node:sqlite';
const root='/opt/fusion-management-migration/directory-cache';
const readSales=createCommercial({metricsPath:root+'/metrics.sqlite',mlPath:root+'/ml-sales.json',statusPath:root+'/metrics-status.json'});
const readCatalog=async()=>{
 const db=new DatabaseSync('/opt/fusionbikes/herramientas/data/fusion.sqlite',{readOnly:true});
 try{return db.prepare('SELECT id_woo,nombre,sku,tipo,id_padre,stock,actualizado_en,categorias_json,img,atributos_json,marca,no_contable FROM catalogo_cache').all();}finally{db.close();}
};
const data=(await createStockReport({readSales,readCatalog})(new URLSearchParams('mode=stock&days=90&cover=15'),'')).data;
// No contact/order details or credentials enter the notification process.
const keys=['id','name','sku','variant','stock','units','coverage_days','alert','issue','stock_at','stock_stale'];
console.log(JSON.stringify({schema:1,period:data.period,snapshot:data.snapshot,quality:data.quality,rows:data.rows.map(r=>Object.fromEntries(keys.map(k=>[k,r[k]])))}));
