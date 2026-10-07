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
   INSERT INTO users VALUES(1,'Matias',1,1),(2,'Jose',1,1),(3,'Miguel',0,1),(4,'Santi',0,1),(5,'Fabri',1,1),(6,'Sin acceso',0,1),(7,'Inactivo',1,0);
   INSERT INTO user_permisos VALUES(3,'mensajeria','write'),(4,'mensajeria','write');`);
  env={INBOX_PROXY_SECRET:'test-only-signing-key-32-characters-minimum',INBOX_PUBLIC_ORIGIN:'https://app.test'};
  fetcher=vi.fn(async()=>new Response(JSON.stringify({ok:true,threads:[]}),{status:200}));
  app=express();app.use(session({secret:'local-test-only-secret',resave:false,saveUninitialized:false}));
  app.get('/test-login/:id',(req,res)=>{req.session.userId=Number(req.params.id);res.json({ok:true});});
  app.use('/api/mensajeria',requireAuth(db),mensajeriaRouter(db,{env,fetchImpl:fetcher}));
  db.prepare('INSERT INTO mensajeria_roles VALUES(?,?,?,?)').run(1,'reader',2,new Date().toISOString());
  db.prepare('INSERT INTO mensajeria_roles VALUES(?,?,?,?)').run(5,'agent',2,new Date().toISOString());
 });
 afterEach(()=>db.close());
 async function login(id){const agent=request.agent(app);await agent.get(`/test-login/${id}`);const boot=await agent.get('/api/mensajeria/bootstrap');return{agent,boot,csrf:boot.body.csrf};}
 const command=()=>({key:'whatsapp:number:customer',revision:1,request_id:crypto.randomUUID(),action:'send',text:'Consulta ficticia'});
 const send=(a,path,body,csrf)=>a.post('/api/mensajeria'+path).set('Origin',env.INBOX_PUBLIC_ORIGIN).set('X-CSRF-Token',csrf).send(body);
 it('sin sesión no expone conversaciones, personas ni archivos',async()=>{for(const p of ['bootstrap','list','status','media/123'])expect((await request(app).get('/api/mensajeria/'+p)).status).toBe(401);expect(fetcher).not.toHaveBeenCalled();});
 it('deniega usuarios sin acceso y desactivados',async()=>{expect((await login(6)).boot.status).toBe(403);expect((await login(7)).boot.status).toBe(401);});
 it('respeta Matias solo lector y Fabri agente aunque son administradores globales',async()=>{expect((await login(1)).boot.body.actor.role).toBe('reader');expect((await login(5)).boot.body.actor.role).toBe('agent');});
 it('lector no envía, sube, cambia presencia ni equipo',async()=>{const a=await login(1);for(const p of ['/command','/upload','/presence','/team/3'])expect((await send(a.agent,p,command(),a.csrf)).status).toBe(403);expect(fetcher).not.toHaveBeenCalled();});
 it('directorio excluye lectores, inactivos y personas sin permiso',async()=>{const{boot}=await login(2);expect(boot.body.agents.map(a=>a.name).sort()).toEqual(['Fabri','Jose','Miguel','Santi']);});
 it('rechaza origen ajeno y CSRF ausente o inválido',async()=>{const a=await login(3);expect((await a.agent.post('/api/mensajeria/command').send(command())).status).toBe(403);expect((await a.agent.post('/api/mensajeria/command').set('Origin','https://other.test').set('X-CSRF-Token',a.csrf).send(command())).status).toBe(403);expect(fetcher).not.toHaveBeenCalled();});
 it('firma la identidad real y descarta actor/rol/nombre manipulados',async()=>{const a=await login(3);expect((await send(a.agent,'/command',{...command(),actor:{id:'herramientas:2',role:'supervisor'},op:'delete'},a.csrf)).status).toBe(200);const options=fetcher.mock.calls[0][1],body=JSON.parse(options.body);expect(body.actor).toEqual({id:'herramientas:3',name:'Miguel',role:'agent'});expect(body.op).toBe('command');const h=options.headers;expect(h['x-inbox-signature']).toBe(crypto.createHmac('sha256',env.INBOX_PROXY_SECRET).update(`${h['x-inbox-timestamp']}.${h['x-inbox-nonce']}.${options.body}`).digest('hex'));});
 it('5 sesiones mantienen identidad separada',async()=>{const sessions=await Promise.all([1,2,3,4,5].map(login));expect(new Set(sessions.map(s=>s.boot.body.actor.id)).size).toBe(5);expect(new Set(sessions.map(s=>s.csrf)).size).toBe(5);});
 it('transferencia ignora nombre aportado y valida permiso vigente del destino',async()=>{const a=await login(3);let b={...command(),action:'transfer',target:{id:'herramientas:4',name:'Administrador'}};expect((await send(a.agent,'/command',b,a.csrf)).status).toBe(200);expect(JSON.parse(fetcher.mock.calls[0][1].body).target).toEqual({id:'herramientas:4',name:'Santi'});b.target.id='herramientas:1';expect((await send(a.agent,'/command',b,a.csrf)).status).toBe(400);});
 it('permisos revocados se aplican a una sesión ya iniciada',async()=>{const a=await login(3);db.prepare('INSERT INTO mensajeria_roles VALUES(?,?,?,?)').run(3,'none',2,new Date().toISOString());expect((await a.agent.get('/api/mensajeria/list')).status).toBe(403);});
 it('solo supervisor cambia equipo y el cambio queda auditado',async()=>{const a=await login(3);expect((await send(a.agent,'/team/4',{role:'supervisor'},a.csrf)).status).toBe(403);const boss=await login(2);expect((await send(boss.agent,'/team/4',{role:'reader'},boss.csrf)).status).toBe(200);expect(db.prepare('SELECT * FROM mensajeria_roles_audit').all()).toHaveLength(1);expect((await login(4)).boot.body.actor.role).toBe('reader');});
 it('protege al último supervisor',async()=>{const a=await login(2);expect((await send(a.agent,'/team/2',{role:'reader'},a.csrf)).status).toBe(409);});
 it('valida UUID, revisión y tamaño antes de mandar al servidor',async()=>{const a=await login(3);for(const patch of[{request_id:'123'},{revision:-1},{text:'x'.repeat(4097)},{action:'delete'}])expect((await send(a.agent,'/command',{...command(),...patch},a.csrf)).status).toBe(400);expect(fetcher).not.toHaveBeenCalled();});
 it('falla cerrado sin clave del servicio',async()=>{env.INBOX_PROXY_SECRET='';const a=await login(3);expect((await a.agent.get('/api/mensajeria/list')).status).toBe(503);expect(fetcher).not.toHaveBeenCalled();});
 it('no expone errores de red con tokens y conserva ambigüedad',async()=>{fetcher.mockRejectedValueOnce(new Error('TOKEN=secret'));const a=await login(3);const r=await send(a.agent,'/command',command(),a.csrf);expect(r.status).toBe(502);expect(r.body.code).toBe('backend_unavailable');expect(r.text).not.toContain('TOKEN');});
 it('descarga privada limitada y Range para audio',async()=>{fetcher.mockResolvedValue(new Response(JSON.stringify({ok:true,data_base64:Buffer.from('123456').toString('base64'),mime:'audio/mpeg',name:'prueba.mp3'})));const a=await login(3);const r=await a.agent.get('/api/mensajeria/media/fake').set('Range','bytes=1-3');expect(r.status).toBe(206);expect(r.headers['cache-control']).toContain('no-store');expect(r.headers['content-range']).toBe('bytes 1-3/6');expect(r.headers['x-content-type-options']).toBe('nosniff');});
 it('retorna conflictos del motor y no ejecuta reintentos automáticos',async()=>{fetcher.mockResolvedValue(new Response(JSON.stringify({ok:false,code:'revision_conflict',error:'Otra persona cambió la conversación.'}),{status:409}));const a=await login(3);const r=await send(a.agent,'/command',command(),a.csrf);expect(r.status).toBe(409);expect(fetcher).toHaveBeenCalledTimes(1);});
});
