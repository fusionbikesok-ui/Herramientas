import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import path from 'node:path';import crypto from 'node:crypto';import http from 'node:http';
export class AndreaniError extends Error{constructor(message,status=400){super(message);this.status=status;}}
const fail=(text,status=400)=>{throw new AndreaniError(text,status);};
const validId=v=>/^[1-9]\d{0,14}$/.test(String(v));
const hashOrder=o=>crypto.createHash('sha256').update(JSON.stringify([o.modified_at,o.billing,o.shipping,o.shipping_document,o.items,o.andreani])).digest('hex');
function sessionCookie(cookie){return String(cookie).split(';').map(p=>p.trim()).find(p=>p.startsWith('connect.sid='))||'';}
export function csrfToken(secret,user,cookie,slot=Math.floor(Date.now()/900000)){return crypto.createHmac('sha256',secret).update('andreani|'+user+'|'+sessionCookie(cookie)+'|'+slot).digest('hex');}
export function csrfValid(token,secret,user,cookie){if(!/^[a-f0-9]{64}$/.test(token||''))return false;return [0,-1].some(delta=>crypto.timingSafeEqual(Buffer.from(token),Buffer.from(csrfToken(secret,user,cookie,Math.floor(Date.now()/900000)+delta))));}
export function createAndreaniWorker({secret,host,port=80}){
 return (payload,user)=>new Promise((resolve,reject)=>{
  const body=Buffer.from(JSON.stringify(payload));if(body.length>4194304)return reject(new AndreaniError('La tanda supera el tamaño admitido. Reducí la selección.'));
  const uri='/fusion-andreani-worker/worker.php',claim=Buffer.from(JSON.stringify({user,method:'POST',uri,time:Math.floor(Date.now()/1000),sha256:crypto.createHash('sha256').update(body).digest('hex')})).toString('base64');
  const req=http.request({hostname:host,port,path:uri,method:'POST',timeout:30000,headers:{'Content-Type':'application/json','Content-Length':body.length,'x-fusion-claim':claim,'x-fusion-signature':crypto.createHmac('sha256',secret).update(claim).digest('hex')}},res=>{
   const chunks=[];let size=0;res.on('data',chunk=>{size+=chunk.length;if(size>20*1024*1024)req.destroy(new Error('response limit'));else chunks.push(chunk);});res.on('end',()=>{try{const raw=Buffer.concat(chunks);if(res.statusCode===200&&res.headers['content-type']?.includes('spreadsheetml'))return resolve(raw);const data=JSON.parse(raw);if(!data.success)return reject(new AndreaniError(data.message||'No se pudo preparar el envío.',res.statusCode===403?503:400));resolve(data.data);}catch{reject(new AndreaniError('No se pudo leer la respuesta del generador.',503));}});
  });req.on('timeout',()=>req.destroy(new Error('worker timeout')));req.on('error',()=>reject(new AndreaniError('El generador no respondió. Volvé a intentar.',503)));req.end(body);
 });
}
export function createAndreani({directoryPath=fileURLToPath(new URL('./directory-cache/directory.sqlite',import.meta.url)),metricsPath=fileURLToPath(new URL('./directory-cache/metrics.sqlite',import.meta.url)),statePath=path.join(process.env.STATE_DIRECTORY||'/var/lib/fusion-management-validation','andreani.sqlite'),worker}={}){
 function database(){const db=new DatabaseSync(statePath);try{db.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS drafts(order_id INTEGER PRIMARY KEY,revision INTEGER,data TEXT,source_hash TEXT,updated_at TEXT,updated_by TEXT);CREATE TABLE IF NOT EXISTS exports(order_id INTEGER PRIMARY KEY,at TEXT,batch TEXT,by_user TEXT);CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY,created_at TEXT,by_user TEXT,filename TEXT,file BLOB);CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT);');return db;}catch(e){db.close();throw e;}}
 function source(){let db,metrics;try{db=new DatabaseSync(directoryPath,{readOnly:true});metrics=new DatabaseSync(metricsPath,{readOnly:true});const state=Object.fromEntries(db.prepare('SELECT key,value FROM state').all().map(r=>[r.key,JSON.parse(r.value)]));if(state.shipping_fields_version!==1||!state.orders_complete)fail('Se está completando la primera sincronización de envíos.',503);const options=JSON.parse(metrics.prepare("SELECT value FROM state WHERE key='options'").get().value);return {db,metrics,state,options};}catch(e){db?.close();metrics?.close();throw e instanceof AndreaniError?e:new AndreaniError('El historial de envíos no está disponible.',503);}}
 function settings(db){const row=db.prepare("SELECT value FROM settings WHERE key='bike_categories'").get();return {bike_categories:row?JSON.parse(row.value):[62],dni_key:''};}
 function load(s,db,id){if(!validId(id))fail('Pedido inválido.');const row=s.db.prepare('SELECT data FROM orders WHERE id=?').get(Number(id));if(!row)fail('El pedido no está en el historial sincronizado.',404);const o=JSON.parse(row.data),hash=hashOrder(o),saved=db.prepare('SELECT * FROM drafts WHERE order_id=?').get(o.id),exported=db.prepare('SELECT * FROM exports WHERE order_id=?').get(o.id);let changed=false;
  if(saved){o.andreani.draft=JSON.parse(saved.data);changed=saved.source_hash!==hash;if(changed)o.andreani.draft.reviewed=false;}if(exported)o.andreani.exported_at=exported.at;
  return {order:o,revision:saved?.revision||0,hash,changed};
 }
 function context(s,db,orders){const products={};for(const order of orders)for(const item of order.items)for(const id of [item.product_id,item.variation_id])if(id&&!products[id]){const row=s.metrics.prepare('SELECT data FROM products WHERE id=?').get(id);if(!row)fail('Falta sincronizar un producto del pedido. Esperá la actualización del catálogo.',503);products[id]=JSON.parse(row.data);if(products[id].exists&&typeof products[id].virtual!=='boolean')fail('La clasificación de bultos se está sincronizando.',503);}
  return {orders,products,settings:settings(db),options:s.options};
 }
 async function drafts(s,db,loaded,user){const result=await worker({action:'draft',...context(s,db,loaded.map(x=>x.order))},user);return result.map((row,index)=>({...row,revision:loaded[index].revision,source_changed:loaded[index].changed}));}
 function summary(s){return {orders_at:s.state.orders_at,stale:Date.now()-Date.parse(s.state.orders_at)>3600000};}
 return async function handle(action,input,user){
  let db,s;try{
   db=database();
   if(action==='download'){
    if(!/^[a-f0-9-]{36}$/.test(input.id||''))fail('Archivo inválido.');const row=db.prepare('SELECT * FROM batches WHERE id=?').get(input.id);if(!row||Date.now()-Date.parse(row.created_at)>86400000)fail('El archivo venció. Generá una reexportación si corresponde.',410);if(row.by_user!==user)fail('Este archivo fue generado por otro administrador.',403);return {file:Buffer.from(row.file),filename:row.filename};
   }
   s=source();
   if(action==='list'){
    const status=String(input.status||'all'),page=String(input.page||'1'),from=input.from||'',to=input.to||'',id=input.order_id||'';
    if(!/^[1-9]\d{0,5}$/.test(page))fail('Página inválida.');if(status!=='all'&&!s.options.statuses.some(v=>v.key==='wc-'+status))fail('Estado inválido.');
    for(const d of [from,to])if(d&&(!/^\d{4}-\d{2}-\d{2}$/.test(d)||!Number.isFinite(Date.parse(d))||new Date(d).toISOString().slice(0,10)!==d))fail('Fecha inválida.');if(from&&to&&from>to)fail('Revisá el período.');
    const conditions=[],values=[];if(id){if(!validId(id))fail('ID inválido.');conditions.push('id=?');values.push(Number(id));}else{
     if(status!=='all'){conditions.push("json_extract(data,'$.status')=?");values.push(status);}
     if(from){conditions.push("date(created_at,'-3 hours')>=?");values.push(from);}if(to){conditions.push("date(created_at,'-3 hours')<=?");values.push(to);}
    }
    const where=conditions.length?' WHERE '+conditions.join(' AND '):'',total=s.db.prepare('SELECT COUNT(*) n FROM orders'+where).get(...values).n;
    const ids=s.db.prepare('SELECT id FROM orders'+where+' ORDER BY created_at DESC,id DESC LIMIT 25 OFFSET ?').all(...values,(+page-1)*25).map(r=>r.id),loaded=ids.map(id=>load(s,db,id));
    return {rows:await drafts(s,db,loaded,user),total,pages:Math.ceil(total/25),page:Number(page),status:summary(s),options:s.options,settings:settings(db)};
   }
   if(action==='order')return (await drafts(s,db,[load(s,db,input.id)],user))[0];
   if(action==='phone'||action==='search'){
    if(String(input.q||input.phone||'').length>200)fail('Texto demasiado largo.');return await worker({action,phone:input.phone,kind:input.kind,q:input.q},user);
   }
   if(action==='settings'){
    if(!Array.isArray(input.bike_categories)||input.bike_categories.length>100||input.bike_categories.some(id=>!s.options.categories.some(c=>c.id===Number(id))))fail('Categorías inválidas.');
    db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run('bike_categories',JSON.stringify([...new Set(input.bike_categories.map(Number))]));return {saved:true};
   }
   if(action==='save'){
    const item=load(s,db,input.id);if(!Number.isInteger(input.revision)||input.revision!==item.revision)fail('Otro operador cambió la revisión. Cerrá y abrí el pedido para cargarla.',409);
    const normalized=await worker({action:'normalize',draft:input.draft,...context(s,db,[item.order])},user);
    // Recheck after the asynchronous worker to prevent overwriting another editor.
    db.exec('BEGIN IMMEDIATE');const revision=db.prepare('SELECT revision FROM drafts WHERE order_id=?').get(item.order.id)?.revision||0;if(revision!==item.revision)fail('La revisión cambió. Volvé a abrir el pedido.',409);
    db.prepare('INSERT OR REPLACE INTO drafts VALUES(?,?,?,?,?,?)').run(item.order.id,revision+1,JSON.stringify(normalized.draft),item.hash,new Date().toISOString(),user);db.exec('COMMIT');return (await drafts(s,db,[load(s,db,item.order.id)],user))[0];
   }
   if(action==='export'){
    if(summary(s).stale)fail('La copia de pedidos está atrasada. Esperá una sincronización correcta antes de exportar.',409);
    if(!Array.isArray(input.ids)||!input.ids.length||input.ids.length>100||input.ids.some(id=>!validId(id))||new Set(input.ids.map(Number)).size!==input.ids.length)fail('Seleccioná entre 1 y 100 pedidos distintos.');
    db.exec('BEGIN IMMEDIATE');const loaded=input.ids.map(Number).sort((a,b)=>a-b).map(id=>load(s,db,id));
    for(const item of loaded){if(item.changed)fail('Pedido #'+item.order.number+': cambiaron los datos de origen. Revisá y guardá nuevamente.',409);if(item.order.andreani.exported_at&&input.allow_repeat!==true)fail('Pedido #'+item.order.number+' ya exportado. Habilitá Permitir reexportar si corresponde.',409);}
    const file=await worker({action:'export',...context(s,db,loaded.map(i=>i.order))},user);if(!Buffer.isBuffer(file)||file.length<1000||file.subarray(0,2).toString()!=='PK')fail('El generador no devolvió un Excel válido.',503);
    const id=crypto.randomUUID(),at=new Date().toISOString(),filename='Fusion-Andreani-'+at.replace(/[^0-9]/g,'').slice(0,14)+'.xlsx';
    db.prepare('INSERT INTO batches VALUES(?,?,?,?,?)').run(id,at,user,filename,file);for(const item of loaded)db.prepare('INSERT OR REPLACE INTO exports VALUES(?,?,?,?)').run(item.order.id,at,id,user);
    db.prepare('UPDATE batches SET file=NULL WHERE created_at<?').run(new Date(Date.now()-86400000).toISOString());db.exec('COMMIT');return {url:'/herramientas/gestion-vps/andreani/download?id='+id,filename,batch:id,orders:loaded.length};
   }
   fail('Acción no disponible.',404);
  }catch(error){try{db?.exec('ROLLBACK');}catch{}if(error instanceof AndreaniError)throw error;if(error.code==='ERR_SQLITE_ERROR'&&/locked|busy/i.test(error.message))throw new AndreaniError('Otro operador está generando un archivo. Volvé a intentar.',409);throw new AndreaniError('No se pudo completar la preparación de envíos.',503);}
  finally{db?.close();s?.db.close();s?.metrics.close();}
 };
}
