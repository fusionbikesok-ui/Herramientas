import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import { openDb } from '../db/index.js';
import { preparacionRouter } from '../routes/preparacion.js';
import { calcularFechaDespacho, fechaEstimadaShipment, horaValida, normalizarHorarios, asegurarEsquemaHorarios } from '../lib/horariosDespacho.js';
import { hashPassword, requireAuth } from '../lib/auth.js';
import { permiteAcceso, resolvePermiso } from '../lib/permisos.js';

const laborables = normalizarHorarios([]);

describe('horarios de despacho', () => {
  it('valida cortes HH:MM', () => {
    expect(horaValida('16:00')).toBe(true);
    expect(horaValida('24:00')).toBe(false);
    expect(horaValida('4:00')).toBe(false);
  });

  it('propone el mismo día antes del corte y el siguiente después', () => {
    expect(calcularFechaDespacho(laborables, new Date('2026-08-28T17:00:00Z'))).toBe('2026-08-28');
    expect(calcularFechaDespacho(laborables, new Date('2026-08-28T20:30:00Z'))).toBe('2026-08-31');
  });

  it('salta fines de semana deshabilitados', () => {
    expect(calcularFechaDespacho(laborables, new Date('2026-08-29T14:00:00Z'))).toBe('2026-08-31');
  });

  it('no rompe el sync si no hay días habilitados', () => {
    expect(calcularFechaDespacho(laborables.map((h) => ({ ...h, habilitado: false })), new Date())).toBeNull();
  });

  it('usa solo el límite de preparación del shipment, no la fecha de entrega', () => {
    expect(fechaEstimadaShipment({ date_estimated_delivery: '2026-09-03' })).toBeNull();
    expect(fechaEstimadaShipment({ shipping_option: { estimated_handling_limit: { date: '2026-08-31T12:00:00Z' } } })).toBe('2026-08-31');
    expect(fechaEstimadaShipment({ sla: { expected_date: '2026-09-01T23:59:59-03:00' } })).toBe('2026-09-01');
    expect(fechaEstimadaShipment({ sla: { expected_date: '2026-09-01T00:30:00Z' } })).toBe('2026-08-31');
    expect(fechaEstimadaShipment({ sla: { expected_date: '2026-02-30' }, expected_date: '2026-09-02' })).toBe('2026-09-02');
    expect(fechaEstimadaShipment({ sla: { expected_date: '2026-02-30T00:30:00Z' }, expected_date: '2026-09-02' })).toBe('2026-09-02');
    expect(fechaEstimadaShipment({ sla: { expected_date: '2026-02-30' }, date_estimated_delivery: '2026-09-03' })).toBeNull();
  });

  it('expone y actualiza los siete días mediante el router', async () => {
    const file = path.join(process.cwd(), 'test/tmp-horarios-despacho.sqlite');
    const db = openDb(file);
    const app = express(); app.use(express.json());
    app.use('/api/preparacion', preparacionRouter(db, { woo: null, ml: null, colaFotos: { disparoInmediato: false } }));
    const inicial = await request(app).get('/api/preparacion/horarios-despacho');
    expect(inicial.status).toBe(200);
    expect(inicial.body.data).toHaveLength(7);
    expect(inicial.body.version).toBe(1);
    const horarios = inicial.body.data.map((h) => ({ ...h, habilitado: h.dia === 6, hora_corte: '15:30' }));
    const guardado = await request(app).put('/api/preparacion/horarios-despacho').send({ horarios, expected_version: inicial.body.version });
    expect(guardado.status).toBe(200);
    expect(guardado.body.version).toBe(2);
    expect(guardado.body.data.find((h) => h.dia === 6)).toMatchObject({ habilitado: true, hora_corte: '15:30' });
    const invalido = await request(app).put('/api/preparacion/horarios-despacho').send({ horarios: horarios.slice(0, 6), expected_version: 2 });
    expect(invalido.status).toBe(422);
    const ninguno = await request(app).put('/api/preparacion/horarios-despacho').send({ horarios: horarios.map((h) => ({ ...h, habilitado: false })), expected_version: 2 });
    expect(ninguno.status).toBe(422);
    const conflicto = await request(app).put('/api/preparacion/horarios-despacho').send({ horarios, expected_version: 1 });
    expect(conflicto.status).toBe(409);
    db.close();
    try { fs.unlinkSync(file); } catch {}
  });

  it('repite la migración 022 y asegura una base existente sin duplicar columnas', () => {
    const file = path.join(process.cwd(), 'test/tmp-horarios-migracion.sqlite');
    const db = openDb(file);
    db.exec('DROP TABLE IF EXISTS despacho_horarios; DROP TABLE IF EXISTS despacho_horarios_meta;');
    db.exec(`CREATE TABLE pedidos_cache (clave TEXT PRIMARY KEY, estado_envio TEXT NOT NULL, items_json TEXT NOT NULL, actualizado_en TEXT NOT NULL)`);
    db.exec(fs.readFileSync('migrations/032_despacho_horarios.sql', 'utf8'));
    db.exec(fs.readFileSync('migrations/032_despacho_horarios.sql', 'utf8'));
    asegurarEsquemaHorarios(db);
    asegurarEsquemaHorarios(db);
    expect(db.prepare("SELECT COUNT(*) AS n FROM despacho_horarios").get().n).toBe(7);
    expect(db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('pedidos_cache') WHERE name='fecha_despacho'").get().n).toBe(1);
    db.close(); try { fs.unlinkSync(file); } catch {}
  });

  it('rechaza una petición sin autenticación cuando se monta con el middleware real', async () => {
    const file = path.join(process.cwd(), 'test/tmp-horarios-auth.sqlite');
    const db = openDb(file);
    const app = express(); app.use(express.json());
    app.use(requireAuth(db));
    app.use('/api/preparacion', preparacionRouter(db, { woo: null, ml: null, colaFotos: { disparoInmediato: false } }));
    const res = await request(app).get('/api/preparacion/horarios-despacho');
    expect(res.status).toBe(401);
    db.close(); try { fs.unlinkSync(file); } catch {}
  });

  it('exige permiso de escritura de Preparación para actualizar horarios', () => {
    const requisito = resolvePermiso('PUT', '/preparacion/horarios-despacho');
    expect(requisito).toMatchObject({ anyOf: ['preparacion'], nivel: 'write' });
    expect(permiteAcceso([], requisito)).toBe(false);
    expect(permiteAcceso([{ herramienta: 'preparacion', nivel: 'read' }], requisito)).toBe(false);
    expect(permiteAcceso([{ herramienta: 'preparacion', nivel: 'write' }], requisito)).toBe(true);
  });

  it('aplica autorización HTTP real: sin permiso no lee ni actualiza', async () => {
    const file = path.join(process.cwd(), 'test/tmp-horarios-permiso-http.sqlite');
    const db = openDb(file);
    db.prepare(`INSERT INTO users (username, pass_hash, is_admin, activo, creado_en, actualizado_en)
      VALUES (?, ?, 0, 1, ?, ?)`).run('operador-sin-permiso', hashPassword('test'), new Date().toISOString(), new Date().toISOString());
    const app = express(); app.use(express.json());
    app.use((req, res, next) => {
      req.session = { userId: 1 };
      next();
    });
    app.use(requireAuth(db));
    app.use((req, res, next) => {
      const permiso = resolvePermiso(req.method, req.path);
      if (!permiteAcceso(req.user.permisos, permiso)) return res.status(403).json({ ok: false, error: 'Acceso no autorizado' });
      return next();
    });
    app.use('/api/preparacion', preparacionRouter(db, { woo: null, ml: null, colaFotos: { disparoInmediato: false } }));
    expect((await request(app).get('/api/preparacion/horarios-despacho')).status).toBe(403);
    expect((await request(app).put('/api/preparacion/horarios-despacho').send({ horarios: [], expected_version: 1 })).status).toBe(403);
    db.close(); try { fs.unlinkSync(file); } catch {}
  });

  it('registra usuario, versión y valores anterior/nuevo en auditoría', async () => {
    const file = path.join(process.cwd(), 'test/tmp-horarios-auditoria.sqlite');
    const db = openDb(file);
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.user = { username: 'admin-prueba' }; next(); });
    app.use('/api/preparacion', preparacionRouter(db, { woo: null, ml: null, colaFotos: { disparoInmediato: false } }));
    const inicial = await request(app).get('/api/preparacion/horarios-despacho');
    const horarios = inicial.body.data.map((h) => ({ ...h, habilitado: h.dia === 1 ? true : h.habilitado, hora_corte: '15:00' }));
    expect((await request(app).put('/api/preparacion/horarios-despacho').send({ horarios, expected_version: 1 })).status).toBe(200);
    const evento = db.prepare('SELECT * FROM despacho_horarios_auditoria ORDER BY id DESC LIMIT 1').get();
    expect(evento.usuario).toBe('admin-prueba');
    expect(evento.version_anterior).toBe(1);
    expect(evento.version_nueva).toBe(2);
    expect(JSON.parse(evento.valores_anteriores_json)).toHaveLength(7);
    expect(JSON.parse(evento.valores_nuevos_json)).toHaveLength(7);
    db.close(); try { fs.unlinkSync(file); } catch {}
  });

  it('resuelve dos actualizaciones concurrentes determinísticamente sin devolver 500', async () => {
    const file = path.join(process.cwd(), 'test/tmp-horarios-concurrencia.sqlite');
    const dbA = openDb(file);
    const dbB = openDb(file);
    // Mantiene la prueba acotada: la contención debe resolverse como conflicto,
    // no quedar esperando indefinidamente por el timeout global de SQLite.
    dbA.pragma('busy_timeout = 100');
    dbB.pragma('busy_timeout = 100');
    const appA = express(); appA.use(express.json());
    const appB = express(); appB.use(express.json());
    appA.use('/api/preparacion', preparacionRouter(dbA, { woo: null, ml: null, colaFotos: { disparoInmediato: false } }));
    appB.use('/api/preparacion', preparacionRouter(dbB, { woo: null, ml: null, colaFotos: { disparoInmediato: false } }));
    const horarios = (await request(appA).get('/api/preparacion/horarios-despacho')).body.data
      .map((h) => ({ ...h, habilitado: h.dia === 1, hora_corte: '14:00' }));
    const [a, b] = await Promise.all([
      request(appA).put('/api/preparacion/horarios-despacho').send({ horarios, expected_version: 1 }),
      request(appB).put('/api/preparacion/horarios-despacho').send({ horarios, expected_version: 1 }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect([a, b].find((res) => res.status === 409).body.code).toBe('VERSION_CONFLICT');
    expect(dbA.prepare('SELECT version FROM despacho_horarios_meta WHERE id=1').get().version).toBe(2);
    dbA.close(); dbB.close(); try { fs.unlinkSync(file); } catch {}
  });
});
