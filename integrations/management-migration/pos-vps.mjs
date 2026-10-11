import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
export class PosError extends Error{constructor(message,status=400,code='pos_error'){super(message);Object.assign(this,{status,code});}}
const fail=(m,s=400,c)=>{throw new PosError(m,s,c);};
const opPattern=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const string=v=>String(v??'').slice(0,1000);
function cleanItems(items){if(!Array.isArray(items)||items.length>100)fail('Máximo 100 productos.');const seen=new Set();return items.map(x=>{if(!Number.isSafeInteger(x.id)||x.id<1||!Number.isInteger(x.qty)||x.qty<1||x.qty>999||seen.has(x.id))fail('Producto o cantidad inválida.');seen.add(x.id);return {id:x.id,qty:x.qty,serials:(Array.isArray(x.serials)?x.serials:[]).slice(0,x.qty).map(v=>string(v).slice(0,120))};});}
function customer(c={}){const billing=Object.fromEntries(Object.entries(c.billing||{}).filter(([k,v])=>/^billing_[a-z_]+$/.test(k)&&['string','number'].includes(typeof v)).slice(0,40).map(([k,v])=>[k,string(v)]));return {id:Number.isSafeInteger(c.id)&&c.id>0?c.id:0,name:string(c.name),document:string(c.document),email:string(c.email),phone:string(c.phone),consumerFinal:!!c.consumerFinal,billing};}
export function cleanSale(s={}){return {items:cleanItems(s.items||[]),customer:customer(s.customer),plan:/^(cash|promo3|plan(?:3|6|9|12|18|24))$/.test(s.plan||'')?s.plan:'cash',gateway:'store-checkout',note:string(s.note),quote_id:0,operation:opPattern.test(s.operation||'')?s.operation:'',phase:['payment','registered'].includes(s.phase)?s.phase:'editing',payment_url:'',status_url:'vps'};}
export function createStoreClient(key,origin='https://fusionbikes.com.ar',fetcher=fetch){
 return async(input,user)=>{
  if(!key||key.length<64)fail('El puente seguro no está configurado.',503);
  const actor=crypto.createHmac('sha256',key).update('operator:'+user).digest('hex');
  const body=JSON.stringify({...input,actor}),time=String(Math.floor(Date.now()/1000));
  const signature=crypto.createHmac('sha256',key).update(time+'\n'+crypto.createHash('sha256').update(body).digest('hex')).digest('hex');
  let r,data;try{r=await fetcher(origin+'/wp-json/fusion-vps-pos/v1/command',{method:'POST',redirect:'error',headers:{'content-type':'application/json','x-fusion-pos-time':time,'x-fusion-pos-signature':signature},body,signal:AbortSignal.timeout(20000)});const raw=await r.text();if(raw.length>65536)throw Error();data=JSON.parse(raw);}catch{fail('La tienda no respondió. Conservá esta preparación y actualizá el estado antes de reintentar.',503,'bridge_unavailable');}
  if(!r.ok)fail(data.message||'No se pudo consultar la tienda.',r.status,data.code);
  return data;
 };
}
export function createPos({statePath=path.join(process.env.STATE_DIRECTORY||'/var/lib/fusion-management-validation','pos.sqlite'),store=createStoreClient(process.env.FUSION_POS_VPS_BRIDGE_KEY),catalog}){
 const quotes=new Map();
 function db(){const d=new DatabaseSync(statePath);d.exec('PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS drafts(user TEXT PRIMARY KEY,version INTEGER NOT NULL,sale TEXT NOT NULL);CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,user TEXT NOT NULL,payload TEXT NOT NULL,response TEXT,released INTEGER DEFAULT 0);');return d;}
 function draft(d,user){const row=d.prepare('SELECT * FROM drafts WHERE user=?').get(user);return row?{version:row.version,sale:JSON.parse(row.sale)}:{version:0,sale:cleanSale()};}
 function owned(d,op,user){const r=d.prepare('SELECT * FROM operations WHERE id=?').get(op);if(!r||r.user!==user)fail('Preparación no disponible para este operador.',404,'operation_missing');return r;}
 async function status(d,op,user){const r=owned(d,op,user);if(r.released)return {order_id:0,released:true,status:'Preparación cerrada'};try{return await store({action:'status',operation:op},user);}catch(e){if(e.code==='operation_missing'&&!r.response)return {order_id:0,status:'Pendiente de abrir el checkout'};throw e;}}
 async function release(d,op,user){const row=owned(d,op,user);let result;try{result=await store({action:'release',operation:op},user);}catch(e){if(e.code!=='operation_missing'||row.response)throw e;result={released:true};}d.prepare('UPDATE operations SET released=1 WHERE id=? AND user=?').run(op,user);return result;}
 return async(action,input,user,cookie='')=>{
  const d=db();try{
   if(action==='pricing'){
    const items=cleanItems(input.items).map(({id,qty})=>({id,qty}));if(!items.length)fail('Agregá un producto.');
    const key=JSON.stringify(items.sort((a,b)=>a.id-b.id)),cached=quotes.get(key);
    if(cached&&cached.expires>Date.now())return cached.data;
    const data=await store({action:'pricing',items},user);
    if(!Array.isArray(data.plans)||!data.plans.length||data.plans.some(p=>!Number.isFinite(p.total)||p.total<=0))fail('No se pudieron verificar los planes.',502);
    if(quotes.size>100)quotes.clear();quotes.set(key,{expires:Date.now()+60000,data});return data;
   }
   if(action==='order-read'){
    if(!Number.isSafeInteger(input.order_id)||input.order_id<1)fail('Número de pedido inválido.');
    return await store({action:'order-read',order_id:input.order_id},user);
   }
   if(['manual-receipt','fulfillment'].includes(action)){
    if(!opPattern.test(input.operation||''))fail('Operación inválida.');
    // Source validates the signed actor and the original store operator, including recovered orders.
    if(action==='manual-receipt'&&input.confirmed!==true)fail('Confirmá que recibiste el dinero.');
    if(action==='fulfillment'&&!['pickup','shipping'].includes(input.mode))fail('Elegí retiro o envío.');
    return await store({action,operation:input.operation,...(action==='manual-receipt'?{confirmed:true}:{mode:input.mode})},user);
   }
   if(action==='draft-read'){
    const result=draft(d,user);result.products=[];
    for(const item of result.sale.items){try{result.products.push({...await catalog({module:'pos',type:'product',id:item.id,query:new URLSearchParams()},cookie),qty:item.qty,serials:item.serials});}catch{result.products.push({...item,name:'Producto #'+item.id+' no disponible',price:0,stock:0,stock_status:'outofstock',selectable:false});}}
    if(result.sale.operation){const row=d.prepare('SELECT response FROM operations WHERE id=? AND user=?').get(result.sale.operation,user);if(row?.response)result.sale.payment_url=JSON.parse(row.response).payment_url||'';}
    return result;
   }
   if(action==='draft-write'||action==='reset'){
    const old=draft(d,user);if(input.version!==old.version)fail('La venta cambió en otra pestaña. Recargá el tablero.',409,'draft_conflict');
    let sale=action==='reset'?cleanSale():cleanSale(input.sale);
    if(old.sale.operation&&old.sale.operation!==sale.operation){const row=owned(d,old.sale.operation,user);if(!row.released){const s=await status(d,old.sale.operation,user);if(!s.order_id&&!s.released)await release(d,old.sale.operation,user);}}
    if(sale.operation&&!d.prepare('SELECT 1 FROM operations WHERE id=? AND user=?').get(sale.operation,user)){
     // The browser saves its UUID before /prepare; only preserve the previous known operation here.
     sale.operation=old.sale.operation||'';sale.phase=sale.operation?old.sale.phase:'editing';
    }
    const encoded=JSON.stringify(sale);let changed;
    if(old.version===0)changed=d.prepare('INSERT OR IGNORE INTO drafts(user,version,sale) VALUES(?,1,?)').run(user,encoded).changes;
    else changed=d.prepare('UPDATE drafts SET version=version+1,sale=? WHERE user=? AND version=?').run(encoded,user,old.version).changes;
    if(!changed)fail('La venta cambió en otra pestaña. Recargá el tablero.',409,'draft_conflict');return {version:old.version+1};
   }
   if(action==='prepare'){
    if(!opPattern.test(input.operation||''))fail('Identificador de venta inválido.');
    const items=cleanItems(input.items);if(!items.length)fail('Agregá al menos un producto.');
    if(input.quote_id)fail('La conversión de presupuestos históricos se realiza todavía en la tienda.');
    const c=customer({id:input.customer_id,name:input.customer_name,document:input.customer_document,email:input.customer_email,phone:input.customer_phone,billing:input.billing,consumerFinal:input.consumer_final});
    const price_key=input.price_key||'cash';if(!/^(cash|promo3|plan(?:3|6|9|12|18|24))$/.test(price_key))fail('Plan inválido.');if(input.expected_total!==undefined&&(!Number.isFinite(input.expected_total)||input.expected_total<=0))fail('Importe inválido.');
    const payload={action:'prepare',price_key,...(input.expected_total!==undefined?{expected_total:input.expected_total}:{}),operation:input.operation,items,customer_id:c.id,customer_name:c.name,customer_document:c.document,customer_email:c.email,customer_phone:c.phone,billing:c.billing,consumer_final:c.consumerFinal,note:string(input.note)};
    const saved=draft(d,user);if(saved.sale.operation&&saved.sale.operation!==input.operation)fail('Hay otra preparación abierta. Actualizá el tablero.',409,'prepare_busy');
    const encoded=JSON.stringify(payload);d.prepare('INSERT OR IGNORE INTO operations(id,user,payload) VALUES(?,?,?)').run(input.operation,user,encoded);const row=owned(d,input.operation,user);
    if(row.payload!==encoded||row.released)fail('La preparación cambió o está cerrada. Volvé a editar.',409,'operation_conflict');
    if(saved.version){saved.sale.operation=input.operation;saved.sale.phase='payment';d.prepare('UPDATE drafts SET sale=? WHERE user=? AND version=?').run(JSON.stringify(saved.sale),user,saved.version);}
    if(row.response)return JSON.parse(row.response);
    const response=await store(payload,user);const url=new URL(response.payment_url);if(url.origin!=='https://fusionbikes.com.ar'||!/^\/[?]fbpos_vps_open=[a-f0-9]{48}$/.test(url.pathname+url.search))fail('La tienda devolvió un enlace inesperado.',502);
    d.prepare('UPDATE operations SET response=? WHERE id=? AND user=?').run(JSON.stringify(response),input.operation,user);return response;
   }
   if(action==='status')return await status(d,input.operation,user);
   if(action==='release')return await release(d,input.operation,user);
   if(action==='customer'){
    const billing=customer({billing:input.billing}).billing;const name=[billing.billing_first_name,billing.billing_last_name].filter(Boolean).join(' ')||billing.billing_company;
    if(!name)fail('Completá el nombre del cliente.');
    return {success:true,customer:customer({id:Number(input.id)||0,name,email:billing.billing_email,phone:billing.billing_phone,document:billing.billing_dni_cuit||billing.billing_dni_afip,billing})};
   }
   fail('Acción del POS no disponible.',404);
  }finally{d.close();}
 };
}
