import {describe,it,expect,afterEach,vi} from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {buildApp} from '../server.js';
import {hashPassword} from '../lib/auth.js';

describe('Mensajería montada en servidor completo',()=>{
 let app,dir;
 afterEach(()=>{try{app?._db?.close();}catch{}vi.unstubAllGlobals();vi.unstubAllEnvs();if(dir)fs.rmSync(dir,{recursive:true,force:true});});
 it('sirve al agente no-admin y protege todas las rutas; upload sobre 10MB llega al parser autenticado',async()=>{
  dir=fs.mkdtempSync(path.join(os.tmpdir(),'fusion-inbox-test-'));
  vi.stubEnv('INBOX_PROXY_SECRET','test-only-integration-secret-at-least32');
  vi.stubEnv('INBOX_PUBLIC_ORIGIN','https://inbox.test');
  const fake=vi.fn(async()=>new Response(JSON.stringify({ok:true,media_id:'fake-media'}),{status:200}));vi.stubGlobal('fetch',fake);
  app=buildApp({dbPath:path.join(dir,'data.sqlite'),sessionSecret:'test-session',mobileJwtSecret:'test-only-mobile-secret-long-enough-32',wooCfg:{},geminiKey:'',mlCfg:{}});
  const now=new Date().toISOString();
  const user=app._db.prepare('INSERT INTO users(username,pass_hash,is_admin,activo,creado_en,actualizado_en) VALUES(?,?,0,1,?,?)').run('SantiQA',hashPassword('only-test-123456'),now,now).lastInsertRowid;
  app._db.prepare('INSERT INTO user_permisos(user_id,herramienta,nivel) VALUES(?,?,?)').run(user,'mensajeria','write');
  expect((await request(app).get('/api/mensajeria/list')).status).toBe(401);
  expect((await request(app).get('/mensajeria/')).status).toBe(200);
  const agent=request.agent(app);expect((await agent.post('/api/auth/login').send({username:'SantiQA',password:'only-test-123456'})).status).toBe(200);
  const boot=await agent.get('/api/mensajeria/bootstrap');expect(boot.status).toBe(200);expect(boot.body.actor.role).toBe('agent');
  const body={key:'whatsapp:111:qa',request_id:crypto.randomUUID(),name:'archivo.pdf',mime:'application/pdf',data_base64:Buffer.alloc(8*1024*1024).toString('base64')};
  expect(JSON.stringify(body).length).toBeGreaterThan(10*1024*1024);
  const send=b=>agent.post('/api/mensajeria/upload').set('Origin','https://inbox.test').set('X-CSRF-Token',boot.body.csrf).send(b);
  expect((await send(body)).status).toBe(200);expect(fake).toHaveBeenCalledTimes(1);
  const badCsrf=await agent.post('/api/mensajeria/presence').set('Origin','https://inbox.test').set('X-CSRF-Token','invalid').send({status:'available'});expect(badCsrf.status).toBe(403);
  app._db.prepare('INSERT INTO mensajeria_roles VALUES(?,?,?,?)').run(user,'reader',user,now);
  expect((await agent.get('/api/mensajeria/bootstrap')).body.actor.role).toBe('reader');
  expect((await send({...body,request_id:crypto.randomUUID()})).status).toBe(403);
  expect(fake).toHaveBeenCalledTimes(1);
  app._db.prepare('DELETE FROM user_permisos WHERE user_id=?').run(user);
  expect((await agent.get('/api/mensajeria/bootstrap')).status).toBe(403);
 },30000);
});
