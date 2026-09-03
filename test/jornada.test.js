import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import { ensureTablesJornada } from '../routes/jornada.js';
import { fechaLocalHoy, abrirJornada, jornadaDeHoy, anotarVencimiento, reclamarOla, sincronizarMiniOlas, cerrarJornada, iniciarBusqueda, configurarZona, pedirAyudaZona, recibirAyudaZona, pasarAMesa, asignarUnidadMesa, registrarFaltante, resolverFaltante, cerrarOla, pausarOla, reanudarOla } from '../lib/jornada.js';

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

  it('pick_wave_items bloquea duplicados en la jornada pero permite arrastre entre jornadas', () => {
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
    const otraOlaMismaJornada = db.prepare(`INSERT INTO pick_waves (operational_day_id, tipo, estado, creada_en) VALUES (?,'inicial','congelada',?)`)
      .run(dayId, ts).lastInsertRowid;
    expect(() => db.prepare(`INSERT INTO pick_wave_items (pick_wave_id, pedido_clave, agregado_en) VALUES (?,?,?)`)
      .run(otraOlaMismaJornada, 'ml:1', ts)).toThrow();
    const otroDia = db.prepare(`INSERT INTO operational_days (fecha, estado, abierta_por, abierta_en) VALUES (?,?,?,?)`)
      .run('2026-09-02', 'abierta', 'tester', ts).lastInsertRowid;
    const otraOla = db.prepare(`INSERT INTO pick_waves (operational_day_id, tipo, estado, creada_en) VALUES (?,'inicial','congelada',?)`)
      .run(otroDia, ts).lastInsertRowid;
    expect(() => db.prepare(`INSERT INTO pick_wave_items (pick_wave_id, pedido_clave, agregado_en) VALUES (?,?,?)`)
      .run(otraOla, 'ml:1', ts)).not.toThrow();
  });

  it('la migración 043 puede ejecutarse repetidamente sobre el esquema 042→043', () => {
    const migration = fs.readFileSync('migrations/043_operational_day_wave_item_scope.sql', 'utf8');
    expect(() => db.exec(migration)).not.toThrow();
    expect(() => db.exec(migration)).not.toThrow();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='uq_pick_wave_items_day_pedido'").get()).toBeTruthy();
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
      substatus TEXT, items_json TEXT NOT NULL, actualizado_en TEXT NOT NULL,
      fecha_despacho_limite TEXT, estado_despacho TEXT, despacho_motivo TEXT,
      shipment_limite_original TEXT
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

  it('excluye de la ola una preparación local ya completada o cerrada', () => {
    db.prepare(`CREATE TABLE preparaciones (id INTEGER PRIMARY KEY, clave TEXT UNIQUE, estado TEXT NOT NULL)`).run();
    insertarPedido('web:completo', 'web', '2026-09-01T09:00:00Z');
    insertarPedido('web:cerrado', 'web', '2026-09-01T10:00:00Z');
    db.prepare('INSERT INTO preparaciones (clave, estado) VALUES (?,?)').run('web:completo', 'completada');
    db.prepare('INSERT INTO preparaciones (clave, estado) VALUES (?,?)').run('web:cerrado', 'cerrada_sin_evidencia');
    const r = abrirJornada(db, { usuario: 'tester' }, new Date('2026-09-01T13:00:00Z'));
    expect(db.prepare('SELECT pedido_clave FROM pick_wave_items WHERE pick_wave_id=?').all(r.olaInicial.id)).toEqual([]);
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
    for (const column of ['fecha_despacho_limite', 'estado_despacho', 'despacho_motivo', 'shipment_limite_original']) {
      if (!db.prepare('PRAGMA table_info(pedidos_cache)').all().some(c => c.name === column)) {
        db.exec(`ALTER TABLE pedidos_cache ADD COLUMN ${column} TEXT`);
      }
    }
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
    expect(r.body.jornada.hora_corte_web).toBe('15:00');
    expect(r.body.reglas.zona_horaria).toBe('America/Argentina/Buenos_Aires');
    expect(r.body.reglas.ml_andreani.margen_minutos).toBe(30);
    expect(r.body.preflight.estado).toBe('abierta_con_advertencias');
    expect(r.body.preflight.integraciones.mercadolibre.estado).toBe('desconocido');
    expect(r.body.preflight.agente_impresora.verificacion).toBe('no_requerido_e1');
  });

  it('POST /zonas rechaza configuración a un operario', async () => {
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.user = { username: 'operario', is_admin: 0, rol: 'operario' }; next(); });
    app.use('/api/jornada', jornadaRouter(db, {}));
    const r = await request(app).post('/api/jornada/zonas').send({ nombre: 'Estante restringido' });
    expect(r.status).toBe(403); expect(r.body.code).toBe('FORBIDDEN');
  });

  it('GET /ayuda/:id rechaza a un operario que no es parte de la ayuda', async () => {
    const ts = new Date().toISOString();
    const day = db.prepare("INSERT INTO operational_days (fecha,estado,abierta_por,abierta_en) VALUES ('2026-09-03','abierta','op1',?)").run(ts).lastInsertRowid;
    const wave = db.prepare("INSERT INTO pick_waves (operational_day_id,tipo,estado,estado_operativo,creada_en) VALUES (?,'inicial','en_picking','en_busqueda',?)").run(day, ts).lastInsertRowid;
    const zone = db.prepare("INSERT INTO warehouse_pick_zones (nombre,creado_por,creado_en) VALUES ('Zona ayuda','op1',?)").run(ts).lastInsertRowid;
    const help = db.prepare("INSERT INTO pick_wave_helpers (pick_wave_id,zona_id,ayudante,solicitado_por,operation_id,creado_en,actualizado_en) VALUES (?,?,?,?,?,?,?)").run(wave, zone, 'op2', 'op1', 'help-perm', ts, ts).lastInsertRowid;
    const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.user = { username: 'op3', is_admin: 0, rol: 'operario' }; next(); }); app.use('/api/jornada', jornadaRouter(db, {}));
    const r = await request(app).get(`/api/jornada/ayuda/${help}`);
    expect(r.status).toBe(403); expect(r.body.code).toBe('FORBIDDEN');
  });

  it('POST /abrir rechaza overrides de horario y ventana ML global', async () => {
    const r = await request(appConUsuario('tester')).post('/api/jornada/abrir')
      .send({ horaCorteWeb: '09:00', ventanaMlJson: { desde: '10:00' } });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('OPENING_RULES_SERVER_CONTROLLED');
  });

  it('POST /abrir exige confirmación explícita si el operador la niega', async () => {
    const r = await request(appConUsuario('tester')).post('/api/jornada/abrir')
      .send({ confirmar_horarios: false });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('SCHEDULE_CONFIRMATION_REQUIRED');
    expect(db.prepare('SELECT COUNT(*) AS n FROM operational_days').get().n).toBe(0);
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

  it('GET /olas devuelve el claim vigente de cada ola', async () => {
    const app = appConUsuario('operario');
    const abrir = await request(app).post('/api/jornada/abrir').send({});
    const ola = abrir.body.olaInicial;
    await request(app).post(`/api/jornada/ola/${ola.id}/reclamar`).send({});
    const r = await request(app).get('/api/jornada/olas');
    expect(r.status).toBe(200);
    expect(r.body.olas.find((item) => item.id === ola.id).claim.usuario).toBe('operario');
  });

  it('GET /olas enriquece el claim con vencimiento usando una referencia temporal consistente', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T12:00:00Z'));
    const app = appConUsuario('operario');
    const abrir = await request(app).post('/api/jornada/abrir').send({});
    const ola = abrir.body.olaInicial;
    await request(app).post(`/api/jornada/ola/${ola.id}/reclamar`).send({});

    vi.setSystemTime(new Date('2026-09-01T12:06:00Z'));
    const r = await request(app).get('/api/jornada/olas');
    const claim = r.body.olas.find((item) => item.id === ola.id).claim;
    expect(claim).toMatchObject({ por_vencer: true, segundos_restantes: 540 });
    vi.useRealTimers();
  });

  it('POST /cerrar requiere is_admin y cierra la jornada', async () => {
    const appNoAdmin = express();
    appNoAdmin.use(express.json());
    appNoAdmin.use((req, _res, next) => { req.user = { username: 'op1', is_admin: 0 }; next(); });
    appNoAdmin.use('/api/jornada', jornadaRouter(db, {}));
    const noPermitido = await request(appNoAdmin).post('/api/jornada/cerrar').send({});
    expect(noPermitido.status).toBe(403);

    const appAdmin = appConUsuario('supervisor');
    await request(appAdmin).post('/api/jornada/abrir').send({});
    const r = await request(appAdmin).post('/api/jornada/cerrar').send({});
    expect(r.status).toBe(200);
    expect(r.body.jornada.estado).toBe('cerrada');
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

  it('reclamar una ola inicial congelada la pasa a en_picking', () => {
    const congelada = db.prepare("UPDATE pick_waves SET estado='congelada' WHERE id=?").run(waveId);
    const r = reclamarOla(db, waveId, 'op1');
    expect(congelada.changes).toBe(1);
    expect(r.ok).toBe(true);
    expect(r.olaCongelada.estado).toBe('en_picking');
    expect(db.prepare('SELECT estado FROM pick_waves WHERE id=?').get(waveId).estado).toBe('en_picking');
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

  it('no permite reclamar una ola completada', () => {
    db.prepare("UPDATE pick_waves SET estado='completada' WHERE id=?").run(waveId);
    const r = reclamarOla(db, waveId, 'op1');
    expect(r).toEqual({ ok: false, code: 'WAVE_NOT_CLAIMABLE' });
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
    for (const column of ['fecha_despacho_limite', 'estado_despacho', 'despacho_motivo', 'shipment_limite_original']) {
      if (!db.prepare('PRAGMA table_info(pedidos_cache)').all().some(c => c.name === column)) {
        db.exec(`ALTER TABLE pedidos_cache ADD COLUMN ${column} TEXT`);
      }
    }
  });
  afterEach(() => { db.close(); try { fs.unlinkSync(TEST_DB); } catch {} });

  function insertarPedido(clave, canal, { espejo_ml = 0, fecha_despacho = null, fecha_despacho_limite = null } = {}) {
    db.prepare(`INSERT INTO pedidos_cache (clave, canal, numero_pedido, comprador, fecha, fecha_despacho, estado_envio, espejo_ml, items_json, actualizado_en)
      VALUES (?,?,?,?,?,?,'pendiente',?,'[]',?)`)
      .run(clave, canal, clave, 'Cliente', new Date().toISOString(), fecha_despacho, espejo_ml, new Date().toISOString());
    if (fecha_despacho_limite) db.prepare('UPDATE pedidos_cache SET fecha_despacho_limite=? WHERE clave=?').run(fecha_despacho_limite, clave);
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

  it('un ML urgente durante una ola activa se incorpora a esa ola y deja retorno obligatorio', () => {
    const now = new Date('2026-09-01T12:00:00Z');
    abrirJornada(db, { usuario: 'tester' }, now);
    const ola = db.prepare("SELECT * FROM pick_waves WHERE tipo='inicial'").get();
    reclamarOla(db, ola.id, 'op1', {}, now);
    insertarPedido('ml:urgente-activo', 'ml', { fecha_despacho: fechaLocalHoy(now) });

    const r = sincronizarMiniOlas(db, now);
    expect(r.agregados).toBe(1);
    expect(db.prepare("SELECT COUNT(*) c FROM pick_wave_items WHERE pick_wave_id=? AND pedido_clave='ml:urgente-activo'").get(ola.id).c).toBe(1);
    expect(db.prepare("SELECT estado FROM pick_wave_returns WHERE pick_wave_id=? AND pedido_clave='ml:urgente-activo'").get(ola.id).estado).toBe('pendiente');
    expect(db.prepare("SELECT COUNT(*) c FROM pick_waves WHERE tipo='ml_urgente'").get().c).toBe(0);
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

  it('un pedido ML con SLA vencido permanece en la ola urgente', () => {
    const now = new Date('2026-09-01T12:00:00Z');
    abrirJornada(db, { usuario: 'tester' }, now);
    insertarPedido('ml:vencido', 'ml', { fecha_despacho_limite: '2026-09-01T11:00:00.000Z' });
    sincronizarMiniOlas(db, now);
    const urgente = db.prepare("SELECT * FROM pick_waves WHERE tipo='ml_urgente'").get();
    expect(urgente).toBeTruthy();
    expect(db.prepare('SELECT pedido_clave FROM pick_wave_items WHERE pick_wave_id=?').get(urgente.id).pedido_clave).toBe('ml:vencido');
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

  it('bloquea un pedido de la ola cuando cambian SKU o cantidad externamente', () => {
    const now = new Date('2026-09-01T12:00:00Z');
    insertarPedido('web:cambio', 'web');
    abrirJornada(db, { usuario: 'tester' }, now);
    db.prepare("UPDATE pedidos_cache SET items_json=? WHERE clave=?")
      .run(JSON.stringify([{ sku: 'SKU-NUEVO', quantity: 2 }]), 'web:cambio');
    sincronizarMiniOlas(db, now);
    const item = db.prepare("SELECT * FROM pick_wave_items WHERE pedido_clave='web:cambio'").get();
    expect(item.estado_operativo).toBe('bloqueado_cambio_externo');
    expect(item.bloqueo_motivo).toBe('lineas_del_pedido_modificadas_externamente');
  });

  it('crea retorno físico si el cambio externo ocurre después de asignar unidades', () => {
    const now = new Date('2026-09-01T12:00:00Z');
    insertarPedido('web:retorno', 'web', { items_json: JSON.stringify([{ sku: 'SKU-R', cantidad: 1 }]) });
    abrirJornada(db, { usuario: 'tester' }, now);
    const ola = db.prepare("SELECT * FROM pick_waves WHERE tipo='inicial'").get();
    reclamarOla(db, ola.id, 'op1', {}, now); iniciarBusqueda(db, ola.id, 'op1', {}, now); pasarAMesa(db, ola.id, 'op1', {}, now);
    db.prepare("UPDATE pick_wave_items SET estado_operativo='en_mesa', items_json_snapshot=? WHERE pick_wave_id=? AND pedido_clave='web:retorno'").run(JSON.stringify([{ sku: 'SKU-R', cantidad: 1 }]), ola.id);
    db.prepare('INSERT INTO pick_wave_assignments (pick_wave_id,pedido_clave,sku,cantidad,asignado_por,operation_id,creado_en) VALUES (?,?,?,?,?,?,?)').run(ola.id, 'web:retorno', 'SKU-R', 1, 'op1', 'assign-retorno', now.toISOString());
    db.prepare("UPDATE pedidos_cache SET items_json=? WHERE clave='web:retorno'").run(JSON.stringify([{ sku: 'SKU-NUEVO', cantidad: 1 }]));
    sincronizarMiniOlas(db, now);
    expect(db.prepare("SELECT estado, sku FROM pick_wave_returns WHERE pick_wave_id=? AND pedido_clave='web:retorno'").get(ola.id)).toMatchObject({ estado: 'pendiente', sku: 'SKU-R' });
  });

  it('bloquea un ítem legacy sin snapshot verificable', () => {
    const now = new Date('2026-09-01T12:00:00Z');
    insertarPedido('web:sin-snapshot', 'web'); abrirJornada(db, { usuario: 'tester' }, now);
    const ola = db.prepare("SELECT * FROM pick_waves WHERE tipo='inicial'").get();
    db.prepare("UPDATE pick_wave_items SET items_json_snapshot=NULL WHERE pick_wave_id=? AND pedido_clave='web:sin-snapshot'").run(ola.id);
    sincronizarMiniOlas(db, now);
    expect(db.prepare("SELECT estado_operativo, bloqueo_motivo FROM pick_wave_items WHERE pick_wave_id=? AND pedido_clave='web:sin-snapshot'").get(ola.id)).toMatchObject({ estado_operativo: 'bloqueado_cambio_externo', bloqueo_motivo: 'snapshot_no_verificable' });
  });
});

describe('cerrarJornada', () => {
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

  it('cierra la jornada abierta y no exige olas completadas', () => {
    const now = new Date('2026-09-01T12:00:00Z');
    abrirJornada(db, { usuario: 'tester' }, now);
    const r = cerrarJornada(db, 'supervisor', now);
    expect(r.ok).toBe(true);
    expect(r.jornada.estado).toBe('cerrada');
    expect(r.jornada.cerrada_por).toBe('supervisor');
  });

  it('sin jornada abierta hoy responde NO_OPEN_DAY', () => {
    const r = cerrarJornada(db, 'supervisor', new Date('2026-09-01T12:00:00Z'));
    expect(r.ok).toBe(false);
    expect(r.code).toBe('NO_OPEN_DAY');
  });
});

describe('E1 operativo: búsqueda, ayuda y mesa', () => {
  let db, waveId, zoneId;
  beforeEach(() => {
    db = openDb(TEST_DB); ensureTablesJornada(db);
    const ts = new Date('2026-09-01T12:00:00Z').toISOString();
    const dayId = db.prepare(`INSERT INTO operational_days (fecha,estado,abierta_por,abierta_en) VALUES (?,?,?,?)`).run('2026-09-01','abierta','op1',ts).lastInsertRowid;
    waveId = db.prepare(`INSERT INTO pick_waves (operational_day_id,tipo,estado,estado_operativo,creada_en) VALUES (?,'inicial','congelada','disponible',?)`).run(dayId,ts).lastInsertRowid;
    db.prepare(`INSERT INTO pick_wave_claims (pick_wave_id,usuario,claimed_at,expires_at,renovado_en) VALUES (?,?,?,?,?)`).run(waveId,'op1',ts,'2099-09-01T13:00:00.000Z',ts);
    db.prepare(`INSERT INTO pick_wave_items (pick_wave_id,pedido_clave,agregado_en) VALUES (?,?,?)`).run(waveId,'web:1',ts);
    db.prepare(`INSERT INTO pick_wave_items (pick_wave_id,pedido_clave,agregado_en) VALUES (?,?,?)`).run(waveId,'web:2',ts);
    db.exec('CREATE TABLE pedidos_cache (clave TEXT PRIMARY KEY, items_json TEXT, estado_envio TEXT)');
    db.prepare('INSERT INTO pedidos_cache (clave,items_json,estado_envio) VALUES (?,?,?)').run('web:1', JSON.stringify([{ sku: 'SKU-1', cantidad: 2 }]), 'pendiente');
    db.prepare('INSERT INTO pedidos_cache (clave,items_json,estado_envio) VALUES (?,?,?)').run('web:2', JSON.stringify([{ sku: 'SKU-2', cantidad: 1 }]), 'pendiente');
    zoneId = db.prepare(`INSERT INTO warehouse_pick_zones (nombre,creado_por,creado_en) VALUES ('Estante A','op1',?)`).run(ts).lastInsertRowid;
  });
  afterEach(() => { db.close(); try { fs.unlinkSync(TEST_DB); } catch {} });

  it('recorre estados objetivo y guarda auditoría idempotente', () => {
    const inicio = iniciarBusqueda(db, waveId, 'op1', { expectedVersion: 1, operationId: 'start-1' });
    expect(inicio.ola.estado_operativo).toBe('en_busqueda');
    const mesa = pasarAMesa(db, waveId, 'op1', { expectedVersion: 2, operationId: 'table-1' });
    expect(mesa.ola.estado_operativo).toBe('en_mesa');
    const repetido = pasarAMesa(db, waveId, 'op1', { expectedVersion: 2, operationId: 'table-1' });
    expect(repetido.ok).toBe(true);
    expect(db.prepare('SELECT COUNT(*) c FROM operational_day_events WHERE pick_wave_id=?').get(waveId).c).toBe(2);
  });

  it('rechaza versión obsoleta y permite solicitar/recibir ayuda física identificada', () => {
    iniciarBusqueda(db, waveId, 'op1', { operationId: 'start-2' });
    const ayuda = pedirAyudaZona(db, waveId, { zonaId: zoneId, ayudante: 'op2' }, 'op1', { expectedVersion: 2, operationId: 'help-1' });
    expect(ayuda.ok).toBe(true);
    expect(pedirAyudaZona(db, waveId, { zonaId: zoneId, ayudante: 'op2' }, 'op1', { expectedVersion: 1, operationId: 'help-1' }).repetido).toBe(true);
    expect(pedirAyudaZona(db, waveId, { zonaId: zoneId, ayudante: 'op2' }, 'op1', { expectedVersion: 1, operationId: 'help-old' }).code).toBe('WAVE_VERSION_CONFLICT');
    const recibida = recibirAyudaZona(db, ayuda.ayuda.id, 'op1', { expectedVersion: 3, operationId: 'receive-1', entrega: [{ sku: 'SKU-1', cantidad: 2 }] });
    expect(recibida.ayuda.estado).toBe('recibida');
    expect(JSON.parse(recibida.ayuda.entrega_json)).toEqual([{ sku: 'SKU-1', cantidad: 2 }]);
    expect(recibirAyudaZona(db, ayuda.ayuda.id, 'op1', { expectedVersion: 3, operationId: 'receive-1' }).repetido).toBe(true);
    expect(recibida.ayuda.ayudante).toBe('op2');
    expect(recibida.ola.estado_operativo).toBe('en_busqueda');
  });

  it('asigna unidades, registra faltante y cierra con derivados', () => {
    iniciarBusqueda(db, waveId, 'op1', { operationId: 'start-3' });
    pasarAMesa(db, waveId, 'op1', { expectedVersion: 2, operationId: 'table-3' });
    const asignada = asignarUnidadMesa(db, waveId, { pedidoClave: 'web:1', sku: 'SKU-1', cantidad: 2 }, 'op1', { expectedVersion: 3, operationId: 'assign-3' });
    expect(asignada.asignacion.cantidad).toBe(2);
    const asignadaRepetida = asignarUnidadMesa(db, waveId, { pedidoClave: 'web:1', sku: 'SKU-1', cantidad: 2 }, 'op1', { expectedVersion: 3, operationId: 'assign-3' });
    expect(asignadaRepetida.repetido).toBe(true);
    const falta = registrarFaltante(db, waveId, { pedidoClave: 'web:2', sku: 'SKU-2', motivo: 'no_encontrado', nota: 'revisar' }, 'op1', { expectedVersion: 4, operationId: 'short-3' });
    expect(falta.faltante.motivo).toBe('no_encontrado');
    const cerrado = cerrarOla(db, waveId, 'op1', { expectedVersion: 5, operationId: 'close-3', derivados: ['asignado','faltante_bloqueado'] });
    expect(cerrado.ok).toBe(false);
    expect(cerrado.code).toBe('WAVE_INCOMPLETE');
  });

  it('bloquea asignación cuando el detalle del pedido no es verificable', () => {
    db.prepare("UPDATE pedidos_cache SET items_json=NULL WHERE clave='web:1'").run();
    iniciarBusqueda(db, waveId, 'op1', {}, new Date('2026-09-01T12:00:00Z'));
    pasarAMesa(db, waveId, 'op1', {}, new Date('2026-09-01T12:00:01Z'));
    const resultado = asignarUnidadMesa(db, waveId, { pedidoClave: 'web:1', sku: 'SKU-1', cantidad: 1 }, 'op1', {}, new Date('2026-09-01T12:00:02Z'));
    expect(resultado.code).toBe('ORDER_DATA_UNAVAILABLE');
  });

  it('impide dos olas activas para el mismo operario y SKU ajeno al pedido', () => {
    const ts = new Date('2026-09-01T12:00:00Z').toISOString();
    const otra = db.prepare(`INSERT INTO pick_waves (operational_day_id,tipo,estado,estado_operativo,creada_en) VALUES ((SELECT operational_day_id FROM pick_waves WHERE id=?),'mini','abierta','disponible',?)`).run(waveId, ts).lastInsertRowid;
    expect(reclamarOla(db, waveId, 'op1', {}, new Date('2026-09-01T12:00:00Z')).ok).toBe(true);
    expect(reclamarOla(db, otra, 'op1', {}, new Date('2026-09-01T12:00:01Z')).code).toBe('OPERATOR_ALREADY_CLAIMED');
    iniciarBusqueda(db, waveId, 'op1', {}, new Date('2026-09-01T12:00:02Z'));
    pasarAMesa(db, waveId, 'op1', { operationId: 'table-invalid' }, new Date('2026-09-01T12:00:03Z'));
    expect(asignarUnidadMesa(db, waveId, { pedidoClave: 'web:1', sku: 'SKU-AJENO', cantidad: 1 }, 'op1', {}, new Date('2026-09-01T12:00:02Z')).code).toBe('PRODUCT_CODE_UNKNOWN');
  });

  it('reintentar reclamar con la misma operación no crea un segundo cambio', () => {
    const now = new Date('2026-09-01T12:00:00Z');
    const first = reclamarOla(db, waveId, 'op1', { operationId: 'claim-replay', expectedVersion: 1 }, now);
    const replay = reclamarOla(db, waveId, 'op1', { operationId: 'claim-replay', expectedVersion: 1 }, new Date('2026-09-01T12:00:01Z'));
    expect(first.ok).toBe(true);
    expect(replay.ok).toBe(true);
    expect(replay.repetido).toBe(true);
  });

  it('exige resolución comercial explícita para cerrar un faltante', () => {
    const now = new Date('2026-09-01T12:00:00Z');
    iniciarBusqueda(db, waveId, 'op1', {}, now);
    pasarAMesa(db, waveId, 'op1', {}, new Date('2026-09-01T12:00:01Z'));
    const falta = registrarFaltante(db, waveId, { pedidoClave:'web:1', sku:'SKU-1', motivo:'no_encontrado' }, 'op1', {}, new Date('2026-09-01T12:00:02Z'));
    expect(resolverFaltante(db, falta.faltante.id, 'op1', { expectedVersion:falta.ola.expected_version }, new Date('2026-09-01T12:00:03Z')).code).toBe('SHORTAGE_RESOLUTION_REQUIRED');
  });

  it('resuelve EAN a SKU y bloquea un EAN ambiguo en mesa', () => {
    const now = new Date('2026-09-01T12:00:00Z');
    db.prepare('DELETE FROM catalogo_cache').run();
    db.prepare('INSERT INTO catalogo_cache (nombre,sku,gtin,actualizado_en,no_contable) VALUES (?,?,?,?,?)').run('Demo','SKU-1', '7790000000011', now.toISOString(), 0);
    iniciarBusqueda(db, waveId, 'op1', {}, now);
    pasarAMesa(db, waveId, 'op1', {}, new Date('2026-09-01T12:00:01Z'));
    const ok = asignarUnidadMesa(db, waveId, { pedidoClave:'web:1', sku:'7790000000011', cantidad:1 }, 'op1', {}, new Date('2026-09-01T12:00:02Z'));
    expect(ok.ok).toBe(true);
    expect(ok.asignacion.sku).toBe('SKU-1');
    db.prepare('INSERT INTO catalogo_cache (nombre,sku,gtin,actualizado_en,no_contable) VALUES (?,?,?,?,?)').run('Otro','SKU-OTRO', '7790000000011', now.toISOString(), 0);
    expect(asignarUnidadMesa(db, waveId, { pedidoClave:'web:1', sku:'7790000000011', cantidad:1 }, 'op1', {}, new Date('2026-09-01T12:00:03Z')).code).toBe('PRODUCT_CODE_AMBIGUOUS');
  });

  it('pausa y reanuda la ola con motivo, auditoría e idempotencia', () => {
    const now = new Date('2026-09-01T12:00:00Z');
    const claimed = reclamarOla(db, waveId, 'op1', { operationId:'pause-claim', expectedVersion:1 }, now);
    const paused = pausarOla(db, waveId, 'op1', { operationId:'pause-1', expectedVersion:claimed.olaCongelada.expected_version, motivo:'cambio de prioridad' }, now);
    expect(paused.ok).toBe(true);
    expect(paused.claim.motivo_pausa).toBe('cambio de prioridad');
    const replay = pausarOla(db, waveId, 'op1', { operationId:'pause-1', expectedVersion:1, motivo:'otro' }, now);
    expect(replay.ok).toBe(true);
    expect(replay.repetido).toBe(true);
    expect(reanudarOla(db, waveId, 'op1', { operationId:'resume-1', expectedVersion:paused.ola.expected_version }, new Date(now.getTime()+1000)).ok).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM operational_day_events WHERE pick_wave_id=? AND tipo IN ('ola_pausada','ola_reanudada')").get(waveId).n).toBe(2);
  });

  it('rechaza pausar o reanudar con claim vencido', () => {
    const now = new Date('2026-09-01T12:00:00Z');
    const claimed = reclamarOla(db, waveId, 'op1', { operationId:'expired-claim', expectedVersion:1 }, now);
    db.prepare("UPDATE pick_wave_claims SET expires_at=? WHERE pick_wave_id=?").run('2026-09-01T11:59:00.000Z', waveId);
    expect(pausarOla(db, waveId, 'op1', { expectedVersion:claimed.olaCongelada.expected_version, motivo:'intento tardío' }, now).code).toBe('CLAIM_EXPIRED');
    expect(reanudarOla(db, waveId, 'op1', { expectedVersion:claimed.olaCongelada.expected_version }, now).code).toBe('CLAIM_EXPIRED');
  });
});
