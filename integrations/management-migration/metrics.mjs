import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
export class MetricsError extends Error { constructor(message,status=503){super(message);this.status=status;} }
export function metricsRoute(local){const u=new URL(local,'http://private.invalid');return u.pathname==='/ventas/api'?u.searchParams:null;}
const invalid=message=>{throw new MetricsError(message,400);};
export function csvReport(rows,params){
 const brands=params.getAll('filter_brands[]'),search=(params.get('search')||'').toLocaleLowerCase(),currency=params.get('currency')||'';
 const filtered=rows.filter(r=>r.currency===currency&&(!brands.length||brands.includes(r.brand))&&(!params.get('filter_kind')||r.kind===params.get('filter_kind'))&&['category','country','state','city'].every(k=>!params.get(k)||(k==='category'?r.categories.includes(params.get(k)):r[k]===params.get(k)))&&(!search||(r.model+' '+r.sku).toLocaleLowerCase().includes(search)));
 const safe=value=>{let s=String(value??'');if(/^[\s]*[=+@-]/.test(s)&&typeof value!=='number')s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
 const keys=['date','brand','model','sku','variant','quantity','amount','currency','country','state','city'];
 return '\uFEFF'+[['Fecha','Marca','Modelo','SKU','Variante','Unidades netas','Importe sin impuestos','Moneda','País','Provincia','Ciudad'],...filtered.map(r=>keys.map(k=>r[k]))].map(r=>r.map(safe).join(';')).join('\r\n');
}
export function lineRows(order,products,options,query){
 return order.items.map(item=>{
  const p=products.get(item.product_id),v=products.get(item.variation_id||item.product_id);
  const terms=tax=>p?.terms?.[tax]||[];
  let brand=[];for(const tax of query.brand?[query.brand]:['pa_marca','product_brand','pwb-brand','yith_product_brand']){brand=terms(tax);if(brand.length)break;}
  const models=terms(query.model),exists=p?.exists;
  return {kind:!exists?'Sin clasificar':p.category_ids.some(id=>query.bikes.includes(id))?'Bicicletas':'Resto de productos',brand:brand.length?brand.join(' / '):'Sin marca',
   model:models.length?models.join(' / '):exists?p.name:item.name,modelKey:models.length?'m:'+brand.join('|')+':'+models.join('|'):'p:'+(item.product_id||item.id),
   categories:terms('product_cat'),sku:v?.exists?v.sku:'',variant:item.variation_id&&v?.exists?v.variant:'',product:item.product_id,
   order:order.id,date:order.date,currency:order.currency,country:order.country,state:options.states?.[order.country]?.[order.state]||order.state,city:order.city,quantity:item.quantity,amount:item.amount};
 });
}
export function createMetrics({path=fileURLToPath(new URL('./directory-cache/metrics.sqlite',import.meta.url)),statusPath=fileURLToPath(new URL('./directory-cache/metrics-status.json',import.meta.url)),batchSize=500}={}){
 return params=>{
  const allowed=['kind','from','to','statuses[]','bike_categories[]','brand','model','page','generation','filter_kind','filter_brands[]','currency','category','country','state','city','search'];
  for(const key of params.keys())if(!allowed.includes(key)||(!key.endsWith('[]')&&params.getAll(key).length!==1))invalid('Parámetro inválido.');
  if(!['options','batch','export'].includes(params.get('kind')||''))invalid('Consulta inválida.');
  for(const [key,value] of params)if(value.length>200||/[\x00-\x1f]/.test(value))invalid('Filtro inválido.');
  let db;try{db=new DatabaseSync(path,{readOnly:true});}catch{throw new MetricsError('La primera copia de métricas aún no está disponible. Volvé a intentar en unos minutos.');}
  try{
   const s=Object.fromEntries(db.prepare('SELECT key,value FROM state').all().map(r=>[r.key,JSON.parse(r.value)])),o=s.options;
   let sync;try{sync=JSON.parse(readFileSync(statusPath,'utf8'));}catch{sync={state:'unknown'};}
   const snapshot={generation:s.generation,orders_at:s.orders_at,completed_at:s.completed_at,product_dimensions_at:s.product_dimensions_at,orders:s.orders,lines:s.lines,refund_orders:s.refund_orders,stale:Date.now()-Date.parse(s.orders_at)>60*60*1000,sync_state:sync.state};
   if(params.get('kind')==='options')return {success:true,data:{options:o,snapshot}};
   const from=params.get('from')||'',to=params.get('to')||'';
   for(const date of [from,to])if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date)invalid('Fecha inválida.');
   if(from>to||(+to.slice(0,4)-+from.slice(0,4))*12+(+to.slice(5,7)-+from.slice(5,7))>=120)invalid('Elegí un período de hasta 10 años.');
   const statuses=[...new Set(params.getAll('statuses[]'))],bikes=[...new Set(params.getAll('bike_categories[]'))];
   if(!statuses.length||statuses.some(key=>!o.statuses.some(s=>s.key===key)))invalid('Seleccioná estados válidos.');
   if(!bikes.length||bikes.some(id=>!/^\d+$/.test(id)||!o.categories.some(c=>String(c.id)===id)))invalid('Seleccioná categorías válidas.');
   const brand=params.get('brand')||'',model=params.get('model')||'';
   if([brand,model].some(tax=>tax&&!o.taxonomies.some(t=>t.name===tax)))invalid('Atributo inválido.');
   const page=params.get('page')||'1';if(!/^[1-9]\d{0,5}$/.test(page))invalid('Página inválida.');
   const generation=params.get('generation');
   if((generation&&generation!==s.generation)||(+page>1&&!generation))throw new MetricsError('La copia sincronizada cambió durante la carga. Actualizá el reporte para consultar una sola versión.',409);
   const where=`date BETWEEN ? AND ? AND status IN (${statuses.map(()=>'?').join(',')})`,args=[from,to,...statuses.map(s=>s.replace(/^wc-/,''))];
   const total=db.prepare(`SELECT COUNT(*) n FROM facts WHERE ${where}`).get(...args).n;
   const exporting=params.get('kind')==='export';if(exporting&&!generation)invalid('Actualizá el reporte antes de exportar.');
   if(exporting&&total>50000)invalid('Acotá el período para exportar hasta 50.000 pedidos.');
   const orders=db.prepare(`SELECT data FROM facts WHERE ${where} ORDER BY id LIMIT ? OFFSET ?`).all(...args,exporting?50000:batchSize,exporting?0:(+page-1)*batchSize).map(r=>JSON.parse(r.data));
   const products=new Map(),getProduct=db.prepare('SELECT data FROM products WHERE id=?');
   for(const order of orders)for(const item of order.items)for(const id of [item.product_id,item.variation_id])if(id&&!products.has(id)){const row=getProduct.get(id);if(!row)throw new MetricsError('La clasificación del catálogo está incompleta. Esperá la próxima sincronización.');products.set(id,JSON.parse(row.data));}
   const rows=orders.flatMap(order=>lineRows(order,products,o,{brand,model,bikes:bikes.map(Number)}));
   if(exporting)return {csv:csvReport(rows,params)};
   return {success:true,data:{rows,pages:Math.ceil(total/batchSize),total,unassigned:orders.filter(o=>o.unassigned).length,snapshot}};
  }finally{db.close();}
 };
}
