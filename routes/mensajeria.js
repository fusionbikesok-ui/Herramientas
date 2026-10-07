import crypto from 'node:crypto';
import express from 'express';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIONS = new Set(['take','transfer','release','close','reopen','pause','resume','note','send']);
const eq = (a,b) => {if(typeof a!=='string'||typeof b!=='string')return false;const left=Buffer.from(a),right=Buffer.from(b);return left.length===right.length&&crypto.timingSafeEqual(left,right);};
export function inboxActor(user,override=null) {
  if (!user?.id) return null;
  const has = (tool,level) => user.permisos?.some(p => p.herramienta === tool && (!level || p.nivel === level));
  const role = override ? (override==='none'?null:override) : user.is_admin || has('mensajeria-supervision','write') ? 'supervisor' : has('mensajeria','write') ? 'agent' : has('mensajeria') || has('mensajeria-supervision') ? 'reader' : null;
  return role ? {id:`herramientas:${user.id}`,name:user.username,role} : null;
}

export function mensajeriaRouter(db,{env=process.env,fetchImpl=fetch,now=()=>Date.now()}={}) {
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
      if(actor.role==='reader')return error(res,403,'read_only','Tu acceso es de revisión: no permite enviar ni modificar conversaciones.');
      const origin=env.INBOX_PUBLIC_ORIGIN || 'https://herramientas.fusionbikes.com.ar';
      if(req.get('origin')!==origin || !eq(req.get('x-csrf-token'),req.session?.inboxCsrf))return error(res,403,'csrf','La sesión cambió. Recargá la bandeja antes de continuar.');
      if(!req.is('application/json'))return error(res,415,'json_required','Se requiere JSON.');
      const key=actor.id,at=now();
      if(budgets.size>500)for(const[k,v]of budgets)if(at-v.start>60000)budgets.delete(k);
      let b=budgets.get(key);if(!b||at-b.start>60000){b={start:at,count:0,uploads:0};budgets.set(key,b);}
      b.count++;if(req.path==='/upload')b.uploads++;
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
  router.get('/bootstrap',(req,res)=>{
    req.session.inboxCsrf ||= crypto.randomBytes(32).toString('hex');
    res.json({ok:true,actor:{...req.inboxActor,is_admin:req.inboxActor.role==='supervisor'&&Boolean(req.user.is_admin)},csrf:req.session.inboxCsrf,agents:agents()});
  });
  router.get('/team',(req,res)=>{
    if(req.inboxActor.role!=='supervisor')return error(res,403,'supervisor_required','Solo el supervisor puede gestionar el equipo.');
    res.json({ok:true,users:roster()});
  });
  router.post('/team/:id',(req,res)=>{
    if(req.inboxActor.role!=='supervisor')return error(res,403,'supervisor_required','Solo el supervisor puede gestionar el equipo.');
    const id=Number(req.params.id),role=req.body?.role;
    if(!Number.isInteger(id)||!['none','reader','agent','supervisor'].includes(role))return error(res,400,'invalid_role','Rol inválido.');
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
    filter:['all','mine','unassigned','closed'].includes(req.query.filter)?req.query.filter:'all',
    channel:['all','web','whatsapp'].includes(req.query.channel)?req.query.channel:'all',
    search:String(req.query.search||'').slice(0,150),number:req.query.channel==='web'?'':String(req.query.number||'').slice(0,100),
    offset:Math.max(0,Math.min(Number(req.query.offset)||0,100000)),limit:Math.max(1,Math.min(Number(req.query.limit)||30,100))
  }))));
  router.get('/thread',safe(async(req,res)=>res.json(await proxy(req,'thread',{key:String(req.query.key||'').slice(0,300),...(req.query.before?{before:String(req.query.before).slice(0,60)}:{})}))));
  router.get('/status',safe(async(req,res)=>res.json(await proxy(req,'status'))));
  router.post('/presence',safe(async(req,res)=>res.json(await proxy(req,'presence',{status:['available','busy','offline'].includes(req.body.status)?req.body.status:'offline'}))));
  router.post('/command',safe(async(req,res)=>{
    const b=req.body||{};
    if(!ACTIONS.has(b.action)||!UUID.test(b.request_id)||!Number.isInteger(b.revision)||b.revision<0||typeof b.key!=='string'||b.key.length>300)
      return error(res,400,'invalid_command','La operación no es válida. Actualizá la conversación.');
    const data={key:b.key,action:b.action,request_id:b.request_id,revision:b.revision};
    if(b.text!==undefined){if(typeof b.text!=='string'||b.text.length>4096)return error(res,400,'invalid_text','El mensaje admite hasta 4096 caracteres.');data.text=b.text;}
    if(b.media_id!==undefined)data.media_id=String(b.media_id).slice(0,100);
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
    res.json(await proxy(req,'upload',{key:b.key.slice(0,300),request_id:b.request_id,name:String(b.name||'archivo').slice(0,180),mime:String(b.mime||'').slice(0,100),data_base64:b.data_base64}));
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
