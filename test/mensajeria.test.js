import {describe,it,expect,beforeEach,afterEach,vi} from 'vitest';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import {mensajeriaRouter,inboxActor} from '../routes/mensajeria.js';
import {requireAuth} from '../lib/auth.js';

describe('Mensajería: identidad, permisos y proxy firmado',()=>{
 let db,app,fetcher,env;
 beforeEach(()=>{
  db=new Database(':memory:');db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,is_admin INTEGER,activo INTEGER);
   CREATE TABLE user_permisos(user_id INTEGER,herramienta TEXT,nivel TEXT,UNIQUE(user_id,herramienta));
   INSERT INTO users VALUES(1,'Matias',1,1),(2,'Jose',1,1),(3,'Miguel',0,1),(4,'Santi',0,1),(5,'Fabri',1,1),(6,'Sin acceso',0,1),(7,'Inactivo',1,0),(8,'Consulta',0,1);
   INSERT INTO user_permisos VALUES(3,'mensajeria','write'),(4,'mensajeria','write'),(8,'mensajeria','read');`);
  env={INBOX_PROXY_SECRET:'test-only-signing-key-32-characters-minimum',INBOX_PUBLIC_ORIGIN:'https://app.test'};
  fetcher=vi.fn(async()=>new Response(JSON.stringify({ok:true,threads:[]}),{status:200}));
  app=express();app.use(session({secret:'local-test-only-secret',resave:false,saveUninitialized:false}));
  app.get('/test-login/:id',(req,res)=>{req.session.userId=Number(req.params.id);res.json({ok:true});});
  app.use('/api/mensajeria',requireAuth(db),mensajeriaRouter(db,{env,fetchImpl:fetcher}));
  db.prepare('INSERT INTO mensajeria_roles VALUES(?,?,?,?)').run(1,'supervisor',2,new Date().toISOString());
  db.prepare('INSERT INTO mensajeria_roles VALUES(?,?,?,?)').run(5,'agent',2,new Date().toISOString());
 });
 afterEach(()=>db.close());
 async function login(id){const agent=request.agent(app);await agent.get(`/test-login/${id}`);const boot=await agent.get('/api/mensajeria/bootstrap');return{agent,boot,csrf:boot.body.csrf};}
 const command=()=>({key:'whatsapp:number:customer',revision:1,request_id:crypto.randomUUID(),action:'send',text:'Consulta ficticia'});
 const send=(a,path,body,csrf)=>a.post('/api/mensajeria'+path).set('Origin',env.INBOX_PUBLIC_ORIGIN).set('X-CSRF-Token',csrf).send(body);
 it('abrir asigna sólo con identidad de sesión y protege el POST con CSRF y permisos',async()=>{
  const a=await login(3),body={...command(),action:'open',actor:{id:'herramientas:99',role:'supervisor'}};
  expect((await a.agent.post('/api/mensajeria/command').send(body)).status).toBe(403);
  const reader=await login(8);expect((await send(reader.agent,'/command',body,reader.csrf)).status).toBe(403);
  expect((await send(a.agent,'/command',body,a.csrf)).status).toBe(200);
  const signed=JSON.parse(fetcher.mock.calls.at(-1)[1].body);
  expect(signed.action).toBe('open');expect(signed.actor).toEqual({id:'herramientas:3',name:'Miguel',role:'agent'});
 });
 it.each(['agent','reader'])('administrador recupera sólo su propia supervisión desde %s',async(role)=>{
  db.prepare('UPDATE mensajeria_roles SET role=? WHERE user_id=1').run(role);
  const a=await login(1);expect(a.boot.body.actor.can_restore_supervision).toBe(true);
  expect((await send(a.agent,'/restore-supervision',{user_id:3,role:'none'},a.csrf)).status).toBe(200);
  expect((await a.agent.get('/api/mensajeria/bootstrap')).body.actor.role).toBe('supervisor');
  expect((await login(3)).boot.body.actor.role).toBe('agent');
  expect(db.prepare('SELECT actor_id,user_id,old_role,new_role FROM mensajeria_roles_audit').all()).toEqual([{actor_id:1,user_id:1,old_role:role,new_role:'supervisor'}]);
 });
 it('recuperar supervisión exige admin real y CSRF; supervisor no puede quitarse acceso',async()=>{
  const a=await login(3);expect((await send(a.agent,'/restore-supervision',{is_admin:true},a.csrf)).status).toBe(403);
  const boss=await login(1);expect((await boss.agent.post('/api/mensajeria/restore-supervision').send({})).status).toBe(403);
  expect((await send(boss.agent,'/team/1',{role:'none'},boss.csrf)).status).toBe(409);
 });
 it('control IA sólo supervisor, booleano estricto e identidad firmada',async()=>{
  for(const id of [3,8]){const a=await login(id);expect((await send(a.agent,'/ai-number',{number:'5493518752035',enabled:true},a.csrf)).status).toBe(403);}
  const boss=await login(1);
  for(const b of [{number:'otro',enabled:true},{number:'5493518752035',enabled:'true'}])expect((await send(boss.agent,'/ai-number',b,boss.csrf)).status).toBe(400);
  expect((await send(boss.agent,'/ai-number',{number:'5493518752035',enabled:false,actor:{id:'fake'}},boss.csrf)).status).toBe(200);
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({op:'ai-number',number:'5493518752035',enabled:false,actor:{id:'herramientas:1',name:'Matias',role:'supervisor'}});
 });
 it('confirmación de lectura valida identidad y límite bigint sin permitir actor del navegador',async()=>{
  const a=await login(3);const body={key:'whatsapp:111:5493511234567',through_id:'9223372036854775807',actor:{id:'fake',role:'supervisor'}};
  expect((await send(a.agent,'/read',body,a.csrf)).status).toBe(200);
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({op:'read',key:body.key,through_id:body.through_id,actor:{id:'herramientas:3',name:'Miguel',role:'agent'}});
 });
 it('lectura exige sesión, permiso, origen, CSRF y límite canónico válido',async()=>{
  const body={key:'whatsapp:111:test',through_id:'1'};
  expect((await request(app).post('/api/mensajeria/read').send(body)).status).toBe(401);
  const reader=await login(8);expect((await send(reader.agent,'/read',body,reader.csrf)).status).toBe(403);
  const a=await login(3);expect((await a.agent.post('/api/mensajeria/read').send(body)).status).toBe(403);
  for(const id of [1,'0','01','-1','1e2','9223372036854775808','x',null])expect((await send(a.agent,'/read',{...body,through_id:id},a.csrf)).status).toBe(400);
  expect(fetcher).not.toHaveBeenCalled();
 });
 it('envía Pendientes como filtro propio al backend',async()=>{
  const a=await login(3);expect((await a.agent.get('/api/mensajeria/list?filter=unread')).status).toBe(200);
  expect(JSON.parse(fetcher.mock.calls[0][1].body).filter).toBe('unread');
 });
 it('sin sesión no expone conversaciones, personas ni archivos',async()=>{for(const p of ['bootstrap','list','status','media/123'])expect((await request(app).get('/api/mensajeria/'+p)).status).toBe(401);expect(fetcher).not.toHaveBeenCalled();});
 it('deniega usuarios sin acceso y desactivados',async()=>{expect((await login(6)).boot.status).toBe(403);expect((await login(7)).boot.status).toBe(401);});
 it('Matias tiene supervisión completa y el rol explícito de Fabri se conserva',async()=>{expect((await login(1)).boot.body.actor).toMatchObject({role:'supervisor',is_admin:true});expect((await login(5)).boot.body.actor).toMatchObject({role:'agent',is_admin:false});expect((await login(8)).boot.body.actor).toMatchObject({role:'reader',is_admin:false});});
 it('el indicador de administrador no eleva una asignación explícita de consulta',async()=>{db.prepare('UPDATE mensajeria_roles SET role=? WHERE user_id=?').run('reader',1);expect((await login(1)).boot.body.actor).toMatchObject({role:'reader',is_admin:false});});
 it('lector no envía, sube, cambia presencia ni equipo',async()=>{const a=await login(8);for(const p of ['/command','/upload','/presence','/team/3'])expect((await send(a.agent,p,command(),a.csrf)).status).toBe(403);expect(fetcher).not.toHaveBeenCalled();});
 it('directorio incluye a Matias y excluye lectores, inactivos y personas sin permiso',async()=>{const{boot}=await login(2);expect(boot.body.agents.map(a=>a.name).sort()).toEqual(['Fabri','Jose','Matias','Miguel','Santi']);});
 it('rechaza origen ajeno y CSRF ausente o inválido',async()=>{const a=await login(3);expect((await a.agent.post('/api/mensajeria/command').send(command())).status).toBe(403);expect((await a.agent.post('/api/mensajeria/command').set('Origin','https://other.test').set('X-CSRF-Token',a.csrf).send(command())).status).toBe(403);expect(fetcher).not.toHaveBeenCalled();});
 it('firma la identidad real y descarta actor/rol/nombre manipulados',async()=>{const a=await login(3);expect((await send(a.agent,'/command',{...command(),actor:{id:'herramientas:2',role:'supervisor'},op:'delete'},a.csrf)).status).toBe(200);const options=fetcher.mock.calls[0][1],body=JSON.parse(options.body);expect(body.actor).toEqual({id:'herramientas:3',name:'Miguel',role:'agent'});expect(body.op).toBe('command');const h=options.headers;expect(h['x-inbox-signature']).toBe(crypto.createHmac('sha256',env.INBOX_PROXY_SECRET).update(`${h['x-inbox-timestamp']}.${h['x-inbox-nonce']}.${options.body}`).digest('hex'));});
 it('5 sesiones mantienen identidad separada',async()=>{const sessions=await Promise.all([1,2,3,4,5].map(login));expect(new Set(sessions.map(s=>s.boot.body.actor.id)).size).toBe(5);expect(new Set(sessions.map(s=>s.csrf)).size).toBe(5);});
 it('transferencia ignora nombre aportado y valida permiso vigente del destino',async()=>{const a=await login(3);let b={...command(),action:'transfer',target:{id:'herramientas:4',name:'Administrador'}};expect((await send(a.agent,'/command',b,a.csrf)).status).toBe(200);expect(JSON.parse(fetcher.mock.calls[0][1].body).target).toEqual({id:'herramientas:4',name:'Santi'});b.target.id='herramientas:8';expect((await send(a.agent,'/command',b,a.csrf)).status).toBe(400);});
 it('permisos revocados se aplican a una sesión ya iniciada',async()=>{const a=await login(3);db.prepare('INSERT INTO mensajeria_roles VALUES(?,?,?,?)').run(3,'none',2,new Date().toISOString());expect((await a.agent.get('/api/mensajeria/list')).status).toBe(403);});
 it('solo supervisor cambia equipo y el cambio queda auditado',async()=>{const a=await login(3);expect((await send(a.agent,'/team/4',{role:'supervisor'},a.csrf)).status).toBe(403);const boss=await login(2);expect((await send(boss.agent,'/team/4',{role:'reader'},boss.csrf)).status).toBe(200);expect(db.prepare('SELECT * FROM mensajeria_roles_audit').all()).toHaveLength(1);expect((await login(4)).boot.body.actor.role).toBe('reader');});
 it('protege al último supervisor',async()=>{db.prepare('UPDATE mensajeria_roles SET role=? WHERE user_id=?').run('reader',1);const a=await login(2);expect((await send(a.agent,'/team/2',{role:'reader'},a.csrf)).status).toBe(409);});
 it('Matias supervisa ambos canales con la misma identidad y sin modificar otros roles',async()=>{const a=await login(1);expect((await a.agent.get('/api/mensajeria/team')).status).toBe(200);for(const channel of ['web','whatsapp'])expect((await send(a.agent,'/command',{...command(),key:`${channel}:test:customer`,actor:{id:'fake',role:'reader'},channel:'otro'},a.csrf)).status).toBe(200);for(const[,options]of fetcher.mock.calls){const body=JSON.parse(options.body);expect(body.actor).toEqual({id:'herramientas:1',name:'Matias',role:'supervisor'});expect(body).not.toHaveProperty('channel');}expect(db.prepare('SELECT role FROM mensajeria_roles WHERE user_id=5').get().role).toBe('agent');});
 it.each([['','all'],['all','all'],['web','web'],['whatsapp','whatsapp'],['admin','all']])('lista permite únicamente canales conocidos: %s',async(channel,expected)=>{const a=await login(3);expect((await a.agent.get('/api/mensajeria/list').query({channel,filter:'mine',number:'business-1'})).status).toBe(200);const body=JSON.parse(fetcher.mock.calls[0][1].body);expect(body).toMatchObject({op:'list',filter:'mine',channel:expected,number:expected==='web'?'':'business-1'});});
 it('valida UUID, revisión y tamaño antes de mandar al servidor',async()=>{const a=await login(3);for(const patch of[{request_id:'123'},{revision:-1},{text:'x'.repeat(4097)},{action:'delete'}])expect((await send(a.agent,'/command',{...command(),...patch},a.csrf)).status).toBe(400);expect(fetcher).not.toHaveBeenCalled();});
 it('falla cerrado sin clave del servicio',async()=>{env.INBOX_PROXY_SECRET='';const a=await login(3);expect((await a.agent.get('/api/mensajeria/list')).status).toBe(503);expect(fetcher).not.toHaveBeenCalled();});
 it('no expone errores de red con tokens y conserva ambigüedad',async()=>{fetcher.mockRejectedValueOnce(new Error('TOKEN=secret'));const a=await login(3);const r=await send(a.agent,'/command',command(),a.csrf);expect(r.status).toBe(502);expect(r.body.code).toBe('backend_unavailable');expect(r.text).not.toContain('TOKEN');});
 it('descarga privada limitada y Range para audio',async()=>{fetcher.mockResolvedValue(new Response(JSON.stringify({ok:true,data_base64:Buffer.from('123456').toString('base64'),mime:'audio/mpeg',name:'prueba.mp3'})));const a=await login(3);const r=await a.agent.get('/api/mensajeria/media/fake').set('Range','bytes=1-3');expect(r.status).toBe(206);expect(r.headers['cache-control']).toContain('no-store');expect(r.headers['content-range']).toBe('bytes 1-3/6');expect(r.headers['x-content-type-options']).toBe('nosniff');});
 it('retorna conflictos del motor y no ejecuta reintentos automáticos',async()=>{fetcher.mockResolvedValue(new Response(JSON.stringify({ok:false,code:'revision_conflict',error:'Otra persona cambió la conversación.'}),{status:409}));const a=await login(3);const r=await send(a.agent,'/command',command(),a.csrf);expect(r.status).toBe(409);expect(fetcher).toHaveBeenCalledTimes(1);});

 it('respuesta cita por id y versión; nunca acepta texto de cita del navegador',async()=>{
  const a=await login(3),b={...command(),reply_to_id:'123',reply_to_version:'a'.repeat(64),reply_preview:{text:'injected'}};
  expect((await send(a.agent,'/command',b,a.csrf)).status).toBe(200);
  const data=JSON.parse(fetcher.mock.calls[0][1].body);expect(data.reply_to_id).toBe('123');expect(data.reply_to_version).toBe(b.reply_to_version);expect(data).not.toHaveProperty('reply_preview');
 });
 it('respuesta rechaza referencias malformadas, notas y plantillas',async()=>{
  const a=await login(3),base={...command(),reply_to_id:'123',reply_to_version:'a'.repeat(64)};
  for(const patch of [{reply_to_id:123},{reply_to_id:'9223372036854775808'},{reply_to_version:''},{action:'note'},{template:{name:'hello'}}])expect((await send(a.agent,'/command',{...base,...patch},a.csrf)).status).toBe(400);
  expect(fetcher).not.toHaveBeenCalled();
 });
 it('reenvío contiene sólo referencia, destino y actor auténtico',async()=>{
  const a=await login(3),b={key:'whatsapp:111:target',request_id:crypto.randomUUID(),revision:1,action:'forward',source_key:'whatsapp:111:source',source_message_id:'123',source_version:'b'.repeat(64),take_if_unassigned:true,actor:{id:'fake'},metadata:{secret:'no'}};
  expect((await send(a.agent,'/command',b,a.csrf)).status).toBe(200);
  const data=JSON.parse(fetcher.mock.calls[0][1].body);expect(data).toMatchObject({action:'forward',source_key:b.source_key,source_message_id:'123',source_version:b.source_version,take_if_unassigned:true,actor:{id:'herramientas:3'}});expect(data).not.toHaveProperty('metadata');
 });
 it('reenvío rechaza contenido alterado y permisos insuficientes',async()=>{
  const b={key:'whatsapp:111:target',request_id:crypto.randomUUID(),revision:1,action:'forward',source_key:'whatsapp:111:source',source_message_id:'123',source_version:'b'.repeat(64),take_if_unassigned:false},a=await login(3);
  for(const patch of [{text:'alterado'},{media_id:'otro'},{source_version:''},{source_message_id:'0'},{source_key:''},{take_if_unassigned:'true'}])expect((await send(a.agent,'/command',{...b,...patch},a.csrf)).status).toBe(400);
  const reader=await login(8);expect((await send(reader.agent,'/command',b,reader.csrf)).status).toBe(403);expect((await a.agent.post('/api/mensajeria/command').send(b)).status).toBe(403);expect(fetcher).not.toHaveBeenCalled();
 });
});
