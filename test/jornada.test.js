import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import { ensureTablesJornada } from '../routes/jornada.js';
import { fechaLocalHoy, abrirJornada, jornadaDeHoy } from '../lib/jornada.js';

const TEST_DB = 'test/jornada.test.sqlite';

describe('ensureTablesJornada', () => {
  let db;
  beforeEach(() => { db = openDb(TEST_DB); });
  afterEach(() => { db.close(); try { fs.unlinkSync(TEST_DB); } catch {} });

  it('crea las 4 tablas y es idempotente al llamarse dos veces', () => {
    ensureTablesJornada(db);
    ensureTablesJornada(db); // no debe tirar error
    const tablas = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    expect(tablas).toEqual(expect.arrayContaining([
      'operational_days', 'pick_waves', 'pick_wave_items', 'pick_wave_claims',
    ]));
  });

  it('operational_days rechaza fecha duplicada (UNIQUE)', () => {
    ensureTablesJornada(db);
    const ts = new Date().toISOString();
    db.prepare(`INSERT INTO operational_days (fecha, estado, abierta_por, abierta_en) VALUES (?,?,?,?)`)
      .run('2026-09-01', 'abierta', 'tester', ts);
    expect(() => db.prepare(`INSERT INTO operational_days (fecha, estado, abierta_por, abierta_en) VALUES (?,?,?,?)`)
      .run('2026-09-01', 'abierta', 'tester', ts)).toThrow();
  });

  it('pick_waves rechaza una segunda mini-ola abierta en el mismo día (índice único parcial)', () => {
    ensureTablesJornada(db);
    const ts = new Date().toISOString();
    const dayId = db.prepare(`INSERT INTO operational_days (fecha, estado, abierta_por, abierta_en) VALUES (?,?,?,?)`)
      .run('2026-09-01', 'abierta', 'tester', ts).lastInsertRowid;
    db.prepare(`INSERT INTO pick_waves (operational_day_id, tipo, estado, creada_en) VALUES (?,?,?,?)`)
      .run(dayId, 'mini', 'abierta', ts);
    expect(() => db.prepare(`INSERT INTO pick_waves (operational_day_id, tipo, estado, creada_en) VALUES (?,?,?,?)`)
      .run(dayId, 'mini', 'abierta', ts)).toThrow();
  });

  it('pick_wave_items rechaza que el mismo pedido esté en dos olas (índice único sobre pedido_clave)', () => {
    ensureTablesJornada(db);
    const ts = new Date().toISOString();
    const dayId = db.prepare(`INSERT INTO operational_days (fecha, estado, abierta_por, abierta_en) VALUES (?,?,?,?)`)
      .run('2026-09-01', 'abierta', 'tester', ts).lastInsertRowid;
    const waveId = db.prepare(`INSERT INTO pick_waves (operational_day_id, tipo, estado, creada_en) VALUES (?,?,?,?)`)
      .run(dayId, 'mini', 'abierta', ts).lastInsertRowid;
    db.prepare(`INSERT INTO pick_wave_items (pick_wave_id, pedido_clave, agregado_en) VALUES (?,?,?)`)
      .run(waveId, 'ml:1', ts);
    expect(() => db.prepare(`INSERT INTO pick_wave_items (pick_wave_id, pedido_clave, agregado_en) VALUES (?,?,?)`)
      .run(waveId, 'ml:1', ts)).toThrow();
  });
});

describe('abrirJornada', () => {
  let db;
  beforeEach(() => {
    db = openDb(TEST_DB);
    ensureTablesJornada(db);
    // pedidos_cache la crea preparacionRouter; para no depender de ese router en este test,
    // se crea acá mínimamente igual que en preparacion.js.
    db.prepare(`CREATE TABLE IF NOT EXISTS pedidos_cache (
      clave TEXT PRIMARY KEY, canal TEXT NOT NULL, wc_order_id INTEGER, ml_order_id TEXT,
      numero_pedido TEXT, comprador TEXT, fecha TEXT, estado_envio TEXT NOT NULL,
      estado_wc TEXT, espejo_ml INTEGER NOT NULL DEFAULT 0, logistic_type TEXT,
      substatus TEXT, items_json TEXT NOT NULL, actualizado_en TEXT NOT NULL
    )`).run();
  });
  afterEach(() => { db.close(); try { fs.unlinkSync(TEST_DB); } catch {} });

  function insertarPedido(clave, canal, fecha, extra = {}) {
    db.prepare(`INSERT INTO pedidos_cache (clave, canal, numero_pedido, comprador, fecha, estado_envio, espejo_ml, items_json, actualizado_en)
      VALUES (?,?,?,?,?,'pendiente',?,'[]',?)`)
      .run(clave, canal, clave, 'Cliente', fecha, extra.espejo_ml ? 1 : 0, new Date().toISOString());
  }

  it('crea la jornada y congela la ola inicial con los pedidos elegibles en ese instante', () => {
    insertarPedido('ml:1', 'ml', '2026-09-01T10:00:00Z');
    insertarPedido('web:1', 'web', '2026-09-01T09:00:00Z');
    const now = new Date('2026-09-01T13:00:00Z');
    const r = abrirJornada(db, { usuario: 'tester' }, now);
    expect(r.ok).toBe(true);
    expect(r.jornada.fecha).toBe(fechaLocalHoy(now));
    expect(r.olaInicial.tipo).toBe('inicial');
    expect(r.olaInicial.estado).toBe('congelada');
    const items = db.prepare('SELECT pedido_clave FROM pick_wave_items WHERE pick_wave_id=?').all(r.olaInicial.id).map(x => x.pedido_clave);
    expect(items).toEqual(['ml:1', 'web:1']);
  });

  it('un pedido insertado DESPUÉS de abrir la jornada no entra en la ola inicial', () => {
    const now = new Date('2026-09-01T13:00:00Z');
    const r = abrirJornada(db, { usuario: 'tester' }, now);
    insertarPedido('web:2', 'web', '2026-09-01T14:00:00Z');
    const items = db.prepare('SELECT pedido_clave FROM pick_wave_items WHERE pick_wave_id=?').all(r.olaInicial.id);
    expect(items).toHaveLength(0);
  });

  it('doble apertura el mismo día local devuelve 409 lógico sin crear una segunda fila', () => {
    const now = new Date('2026-09-01T13:00:00Z');
    abrirJornada(db, { usuario: 'tester' }, now);
    const r2 = abrirJornada(db, { usuario: 'otro' }, new Date('2026-09-01T15:00:00Z'));
    expect(r2.ok).toBe(false);
    expect(r2.code).toBe('OPERATIONAL_DAY_EXISTS');
    const filas = db.prepare('SELECT COUNT(*) c FROM operational_days').get().c;
    expect(filas).toBe(1);
  });

  it('jornadaDeHoy devuelve null si no se abrió y la fila si se abrió', () => {
    const now = new Date('2026-09-01T13:00:00Z');
    expect(jornadaDeHoy(db, now)).toBeNull();
    abrirJornada(db, { usuario: 'tester' }, now);
    expect(jornadaDeHoy(db, now).fecha).toBe(fechaLocalHoy(now));
  });
});

import express from 'express';
import request from 'supertest';
import { jornadaRouter } from '../routes/jornada.js';

describe('rutas /api/jornada', () => {
  let db;
  beforeEach(() => {
    db = openDb(TEST_DB);
    db.prepare(`CREATE TABLE IF NOT EXISTS pedidos_cache (
      clave TEXT PRIMARY KEY, canal TEXT NOT NULL, wc_order_id INTEGER, ml_order_id TEXT,
      numero_pedido TEXT, comprador TEXT, fecha TEXT, estado_envio TEXT NOT NULL,
      estado_wc TEXT, espejo_ml INTEGER NOT NULL DEFAULT 0, logistic_type TEXT,
      substatus TEXT, items_json TEXT NOT NULL, actualizado_en TEXT NOT NULL
    )`).run();
  });
  afterEach(() => { db.close(); try { fs.unlinkSync(TEST_DB); } catch {} });

  function appConUsuario(usuario) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { username: usuario, is_admin: 1 }; next(); });
    app.use('/api/jornada', jornadaRouter(db, {}));
    return app;
  }

  it('POST /abrir crea la jornada y responde la ola inicial', async () => {
    const r = await request(appConUsuario('tester')).post('/api/jornada/abrir').send({});
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.jornada.estado).toBe('abierta');
    expect(r.body.olaInicial.tipo).toBe('inicial');
  });

  it('POST /abrir sin usuario autenticado responde 401', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/jornada', jornadaRouter(db, {}));
    const r = await request(app).post('/api/jornada/abrir').send({});
    expect(r.status).toBe(401);
  });

  it('doble POST /abrir el mismo día responde 409 OPERATIONAL_DAY_EXISTS', async () => {
    const app = appConUsuario('tester');
    await request(app).post('/api/jornada/abrir').send({});
    const r2 = await request(app).post('/api/jornada/abrir').send({});
    expect(r2.status).toBe(409);
    expect(r2.body.code).toBe('OPERATIONAL_DAY_EXISTS');
  });

  it('GET /hoy devuelve null antes de abrir y la jornada después', async () => {
    const app = appConUsuario('tester');
    const antes = await request(app).get('/api/jornada/hoy');
    expect(antes.body.jornada).toBeNull();
    await request(app).post('/api/jornada/abrir').send({});
    const despues = await request(app).get('/api/jornada/hoy');
    expect(despues.body.jornada.estado).toBe('abierta');
  });
});
