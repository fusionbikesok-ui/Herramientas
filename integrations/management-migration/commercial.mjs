import {DatabaseSync} from 'node:sqlite';
import {readFileSync,statSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join,dirname} from 'node:path';
import crypto from 'node:crypto';
import core from './assets/sales-core.js';
import {combineMlSources} from './ml-report.mjs';

export class CommercialError extends Error{constructor(message,status=400){super(message);this.status=status;}}
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const stamp=p=>{try{const s=statSync(p);return `${s.ino}:${s.mtimeMs}:${s.size}`;}catch{return 'missing';}};
export function bikeCategoryIds(categories){const ids=new Set(categories.filter(c=>c.slug==='bicicletas-por-marca').map(c=>c.id));let changed=true;while(changed){changed=false;for(const c of categories)if(ids.has(c.parent)&&!ids.has(c.id)){ids.add(c.id);changed=true;}}return [...ids];}
function status(o,defaults){if(o.ml_mirror)return 'review';if(['cancelled','failed','trash'].includes(o.status))return 'cancelled';if(o.status==='refunded')return 'refunded';if(o.unassigned)return 'review';if(o.has_refund)return 'partial';return defaults.has(o.status)?'valid':'pending';}
function dimensions(item,products,skuIndex,bikes){
 let p=products.get(item.product_id),v=products.get(item.variation_id||item.product_id);
 if(!p?.exists&&item.sku&&skuIndex.has(core.norm(item.sku))){v=skuIndex.get(core.norm(item.sku));p=products.get(v.parent_id)||v;}
 if(p?.parent_id&&products.get(p.parent_id)?.exists)p=products.get(p.parent_id);
 const terms=p?.terms||{},rawBrand=['pa_marca','product_brand','pwb-brand','yith_product_brand'].map(k=>terms[k]).find(a=>a?.length);
 const categories=(terms.product_cat||[]).map(core.label);
 const brand=core.brand(rawBrand?.join(' / ')||item.brand);
 return{brand,model:p?.exists?p.name:item.name||'Producto sin nombre',originalName:item.name||'',modelKey:p?.exists?'p:'+p.id:item.sku?'sku:'+core.norm(item.sku):'ml:'+item.listing+':'+(item.variation||''),product:p?.id||null,
  kind:p?.exists?(p.category_ids?.some(id=>bikes.includes(id))?'Bicicletas':'Resto de productos'):item.kind||'Sin clasificar',categories:categories.length?categories:(item.category?[core.label(item.category)]:[]),
  catalog_id:v?.exists?v.id:null,sku:item.sku||v?.sku||'',variant:item.variant||v?.variant||'',listing:item.listing||'',classification:p?.exists?'catalog':'pending'};
}
export function mergeSales(woo,ml,products,options,bikes){
 const skuIndex=new Map(),ambiguous=new Set();for(const p of products.values()){if(!p.exists||!p.sku)continue;const k=core.norm(p.sku);if(skuIndex.has(k)){ambiguous.add(k);skuIndex.delete(k);}else if(!ambiguous.has(k))skuIndex.set(k,p);}
 const defaults=new Set(options.statuses.filter(x=>x.default).map(x=>x.key.replace(/^wc-/,'')));if(!defaults.size)defaults.add('completed');
 const originals=new Map();for(const o of ml){const id=String(o.id);if(!id)continue;const old=originals.get(id);if(!old||String(o.updated_at||'')>String(old.updated_at||''))originals.set(id,o);}
 const represented=new Set();for(const o of originals.values()){represented.add(String(o.id));for(const id of o.native_ids||[])represented.add(String(id));}
 const mirrors=new Map();for(const o of woo)if(o.ml_mirror&&o.ml_order_id){const k=String(o.ml_order_id);if(!mirrors.has(k))mirrors.set(k,[]);mirrors.get(k).push(o);}
 const result=[],counts={mirrors_replaced:0,mirrors_pending:0,ambiguous_skus:ambiguous.size};
 for(const o of woo){
  if(o.ml_mirror&&o.ml_order_id&&represented.has(String(o.ml_order_id))){counts.mirrors_replaced++;continue;}
  if(o.ml_mirror&&o.ml_order_id&&mirrors.get(String(o.ml_order_id))[0]!==o)continue;
  const saleState=status(o,defaults),channel=o.ml_mirror?'ml_pending':'web';if(o.ml_mirror)counts.mirrors_pending++;
  for(const item of o.items){const d=dimensions(item,products,skuIndex,bikes);if(d.modelKey.startsWith('ml:'))d.modelKey='woo-line:'+o.id+':'+item.id;
   result.push({...d,order:'woo:'+o.id,externalOrder:String(o.ml_order_id||o.id),pack:'',channel,saleState,date:o.date,currency:o.currency,country:o.country,state:core.label(options.states?.[o.country]?.[o.state]||o.state)||'Sin provincia',city:core.label(o.city)||'Sin ciudad',
    quantity:['cancelled','refunded'].includes(saleState)?0:saleState==='review'?null:item.quantity,recordedQuantity:item.quantity,amount:o.ml_mirror||!finite(item.gross_amount)?null:['cancelled','refunded'].includes(saleState)?0:item.gross_amount,
    source:o.ml_mirror?'Espejo Woo; importe ML pendiente':'WooCommerce',rawStatus:o.status,refundsKnown:!o.unassigned});
  }
 }
 for(const o of originals.values()){
  const candidates=mirrors.get(String(o.id))||[],mirror=candidates[0];
  for(const item of o.items||[]){
   // Mirror dimensions are used only for one exact SKU match (never title or order position).
   const matches=(mirror?.items||[]).filter(x=>item.sku&&core.norm(x.sku)===core.norm(item.sku));
   const mapped=matches.length===1?{...matches[0],...item,product_id:matches[0].product_id,variation_id:matches[0].variation_id}:item;
   const d=dimensions(mapped,products,skuIndex,bikes),saleState=o.saleState||'review';
   result.push({...d,order:'ml:'+o.id,externalOrder:String(o.externalReference||o.id),referenceType:o.referenceType||'order',pack:String(o.pack||''),channel:'ml',saleState,date:o.date,currency:o.currency,
    country:o.country||mirror?.country||'Sin país',state:core.label(o.state||options.states?.[mirror?.country]?.[mirror?.state]||mirror?.state)||'Sin provincia',city:core.label(o.city||mirror?.city)||'Sin ciudad',
    quantity:['cancelled','refunded'].includes(saleState)?0:saleState==='review'?null:finite(item.quantity)?item.quantity:null,recordedQuantity:item.quantity,amount:['cancelled','refunded'].includes(saleState)?0:finite(item.amount)?item.amount:null,
    source:o.source||'Mercado Libre',rawStatus:o.status||'',refundsKnown:o.refundsKnown===true});
  }
 }
 // One label per exact case/accent-normalized value; no fuzzy joins between cities or products.
 for(const key of ['brand','state','city']){
  const pool=new Map(),identity=r=>(key==='brand'?'':r.country+'|'+(key==='city'?core.norm(r.state)+'|':''))+core.norm(r[key]);
  for(const r of result){const k=identity(r),value=r[key],old=pool.get(k);if(!old||(/[áéíóúñü]/i.test(value)&&!/[áéíóúñü]/i.test(old)))pool.set(k,value);}
  for(const r of result)r[key]=pool.get(identity(r));
 }
 return{rows:result,counts};
}
export function createCommercial({metricsPath=fileURLToPath(new URL('./directory-cache/metrics.sqlite',import.meta.url)),mlPath=fileURLToPath(new URL('./directory-cache/ml-sales.json',import.meta.url)),reportPath=join(dirname(mlPath),'ml-report.json'),statusPath=fileURLToPath(new URL('./directory-cache/metrics-status.json',import.meta.url))}={}){
 let cache;
 function snapshot(){
  const fingerprint=stamp(metricsPath)+'|'+stamp(mlPath)+'|'+stamp(reportPath);if(cache?.fingerprint===fingerprint)return cache;
  let db;try{db=new DatabaseSync(metricsPath,{readOnly:true});}catch{throw new CommercialError('La copia de ventas todavía no está disponible.',503);}
  try{db.exec('BEGIN');const s=Object.fromEntries(db.prepare('SELECT key,value FROM state').all().map(r=>[r.key,JSON.parse(r.value)]));
   const woo=db.prepare('SELECT data FROM facts ORDER BY id').all().map(r=>JSON.parse(r.data));const products=new Map(db.prepare('SELECT id,data FROM products').all().map(r=>[r.id,JSON.parse(r.data)]));
   let ml={orders:[],windows:[],state:'pending'};try{ml=JSON.parse(readFileSync(mlPath,'utf8'));if(!Array.isArray(ml.orders))throw Error();}catch(e){if(stamp(mlPath)!=='missing')throw new CommercialError('El histórico de Mercado Libre no se pudo leer. No se muestra un total parcial.',503);}
   let report=null;try{report=JSON.parse(readFileSync(reportPath,'utf8'));}catch{if(stamp(reportPath)!=='missing')throw new CommercialError('El Excel de Mercado Libre incorporado no se pudo leer. Revisá la fuente antes de sumar los canales.',503);}
   let combined;try{combined=combineMlSources(ml.orders,report);}catch{throw new CommercialError('Hay referencias de Mercado Libre superpuestas o inválidas. Revisá la conciliación.',503);}
   const options=s.options,bikes=bikeCategoryIds(options.categories);
   const merged=mergeSales(woo,combined.orders,products,options,bikes);
   const dates=merged.rows.filter(r=>r.channel==='web').map(r=>r.date).sort(),mlDates=combined.orders.map(o=>o.date).sort();
   cache={fingerprint,rows:merged.rows,options,snapshot:{generation:crypto.createHash('sha256').update(fingerprint+String(s.generation)).digest('hex').slice(0,32),orders_at:s.orders_at,product_dimensions_at:s.product_dimensions_at,orders:s.orders,
    ml_at:ml.updated_at||null,ml_state:ml.state||'pending',ml_error:ml.error||null,ml_orders:combined.orders.length,ml_report:combined.reportStats,ml_from:mlDates[0]||null,ml_to:mlDates.at(-1)||null,web_from:dates[0]||null,web_to:dates.at(-1)||null,windows:ml.windows||[],...merged.counts,amount_basis:'products_including_tax_after_known_refunds'}};return cache;
  }finally{db.close();}
 }
 return params=>{
  const allowed=['kind','mode','from','to','page','generation','channel','filter_kind','filter_brands[]','currency','category','category[]','country','state','city','search','modelKey','variant','quality','saleState'];
  for(const[k,v]of params)if(!allowed.includes(k)||v.length>300||/[\x00-\x1f]/.test(v)||(!k.endsWith('[]')&&params.getAll(k).length!==1))throw new CommercialError('Filtro inválido.');
  const kind=params.get('kind');if(!['options','batch','export'].includes(kind))throw new CommercialError('Consulta inválida.');
  const s=snapshot();let sync;try{sync=JSON.parse(readFileSync(statusPath,'utf8'));}catch{sync={state:'unknown'};}
  const meta={...s.snapshot,stale:Date.now()-Date.parse(s.snapshot.orders_at)>3600000,sync_state:sync.state};
  if(kind==='options')return{success:true,data:{options:{timezone:s.options.timezone},snapshot:meta}};
  const from=params.get('from'),to=params.get('to');try{core.months(from,to);}catch(e){throw new CommercialError(e.message);}
  const page=params.get('page')||'1';if(!/^[1-9]\d{0,5}$/.test(page))throw new CommercialError('Página inválida.');
  const generation=params.get('generation');if((generation&&generation!==meta.generation)||((+page>1||kind==='export')&&!generation))throw new CommercialError('Los datos cambiaron. Actualizá el reporte para consultar y exportar la misma versión.',409);
  let rows=s.rows.filter(r=>r.date>=from&&r.date<=to);
  if(kind==='export'){const f=Object.fromEntries(params);f.kind=params.get('filter_kind');f.brands=params.getAll('filter_brands[]');if(params.has('category[]'))f.category=params.getAll('category[]');rows=rows.filter(r=>core.matches(r,f));return{csv:core.csv(rows)};}
  const total=rows.length,size=750;return{success:true,data:{rows:rows.slice((+page-1)*size,+page*size),pages:Math.max(1,Math.ceil(total/size)),total,snapshot:meta}};
 };
}
