import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import { ensureTablesJornada } from '../routes/jornada.js';
import { fechaLocalHoy, abrirJornada, jornadaDeHoy, anotarVencimiento, reclamarOla, sincronizarMiniOlas } from '../lib/jornada.js';

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

  it('POST /ola/:id/reclamar congela y devuelve olaNueva', async () => {
    const app = appConUsuario('op1');
    const abrir = await request(app).post('/api/jornada/abrir').send({});
    const waveId = abrir.body.olaInicial.id;
    const r = await request(app).post(`/api/jornada/ola/${waveId}/reclamar`).send({});
    expect(r.status).toBe(200);
    expect(r.body.claim).toHaveProperty('por_vencer');
  });

  it('GET /olas sincroniza y devuelve las olas del día con sus items', async () => {
    const app = appConUsuario('tester');
    await request(app).post('/api/jornada/abrir').send({});
    db.prepare(`INSERT INTO pedidos_cache (clave, canal, numero_pedido, comprador, fecha, estado_envio, espejo_ml, items_json, actualizado_en)
      VALUES ('web:9','web','9','Cliente',?,'pendiente',0,'[]',?)`).run(new Date().toISOString(), new Date().toISOString());
    const r = await request(app).get('/api/jornada/olas');
    expect(r.status).toBe(200);
    const mini = r.body.olas.find(o => o.tipo === 'mini');
    expect(mini.items.map(i => i.pedido_clave)).toEqual(['web:9']);
  });
});

describe('anotarVencimiento', () => {
  it('por_vencer es false lejos del vencimiento y true dentro de los 10 minutos', () => {
    const claim = { expires_at: new Date('2026-09-01T12:15:00Z').toISOString() };
    const lejos = anotarVencimiento(claim, new Date('2026-09-01T12:00:00Z'));
    expect(lejos.por_vencer).toBe(false);
    expect(lejos.segundos_restantes).toBe(900);
    const cerca = anotarVencimiento(claim, new Date('2026-09-01T12:06:00Z'));
    expect(cerca.por_vencer).toBe(true);
    expect(cerca.segundos_restantes).toBe(540);
  });

  it('segundos_restantes nunca es negativo si ya venció', () => {
    const claim = { expires_at: new Date('2026-09-01T12:00:00Z').toISOString() };
    const r = anotarVencimiento(claim, new Date('2026-09-01T12:05:00Z'));
    expect(r.segundos_restantes).toBe(0);
    expect(r.por_vencer).toBe(true);
  });
});

describe('reclamarOla', () => {
  let db, dayId, waveId;
  beforeEach(() => {
    db = openDb(TEST_DB);
    ensureTablesJornada(db);
    const ts = new Date().toISOString();
    dayId = db.prepare(`INSERT INTO operational_days (fecha, estado, abierta_por, abierta_en) VALUES (?,?,?,?)`)
      .run('2026-09-01', 'abierta', 'tester', ts).lastInsertRowid;
    waveId = db.prepare(`INSERT INTO pick_waves (operational_day_id, tipo, estado, creada_en) VALUES (?,'mini','abierta',?)`)
      .run(dayId, ts).lastInsertRowid;
    db.prepare(`INSERT INTO pick_wave_items (pick_wave_id, pedido_clave, agregado_en) VALUES (?,?,?)`).run(waveId, 'ml:1', ts);
  });
  afterEach(() => { db.close(); try { fs.unlinkSync(TEST_DB); } catch {} });

  it('congela la ola con exactamente sus items y abre una mini-ola nueva vacía', () => {
    const r = reclamarOla(db, waveId, 'op1');
    expect(r.ok).toBe(true);
    expect(r.olaCongelada.estado).toBe('en_picking');
    expect(r.olaNueva.tipo).toBe('mini');
    expect(r.olaNueva.estado).toBe('abierta');
    const itemsCongelados = db.prepare('SELECT pedido_clave FROM pick_wave_items WHERE pick_wave_id=?').all(r.olaCongelada.id);
    expect(itemsCongelados.map(i => i.pedido_clave)).toEqual(['ml:1']);
  });

  it('un pedido agregado después del claim cae en la ola nueva, no en la congelada', () => {
    const r = reclamarOla(db, waveId, 'op1');
    const ts = new Date().toISOString();
    db.prepare(`INSERT INTO pick_wave_items (pick_wave_id, pedido_clave, agregado_en) VALUES (?,?,?)`).run(r.olaNueva.id, 'web:2', ts);
    const enCongelada = db.prepare('SELECT COUNT(*) c FROM pick_wave_items WHERE pick_wave_id=? AND pedido_clave=?').get(r.olaCongelada.id, 'web:2').c;
    expect(enCongelada).toBe(0);
  });

  it('un segundo claim del mismo usuario mientras el primero sigue vigente no crea una segunda ola nueva', () => {
    const r1 = reclamarOla(db, waveId, 'op1');
    const r2 = reclamarOla(db, r1.olaCongelada.id, 'op1');
    expect(r2.ok).toBe(true);
    const totalOlas = db.prepare('SELECT COUNT(*) c FROM pick_waves WHERE operational_day_id=?').get(dayId).c;
    expect(totalOlas).toBe(2); // la congelada original + la nueva abierta por el primer claim, sin una tercera
  });

  it('claim de otro usuario mientras está vigente responde WAVE_CLAIMED', () => {
    reclamarOla(db, waveId, 'op1');
    const r2 = reclamarOla(db, waveId, 'op2');
    // la ola ya no está en estado 'abierta' tras el primer claim; el segundo reclamo sobre
    // la MISMA ola original ahora es sobre una ola en_picking tomada por op1.
    expect(r2.ok).toBe(false);
    expect(r2.code).toBe('WAVE_CLAIMED');
  });

  it('anota por_vencer/segundos_restantes en el claim devuelto', () => {
    const r = reclamarOla(db, waveId, 'op1', {}, new Date('2026-09-01T12:00:00Z'));
    expect(r.claim).toHaveProperty('por_vencer', false);
    expect(r.claim).toHaveProperty('segundos_restantes', 900);
  });
});

describe('sincronizarMiniOlas', () => {
  let db;
  beforeEach(() => {
    db = openDb(TEST_DB);
    ensureTablesJornada(db);
    db.prepare(`CREATE TABLE IF NOT EXISTS pedidos_cache (
      clave TEXT PRIMARY KEY, canal TEXT NOT NULL, wc_order_id INTEGER, ml_order_id TEXT,
      numero_pedido TEXT, comprador TEXT, fecha TEXT, fecha_despacho TEXT, estado_envio TEXT NOT NULL,
      estado_wc TEXT, espejo_ml INTEGER NOT NULL DEFAULT 0, logistic_type TEXT,
      substatus TEXT, items_json TEXT NOT NULL, actualizado_en TEXT NOT NULL
    )`).run();
  });
  afterEach(() => { db.close(); try { fs.unlinkSync(TEST_DB); } catch {} });

  function insertarPedido(clave, canal, { espejo_ml = 0, fecha_despacho = null } = {}) {
    db.prepare(`INSERT INTO pedidos_cache (clave, canal, numero_pedido, comprador, fecha, fecha_despacho, estado_envio, espejo_ml, items_json, actualizado_en)
      VALUES (?,?,?,?,?,?,'pendiente',?,'[]',?)`)
      .run(clave, canal, clave, 'Cliente', new Date().toISOString(), fecha_despacho, espejo_ml, new Date().toISOString());
  }

  it('sin jornada abierta hoy, no hace nada', () => {
    const r = sincronizarMiniOlas(db, new Date('2026-09-01T12:00:00Z'));
    expect(r).toEqual({ ok: true, agregados: 0, motivo: 'sin_jornada_abierta' });
  });

  it('agrega pedidos web/ml no urgentes a una única mini-ola abierta', () => {
    const now = new Date('2026-09-01T12:00:00Z');
    abrirJornada(db, { usuario: 'tester' }, now);
    insertarPedido('web:1', 'web');
    insertarPedido('web:2', 'web');
    const r = sincronizarMiniOlas(db, now);
    expect(r.agregados).toBe(2);
    const minis = db.prepare("SELECT * FROM pick_waves WHERE tipo='mini' AND estado='abierta'").all();
    expect(minis).toHaveLength(1);
    const items = db.prepare('SELECT pedido_clave FROM pick_wave_items WHERE pick_wave_id=?').all(minis[0].id);
    expect(items.map(i => i.pedido_clave).sort()).toEqual(['web:1', 'web:2']);
  });

  it('un pedido ML con fecha_despacho de hoy crea su propia mini-ola ml_urgente congelada', () => {
    const now = new Date('2026-09-01T12:00:00Z');
    abrirJornada(db, { usuario: 'tester' }, now);
    insertarPedido('ml:1', 'ml', { fecha_despacho: fechaLocalHoy(now) });
    sincronizarMiniOlas(db, now);
    const urgente = db.prepare("SELECT * FROM pick_waves WHERE tipo='ml_urgente'").get();
    expect(urgente).toBeTruthy();
    expect(urgente.estado).toBe('congelada');
    const items = db.prepare('SELECT pedido_clave FROM pick_wave_items WHERE pick_wave_id=?').all(urgente.id);
    expect(items.map(i => i.pedido_clave)).toEqual(['ml:1']);
  });

  it('un pedido ML con fecha_despacho de mañana NO es urgente, cae en la mini-ola acumulativa', () => {
    const now = new Date('2026-09-01T12:00:00Z');
    abrirJornada(db, { usuario: 'tester' }, now);
    insertarPedido('ml:2', 'ml', { fecha_despacho: '2026-09-02' });
    sincronizarMiniOlas(db, now);
    const urgente = db.prepare("SELECT * FROM pick_waves WHERE tipo='ml_urgente'").get();
    expect(urgente).toBeUndefined();
    const mini = db.prepare("SELECT * FROM pick_waves WHERE tipo='mini' AND estado='abierta'").get();
    const items = db.prepare('SELECT pedido_clave FROM pick_wave_items WHERE pick_wave_id=?').all(mini.id);
    expect(items.map(i => i.pedido_clave)).toEqual(['ml:2']);
  });

  it('llamar dos veces seguidas no duplica items (idempotente)', () => {
    const now = new Date('2026-09-01T12:00:00Z');
    abrirJornada(db, { usuario: 'tester' }, now);
    insertarPedido('web:1', 'web');
    sincronizarMiniOlas(db, now);
    const r2 = sincronizarMiniOlas(db, now);
    expect(r2.agregados).toBe(0);
    const total = db.prepare('SELECT COUNT(*) c FROM pick_wave_items').get().c;
    expect(total).toBe(1);
  });

  it('un pedido ya incluido en la ola inicial no se vuelve a agregar a la mini-ola', () => {
    const now = new Date('2026-09-01T12:00:00Z');
    insertarPedido('web:1', 'web');
    abrirJornada(db, { usuario: 'tester' }, now); // web:1 entra en la inicial
    const r = sincronizarMiniOlas(db, now);
    expect(r.agregados).toBe(0);
  });
});
