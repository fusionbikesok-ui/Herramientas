import crypto from 'node:crypto';
import express from 'express';
import {createCommerce} from '../lib/mensajeriaCommerce.js';
import {createInvoiceSource} from '../lib/mensajeriaInvoiceSource.js';
import {createProductSource,productMessage} from '../lib/mensajeriaProductSource.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIONS = new Set(['open','take','transfer','release','close','reopen','pause','resume','note','send','forward']);
const eq = (a,b) => {if(typeof a!=='string'||typeof b!=='string')return false;const left=Buffer.from(a),right=Buffer.from(b);return left.length===right.length&&crypto.timingSafeEqual(left,right);};
export function inboxActor(user,override=null) {
  if (!user?.id) return null;
  const has = (tool,level) => user.permisos?.some(p => p.herramienta === tool && (!level || p.nivel === level));
  const role = override ? (override==='none'?null:override) : user.is_admin || has('mensajeria-supervision','write') ? 'supervisor' : has('mensajeria','write') ? 'agent' : has('mensajeria') || has('mensajeria-supervision') ? 'reader' : null;
  return role ? {id:`herramientas:${user.id}`,name:user.username,role} : null;
}

export function mensajeriaRouter(db,{env=process.env,fetchImpl=fetch,now=()=>Date.now(),commerce=null,invoiceSource=null,productSource=null}={}) {
  const router=express.Router();
  db.exec(`CREATE TABLE IF NOT EXISTS mensajeria_roles (user_id INTEGER PRIMARY KEY REFERENCES users(id),role TEXT NOT NULL CHECK(role IN ('reader','agent','supervisor','none')),updated_by INTEGER,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS mensajeria_roles_audit (id INTEGER PRIMARY KEY,actor_id INTEGER NOT NULL,user_id INTEGER NOT NULL,old_role TEXT,new_role TEXT NOT NULL,created_at TEXT NOT NULL);`);
  const budgets=new Map();
  const error=(res,status,code,message)=>res.status(status).json({ok:false,code,error:message});
  const roster=()=>db.prepare('SELECT u.id,u.username,u.is_admin,r.role FROM users u LEFT JOIN mensajeria_roles r ON r.user_id=u.id WHERE u.activo=1 ORDER BY u.username').all().map(u=>{
    const permisos=db.prepare('SELECT herramienta,nivel FROM user_permisos WHERE user_id=?').all(u.id);
    return {user_id:u.id,id:`herramientas:${u.id}`,name:u.username,role:inboxActor({...u,permisos},u.role)?.role||'none'};
  });
  const agents=()=>roster().filter(u=>['agent','supervisor'].includes(u.role)).map(({id,name})=>({id,name}));
  router.use((req,res,next)=>{
    res.set('Cache-Control','private, no-store');
    res.set('X-Content-Type-Options','nosniff');
    const actor=inboxActor(req.user,req.user?.id?db.prepare('SELECT role FROM mensajeria_roles WHERE user_id=?').get(req.user.id)?.role:null);
    if(!actor)return error(res,403,'forbidden','Tu usuario no tiene acceso a Mensajería.');
    req.inboxActor=actor;
    if(req.method!=='GET' && req.method!=='HEAD') {
      if(actor.role==='reader'&&!(req.path==='/restore-supervision'&&req.user.is_admin))return error(res,403,'read_only','Tu acceso es de revisión: no permite enviar ni modificar conversaciones.');
      const origin=env.INBOX_PUBLIC_ORIGIN || 'https://herramientas.fusionbikes.com.ar';
      if(req.get('origin')!==origin || !eq(req.get('x-csrf-token'),req.session?.inboxCsrf))return error(res,403,'csrf','La sesión cambió. Recargá la bandeja antes de continuar.');
      if(!req.is('application/json'))return error(res,415,'json_required','Se requiere JSON.');
      const key=actor.id,at=now();
      if(budgets.size>500)for(const[k,v]of budgets)if(at-v.start>60000)budgets.delete(k);
      let b=budgets.get(key);if(!b||at-b.start>60000){b={start:at,count:0,uploads:0};budgets.set(key,b);}
      b.count++;if(req.path==='/upload'||req.path==='/commerce/prepare')b.uploads++;
      if(b.count>80||b.uploads>8)return error(res,429,'rate_limit','Esperá un minuto antes de continuar.');
    }
    next();
  });
  router.use(express.json({limit:'24mb'}));
  async function proxy(req,op,data={}) {
    const secret=env.INBOX_PROXY_SECRET;
    if(!secret||secret.length<32)throw Object.assign(new Error('Mensajería todavía no está configurada.'),{status:503,code:'not_configured'});
    const target=new URL(env.INBOX_BACKEND_URL || 'http://127.0.0.1:8091/v1/inbox');
    if(target.protocol!=='http:'&&target.protocol!=='https:')throw new Error('Configuración inválida');
    const raw=JSON.stringify({...data,op,actor:req.inboxActor});
    const ts=String(Math.floor(now()/1000)),nonce=crypto.randomUUID();
    const signature=crypto.createHmac('sha256',secret).update(`${ts}.${nonce}.${raw}`).digest('hex');
    let response;
    try {response=await fetchImpl(target,{method:'POST',headers:{'content-type':'application/json','x-inbox-timestamp':ts,'x-inbox-nonce':nonce,'x-inbox-signature':signature},body:raw,signal:AbortSignal.timeout(op==='media'||op==='upload'?60000:20000),redirect:'error'});}
    catch{throw Object.assign(new Error('No llegó la confirmación del servidor. Conservá el borrador y verificá la operación antes de repetirla.'),{status:502,code:'backend_unavailable'});}
    const text=await response.text();
    if(text.length>25*1024*1024)throw Object.assign(new Error('El archivo supera el tamaño permitido.'),{status:502,code:'response_too_large'});
    let result;try{result=JSON.parse(text);}catch{throw Object.assign(new Error('El servidor devolvió una respuesta inválida.'),{status:502,code:'invalid_response'});}
    if(!response.ok||result.ok===false)throw Object.assign(new Error(typeof result.error==='string'?result.error:'No se pudo completar la operación.'),{status:response.status>=400?response.status:502,code:result.code||'backend_error'});
    return result;
  }
  const safe=fn=>async(req,res)=>{try{await fn(req,res);}catch(e){error(res,e.status>=400&&e.status<=599?e.status:502,e.code||'internal_error',e.status?e.message:'No se pudo completar la operación.');}};
  let commerceData=commerce;
  const data=()=>commerceData ||= createCommerce(db,{directoryPath:env.INBOX_DIRECTORY_PATH,now});
  const readInvoice=invoiceSource || createInvoiceSource({env,fetchImpl});
  const products=productSource || createProductSource({env,fetchImpl,now});
  const contactPhone=thread=>thread.channel!=='web' && /^\d{8,15}$/.test(thread.phone||'')?'+'+thread.phone:thread.phone;
  const fail=(status,code,message)=>{throw Object.assign(new Error(message),{status,code});};
  async function commerceThread(req,key,{sending=false,invoice=false}={}) {
    if(req.inboxActor.role==='reader')fail(403,'write_required','Tu acceso no permite preparar mensajes comerciales.');
    if(typeof key!=='string'||!key||key.length>300)fail(400,'invalid_thread','Elegí una conversación.');
    const {thread}=await proxy(req,'thread',{key});
    if(!thread || thread.key!==key)fail(404,'thread_not_found','No se encontró esta conversación.');
    if(req.inboxActor.role!=='supervisor' && thread.owner_id!==req.inboxActor.id)fail(403,'owner_required','Tomá la conversación antes de consultar sus pedidos.');
    if(thread.status==='closed')fail(409,'thread_closed','Reabrí la conversación para preparar una respuesta.');
    if(invoice && (thread.channel==='web'||thread.capabilities?.media===false))fail(409,'web_media_unsupported','Las facturas PDF se comparten desde la conversación de WhatsApp del cliente.');
    if(sending && !thread.can_send)fail(409,thread.send_blocked_reason||'cannot_send','La conversación todavía no permite responder.');
    return thread;
  }
  router.get('/products',safe(async(req,res)=>{
    if(req.inboxActor.role==='reader')return error(res,403,'write_required','Tu acceso no permite preparar mensajes comerciales.');
    if(typeof req.query.q!=='string')return error(res,400,'invalid_search','Buscá por nombre o SKU.');
    const stock=req.query.stock??'all';
    if(!['all','instock','outofstock'].includes(stock))return error(res,400,'invalid_stock','Elegí un filtro de stock válido.');
    res.json(await data().products(req.query.q,stock));
  }));
  router.get('/commerce/orders',safe(async(req,res)=>{
    const thread=await commerceThread(req,req.query.key);
    const result=await data().orders(contactPhone(thread));
    res.json({ok:true,...result,identity_warning:thread.channel==='web'?'Este teléfono fue informado en el chat web. Confirmá la identidad del cliente antes de compartir información de su compra.':'Revisá el nombre y el pedido antes de compartir información de la compra.'});
  }));
  router.post('/commerce/prepare',safe(async(req,res)=>{
    const b=req.body||{};
    if(!UUID.test(b.request_id)||!['product','invoice','tracking'].includes(b.kind))return error(res,400,'invalid_share','Elegí qué querés compartir.');
    const thread=await commerceThread(req,b.key,{sending:true,invoice:b.kind==='invoice'});
    if(b.kind==='product') {
      const local=await data().product(b.product_id),quote=await products.quote(local);
      const product={...local,name:quote.name||local.name,price:quote.cash};
      const text=productMessage(product,quote);
      const canPhoto=thread.channel!=='web'&&thread.capabilities?.media!==false;
      if(text.length>(canPhoto&&product.image?1024:4096))return error(res,400,'product_caption_too_long','La descripción del producto supera el tamaño de un mensaje con foto.');
      const photo=canPhoto?await products.photo(product):null;
      const current=await commerceThread(req,b.key,{sending:true});
      if(current.phone!==thread.phone||current.number_id!==thread.number_id||current.channel!==thread.channel)fail(409,'contact_changed','La conversación cambió. Volvé a elegir el producto.');
      if(photo){
        const uploaded=await proxy(req,'upload',{key:b.key,request_id:b.request_id,...photo});
        return res.json({ok:true,product,text,media:{media_id:uploaded.media_id,name:uploaded.name||photo.name,mime:uploaded.mime||photo.mime}});
      }
      return res.json({ok:true,product,text});
    }
    const order=await data().orderForPhone(contactPhone(thread),b.order_id);
    if(b.kind==='tracking') {
      const index=b.tracking_index??0;
      if(!Number.isInteger(index)||index<0||!order.tracking?.[index])return error(res,404,'tracking_not_found','Este pedido todavía no tiene un número de seguimiento registrado.');
      const tracking=order.tracking[index];
      return res.json({ok:true,order,text:`Seguimiento del pedido #${order.number}\n${tracking.carrier}: ${tracking.number}\n${tracking.url}`});
    }
    if(b.invoice_id!==undefined && (!Number.isSafeInteger(Number(b.invoice_id))||Number(b.invoice_id)<1||!/^\d{1,15}$/.test(String(b.invoice_id))))return error(res,400,'invalid_invoice','Elegí un comprobante emitido de este pedido.');
    let invoiceId=b.invoice_id;
    let document=await readInvoice({orderId:order.id,invoiceId,phone:thread.phone});
    if(invoiceId===undefined&&document.invoices.length===1){
      invoiceId=document.invoices[0].id;
      document=await readInvoice({orderId:order.id,invoiceId,phone:thread.phone});
    }
    // Permissions/ownership can change during the remote store read.
    const current=await commerceThread(req,b.key,{sending:true,invoice:true});
    if(current.phone!==thread.phone)fail(409,'contact_changed','El contacto cambió. Volvé a elegir el pedido.');
    await data().orderForPhone(contactPhone(current),order.id);
    if(invoiceId===undefined)return res.json({ok:true,order,selection_required:true,invoices:document.invoices});
    const upload=await proxy(req,'upload',{key:b.key,request_id:b.request_id,name:document.name,mime:document.mime,data_base64:document.data_base64});
    res.json({ok:true,order,text:`Te compartimos el comprobante del pedido #${order.number}.`,media:{media_id:upload.media_id,name:upload.name||document.name,mime:upload.mime||document.mime}});
  }));
  router.get('/bootstrap',(req,res)=>{
    req.session.inboxCsrf ||= crypto.randomBytes(32).toString('hex');
    res.json({ok:true,actor:{...req.inboxActor,is_admin:req.inboxActor.role==='supervisor'&&Boolean(req.user.is_admin),can_restore_supervision:Boolean(req.user.is_admin)},csrf:req.session.inboxCsrf,agents:agents()});
  });
  router.post('/restore-supervision',(req,res)=>{
    if(!req.user.is_admin)return error(res,403,'admin_required','Solo un administrador general puede recuperar su propia supervisión.');
    db.transaction(()=>{
      const id=req.user.id,ts=new Date(now()).toISOString();
      if(req.inboxActor.role==='supervisor')return;
      db.prepare('INSERT INTO mensajeria_roles(user_id,role,updated_by,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET role=excluded.role,updated_by=excluded.updated_by,updated_at=excluded.updated_at').run(id,'supervisor',id,ts);
      db.prepare('INSERT INTO mensajeria_roles_audit(actor_id,user_id,old_role,new_role,created_at) VALUES(?,?,?,?,?)').run(id,id,req.inboxActor.role,'supervisor',ts);
      for(const tool of ['mensajeria','mensajeria-supervision'])db.prepare('INSERT INTO user_permisos(user_id,herramienta,nivel) VALUES(?,?,?) ON CONFLICT(user_id,herramienta) DO UPDATE SET nivel=excluded.nivel').run(id,tool,'write');
    })();
    res.json({ok:true});
  });
  router.get('/team',(req,res)=>{
    if(req.inboxActor.role!=='supervisor')return error(res,403,'supervisor_required','Solo el supervisor puede gestionar el equipo.');
    res.json({ok:true,users:roster()});
  });
  router.post('/team/:id',(req,res)=>{
    if(req.inboxActor.role!=='supervisor')return error(res,403,'supervisor_required','Solo el supervisor puede gestionar el equipo.');
    const id=Number(req.params.id),role=req.body?.role;
    if(!Number.isInteger(id)||!['none','reader','agent','supervisor'].includes(role))return error(res,400,'invalid_role','Rol inválido.');
    if(id===req.user.id&&role==='none')return error(res,409,'self_access','No podés quitarte el acceso a Mensajería.');
    const result=db.transaction(()=>{
      const current=roster(),target=current.find(u=>u.user_id===id);
      if(!target)return {status:404,code:'not_found',error:'Usuario activo no encontrado.'};
      if(target.role==='supervisor'&&role!=='supervisor'&&current.filter(u=>u.role==='supervisor').length<2)return {status:409,code:'last_supervisor',error:'Debe quedar al menos un supervisor.'};
      const ts=new Date(now()).toISOString();
      db.prepare(`INSERT INTO mensajeria_roles(user_id,role,updated_by,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET role=excluded.role,updated_by=excluded.updated_by,updated_at=excluded.updated_at`).run(id,role,req.user.id,ts);
      db.prepare('INSERT INTO mensajeria_roles_audit(actor_id,user_id,old_role,new_role,created_at) VALUES(?,?,?,?,?)').run(req.user.id,id,target.role,role,ts);
      db.prepare("DELETE FROM user_permisos WHERE user_id=? AND herramienta IN ('mensajeria','mensajeria-supervision')").run(id);
      if(role!=='none')db.prepare('INSERT INTO user_permisos(user_id,herramienta,nivel) VALUES(?,?,?)').run(id,'mensajeria',role==='reader'?'read':'write');
      if(role==='supervisor')db.prepare('INSERT INTO user_permisos(user_id,herramienta,nivel) VALUES(?,?,?)').run(id,'mensajeria-supervision','write');
      return {ok:true};
    })();
    if(!result.ok)return error(res,result.status,result.code,result.error);
    res.json({...result,users:roster(),agents:agents()});
  });
  router.get('/list',safe(async(req,res)=>res.json(await proxy(req,'list',{
    filter:['all','mine','unassigned','closed','unread'].includes(req.query.filter)?req.query.filter:'all',
    channel:['all','web','whatsapp','lead'].includes(req.query.channel)?req.query.channel:'all',
    source:['all','gift','cart','contact'].includes(req.query.source)?req.query.source:'all',
    search:String(req.query.search||'').slice(0,150),number:req.query.channel==='web'?'':String(req.query.number||'').slice(0,100),
    offset:Math.max(0,Math.min(Number(req.query.offset)||0,100000)),limit:Math.max(1,Math.min(Number(req.query.limit)||30,100))
  }))));
  router.get('/thread',safe(async(req,res)=>res.json(await proxy(req,'thread',{key:String(req.query.key||'').slice(0,300),...(req.query.before?{before:String(req.query.before).slice(0,60)}:{})}))));
  router.post('/read',safe(async(req,res)=>{
    const b=req.body||{};
    if(typeof b.key!=='string'||!b.key||b.key.length>300||typeof b.through_id!=='string'||!/^[1-9][0-9]{0,18}$/.test(b.through_id)||BigInt(b.through_id)>9223372036854775807n)
      return error(res,400,'invalid_read_boundary','No se pudo confirmar la lectura de este chat.');
    res.json(await proxy(req,'read',{key:b.key,through_id:b.through_id}));
  }));
  router.get('/sales-config',safe(async(req,res)=>{
    if(!req.user.is_admin||req.inboxActor.role!=='supervisor')return error(res,403,'admin_required','Sólo el administrador general puede configurar la API.');
    res.json(await proxy(req,'sales-config',{platform_admin:true}));
  }));
  router.post('/sales-config',safe(async(req,res)=>{
    if(!req.user.is_admin||req.inboxActor.role!=='supervisor')return error(res,403,'admin_required','Sólo el administrador general puede configurar la API.');
    const b=req.body||{};
    if(typeof b.enabled!=='boolean'||!Number.isInteger(b.monthly_usd)||b.monthly_usd<0||b.monthly_usd>200||!Number.isInteger(b.revision))return error(res,400,'invalid_config','Revisá el límite mensual de conversación.');
    res.json(await proxy(req,'sales-save',{platform_admin:true,enabled:b.enabled,monthly_usd:b.monthly_usd,revision:b.revision}));
  }));
  router.get('/multimedia-config',safe(async(req,res)=>{
    if(!req.user.is_admin||req.inboxActor.role!=='supervisor')return error(res,403,'admin_required','Sólo el administrador general puede configurar la API.');
    res.json(await proxy(req,'multimedia-config',{platform_admin:true}));
  }));
  router.post('/multimedia-config',safe(async(req,res)=>{
    if(!req.user.is_admin||req.inboxActor.role!=='supervisor')return error(res,403,'admin_required','Sólo el administrador general puede configurar la API.');
    const b=req.body||{};
    if(typeof b.images!=='boolean'||typeof b.audio!=='boolean'||!Number.isInteger(b.monthly_usd)||b.monthly_usd<0||b.monthly_usd>200||!Number.isInteger(b.revision)||typeof (b.api_key??'')!=='string'||(b.api_key??'').length>512)return error(res,400,'invalid_config','Revisá el límite y la clave ingresada.');
    res.json(await proxy(req,'multimedia-save',{platform_admin:true,images:b.images,audio:b.audio,monthly_usd:b.monthly_usd,revision:b.revision,api_key:b.api_key||'',remove_key:b.remove_key===true}));
  }));
  router.post('/multimedia-check',safe(async(req,res)=>{
    if(!req.user.is_admin||req.inboxActor.role!=='supervisor')return error(res,403,'admin_required','Sólo el administrador general puede configurar la API.');
    res.json(await proxy(req,'multimedia-check',{platform_admin:true}));
  }));
  router.get('/status',safe(async(req,res)=>res.json(await proxy(req,'status'))));
  router.post('/ai-number',safe(async(req,res)=>{
    if(req.inboxActor.role!=='supervisor')return error(res,403,'supervisor_required','Solo el supervisor puede configurar la IA.');
    const {number,enabled}=req.body||{};
    if(!['5493515214819','5493518752035'].includes(number)||typeof enabled!=='boolean')return error(res,400,'invalid_ai_control','Elegí un número y un estado válido.');
    res.json(await proxy(req,'ai-number',{number,enabled}));
  }));
  router.post('/start',safe(async(req,res)=>{
    const b=req.body||{};
    if(!UUID.test(b.request_id)||typeof b.phone!=='string'||b.phone.length>32||typeof b.number_id!=='string'||!/^\d{1,40}$/.test(b.number_id)||b.name!==undefined&&(typeof b.name!=='string'||b.name.length>120))
      return error(res,400,'invalid_start','Ingresá un número internacional y elegí una línea.');
    res.json(await proxy(req,'start',{request_id:b.request_id,phone:b.phone,number_id:b.number_id,name:b.name||''}));
  }));
  router.get('/templates',safe(async(req,res)=>{
    if(req.inboxActor.role==='reader')return error(res,403,'write_required','Tu acceso no permite iniciar mensajes.');
    const number_id=String(req.query.number_id||'');
    if(!/^\d{1,40}$/.test(number_id))return error(res,400,'invalid_number','Elegí una línea de WhatsApp.');
    res.json(await proxy(req,'templates',{number_id}));
  }));
  const templateFields=value=>{
    if(!value||typeof value!=='object'||Array.isArray(value)||!/^\d{1,40}$/.test(value.id)||typeof value.language!=='string'||! /^[a-z]{2,3}(?:_[A-Za-z]{2,4})?$/.test(value.language)||! /^[a-f0-9]{64}$/.test(value.fingerprint))return null;
    const p=value.parameters;
    if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).some(k=>!['header','body'].includes(k)))return null;
    const parameters={header:p.header||[],body:p.body||[]};
    if(Object.values(parameters).some(v=>!Array.isArray(v)||v.length>20||v.some(x=>typeof x!=='string'||x.length>500)))return null;
    return {id:String(value.id),language:value.language,fingerprint:value.fingerprint,parameters};
  };
  router.post('/template-preview',safe(async(req,res)=>{
    const b=req.body||{}, template=templateFields({id:b.template_id,language:b.language,parameters:b.parameters,fingerprint:'0'.repeat(64)});
    if(!template||typeof b.key!=='string'||b.key.length>300)return error(res,400,'invalid_template','Elegí una plantilla y completá sus variables.');
    res.json(await proxy(req,'template-preview',{key:b.key,template_id:template.id,language:template.language,parameters:template.parameters}));
  }));
  router.post('/presence',safe(async(req,res)=>res.json(await proxy(req,'presence',{status:['available','busy','offline'].includes(req.body.status)?req.body.status:'offline'}))));
  router.post('/command',safe(async(req,res)=>{
    const b=req.body||{};
    if(!ACTIONS.has(b.action)||!UUID.test(b.request_id)||!Number.isInteger(b.revision)||b.revision<0||typeof b.key!=='string'||b.key.length>300)
      return error(res,400,'invalid_command','La operación no es válida. Actualizá la conversación.');
    const data={key:b.key,action:b.action,request_id:b.request_id,revision:b.revision};
    if(b.text!==undefined){if(typeof b.text!=='string'||b.text.length>4096)return error(res,400,'invalid_text','El mensaje admite hasta 4096 caracteres.');data.text=b.text;}
    const validMessageId=v=>typeof v==='string'&&/^[1-9][0-9]{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n;
    if(b.reply_to_id!==undefined){
      if(b.action!=='send'||b.template||!validMessageId(b.reply_to_id)||! /^[a-f0-9]{64}$/.test(b.reply_to_version||''))return error(res,400,'invalid_message_reference','Volvé a seleccionar el mensaje al que querés responder.');
      data.reply_to_id=b.reply_to_id;data.reply_to_version=b.reply_to_version;
    }
    if(b.action==='forward'){
      if(!validMessageId(b.source_message_id)||typeof b.source_key!=='string'||!b.source_key||b.source_key.length>300||! /^[a-f0-9]{64}$/.test(b.source_version||'')||b.media_id||b.text||b.template||b.reply_to_id||typeof b.take_if_unassigned!=='boolean')return error(res,400,'invalid_message_reference','Volvé a elegir el mensaje y su destinatario.');
      Object.assign(data,{source_key:b.source_key,source_message_id:b.source_message_id,source_version:b.source_version,take_if_unassigned:b.take_if_unassigned});
    }
    if(b.media_id!==undefined)data.media_id=String(b.media_id).slice(0,100);
    if(b.template!==undefined){
      const template=templateFields(b.template);
      if(b.action!=='send'||!template||b.opt_in!==true||b.text||b.media_id)return error(res,400,'invalid_template_message','Revisá la plantilla y confirmá que el cliente autorizó el contacto.');
      data.template=template;data.opt_in=true;
    }
    if(b.action==='transfer'){
      const target=agents().find(u=>u.id===(b.target?.id||b.target_id));
      if(!target)return error(res,400,'invalid_target','Elegí una persona activa con permiso para atender.');
      data.target=target;
    }
    res.json(await proxy(req,'command',data));
  }));
  router.post('/upload',safe(async(req,res)=>{
    const b=req.body||{};
    if(!UUID.test(b.request_id)||typeof b.key!=='string'||typeof b.data_base64!=='string'||b.data_base64.length>Math.ceil(16*1024*1024/3)*4)
      return error(res,400,'invalid_upload','Archivo inválido o mayor a 16 MB.');
    if(b.recording!==undefined&&typeof b.recording!=='boolean')return error(res,400,'invalid_recording_flag','Grabación inválida.');
    res.json(await proxy(req,'upload',{key:b.key.slice(0,300),request_id:b.request_id,name:String(b.name||'archivo').slice(0,180),mime:String(b.mime||'').slice(0,100),data_base64:b.data_base64,...(b.recording!==undefined?{recording:b.recording}:{})}));
  }));
  router.get('/media/:id',safe(async(req,res)=>{
    const result=await proxy(req,'media',{id:String(req.params.id).slice(0,100)});
    const bytes=Buffer.from(result.data_base64||'','base64');
    if(bytes.length>16*1024*1024)return error(res,413,'media_too_large','Archivo demasiado grande.');
    const mimes=new Set(['image/jpeg','image/png','image/webp','audio/mpeg','audio/ogg','audio/mp4','audio/aac','video/mp4','application/pdf']);
    const mime=mimes.has(result.mime)?result.mime:'application/octet-stream';
    const name=String(result.name||'archivo').replace(/[\r\n\0\\/]/g,'_').slice(0,160);
    res.set({'Content-Type':mime,'Content-Disposition':`${mime.startsWith('image/')||mime.startsWith('audio/')||mime.startsWith('video/')?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,'Content-Security-Policy':"default-src 'none'; sandbox",'Accept-Ranges':'bytes'});
    const range=req.get('range');
    if(range){const match=/^bytes=(\d+)-(\d*)$/.exec(range);if(!match)return res.status(416).set('Content-Range',`bytes */${bytes.length}`).end();
      const start=Number(match[1]),end=match[2]?Math.min(Number(match[2]),bytes.length-1):bytes.length-1;
      if(start>end||start>=bytes.length)return res.status(416).set('Content-Range',`bytes */${bytes.length}`).end();
      return res.status(206).set('Content-Range',`bytes ${start}-${end}/${bytes.length}`).send(bytes.subarray(start,end+1));}
    res.send(bytes);
  }));
  router.use((err,req,res,next)=>{if(err.type==='entity.too.large')return error(res,413,'upload_too_large','El archivo supera el límite de 16 MB.');if(err instanceof SyntaxError)return error(res,400,'invalid_json','JSON inválido.');next(err);});
  return router;
}
