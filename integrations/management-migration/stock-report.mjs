import crypto from 'node:crypto';
import core from './assets/sales-core.js';
import {catalogImage} from './local-catalog.mjs';

export class StockReportError extends Error{constructor(message,status=400){super(message);this.status=status;}}
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const list=v=>{try{const x=typeof v==='string'?JSON.parse(v):v;return Array.isArray(x)?x:[];}catch{return [];}};
const todayAt=now=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Argentina/Buenos_Aires'}).format(new Date(now));
function covered(from,to,windows){let cursor=from;for(const w of [...windows].sort((a,b)=>String(a.from).localeCompare(String(b.from)))){if(w.from>cursor||w.to<cursor)continue;if(w.to>=to)return true;cursor=new Date(Date.parse(w.to+'T12:00:00Z')+86400000).toISOString().slice(0,10);}return false;}

export function stockRows(catalog,sales,{days,cover,now=Date.now()}){
 const all=new Map(catalog.map(p=>[p.id_woo,p])),byId=new Map(),bySku=new Map(),ambiguous=new Set();
 for(const p of catalog){if(!['simple','variation'].includes(p.tipo)||p.no_contable)continue;byId.set(p.id_woo,p);const sku=core.norm(p.sku);if(!sku)continue;if(bySku.has(sku)){ambiguous.add(sku);bySku.delete(sku);}else if(!ambiguous.has(sku))bySku.set(sku,p);}
 const totals=new Map(),quality={unmatched_lines:0,unmatched_units:0,excluded_lines:0,review_lines:0,shared_stock:0,duplicate_skus:0,stale_stock:0};
 for(const sale of sales){
  if(!['web','ml'].includes(sale.channel)||!['valid','partial'].includes(sale.saleState)||!finite(sale.quantity)){quality.excluded_lines++;if(sale.saleState==='review'||sale.channel==='ml_pending')quality.review_lines++;continue;}
  let p=byId.get(sale.catalog_id);
  if(!p){const match=bySku.get(core.norm(sale.sku));if(match&&(!sale.product||[match.id_woo,match.id_padre].includes(sale.product)))p=match;}
  if(!p){if(sale.quantity>0){quality.unmatched_lines++;quality.unmatched_units+=sale.quantity;}continue;}
  const t=totals.get(p.id_woo)||{web:0,ml:0,last_sale:null,orders:new Set()};t[sale.channel]+=sale.quantity;t.orders.add(sale.order);if(sale.quantity>0&&(!t.last_sale||sale.date>t.last_sale))t.last_sale=sale.date;totals.set(p.id_woo,t);
 }
 const rows=[];
 for(const p of byId.values()){
  const parent=all.get(p.id_padre),t=totals.get(p.id_woo)||{web:0,ml:0,last_sale:null,orders:new Set()},sold=Math.max(0,t.web+t.ml),rate=sold/days;
  let issue=!finite(p.stock)?'unknown':parent&&finite(parent.stock)&&parent.stock>0?'shared':ambiguous.has(core.norm(p.sku))?'duplicate':'';
  const stock=finite(p.stock)?p.stock:null,coverage=!issue&&rate>0?Math.max(0,stock)/rate:null;
  const alert=issue?'review':stock<0?'negative':sold<=0?'no_sales':stock<=0?'missing':coverage<cover?'critical':'healthy';
  const attrs=list(p.atributos_json).filter(a=>a?.name&&a?.option).map(a=>`${a.name}: ${a.option}`).join(' · ');
  const categories=list(p.categorias_json).map(c=>typeof c==='string'?c:c?.name).filter(Boolean);
  const stamp=Date.parse(p.actualizado_en),stale=!Number.isFinite(stamp)||now-stamp>24*3600000;
  if(issue==='shared')quality.shared_stock++;if(issue==='duplicate')quality.duplicate_skus++;if(stale)quality.stale_stock++;
  rows.push({id:p.id_woo,parent_id:p.id_padre||null,name:p.nombre,model:parent?.nombre||p.nombre,brand:core.brand(p.marca||parent?.marca),sku:p.sku||'',variant:p.tipo==='variation'?attrs:'',categories,
   image:catalogImage(p.img)||catalogImage(parent?.img),url:'https://fusionbikes.com.ar/?p='+(p.id_padre||p.id_woo),stock,issue,alert,units:sold,web_units:t.web,ml_units:t.ml,daily:rate,coverage_days:coverage,last_sale:t.last_sale,orders:t.orders.size,stock_at:p.actualizado_en||null,stock_stale:stale});
 }
 return{rows,quality};
}

export function createStockReport({readSales,readCatalog,now=Date.now}={}){
 let cache=null,loading=null;
 async function catalog(cookie){if(cache&&now()-cache.at<30000)return cache.rows;if(!loading)loading=Promise.resolve().then(()=>readCatalog(cookie)).then(rows=>{if(!Array.isArray(rows)||!rows.length)throw new StockReportError('El catálogo local no está disponible. No se interpretó como stock cero.',503);cache={rows,at:now()};return rows;}).finally(()=>loading=null);return loading;}
 return async(params,cookie)=>{
  for(const[k,v]of params)if(!['mode','days','cover'].includes(k)||params.getAll(k).length!==1||v.length>20)throw new StockReportError('Filtro inválido.');
  const days=Number(params.get('days')||90),cover=Number(params.get('cover')||15);if(![30,60,90,180].includes(days)||!Number.isInteger(cover)||cover<1||cover>90)throw new StockReportError('Elegí un período válido y una cobertura entre 1 y 90 días.');
  const to=todayAt(now()),[from]=core.range(String(days),to),query=new URLSearchParams({mode:'commercial',kind:'batch',from,to,page:'1'}),sales=[];
  let snapshot,totalPages=1;
  for(let page=1;page<=totalPages;page++){query.set('page',String(page));const result=readSales(query).data;if(!snapshot){snapshot=result.snapshot;totalPages=result.pages;query.set('generation',snapshot.generation);if(totalPages>150)throw new StockReportError('El período supera el tamaño previsto. Probá un rango más corto.',503);}sales.push(...result.rows);}
  const current=await catalog(cookie),result=stockRows(current,sales,{days,cover,now:now()});
  const stamps=current.map(p=>p.actualizado_en).filter(Boolean).sort(),ordersDate=snapshot.orders_at?todayAt(Date.parse(snapshot.orders_at)):null;
  return{success:true,data:{...result,period:{from,to,days,cover},snapshot:{...snapshot,stock_oldest_at:stamps[0]||null,stock_latest_at:stamps.at(-1)||null,generated_at:new Date(now()).toISOString(),
   stock_generation:crypto.createHash('sha256').update(JSON.stringify(current.map(p=>[p.id_woo,p.stock,p.actualizado_en,p.no_contable]))).digest('hex').slice(0,24),
   web_complete:!!snapshot.web_from&&snapshot.web_from<=from&&ordersDate>=to,ml_complete:covered(from,to,snapshot.windows||[])}}};
 };
}
