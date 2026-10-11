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

 it('sólo administrador con supervisión configura vendedor',async()=>{
  db.prepare('INSERT INTO mensajeria_roles VALUES(?,?,?,?)').run(3,'supervisor',1,new Date().toISOString());
  for(const id of [3,4,5,8]){const a=await login(id);expect((await a.agent.get('/api/mensajeria/sales-config')).status).toBe(403);expect((await send(a.agent,'/sales-config',{enabled:false,monthly_usd:0,revision:0},a.csrf)).status).toBe(403);}
  expect(fetcher).not.toHaveBeenCalled();
 });
 it('firma actor y separa texto de multimedia',async()=>{
  const a=await login(1);expect((await send(a.agent,'/sales-config',{enabled:true,monthly_usd:20,revision:0,actor:{role:'fake'},platform_admin:false},a.csrf)).status).toBe(200);
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({op:'sales-save',platform_admin:true,enabled:true,monthly_usd:20,actor:{id:'herramientas:1',role:'supervisor'}});
 });
 it('rechaza CSRF y presupuesto inválido antes del proxy',async()=>{
  const a=await login(1);expect((await send(a.agent,'/sales-config',{enabled:true,monthly_usd:20,revision:0},'bad')).status).toBe(403);
  for(const monthly_usd of [-1,201,1.5,'20',null])expect((await send(a.agent,'/sales-config',{enabled:true,monthly_usd,revision:0},a.csrf)).status).toBe(400);
  expect(fetcher).not.toHaveBeenCalled();
 });
});
