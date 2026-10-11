// Stage in Herramientas/test with the candidate route; no real backend requests.
import {describe,it,expect,beforeEach,afterEach,vi} from 'vitest';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import {mensajeriaRouter} from '../routes/mensajeria.js';

describe('Mensajería: iniciar conversación, plantillas y grabaciones',()=>{
 let db,app,fetcher,role;
 beforeEach(()=>{
  db=new Database(':memory:');db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,is_admin INTEGER,activo INTEGER);
   CREATE TABLE user_permisos(user_id INTEGER,herramienta TEXT,nivel TEXT);
   INSERT INTO users VALUES(1,'Operador QA',0,1);INSERT INTO user_permisos VALUES(1,'mensajeria','write');`);
  role='write';fetcher=vi.fn(async()=>new Response(JSON.stringify({ok:true}),{status:200}));
  app=express();app.use(session({secret:'test-only-session-secret',resave:false,saveUninitialized:true}));
  app.use((req,res,next)=>{req.user={id:1,username:'Operador QA',permisos:[{herramienta:'mensajeria',nivel:role}]};next();});
  app.use('/api/mensajeria',mensajeriaRouter(db,{env:{INBOX_PROXY_SECRET:'test-only-inbox-secret-long-enough-32',INBOX_PUBLIC_ORIGIN:'https://qa.test'},fetchImpl:fetcher}));
 });
 afterEach(()=>db.close());
 async function client(){const agent=request.agent(app),boot=await agent.get('/api/mensajeria/bootstrap');return{agent,csrf:boot.body.csrf};}
 const post=(a,path,body)=>a.agent.post('/api/mensajeria'+path).set('Origin','https://qa.test').set('X-CSRF-Token',a.csrf).send(body);
 const payload=()=>({key:'whatsapp:111:5493511234567',action:'send',revision:2,request_id:crypto.randomUUID(),template:{id:'12345',language:'es_AR',fingerprint:'a'.repeat(64),parameters:{header:[],body:['Cliente']}},opt_in:true});
 it('start firma actor real y descarta flags IA, dueño y envío inyectados',async()=>{
  const a=await client();expect((await post(a,'/start',{number_id:'111',phone:'+5493511234567',request_id:crypto.randomUUID(),name:'QA',bot_enabled:true,owner_id:'herramientas:99',text:'No enviar',actor:{role:'supervisor'}})).status).toBe(200);
  const body=JSON.parse(fetcher.mock.calls[0][1].body);expect(body.op).toBe('start');expect(body.actor.role).toBe('agent');expect(body).not.toHaveProperty('text');expect(body).not.toHaveProperty('owner_id');expect(body).not.toHaveProperty('bot_enabled');
 });
 it('nuevas rutas mutables mantienen CSRF y lector no inicia ni consulta plantillas',async()=>{
  const a=await client();expect((await a.agent.post('/api/mensajeria/start').send({})).status).toBe(403);
  role='read';expect((await post(a,'/start',{})).status).toBe(403);expect((await a.agent.get('/api/mensajeria/templates?number_id=111')).status).toBe(403);expect(fetcher).not.toHaveBeenCalled();
 });
 it('plantilla solo envía por command validado, opt-in explícito y sin payload arbitrario',async()=>{
  const a=await client(),b=payload();b.template.payload={type:'text',text:'evil'};
  expect((await post(a,'/command',b)).status).toBe(200);const body=JSON.parse(fetcher.mock.calls[0][1].body);expect(body.template).not.toHaveProperty('payload');expect(body.opt_in).toBe(true);
  for(const change of[{opt_in:false},{opt_in:'true'},{text:'otro'},{media_id:'file'},{action:'note'},{template:{...b.template,fingerprint:'bad'}},{template:{...b.template,parameters:{header:[],body:['x'.repeat(501)]}}}])expect((await post(a,'/command',{...b,...change})).status).toBe(400);
  expect(fetcher).toHaveBeenCalledTimes(1);
 });
 it('preview valida forma y remite solo parámetros acotados',async()=>{
  const a=await client();expect((await post(a,'/template-preview',{key:'whatsapp:111:5493511234567',template_id:'12345',language:'es_AR',parameters:{header:[],body:['Cliente']},payload:{to:'evil'}})).status).toBe(200);
  const body=JSON.parse(fetcher.mock.calls[0][1].body);expect(body.op).toBe('template-preview');expect(body).not.toHaveProperty('payload');
  expect((await post(a,'/template-preview',{key:'x',template_id:'12345',language:'es_AR',parameters:{header:[],body:[],button:'evil'}})).status).toBe(400);
 });
 it('recording acepta boolean real y no acepta is_voice desde cliente',async()=>{
  const a=await client(),b={key:'whatsapp:111:5493511234567',request_id:crypto.randomUUID(),recording:true,mime:'audio/webm;codecs=opus',name:'grabado.webm',data_base64:'AAAA',is_voice:true};
  expect((await post(a,'/upload',b)).status).toBe(200);const body=JSON.parse(fetcher.mock.calls[0][1].body);expect(body.recording).toBe(true);expect(body).not.toHaveProperty('is_voice');
  expect((await post(a,'/upload',{...b,recording:'true'})).status).toBe(400);
 });
 it('rechazo backend no dispara retry ni expone secretos',async()=>{
  fetcher.mockResolvedValue(new Response(JSON.stringify({ok:false,code:'template_changed',error:'template_changed'}),{status:422}));
  const a=await client();const r=await post(a,'/command',payload());expect(r.status).toBe(422);expect(r.body.code).toBe('template_changed');expect(fetcher).toHaveBeenCalledTimes(1);
 });
});
