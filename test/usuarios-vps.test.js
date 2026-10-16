import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import { usuariosRouter } from '../routes/usuarios.js';
import { authRouter } from '../routes/auth.js';
import { requireAuth, requireAdmin, hashPassword } from '../lib/auth.js';
import { VPS_APPLICATIONS } from '../integrations/management-migration/permissions.mjs';
import { resolvePermiso, permiteAcceso } from '../lib/permisos.js';
import { mensajeriaRouter } from '../routes/mensajeria.js';

const databases=[];
afterEach(()=>databases.splice(0).forEach(db=>db.close()));
function fixture(){
  const db=new Database(':memory:');databases.push(db);
  db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT UNIQUE,pass_hash TEXT,is_admin INTEGER,activo INTEGER,email TEXT,creado_en TEXT,actualizado_en TEXT);
  CREATE TABLE user_permisos(user_id INTEGER,herramienta TEXT,nivel TEXT,PRIMARY KEY(user_id,herramienta));`);
  const hash=hashPassword('qa-test-only-password');
  for(const [id,name,admin] of [[1,'admin',1],[2,'operador',0]])db.prepare('INSERT INTO users VALUES(?,?,?,?,1,NULL,?,?)').run(id,name,hash,admin,'now','now');
  const app=express();app.use(express.json());app.use(session({secret:'isolated-qa-only',resave:false,saveUninitialized:false}));
  app.use('/api/auth',authRouter(db));app.use('/api/usuarios',requireAuth(db),requireAdmin,usuariosRouter(db));return {app,db};
}

describe('permisos de aplicaciones del VPS desde Usuarios',()=>{
  it('admin puede guardar y revocar cada permiso; sesión existente ve el cambio',async()=>{
    const {app,db}=fixture(),admin=request.agent(app),operator=request.agent(app);
    await admin.post('/api/auth/login').send({username:'admin',password:'qa-test-only-password'}).expect(200);
    await operator.post('/api/auth/login').send({username:'operador',password:'qa-test-only-password'}).expect(200);
    const catalog=await admin.get('/api/usuarios/herramientas').expect(200);
    for(const tool of VPS_APPLICATIONS)expect(catalog.body.herramientas.some(h=>h.id===tool.id)).toBe(true);
    await operator.put('/api/usuarios/2/permisos').send({permisos:[{herramienta:'gestion-ventas',nivel:'read'}]}).expect(403);
    const permisos=VPS_APPLICATIONS.map(h=>({herramienta:h.id,nivel:'read'}));
    await admin.put('/api/usuarios/2/permisos').send({permisos}).expect(200);
    const me=await operator.get('/api/auth/me').expect(200);expect(me.body.is_admin).toBe(false);expect(me.body.permisos).toEqual(expect.arrayContaining(permisos));
    await admin.put('/api/usuarios/2/permisos').send({permisos:[]}).expect(200);
    expect((await operator.get('/api/auth/me')).body.permisos).toEqual([]);
    expect(db.prepare('SELECT is_admin FROM users WHERE id=2').get().is_admin).toBe(0);
    await admin.patch('/api/usuarios/2').send({activo:false}).expect(200);await operator.get('/api/auth/me').expect(401);
  });
  it('el taller comparte únicamente la consulta de precio, nunca las escrituras',()=>{
    const permissions=[{herramienta:'gestion-taller',nivel:'read'}];
    expect(permiteAcceso(permissions,resolvePermiso('GET','/consulta-precios/buscar'))).toBe(true);
    for(const path of ['/consulta-precios/ean','/consulta-precios/importar','/usuarios/1/permisos'])expect(permiteAcceso(permissions,resolvePermiso('POST',path))).toBe(false);
  });
  it('sincroniza y audita el rol explícito de Mensajería y protege al último supervisor',async()=>{
    const {app,db}=fixture(),admin=request.agent(app),operator=request.agent(app);
    db.exec(`CREATE TABLE mensajeria_roles(user_id INTEGER PRIMARY KEY,role TEXT,updated_by INTEGER,updated_at TEXT);
      CREATE TABLE mensajeria_roles_audit(id INTEGER PRIMARY KEY,actor_id INTEGER,user_id INTEGER,old_role TEXT,new_role TEXT,created_at TEXT);`);
    db.prepare('INSERT INTO mensajeria_roles VALUES(?,?,?,?)').run(2,'none',1,'now');
    app.use('/api/mensajeria',requireAuth(db),mensajeriaRouter(db,{env:{},fetchImpl:async()=>{throw new Error('No external calls in permission tests');}}));
    await admin.post('/api/auth/login').send({username:'admin',password:'qa-test-only-password'}).expect(200);
    await operator.post('/api/auth/login').send({username:'operador',password:'qa-test-only-password'}).expect(200);
    await operator.get('/api/mensajeria/bootstrap').expect(403);
    const save=permisos=>admin.put('/api/usuarios/2/permisos').send({permisos});
    await save([{herramienta:'mensajeria',nivel:'write'}]).expect(200);
    expect(db.prepare('SELECT role FROM mensajeria_roles WHERE user_id=2').get().role).toBe('agent');
    expect((await operator.get('/api/mensajeria/bootstrap').expect(200)).body.actor.role).toBe('agent');
    await save([{herramienta:'mensajeria',nivel:'read'}]).expect(200);
    expect(db.prepare('SELECT role FROM mensajeria_roles WHERE user_id=2').get().role).toBe('reader');
    expect((await operator.get('/api/mensajeria/bootstrap').expect(200)).body.actor.role).toBe('reader');
    await save([]).expect(200);
    expect(db.prepare('SELECT role FROM mensajeria_roles WHERE user_id=2').get().role).toBe('none');
    await operator.get('/api/mensajeria/bootstrap').expect(403);
    await save([{herramienta:'mensajeria-supervision',nivel:'write'}]).expect(200);
    expect((await operator.get('/api/mensajeria/bootstrap').expect(200)).body.actor.role).toBe('supervisor');
    db.prepare('INSERT INTO mensajeria_roles VALUES(?,?,?,?)').run(1,'reader',1,'now');
    await save([]).expect(409);
    expect(db.prepare('SELECT role FROM mensajeria_roles WHERE user_id=2').get().role).toBe('supervisor');
    expect(db.prepare('SELECT herramienta FROM user_permisos WHERE user_id=2').all()).toEqual([{herramienta:'mensajeria-supervision'}]);
    expect(db.prepare('SELECT COUNT(*) n FROM mensajeria_roles_audit WHERE actor_id=1').get().n).toBe(4);
  });
});
