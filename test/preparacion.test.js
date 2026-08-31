import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import express from 'express';
import request from 'supertest';
import sharp from 'sharp';
import { openDb } from '../db/index.js';
import {
  splitDireccion, splitTelefonoAr, normalizarEnvio, nombreProvincia, direccionesDifieren,
  resolverPerfil, requisitosFoto, fotosFaltantes, esEnvioLocal, requisitosConCantidad,
  clasificarElegibilidadMl,
} from '../lib/preparacion.js';
import { preparacionRouter, crearPreparacion, registrarEvento, purgarFotosBorradas } from '../routes/preparacion.js';
import { rutaAbsoluta } from '../utils/storage.js';
import heicConvert from 'heic-convert';

vi.mock('heic-convert', () => ({ default: vi.fn() }));
vi.mock('../routes/woo.js', async () => {
  const actual = await vi.importActual('../routes/woo.js');
  return { ...actual, wooFetch: vi.fn() };
});

describe('guards U0.B: casos funcionales de claims y ML inconcluso', () => {
  let db;
  beforeEach(() => { db = openDb(TEST_DB); vi.clearAllMocks(); });
  afterEach(() => { db.close(); try { fs.unlinkSync(TEST_DB); } catch {} });

  it('/iniciar devuelve 401 si no hay usuario y claimPreparacion no tiene claim', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/preparacion', preparacionRouter(db, { woo: null, ml: {}, colaFotos: { disparoInmediato: false } }));
    const r = await request(app).post('/api/preparacion/iniciar').send({ canal: 'ml', id: 'ORD-AUTH' });
    expect(r.status).toBe(401);
    expect(r.body.error).toMatch(/autenticado/i);
    expect(db.prepare("SELECT id FROM preparaciones WHERE clave='ml:ORD-AUTH'").get()).toBeUndefined();
  });

  it('seguimiento sin autenticación devuelve 401 y no crea una preparación huérfana', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/preparacion', preparacionRouter(db, { woo: {}, ml: {}, colaFotos: { disparoInmediato: false } }));
    const r = await request(app).post('/api/preparacion/seguimientos/991').send({ tracking: 'AND991' });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('AUTH_REQUIRED');
    expect(db.prepare("SELECT id FROM preparaciones WHERE clave='web:991'").get()).toBeUndefined();
  });

  it('liberar sin autenticación devuelve 401 y no simula una liberación', async () => {
    const id = crearPreparacion(db, { canal: 'web', wcOrderId: 992, numeroPedido: '992', comprador: 'X', items: [] });
    db.prepare('INSERT INTO preparacion_claims (preparacion_id, usuario, claimed_at, expires_at, renovado_en) VALUES (?,?,?,?,?)')
      .run(id, 'juan', new Date().toISOString(), new Date(Date.now() + 600000).toISOString(), new Date().toISOString());
    const app = express();
    app.use(express.json());
    app.use('/api/preparacion', preparacionRouter(db, { woo: null, ml: null, colaFotos: { disparoInmediato: false } }));
    const r = await request(app).post(`/api/preparacion/${id}/claim/liberar`);
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('AUTH_REQUIRED');
    expect(db.prepare('SELECT usuario FROM preparacion_claims WHERE preparacion_id=?').get(id).usuario).toBe('juan');
  });

  it('decidir vínculo exige claims vigentes para ambas preparaciones', async () => {
    const a = crearPreparacion(db, { canal: 'web', wcOrderId: 910, numeroPedido: '910', comprador: 'X', items: [] });
    const b = crearPreparacion(db, { canal: 'web', wcOrderId: 911, numeroPedido: '911', comprador: 'X', items: [] });
    const now = new Date().toISOString();
    db.prepare('INSERT INTO preparacion_claims (preparacion_id, usuario, claimed_at, expires_at, renovado_en) VALUES (?,?,?,?,?)')
      .run(a, 'tester', now, new Date(Date.now() + 600000).toISOString(), now);
    db.prepare('INSERT INTO preparacion_vinculos (pedido_a_clave, pedido_b_clave, campo_match, creado_en) VALUES (?,?,?,?)')
      .run('web:910', 'web:911', 'comprador', now);
    const vinculo = db.prepare('SELECT id FROM preparacion_vinculos').get();
    const r = await request(buildTestApp(db)).post(`/api/preparacion/vinculos/${vinculo.id}/decidir`)
      .send({ estado: 'rechazado' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('PREPARATION_CLAIMED');
    expect(db.prepare('SELECT estado FROM preparacion_vinculos WHERE id=?').get(vinculo.id).estado).toBe('sugerido');
  });
});

describe('control de despacho U0.B', () => {
  let db;
  beforeEach(() => { db = openDb(TEST_DB); });
  afterEach(() => { db.close(); try { fs.unlinkSync(TEST_DB); } catch {} });
  it('devuelve jornada, resumen, confirmados, sin_fecha y filtros de la hoja', async () => {
    const id = crearPreparacion(db, { canal: 'ml', mlOrderId: 'ORD-HOJA', packId: 'PACK-HOJA', numeroPedido: '700', comprador: 'X', items: [] });
    db.prepare(`INSERT INTO pedidos_cache
      (clave, canal, ml_order_id, pack_id, numero_pedido, estado_envio, items_json, actualizado_en, fecha_despacho)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('ml:ORD-HOJA', 'ml', 'ORD-HOJA', 'PACK-HOJA', '700', 'pendiente', '[]', new Date().toISOString(), '2026-09-01');
    db.prepare(`INSERT INTO despacho_controles (grupo_clave, estado, creado_en, actualizado_en)
      VALUES (?, ?, ?, ?), (?, ?, ?, ?)`).run('PACK-HOJA', 'confirmado', '2026-08-30T10:00:00Z', '2026-08-30T10:00:00Z', 'SIN-FECHA', 'pendiente', '2026-08-30T11:00:00Z', '2026-08-30T11:00:00Z');
    const r = await request(buildTestApp(db)).get('/api/preparacion/despacho/cola?fecha=2026-09-01&estado=confirmado&canal=ml&q=700');
    expect(r.status).toBe(200);
    expect(r.body.jornada).toEqual({ fecha: '2026-09-01', zona_horaria: 'America/Argentina/Buenos_Aires' });
    expect(r.body.resumen).toMatchObject({ total: 1, confirmados: 1, pendientes: 0, escaneados: 0 });
    expect(r.body.data).toHaveLength(1);
    const sinFecha = await request(buildTestApp(db)).get('/api/preparacion/despacho/cola?fecha=sin_fecha');
    expect(sinFecha.body.data).toHaveLength(1);
    expect(sinFecha.body.data[0].jornada).toBe('sin_fecha');
  });
  it('agrupa por pack, hace el escaneo idempotente y encola etiqueta 50x25 al confirmar', async () => {
    const id = crearPreparacion(db, { canal: 'ml', mlOrderId: 'ORD-50', packId: 'PACK-50', numeroPedido: '50', comprador: 'X', items: [] });
    const app = buildTestApp(db);
    await tomarPorApi(app, id);
    const a = await request(app).post(`/api/preparacion/despacho/${id}/escanear`).set('Idempotency-Key', 'k-1').send({ codigo: 'PACK-50' });
    const b = await request(app).post(`/api/preparacion/despacho/${id}/escanear`).set('Idempotency-Key', 'k-1').send({ codigo: 'PACK-50' });
    expect(a.status).toBe(201); expect(b.body.repetido).toBe(true);
    const c = await request(app).post(`/api/preparacion/despacho/${id}/confirmar`).set('Idempotency-Key', 'confirm-50');
    expect(c.status).toBe(200);
    expect(db.prepare('SELECT grupo_clave, estado FROM despacho_controles').get()).toMatchObject({ grupo_clave: 'PACK-50', estado: 'confirmado' });
    expect(db.prepare("SELECT nota, formato_ancho_mm, formato_alto_mm, tipo_etiqueta FROM etiquetas_cola WHERE origen='despacho'").get()).toMatchObject({ formato_ancho_mm: 50, formato_alto_mm: 25, tipo_etiqueta: 'interna' });
  });
  it('exige idempotencia al confirmar, deduplica la misma intención y rechaza otra', async () => {
    const id = crearPreparacion(db, { canal: 'ml', mlOrderId: 'ID', packId: 'PID', numeroPedido: 'ID', items: [] });
    const app = buildTestApp(db); await tomarPorApi(app, id);
    await request(app).post(`/api/preparacion/despacho/${id}/escanear`).set('Idempotency-Key', 'scan-id').send({ codigo: 'pid' });
    expect((await request(app).post(`/api/preparacion/despacho/${id}/confirmar`)).status).toBe(400);
    const first = await request(app).post(`/api/preparacion/despacho/${id}/confirmar`).set('Idempotency-Key', 'confirm-id');
    const repeat = await request(app).post(`/api/preparacion/despacho/${id}/confirmar`).set('Idempotency-Key', 'confirm-id');
    expect(first.body.repetido).toBe(false); expect(repeat.body.repetido).toBe(true);
    expect((await request(app).post(`/api/preparacion/despacho/${id}/confirmar`).set('Idempotency-Key', 'other-id')).status).toBe(409);
  });
  it('rechaza código ajeno y no crea control', async () => {
    const id = crearPreparacion(db, { canal: 'ml', mlOrderId: 'BAD', packId: 'P-BAD', numeroPedido: 'BAD', items: [] });
    const app = buildTestApp(db); await tomarPorApi(app, id);
    const r = await request(app).post(`/api/preparacion/despacho/${id}/escanear`).set('Idempotency-Key', 'bad-code').send({ codigo: 'otro' });
    expect(r.status).toBe(409); expect(r.body.match).toBe('no_coincide');
    expect(db.prepare('SELECT COUNT(*) n FROM despacho_controles').get().n).toBe(0);
  });
  it('rechaza una Idempotency-Key reutilizada en otro grupo', async () => {
    const a = crearPreparacion(db, { canal: 'ml', mlOrderId: 'A', packId: 'PA', numeroPedido: 'A', items: [] });
    const b = crearPreparacion(db, { canal: 'ml', mlOrderId: 'B', packId: 'PB', numeroPedido: 'B', items: [] });
    const app = buildTestApp(db); await tomarPorApi(app, a); await tomarPorApi(app, b);
    await request(app).post(`/api/preparacion/despacho/${a}/escanear`).set('Idempotency-Key', 'global-1').send({ codigo: 'PA' });
    const r = await request(app).post(`/api/preparacion/despacho/${b}/escanear`).set('Idempotency-Key', 'global-1').send({ codigo: 'PB' });
    expect(r.status).toBe(409); expect(r.body.code).toBe('IDEMPOTENCY_CONFLICT');
  });
  it('confirma de forma atómica control, etiqueta y auditoría', async () => {
    const id = crearPreparacion(db, { canal: 'ml', mlOrderId: 'AT', packId: 'PAT', numeroPedido: 'AT', items: [] });
    const app = buildTestApp(db); await tomarPorApi(app, id);
    await request(app).post(`/api/preparacion/despacho/${id}/escanear`).set('Idempotency-Key', 'atomic-1').send({ codigo: 'PAT' });
    db.exec("CREATE TRIGGER test_despacho_auditoria BEFORE INSERT ON preparacion_eventos BEGIN SELECT RAISE(ABORT, 'auditoria caída'); END");
    const r = await request(app).post(`/api/preparacion/despacho/${id}/confirmar`).set('Idempotency-Key', 'atomic-confirm');
    db.exec('DROP TRIGGER test_despacho_auditoria');
    expect(r.status).toBe(500);
    expect(db.prepare("SELECT estado FROM despacho_controles WHERE grupo_clave='PAT'").get().estado).toBe('escaneado');
    expect(db.prepare("SELECT COUNT(*) n FROM etiquetas_cola WHERE origen='despacho'").get().n).toBe(0);
  });
});
vi.mock('../lib/mlClient.js', () => ({
  mlFetch: vi.fn(),
  bootstrapToken: vi.fn(),
  getAccessToken: vi.fn(),
}));

const TEST_DB = './test/tmp-preparacion.sqlite';

// colaFotos.disparoInmediato:false en los dos builders de abajo: sin esto, cada test que sube
// una foto dispararía un worker thread REAL de fondo (heic-convert/sharp de verdad) que puede
// seguir corriendo después de que el test cierre la base de datos (afterEach borra el .sqlite).
// El módulo de la cola (lib/fotosPreparacionCola.js) se testea aparte, con un worker de prueba
// inyectado — ver test/fotos-preparacion-cola.test.js.
function buildTestApp(db) {
  const app = express();
  app.use(express.json());
  // simular usuario autenticado (el server real lo inyecta requireAuth)
  app.use((req, _res, next) => {
    req.user = { username: 'tester', is_admin: 1 };
    next();
  });
  app.use('/api/preparacion', preparacionRouter(db, { woo: null, ml: null, andreaniStatus: 'lpaandreani', colaFotos: { disparoInmediato: false } }));
  return app;
}

function buildTestAppComo(db, usuario) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { username: usuario, is_admin: 0 };
    next();
  });
  app.use('/api/preparacion', preparacionRouter(db, { woo: null, ml: null, andreaniStatus: 'lpaandreani', colaFotos: { disparoInmediato: false } }));
  return app;
}

async function tomarPorApi(app, id) {
  const res = await request(app).post(`/api/preparacion/${id}/tomar`);
  expect(res.status).toBe(200);
  return res;
}

describe('POST /:id/heartbeat', () => {
  let db;
  beforeEach(() => { db = openDb(TEST_DB); });
  afterEach(() => { db.close(); try { fs.unlinkSync(TEST_DB); } catch {} });

  it('registra la presencia y no devuelve a nadie si sos el único viendo la preparación', async () => {
    const prepId = crearPreparacion(db, { canal: 'web', wcOrderId: 900, numeroPedido: '900', comprador: 'Juan', items: [] });

    const res = await request(buildTestAppComo(db, 'juan')).post(`/api/preparacion/${prepId}/heartbeat`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.otros).toEqual([]);
  });

  it('devuelve a otro usuario que mandó heartbeat en los últimos 30s, sin incluirse a sí mismo', async () => {
    const prepId = crearPreparacion(db, { canal: 'web', wcOrderId: 901, numeroPedido: '901', comprador: 'Ana', items: [] });
    await request(buildTestAppComo(db, 'juan')).post(`/api/preparacion/${prepId}/heartbeat`);

    const res = await request(buildTestAppComo(db, 'ana')).post(`/api/preparacion/${prepId}/heartbeat`);

    expect(res.body.otros).toHaveLength(1);
    expect(res.body.otros[0].usuario).toBe('juan');
  });

  it('no devuelve un heartbeat viejo (más de 30s)', async () => {
    const prepId = crearPreparacion(db, { canal: 'web', wcOrderId: 902, numeroPedido: '902', comprador: 'Ana', items: [] });
    const viejo = new Date(Date.now() - 60000).toISOString(); // hace 60s
    db.prepare('INSERT INTO preparacion_vistas (preparacion_id, usuario, visto_en) VALUES (?,?,?)').run(prepId, 'juan', viejo);

    const res = await request(buildTestAppComo(db, 'ana')).post(`/api/preparacion/${prepId}/heartbeat`);

    expect(res.body.otros).toEqual([]);
  });

  it('actualiza (no duplica) el heartbeat del mismo usuario en la misma preparación', async () => {
    const prepId = crearPreparacion(db, { canal: 'web', wcOrderId: 903, numeroPedido: '903', comprador: 'Ana', items: [] });
    await request(buildTestAppComo(db, 'juan')).post(`/api/preparacion/${prepId}/heartbeat`);
    await request(buildTestAppComo(db, 'juan')).post(`/api/preparacion/${prepId}/heartbeat`);

    const filas = db.prepare('SELECT * FROM preparacion_vistas WHERE preparacion_id=?').all(prepId);

    expect(filas).toHaveLength(1);
  });

  it('no mezcla presencia entre preparaciones distintas', async () => {
    const prepA = crearPreparacion(db, { canal: 'web', wcOrderId: 904, numeroPedido: '904', comprador: 'X', items: [] });
    const prepB = crearPreparacion(db, { canal: 'web', wcOrderId: 905, numeroPedido: '905', comprador: 'Y', items: [] });
    await request(buildTestAppComo(db, 'juan')).post(`/api/preparacion/${prepA}/heartbeat`);

    const res = await request(buildTestAppComo(db, 'ana')).post(`/api/preparacion/${prepB}/heartbeat`);

    expect(res.body.otros).toEqual([]);
  });

  it('404 si la preparación no existe', async () => {
    const res = await request(buildTestAppComo(db, 'juan')).post('/api/preparacion/999999/heartbeat');
    expect(res.status).toBe(404);
  });

  it('un mismo usuario puede tener presencia simultánea en dos preparaciones distintas sin pisarse (PK compuesta por preparacion_id+usuario)', async () => {
    const prepA = crearPreparacion(db, { canal: 'web', wcOrderId: 906, numeroPedido: '906', comprador: 'X', items: [] });
    const prepB = crearPreparacion(db, { canal: 'web', wcOrderId: 907, numeroPedido: '907', comprador: 'Y', items: [] });

    // juan está viendo A y B al mismo tiempo (dos pestañas, por ejemplo).
    const resA = await request(buildTestAppComo(db, 'juan')).post(`/api/preparacion/${prepA}/heartbeat`);
    const resB = await request(buildTestAppComo(db, 'juan')).post(`/api/preparacion/${prepB}/heartbeat`);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    // ana entra a A: debe ver a juan en A...
    const desdeA = await request(buildTestAppComo(db, 'ana')).post(`/api/preparacion/${prepA}/heartbeat`);
    expect(desdeA.body.otros.map(o => o.usuario)).toEqual(['juan']);

    // ...y pedro entra a B: debe ver a juan en B, no contaminado por lo de A.
    const desdeB = await request(buildTestAppComo(db, 'pedro')).post(`/api/preparacion/${prepB}/heartbeat`);
    expect(desdeB.body.otros.map(o => o.usuario)).toEqual(['juan']);

    // hay dos filas distintas para juan (una por cada preparación), no una sola pisada.
    const filasJuan = db.prepare('SELECT * FROM preparacion_vistas WHERE usuario=?').all('juan');
    expect(filasJuan).toHaveLength(2);
  });
});

describe('claim exclusivo de preparación', () => {
  let db;
  beforeEach(() => { db = openDb(TEST_DB); });
  afterEach(() => { db.close(); for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) { try { fs.unlinkSync(f); } catch (_) {} } });

  it('solo permite tomarla al primer usuario mientras el claim está vigente', async () => {
    const id = crearPreparacion(db, { canal: 'web', wcOrderId: 920, numeroPedido: '920', comprador: 'X', items: [] });
    const [juan, ana] = await Promise.all([
      request(buildTestAppComo(db, 'juan')).post(`/api/preparacion/${id}/tomar`),
      request(buildTestAppComo(db, 'ana')).post(`/api/preparacion/${id}/tomar`),
    ]);
    expect([juan.status, ana.status].sort()).toEqual([200, 409]);
    const rechazado = juan.status === 409 ? juan : ana;
    const aceptado = juan.status === 200 ? juan : ana;
    expect(rechazado.body.code).toBe('PREPARATION_CLAIMED');
    expect(rechazado.body.claim.usuario).toBe(aceptado.body.claim.usuario);
  });

  it('permite reintento y renovación del mismo usuario sin duplicar el claim', async () => {
    const id = crearPreparacion(db, { canal: 'web', wcOrderId: 921, numeroPedido: '921', comprador: 'X', items: [] });
    const app = buildTestAppComo(db, 'juan');
    const primero = await request(app).post(`/api/preparacion/${id}/tomar`);
    const segundo = await request(app).post(`/api/preparacion/${id}/tomar`);
    const renovado = await request(app).post(`/api/preparacion/${id}/claim/renovar`);
    expect(primero.status).toBe(200);
    expect(segundo.status).toBe(200);
    expect(renovado.status).toBe(200);
    expect(db.prepare('SELECT COUNT(*) n FROM preparacion_claims WHERE preparacion_id=?').get(id).n).toBe(1);
    expect(db.prepare('SELECT usuario FROM preparacion_claims WHERE preparacion_id=?').get(id).usuario).toBe('juan');
  });

  it('permite tomar un claim vencido y rechaza liberar el claim vigente de otro usuario', async () => {
    const id = crearPreparacion(db, { canal: 'web', wcOrderId: 922, numeroPedido: '922', comprador: 'X', items: [] });
    db.prepare(`INSERT INTO preparacion_claims (preparacion_id, usuario, claimed_at, expires_at, renovado_en)
      VALUES (?,?,?,?,?)`).run(id, 'juan', '2020-01-01T00:00:00.000Z', '2020-01-01T00:01:00.000Z', '2020-01-01T00:00:00.000Z');
    const tomado = await request(buildTestAppComo(db, 'ana')).post(`/api/preparacion/${id}/tomar`);
    expect(tomado.status).toBe(200);
    const otroId = crearPreparacion(db, { canal: 'web', wcOrderId: 923, numeroPedido: '923', comprador: 'X', items: [] });
    await request(buildTestAppComo(db, 'juan')).post(`/api/preparacion/${otroId}/tomar`);
    const liberaAjeno = await request(buildTestAppComo(db, 'ana')).post(`/api/preparacion/${otroId}/claim/liberar`);
    expect(liberaAjeno.status).toBe(409);
  });

  it('rechaza una mutación sin toma explícita', async () => {
    const id = crearPreparacion(db, { canal: 'web', wcOrderId: 924, numeroPedido: '924', comprador: 'X', items: [] });
    const res = await request(buildTestAppComo(db, 'juan')).post(`/api/preparacion/${id}/completar`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PREPARATION_CLAIMED');
  });

  it('rechaza una mutación cuando la toma pertenece a otro usuario', async () => {
    const id = crearPreparacion(db, { canal: 'web', wcOrderId: 925, numeroPedido: '925', comprador: 'X', items: [] });
    const appJuan = buildTestAppComo(db, 'juan');
    await tomarPorApi(appJuan, id);
    const res = await request(buildTestAppComo(db, 'ana')).post(`/api/preparacion/${id}/completar`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PREPARATION_CLAIMED');
    expect(res.body.claim.usuario).toBe('juan');
  });
});

describe('registrarEvento', () => {
  let db;
  beforeEach(() => { db = openDb(TEST_DB); });
  afterEach(() => { db.close(); for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) { try { fs.unlinkSync(f); } catch (_) {} } });

  it('inserta un evento con detalle_json serializado', () => {
    const id = crearPreparacion(db, { canal: 'web', wcOrderId: 900, numeroPedido: '900', comprador: 'Ana', items: [] });
    registrarEvento(db, { preparacionId: id, itemId: null, tipo: 'completado', usuario: 'juan', detalle: { foo: 'bar' } });
    const ev = db.prepare('SELECT * FROM preparacion_eventos WHERE preparacion_id=?').get(id);
    expect(ev.tipo).toBe('completado');
    expect(ev.usuario).toBe('juan');
    expect(JSON.parse(ev.detalle_json)).toEqual({ foo: 'bar' });
    expect(ev.creado_en).toBeTruthy();
  });

  it('no lanza si el insert falla (fail-open) — se traga el error', () => {
    // aseguramos que las tablas existan antes de tirar abajo la que nos interesa probar
    crearPreparacion(db, { canal: 'web', wcOrderId: 902, numeroPedido: '902', comprador: 'Ana', items: [] });
    db.prepare('DROP TABLE preparacion_eventos').run();
    expect(() => registrarEvento(db, { preparacionId: 1, tipo: 'completado', usuario: 'juan', detalle: {} })).not.toThrow();
  });
});

// ─── lógica pura: splits de dirección y teléfono ──────────────────────────────

describe('splitDireccion', () => {
  it('separa calle y numeración cuando el número va al final', () => {
    expect(splitDireccion('Av. Siempreviva 742')).toEqual({ calle: 'Av. Siempreviva', numeracion: '742', referencia: '' });
  });

  it('tolera dirección sin número', () => {
    expect(splitDireccion('Camino de los Remeros s/n')).toEqual({ calle: 'Camino de los Remeros s/n', numeracion: '', referencia: '' });
  });

  it('no confunde calles numeradas: el último número es la numeración', () => {
    expect(splitDireccion('Calle 50 1234')).toEqual({ calle: 'Calle 50', numeracion: '1234', referencia: '' });
  });

  // Bug real de producción: "4405, parque industrial pesquero" no termina en
  // dígito, así que sin cortar la coma el regex no matcheaba nunca y el
  // número de calle se perdía por completo (quedaba en la dirección entera
  // sin numeración). El texto después de la coma se guarda como referencia,
  // no se descarta.
  it('no pierde el número cuando hay texto después de una coma', () => {
    expect(splitDireccion('Jose Florio 4405, parque industrial pesquero')).toEqual({
      calle: 'Jose Florio', numeracion: '4405', referencia: 'parque industrial pesquero',
    });
  });

  // Otro bug real: "Escalada 45 depto 9" terminaba en dígito (el 9 del depto)
  // y el regex viejo lo tomaba como numeración de calle, comiéndose "45" y
  // la palabra "depto" adentro de `calle`.
  it('separa un sufijo de depto/piso/casa en vez de comerse el número real', () => {
    expect(splitDireccion('Escalada 45 depto 9')).toEqual({
      calle: 'Escalada', numeracion: '45', referencia: 'depto 9',
    });
  });

  it('tolera vacío/null', () => {
    expect(splitDireccion('')).toEqual({ calle: '', numeracion: '', referencia: '' });
    expect(splitDireccion(null)).toEqual({ calle: '', numeracion: '', referencia: '' });
  });
});

describe('splitTelefonoAr', () => {
  it('usa el primer grupo como característica cuando hay separadores', () => {
    expect(splitTelefonoAr('0351 4567890')).toEqual({ caracteristica: '351', numero: '4567890' });
  });

  it('quita prefijos +54 / 9 / 0 y 15', () => {
    expect(splitTelefonoAr('+54 9 351 555 1234')).toEqual({ caracteristica: '351', numero: '5551234' });
  });

  it('separa CABA (11) sin separadores', () => {
    expect(splitTelefonoAr('1145678901')).toEqual({ caracteristica: '11', numero: '45678901' });
  });

  it('sin separadores y sin 11: asume característica de 3 dígitos', () => {
    expect(splitTelefonoAr('3515551234')).toEqual({ caracteristica: '351', numero: '5551234' });
  });

  it('tolera vacío', () => {
    expect(splitTelefonoAr('')).toEqual({ caracteristica: '', numero: '' });
    expect(splitTelefonoAr(null)).toEqual({ caracteristica: '', numero: '' });
  });
});

describe('nombreProvincia', () => {
  it('mapea códigos cortos conocidos', () => {
    expect(nombreProvincia('B')).toBe('Buenos Aires');
    expect(nombreProvincia('c')).toBe('CABA');
    expect(nombreProvincia('X')).toBe('Córdoba');
  });

  it('deja pasar un nombre completo sin tocarlo', () => {
    expect(nombreProvincia('Buenos Aires')).toBe('Buenos Aires');
  });

  it('vacío da vacío, sin inventar nada', () => {
    expect(nombreProvincia('')).toBe('');
    expect(nombreProvincia(null)).toBe('');
  });
});

describe('normalizarEnvio', () => {
  const base = {
    id: 77, number: '77',
    shipping: { first_name: 'Ana', last_name: 'Gomez', address_1: 'Belgrano 123', address_2: '2B', city: 'Córdoba', state: 'Córdoba', postcode: '5000', phone: '0351 4567890' },
    billing: { first_name: 'Fac', last_name: 'Turador', address_1: 'Otra 999', address_2: '', city: 'CABA', state: 'CABA', postcode: '1000', email: 'ana@mail.com', phone: '011 5555-6666' },
    customer_note: 'tocar timbre',
    meta_data: [{ key: '_billing_dni', value: '30123456' }],
  };

  it('usa la dirección de envío cuando existe', () => {
    const e = normalizarEnvio(base);
    expect(e.nombre).toBe('Ana');
    expect(e.apellido).toBe('Gomez');
    expect(e.calle).toBe('Belgrano');
    expect(e.numeracion).toBe('123');
    expect(e.piso_depto).toBe('2B');
    expect(e.localidad).toBe('Córdoba');
    expect(e.cp).toBe('5000');
    expect(e.caracteristica).toBe('351');
    expect(e.telefono).toBe('4567890');
    expect(e.email).toBe('ana@mail.com');
    expect(e.dni_cuit).toBe('30123456');
    expect(e.notas).toBe('tocar timbre');
  });

  it('mapea el código corto de provincia a nombre completo', () => {
    const conCodigo = { ...base, shipping: { ...base.shipping, state: 'S' } };
    expect(normalizarEnvio(conCodigo).provincia).toBe('Santa Fe');
  });

  it('conserva la provincia tal cual si ya viene como nombre completo', () => {
    expect(normalizarEnvio(base).provincia).toBe('Córdoba');
  });

  it('conserva un valor de provincia desconocido en vez de vaciarlo', () => {
    const raro = { ...base, shipping: { ...base.shipping, state: 'Zona Rara' } };
    expect(normalizarEnvio(raro).provincia).toBe('Zona Rara');
  });

  it('cae a facturación si el envío está vacío', () => {
    const sinShipping = { ...base, shipping: { first_name: '', last_name: '', address_1: '', city: '', state: '', postcode: '' } };
    const e = normalizarEnvio(sinShipping);
    expect(e.nombre).toBe('Fac');
    expect(e.calle).toBe('Otra');
    expect(e.numeracion).toBe('999');
    expect(e.localidad).toBe('CABA');
    expect(e.caracteristica).toBe('11');
    expect(e.telefono).toBe('55556666');
  });

  it('con fuenteForzada usa esa fuente sin importar la regla automática', () => {
    expect(normalizarEnvio(base, 'billing').calle).toBe('Otra');
    expect(normalizarEnvio(base, 'shipping').calle).toBe('Belgrano');
  });
});

describe('direccionesDifieren', () => {
  const mismo = {
    shipping: { first_name: 'Ana', last_name: 'Gomez', address_1: 'Belgrano 123', city: 'Córdoba', state: 'X', phone: '3511234567' },
    billing: { first_name: 'Ana', last_name: 'Gomez', address_1: 'Belgrano 123', city: 'Córdoba', state: 'X', phone: '3511234567' },
  };

  it('no difieren si son la misma dirección', () => {
    expect(direccionesDifieren(mismo)).toEqual({ difieren: false, campos: [] });
  });

  it('no difieren por acentos, mayúsculas o espacios de más', () => {
    const variante = { ...mismo, shipping: { ...mismo.shipping, address_1: '  belgrano   123 ', city: 'CORDOBA' } };
    expect(direccionesDifieren(variante).difieren).toBe(false);
  });

  it('difieren si la calle es distinta', () => {
    const distinta = { ...mismo, billing: { ...mismo.billing, address_1: 'Otra calle 999' } };
    const r = direccionesDifieren(distinta);
    expect(r.difieren).toBe(true);
    expect(r.campos).toContain('calle');
  });

  it('difieren si el nombre del destinatario es distinto', () => {
    const distinto = { ...mismo, billing: { ...mismo.billing, first_name: 'Otro' } };
    expect(direccionesDifieren(distinto).campos).toContain('nombre');
  });

  it('no difieren si billing no tiene dirección propia (vacía)', () => {
    const sinBilling = { ...mismo, billing: { address_1: '' } };
    expect(direccionesDifieren(sinBilling)).toEqual({ difieren: false, campos: [] });
  });
});

// ─── perfiles y requisitos de foto ────────────────────────────────────────────

describe('resolverPerfil', () => {
  it('detecta bici por categoría BICICLETAS', () => {
    expect(resolverPerfil({ categorias: ['BICICLETAS POR MARCA', 'BICICLETAS TREK'], nombre: 'Bicicleta Trek Marlin 7' })).toBe('bici');
  });

  it('detecta kit de transmisión por categoría TRANSMISIONES', () => {
    expect(resolverPerfil({ categorias: ['TRANSMISIONES'], nombre: 'Grupo Shimano Deore 12v' })).toBe('kit_transmision');
  });

  it('detecta kit por nombre GRUPO/KIT + transmisión aunque la categoría no ayude', () => {
    expect(resolverPerfil({ categorias: [], nombre: 'Kit transmisión SRAM GX' })).toBe('kit_transmision');
    expect(resolverPerfil({ categorias: [], nombre: 'Grupo Transmision Shimano Deore 12v' })).toBe('kit_transmision');
  });

  it('un "kit" que no es de transmisión NO es kit_transmision (caso real: kit purgado)', () => {
    expect(resolverPerfil({ categorias: ['HERRAMIENTAS'], nombre: 'Kit Purgado Ezmtb Basico (1019) Shimano' })).toBe('sellado');
    expect(resolverPerfil({ categorias: ['ACCESORIOS TUBELESS'], nombre: 'Kit Tubeless Valvulas' })).toBe('sellado');
  });

  it('el resto es sellado', () => {
    expect(resolverPerfil({ categorias: ['CUBIERTAS'], nombre: 'Cubierta Maxxis Ikon' })).toBe('sellado');
  });
});

describe('requisitosFoto', () => {
  it('bici re_embalada exige lado_a + lado_b + caja_accesorios', () => {
    const slots = requisitosFoto('bici', 're_embalada');
    const tipos = slots.map(s => s.tipos.join('|'));
    expect(tipos).toContain('lado_a');
    expect(tipos).toContain('lado_b');
    expect(tipos).toContain('caja_accesorios');
  });

  it('bici sellada pide una sola foto (articulo o etiqueta)', () => {
    const slots = requisitosFoto('bici', 'sellada');
    expect(slots).toHaveLength(1);
    expect(slots[0].tipos).toEqual(expect.arrayContaining(['articulo', 'etiqueta']));
  });

  it('kit_transmision pide foto de piezas', () => {
    const slots = requisitosFoto('kit_transmision', null);
    expect(slots).toHaveLength(1);
    expect(slots[0].tipos).toContain('piezas');
  });

  it('sellado pide una foto de articulo/etiqueta', () => {
    const slots = requisitosFoto('sellado', null);
    expect(slots).toHaveLength(1);
  });
});

describe('fotosFaltantes', () => {
  it('reporta los slots sin foto', () => {
    const req = requisitosFoto('bici', 're_embalada');
    const faltan = fotosFaltantes(req, [{ tipo: 'lado_a' }]);
    expect(faltan.map(s => s.tipos.join('|'))).toEqual(['lado_b', 'caja_accesorios']);
  });

  it('vacío cuando está todo', () => {
    const req = requisitosFoto('sellado', null);
    expect(fotosFaltantes(req, [{ tipo: 'etiqueta' }])).toEqual([]);
  });
});

describe('requisitosConCantidad', () => {
  it('con cantidad 1 (o menos) no toca nada', () => {
    const slots = requisitosFoto('sellado', null);
    expect(requisitosConCantidad(slots, 1)).toEqual(slots);
    expect(requisitosConCantidad(slots, 0)).toEqual(slots);
  });

  it('anota el slot "de artículo" cuando matchea por tipo (sellado/bici default)', () => {
    const slots = requisitosConCantidad(requisitosFoto('sellado', null), 3);
    expect(slots[0].etiqueta).toMatch(/3 unidades/);
  });

  it('fallback: si ningún slot es "de artículo" por tipo (bici re_embalada), anota el PRIMERO igual (MUTATION: hallazgo del revisor — sin el fallback, la nota desaparece acá)', () => {
    const slots = requisitosConCantidad(requisitosFoto('bici', 're_embalada'), 4);
    // Ninguno de lado_a/lado_b/caja_accesorios matchea 'articulo'/'piezas' por nombre.
    expect(slots.map(s => s.tipos[0])).toEqual(['lado_a', 'lado_b', 'caja_accesorios']);
    expect(slots[0].etiqueta).toMatch(/4 unidades/);
    // Solo el primero lleva la nota, no se duplica en los otros.
    expect(slots[1].etiqueta).not.toMatch(/unidades/);
    expect(slots[2].etiqueta).not.toMatch(/unidades/);
  });

  it('fallback también aplica a un requisitos_json custom con tipos propios (mecanismo real de fotos extra por SKU/categoría)', () => {
    const customSlots = [{ tipos: ['detalle_costura'], min: 1, etiqueta: 'Detalle de costura' }];
    const anotados = requisitosConCantidad(customSlots, 2);
    expect(anotados[0].etiqueta).toMatch(/2 unidades/);
  });

  it('no anota dos veces si YA hay más de un slot "de artículo" — cada uno con su propia nota', () => {
    const slots = [
      { tipos: ['articulo'], min: 1, etiqueta: 'Foto 1' },
      { tipos: ['articulo'], min: 1, etiqueta: 'Foto 2' },
    ];
    const anotados = requisitosConCantidad(slots, 5);
    expect(anotados[0].etiqueta).toMatch(/5 unidades/);
    expect(anotados[1].etiqueta).toMatch(/5 unidades/);
  });
});

describe('esEnvioLocal', () => {
  it('acepta flex y colecta, rechaza full', () => {
    expect(esEnvioLocal('self_service')).toBe(true);
    expect(esEnvioLocal('cross_docking')).toBe(true);
    expect(esEnvioLocal('drop_off')).toBe(true);
    expect(esEnvioLocal('xd_drop_off')).toBe(true);
    expect(esEnvioLocal('fulfillment')).toBe(false);
  });
});

// ─── flujo del router sobre la DB ─────────────────────────────────────────────

describe('preparacion flujo', () => {
  let db, app;

  const ITEMS = [
    { line_item_id: 1, product_id: 10, sku: 'BICI-1', nombre: 'Bicicleta Trek Marlin 7', categoria: 'BICICLETAS TREK', cantidad: 1 },
    { line_item_id: 2, product_id: 20, sku: 'CUB-1', nombre: 'Cubierta Maxxis', categoria: 'CUBIERTAS', cantidad: 2 },
    { line_item_id: 3, product_id: 30, sku: '', nombre: 'Producto sin código', categoria: 'ACCESORIOS', cantidad: 1 },
  ];

  beforeEach(() => {
    for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) { try { fs.unlinkSync(f); } catch (_) {} }
    db = openDb(TEST_DB);
    app = buildTestApp(db);
  });

  afterEach(() => {
    db.close();
    for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) { try { fs.unlinkSync(f); } catch (_) {} }
  });

  async function nuevaPrep() {
    const id = crearPreparacion(db, {
      canal: 'web', wcOrderId: 500, numeroPedido: '500', comprador: 'Ana Gomez', items: ITEMS,
    });
    await tomarPorApi(app, id);
    return id;
  }

  // Las dos fotos generales del paquete (contenido a la vista + cerrado con etiqueta) son
  // obligatorias para completar cualquier preparación desde este ciclo — helper para no
  // repetir el insert en cada test que llega hasta /completar.
  function insertarFotosPaquete(prepId) {
    const now = new Date().toISOString();
    const ins = db.prepare('INSERT INTO preparacion_fotos (preparacion_id, item_id, tipo, url, creado_en) VALUES (?,NULL,?,?,?)');
    ins.run(prepId, 'paquete_abierto', '/uploads/paquete-abierto.jpg', now);
    ins.run(prepId, 'paquete_cerrado', '/uploads/paquete-cerrado.jpg', now);
  }

  it('crearPreparacion es idempotente por clave', async () => {
    const id1 = await nuevaPrep();
    const id2 = await nuevaPrep();
    expect(id2).toBe(id1);
    const items = db.prepare('SELECT * FROM preparacion_items WHERE preparacion_id=?').all(id1);
    expect(items).toHaveLength(3);
    expect(items.find(i => i.sku === 'BICI-1').perfil).toBe('bici');
    expect(items.find(i => i.sku === 'CUB-1').perfil).toBe('sellado');
  });

  it('escanear: match sube cantidad y verifica al completar', async () => {
    const id = await nuevaPrep();
    let r = await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'CUB-1' });
    expect(r.body.resultado).toBe('match');
    expect(r.body.item.cantidad_escaneada).toBe(1);
    expect(r.body.item.estado_item).toBe('pendiente');

    r = await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'CUB-1' });
    expect(r.body.resultado).toBe('match');
    expect(r.body.item.estado_item).toBe('verificado');
  });

  it('escanear: código ajeno → no_coincide; de más → sobrante', async () => {
    const id = await nuevaPrep();
    let r = await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'NO-EXISTE' });
    expect(r.body.resultado).toBe('no_coincide');

    await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'BICI-1' });
    r = await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'BICI-1' });
    expect(r.body.resultado).toBe('sobrante');
  });

  it('confirmar-manual verifica ítems sin código, con motivo válido', async () => {
    const id = await nuevaPrep();
    const item = db.prepare('SELECT id FROM preparacion_items WHERE preparacion_id=? AND sku=?').get(id, '');
    const r = await request(app).post(`/api/preparacion/${id}/item/${item.id}/confirmar-manual`).send({ motivo: 'sin_etiqueta' });
    expect(r.body.ok).toBe(true);
    const row = db.prepare('SELECT * FROM preparacion_items WHERE id=?').get(item.id);
    expect(row.estado_item).toBe('verificado');
    expect(row.confirmado_manual).toBe(1);
  });

  it('confirmar-manual sin motivo → 400, no toca el ítem (MUTATION: si se saca el chequeo de motivo, este test se pone en rojo)', async () => {
    const id = await nuevaPrep();
    const item = db.prepare('SELECT id FROM preparacion_items WHERE preparacion_id=? AND sku=?').get(id, '');
    const r = await request(app).post(`/api/preparacion/${id}/item/${item.id}/confirmar-manual`).send({});
    expect(r.status).toBe(400);
    expect(r.body.ok).toBe(false);
    const row = db.prepare('SELECT * FROM preparacion_items WHERE id=?').get(item.id);
    expect(row.estado_item).not.toBe('verificado');
    expect(row.confirmado_manual).toBe(0);
  });

  it('confirmar-manual con motivo inválido (fuera de la lista corta) → 400', async () => {
    const id = await nuevaPrep();
    const item = db.prepare('SELECT id FROM preparacion_items WHERE preparacion_id=? AND sku=?').get(id, '');
    const r = await request(app).post(`/api/preparacion/${id}/item/${item.id}/confirmar-manual`).send({ motivo: 'porque_si' });
    expect(r.status).toBe(400);
    const row = db.prepare('SELECT * FROM preparacion_items WHERE id=?').get(item.id);
    expect(row.estado_item).not.toBe('verificado');
  });

  it('confirmar-manual con motivo "otro" sin detalle_texto → 400', async () => {
    const id = await nuevaPrep();
    const item = db.prepare('SELECT id FROM preparacion_items WHERE preparacion_id=? AND sku=?').get(id, '');
    const r = await request(app).post(`/api/preparacion/${id}/item/${item.id}/confirmar-manual`).send({ motivo: 'otro' });
    expect(r.status).toBe(400);
    const row = db.prepare('SELECT * FROM preparacion_items WHERE id=?').get(item.id);
    expect(row.estado_item).not.toBe('verificado');
  });

  it('confirmar-manual con motivo "otro" y detalle_texto verifica y registra el texto libre', async () => {
    const id = await nuevaPrep();
    const item = db.prepare('SELECT id FROM preparacion_items WHERE preparacion_id=? AND sku=?').get(id, '');
    const r = await request(app).post(`/api/preparacion/${id}/item/${item.id}/confirmar-manual`)
      .send({ motivo: 'otro', detalle_texto: 'llegó sin caja, el vendedor lo confirmó por teléfono' });
    expect(r.status).toBe(200);
    const ev = db.prepare("SELECT * FROM preparacion_eventos WHERE preparacion_id=? AND tipo='escaneo'").get(id);
    expect(JSON.parse(ev.detalle_json)).toMatchObject({
      motivo: 'otro', detalle_texto: 'llegó sin caja, el vendedor lo confirmó por teléfono',
    });
  });

  it('completar exige ítems verificados, fotos por artículo Y las dos fotos de paquete', async () => {
    const id = await nuevaPrep();
    // nada verificado → 400 con detalle
    let r = await request(app).post(`/api/preparacion/${id}/completar`).send({});
    expect(r.status).toBe(400);
    expect(r.body.faltantes.length).toBeGreaterThan(0);

    // verificar todo
    await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'BICI-1' });
    await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'CUB-1' });
    await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'CUB-1' });
    const sinCodigo = db.prepare('SELECT id FROM preparacion_items WHERE preparacion_id=? AND sku=?').get(id, '');
    await request(app).post(`/api/preparacion/${id}/item/${sinCodigo.id}/confirmar-manual`).send({ motivo: 'codigo_ilegible' });

    // bici re_embalada: faltan fotos → 400
    const bici = db.prepare('SELECT id FROM preparacion_items WHERE preparacion_id=? AND sku=?').get(id, 'BICI-1');
    await request(app).post(`/api/preparacion/${id}/item/${bici.id}/embalaje`).send({ estado_embalaje: 're_embalada' });
    r = await request(app).post(`/api/preparacion/${id}/completar`).send({});
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body.faltantes)).toContain('lado_a');

    // insertar fotos requeridas de todos los ítems (sin las de paquete todavía) y completar
    const now = new Date().toISOString();
    const insFoto = db.prepare('INSERT INTO preparacion_fotos (preparacion_id, item_id, tipo, url, creado_en) VALUES (?,?,?,?,?)');
    const items = db.prepare('SELECT * FROM preparacion_items WHERE preparacion_id=?').all(id);
    for (const it of items) {
      if (it.sku === 'BICI-1') {
        for (const t of ['lado_a', 'lado_b', 'caja_accesorios']) insFoto.run(id, it.id, t, '/uploads/x.jpg', now);
      } else {
        insFoto.run(id, it.id, 'articulo', '/uploads/x.jpg', now);
      }
    }
    // todos los ítems ya tienen su foto, pero faltan las dos generales del paquete → 400
    // (MUTATION: si se saca el chequeo del paquete en /completar, este bloque queda en rojo)
    r = await request(app).post(`/api/preparacion/${id}/completar`).send({});
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body.faltantes)).toMatch(/paquete_abierto|paquete_cerrado/);

    insertarFotosPaquete(id);
    r = await request(app).post(`/api/preparacion/${id}/completar`).send({});
    expect(r.status).toBe(200);
    expect(r.body.estado).toBe('completada');
    const prep = db.prepare('SELECT * FROM preparaciones WHERE id=?').get(id);
    expect(prep.estado).toBe('completada');
    expect(prep.preparado_por).toBe('tester');
    expect(prep.completado_en).toBeTruthy();
  });

  // Estos dos tests aíslan el chequeo `estado_item !== 'verificado'` de calcularFaltantesPreparacion
  // (routes/preparacion.js) del chequeo de fotos: TODAS las fotos (artículo + las dos de
  // paquete) ya están puestas, así que si /completar da 400 acá, es EXCLUSIVAMENTE por el
  // escaneo incompleto. El test viejo de la línea ~474 no probaba esto — pasaba por el 400 de
  // fotos, no por el de verificación (revisor, 2026-08-13).
  it('completar con todas las fotos puestas pero un ítem sin escanear ninguna unidad → 400 sin_verificar, no cambia el estado (MUTATION: sacando el if estado_item!==\'verificado\' de calcularFaltantesPreparacion, este test se pone en rojo)', async () => {
    const id = crearPreparacion(db, {
      canal: 'web', wcOrderId: 701, numeroPedido: '701', comprador: 'Caso incidente',
      items: [{ line_item_id: 1, product_id: 20, sku: 'CUB-1', nombre: 'Cubierta Maxxis', categoria: 'CUBIERTAS', cantidad: 5 }],
    });
    await tomarPorApi(app, id);
    const item = db.prepare('SELECT * FROM preparacion_items WHERE preparacion_id=?').get(id);
    expect(item.cantidad_esperada).toBe(5);
    expect(item.cantidad_escaneada).toBe(0);
    expect(item.estado_item).toBe('pendiente');

    // Todas las fotos: la del artículo y las dos de paquete — nada de fotos falta.
    const insFoto = db.prepare('INSERT INTO preparacion_fotos (preparacion_id, item_id, tipo, url, creado_en) VALUES (?,?,?,?,?)');
    insFoto.run(id, item.id, 'articulo', '/uploads/x.jpg', new Date().toISOString());
    insertarFotosPaquete(id);

    const r = await request(app).post(`/api/preparacion/${id}/completar`).send({});
    expect(r.status).toBe(400);
    expect(r.body.faltantes).toEqual([
      { item_id: item.id, sku: 'CUB-1', nombre: 'Cubierta Maxxis', motivo: 'sin_verificar' },
    ]);

    const prep = db.prepare('SELECT * FROM preparaciones WHERE id=?').get(id);
    expect(prep.estado).toBe('en_preparacion'); // no se movió
    expect(prep.completado_en).toBeNull();
  });

  it('completar con todas las fotos puestas y un ítem parcialmente escaneado (2 de 5, el caso real del incidente) → 400 sin_verificar, no cambia el estado (MUTATION: sacando el if estado_item!==\'verificado\' de calcularFaltantesPreparacion, este test se pone en rojo)', async () => {
    const id = crearPreparacion(db, {
      canal: 'web', wcOrderId: 702, numeroPedido: '702', comprador: 'Caso incidente parcial',
      items: [{ line_item_id: 1, product_id: 20, sku: 'CUB-1', nombre: 'Cubierta Maxxis', categoria: 'CUBIERTAS', cantidad: 5 }],
    });
    await tomarPorApi(app, id);
    await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'CUB-1' });
    await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'CUB-1' });
    const item = db.prepare('SELECT * FROM preparacion_items WHERE preparacion_id=?').get(id);
    expect(item.cantidad_escaneada).toBe(2);
    expect(item.estado_item).toBe('pendiente'); // 2 de 5, no llegó a verificado

    const insFoto = db.prepare('INSERT INTO preparacion_fotos (preparacion_id, item_id, tipo, url, creado_en) VALUES (?,?,?,?,?)');
    insFoto.run(id, item.id, 'articulo', '/uploads/x.jpg', new Date().toISOString());
    insertarFotosPaquete(id);

    const r = await request(app).post(`/api/preparacion/${id}/completar`).send({});
    expect(r.status).toBe(400);
    expect(r.body.faltantes).toEqual([
      { item_id: item.id, sku: 'CUB-1', nombre: 'Cubierta Maxxis', motivo: 'sin_verificar' },
    ]);

    const prep = db.prepare('SELECT * FROM preparaciones WHERE id=?').get(id);
    expect(prep.estado).toBe('en_preparacion');
    expect(prep.completado_en).toBeNull();
  });

  it('el requisito de foto de un ítem con cantidad_esperada>1 pide explícitamente que se vean las N unidades (nota humana, no validación)', async () => {
    const id = await nuevaPrep();
    const cub = db.prepare("SELECT * FROM preparacion_items WHERE preparacion_id=? AND sku='CUB-1'").get(id); // cantidad 2
    const r = await request(app).get(`/api/preparacion/${id}`);
    const itemDetalle = r.body.data.items.find(i => i.id === cub.id);
    expect(itemDetalle.requisitos_foto[0].etiqueta).toMatch(/2 unidades/);

    // el ítem sin código (cantidad 1) NO lleva la nota
    const sinCodigo = r.body.data.items.find(i => i.sku === '');
    expect(sinCodigo.requisitos_foto[0].etiqueta).not.toMatch(/unidades/);
  });

  it('despacho deposito_relajado exime escaneo y fotos', async () => {
    const id = await nuevaPrep();
    const bici = db.prepare('SELECT id FROM preparacion_items WHERE preparacion_id=? AND sku=?').get(id, 'BICI-1');
    const r = await request(app).post(`/api/preparacion/${id}/item/${bici.id}/despacho`)
      .send({ modo: 'deposito_relajado', motivo: 'caja en depósito' });
    expect(r.body.ok).toBe(true);
    const row = db.prepare('SELECT * FROM preparacion_items WHERE id=?').get(bici.id);
    expect(row.estado_item).toBe('exento');
    expect(row.despacho).toBe('deposito_relajado');

    // verificar el resto con fotos y completar sin tocar la bici
    await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'CUB-1' });
    await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'CUB-1' });
    const sinCodigo = db.prepare('SELECT id FROM preparacion_items WHERE preparacion_id=? AND sku=?').get(id, '');
    await request(app).post(`/api/preparacion/${id}/item/${sinCodigo.id}/confirmar-manual`).send({ motivo: 'sin_etiqueta' });
    const now = new Date().toISOString();
    const insFoto = db.prepare('INSERT INTO preparacion_fotos (preparacion_id, item_id, tipo, url, creado_en) VALUES (?,?,?,?,?)');
    for (const it of db.prepare("SELECT * FROM preparacion_items WHERE preparacion_id=? AND estado_item='verificado'").all(id)) {
      insFoto.run(id, it.id, 'articulo', '/uploads/x.jpg', now);
    }
    insertarFotosPaquete(id);
    const fin = await request(app).post(`/api/preparacion/${id}/completar`).send({});
    expect(fin.status).toBe(200);
    expect(fin.body.estado).toBe('completada');
  });

  it('despacho deposito_delegado deja la orden pendiente_deposito y luego se completa', async () => {
    const id = await nuevaPrep();
    const bici = db.prepare('SELECT id FROM preparacion_items WHERE preparacion_id=? AND sku=?').get(id, 'BICI-1');
    await request(app).post(`/api/preparacion/${id}/item/${bici.id}/despacho`).send({ modo: 'deposito_delegado' });

    // resto verificado + fotos
    await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'CUB-1' });
    await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'CUB-1' });
    const sinCodigo = db.prepare('SELECT id FROM preparacion_items WHERE preparacion_id=? AND sku=?').get(id, '');
    await request(app).post(`/api/preparacion/${id}/item/${sinCodigo.id}/confirmar-manual`).send({ motivo: 'sin_etiqueta' });
    const now = new Date().toISOString();
    const insFoto = db.prepare('INSERT INTO preparacion_fotos (preparacion_id, item_id, tipo, url, creado_en) VALUES (?,?,?,?,?)');
    for (const it of db.prepare("SELECT * FROM preparacion_items WHERE preparacion_id=? AND estado_item='verificado'").all(id)) {
      insFoto.run(id, it.id, 'articulo', '/uploads/x.jpg', now);
    }

    // completar → queda pendiente_deposito (la bici la termina el depósito). El paquete
    // todavía no está sellado (falta la bici), así que NO se exige la foto de paquete acá
    // aunque no se haya subido ninguna: sería pedir la foto del cierre antes de cerrar.
    let r = await request(app).post(`/api/preparacion/${id}/completar`).send({});
    expect(r.status).toBe(200);
    expect(r.body.estado).toBe('pendiente_deposito');

    // el depósito escanea la bici y sube su foto → completar de nuevo (acá sí es el cierre
    // final, y ahí se exigen las dos fotos de paquete)
    await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'BICI-1' });
    insFoto.run(id, bici.id, 'articulo', '/uploads/x.jpg', now); // sellada por defecto: 1 foto
    insertarFotosPaquete(id);
    r = await request(app).post(`/api/preparacion/${id}/completar`).send({});
    expect(r.status).toBe(200);
    expect(r.body.estado).toBe('completada');
  });

  it('embalaje y despacho registran valor_anterior -> valor_nuevo en preparacion_eventos', async () => {
    const id = await nuevaPrep();
    const bici = db.prepare('SELECT * FROM preparacion_items WHERE preparacion_id=? AND sku=?').get(id, 'BICI-1');

    await request(app).post(`/api/preparacion/${id}/item/${bici.id}/embalaje`).send({ estado_embalaje: 'abierta' });
    await request(app).post(`/api/preparacion/${id}/item/${bici.id}/embalaje`).send({ estado_embalaje: 're_embalada' });

    const evsEmb = db.prepare("SELECT * FROM preparacion_eventos WHERE preparacion_id=? AND tipo='embalaje' ORDER BY id").all(id);
    expect(evsEmb).toHaveLength(2);
    expect(JSON.parse(evsEmb[0].detalle_json)).toMatchObject({ valor_anterior: null, valor_nuevo: 'abierta' });
    expect(JSON.parse(evsEmb[1].detalle_json)).toMatchObject({ valor_anterior: 'abierta', valor_nuevo: 're_embalada' });

    await request(app).post(`/api/preparacion/${id}/item/${bici.id}/despacho`).send({ modo: 'deposito_relajado' });
    const evDesp = db.prepare("SELECT * FROM preparacion_eventos WHERE preparacion_id=? AND tipo='despacho'").get(id);
    expect(JSON.parse(evDesp.detalle_json)).toMatchObject({ valor_anterior: 'local', valor_nuevo: 'deposito_relajado' });
  });

  it('completar registra un evento tipo completado', async () => {
    const id = await nuevaPrep();
    await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'BICI-1' });
    await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'CUB-1' });
    await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'CUB-1' });
    const sinCodigo = db.prepare('SELECT id FROM preparacion_items WHERE preparacion_id=? AND sku=?').get(id, '');
    await request(app).post(`/api/preparacion/${id}/item/${sinCodigo.id}/confirmar-manual`).send({ motivo: 'sin_etiqueta' });
    const now = new Date().toISOString();
    const insFoto = db.prepare('INSERT INTO preparacion_fotos (preparacion_id, item_id, tipo, url, creado_en) VALUES (?,?,?,?,?)');
    for (const it of db.prepare('SELECT * FROM preparacion_items WHERE preparacion_id=?').all(id)) {
      insFoto.run(id, it.id, 'articulo', '/uploads/x.jpg', now);
    }
    insertarFotosPaquete(id);
    const r = await request(app).post(`/api/preparacion/${id}/completar`).send({});
    expect(r.status).toBe(200);
    expect(r.body.estado).toBe('completada');
    const ev = db.prepare("SELECT * FROM preparacion_eventos WHERE preparacion_id=? AND tipo='completado'").get(id);
    expect(ev).toBeTruthy();
    expect(ev.usuario).toBe('tester');
  });

  it('etiqueta_lista se marca aun sin preparación previa', async () => {
    const r = await request(app).post('/api/preparacion/etiquetas/900/lista').send({ lista: true, numero_pedido: '900', comprador: 'X' });
    expect(r.body.ok).toBe(true);
    const prep = db.prepare("SELECT * FROM preparaciones WHERE clave='web:900'").get();
    expect(prep.etiqueta_lista).toBe(1);
    expect(db.prepare('SELECT usuario FROM preparacion_claims WHERE preparacion_id=?').get(prep.id).usuario).toBe('tester');
  });

  it('etiqueta_lista exige el claim de otro operador si la preparación ya existe', async () => {
    const id = crearPreparacion(db, { canal: 'web', wcOrderId: 901, numeroPedido: '901', comprador: 'X', items: [] });
    await tomarPorApi(buildTestAppComo(db, 'ana'), id);
    const r = await request(app).post('/api/preparacion/etiquetas/901/lista').send({ lista: true });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('PREPARATION_CLAIMED');
  });

  describe('cerrada_sin_evidencia / reabrir', () => {
    async function nuevaPrepCerrada() {
      const id = await nuevaPrep();
      db.prepare("UPDATE preparaciones SET estado='cerrada_sin_evidencia' WHERE id=?").run(id);
      return id;
    }

    it('GET /cerradas-sin-evidencia lista solo las cerradas sin evidencia, no las completadas', async () => {
      const cerrada = await nuevaPrepCerrada();
      const otraCompletada = crearPreparacion(db, { canal: 'web', wcOrderId: 600, numeroPedido: '600', comprador: 'Beto', items: [] });
      db.prepare("UPDATE preparaciones SET estado='completada', completado_en=? WHERE id=?").run(new Date().toISOString(), otraCompletada);

      const r = await request(app).get('/api/preparacion/cerradas-sin-evidencia');
      expect(r.status).toBe(200);
      const ids = r.body.data.map(p => p.id);
      expect(ids).toContain(cerrada);
      expect(ids).not.toContain(otraCompletada);
    });

    it('GET /historial NO mezcla cerradas sin evidencia con las completadas (sección propia, no compartida)', async () => {
      const cerrada = await nuevaPrepCerrada();
      const r = await request(app).get('/api/preparacion/historial');
      expect(r.body.data.some(p => p.id === cerrada)).toBe(false);
    });

    it('GET /pendientes no muestra una preparación cerrada sin evidencia como trabajo pendiente', async () => {
      const id = await nuevaPrepCerrada();
      const prep = db.prepare('SELECT clave FROM preparaciones WHERE id=?').get(id);
      const iso = new Date().toISOString();
      db.prepare(`INSERT INTO pedidos_cache (clave, canal, wc_order_id, numero_pedido, comprador, fecha, estado_envio, items_json, actualizado_en)
        VALUES (?, 'web', 500, '500', 'Ana Gomez', ?, 'pendiente', '[]', ?)`).run(prep.clave, iso, iso);

      const r = await request(app).get('/api/preparacion/pendientes');
      expect(r.body.data.find(p => p.wc_order_id === 500)).toBeUndefined();
    });

    it('POST /:id/reabrir vuelve a en_preparacion y registra el evento reabierta con usuario', async () => {
      const id = await nuevaPrepCerrada();
      const r = await request(app).post(`/api/preparacion/${id}/reabrir`);
      expect(r.status).toBe(200);
      expect(r.body.estado).toBe('en_preparacion');

      const prep = db.prepare('SELECT * FROM preparaciones WHERE id=?').get(id);
      expect(prep.estado).toBe('en_preparacion');

      const ev = db.prepare("SELECT * FROM preparacion_eventos WHERE preparacion_id=? AND tipo='reabierta'").get(id);
      expect(ev).toBeTruthy();
      expect(ev.usuario).toBe('tester');
    });

    it('POST /:id/reabrir sobre una preparación que NO está cerrada_sin_evidencia → 400 (MUTATION: sacando el chequeo de estado, este test se pone en rojo)', async () => {
      const id = await nuevaPrep(); // en_preparacion normal
      const r = await request(app).post(`/api/preparacion/${id}/reabrir`);
      expect(r.status).toBe(400);
      const prep = db.prepare('SELECT * FROM preparaciones WHERE id=?').get(id);
      expect(prep.estado).toBe('en_preparacion'); // sin cambios
    });

    it('POST /:id/completar sobre una cerrada_sin_evidencia → 400, exige reabrir primero (MUTATION: sacando el chequeo, completaría en silencio sin el rastro de reabrir)', async () => {
      // Preparación SIN ítems (como en los tests de heartbeat) y con las dos fotos de
      // paquete ya puestas: si no fuera por el guard de cerrada_sin_evidencia, no habría
      // ningún otro motivo para que /completar la rechace (0 ítems -> nada pendiente de
      // verificar/fotografiar). Aísla el guard bajo prueba del resto de las validaciones.
      const id = crearPreparacion(db, { canal: 'web', wcOrderId: 610, numeroPedido: '610', comprador: 'X', items: [] });
      db.prepare("UPDATE preparaciones SET estado='cerrada_sin_evidencia' WHERE id=?").run(id);
      insertarFotosPaquete(id);
      await tomarPorApi(app, id);

      const r = await request(app).post(`/api/preparacion/${id}/completar`).send({});
      expect(r.status).toBe(400);
      const prep = db.prepare('SELECT * FROM preparaciones WHERE id=?').get(id);
      expect(prep.estado).toBe('cerrada_sin_evidencia');
    });

    it('escanear/confirmar-manual/subir foto sobre una cerrada_sin_evidencia → 400, no tocan nada (hallazgo del revisor: se podía trabajar encima sin reabrir)', async () => {
      const id = await nuevaPrepCerrada();
      const item = db.prepare('SELECT * FROM preparacion_items WHERE preparacion_id=? LIMIT 1').get(id);

      const rEscanear = await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: item.sku || 'CUB-1' });
      expect(rEscanear.status).toBe(400);

      const rConfirmar = await request(app).post(`/api/preparacion/${id}/item/${item.id}/confirmar-manual`).send({ motivo: 'sin_etiqueta' });
      expect(rConfirmar.status).toBe(400);

      const buf = await sharp({ create: { width: 4, height: 4, channels: 3, background: 'red' } }).jpeg().toBuffer();
      const rFoto = await request(app).post(`/api/preparacion/${id}/foto`).attach('archivo', buf, 'a.jpg');
      expect(rFoto.status).toBe(400);

      // Nada de esto tocó al ítem ni sumó fotos.
      const itemDespues = db.prepare('SELECT * FROM preparacion_items WHERE id=?').get(item.id);
      expect(itemDespues.cantidad_escaneada).toBe(0);
      expect(itemDespues.estado_item).toBe('pendiente');
      expect(db.prepare('SELECT COUNT(*) n FROM preparacion_fotos WHERE preparacion_id=?').get(id).n).toBe(0);
    });

    it('escanear sobre una cerrada_sin_evidencia → 400 (MUTATION: sin el guard de estado, escanearía igual sin reabrir)', async () => {
      const id = await nuevaPrepCerrada();
      const item = db.prepare('SELECT * FROM preparacion_items WHERE preparacion_id=? LIMIT 1').get(id);
      const r = await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: item.sku });
      expect(r.status).toBe(400);
      const itemDespues = db.prepare('SELECT * FROM preparacion_items WHERE id=?').get(item.id);
      expect(itemDespues.cantidad_escaneada).toBe(0);
    });

    it('confirmar-manual sobre una cerrada_sin_evidencia → 400 (MUTATION: sin el guard de estado, confirmaría igual sin reabrir)', async () => {
      const id = await nuevaPrepCerrada();
      const item = db.prepare('SELECT * FROM preparacion_items WHERE preparacion_id=? LIMIT 1').get(id);
      const r = await request(app).post(`/api/preparacion/${id}/item/${item.id}/confirmar-manual`).send({ motivo: 'sin_etiqueta' });
      expect(r.status).toBe(400);
      const itemDespues = db.prepare('SELECT * FROM preparacion_items WHERE id=?').get(item.id);
      expect(itemDespues.estado_item).not.toBe('verificado');
    });

    it('confirmar-manual sobre una preparación completada → 400, no se puede confirmar un ítem después del cierre', async () => {
      const id = await nuevaPrep();
      db.prepare("UPDATE preparaciones SET estado='completada' WHERE id=?").run(id);
      const item = db.prepare('SELECT * FROM preparacion_items WHERE preparacion_id=? LIMIT 1').get(id);
      const r = await request(app).post(`/api/preparacion/${id}/item/${item.id}/confirmar-manual`).send({ motivo: 'sin_etiqueta' });
      expect(r.status).toBe(400);
    });

    it('reabrir una preparación completada (no aplica) → 400, no la reabre', async () => {
      const id = await nuevaPrep();
      db.prepare("UPDATE preparaciones SET estado='completada' WHERE id=?").run(id);
      const r = await request(app).post(`/api/preparacion/${id}/reabrir`);
      expect(r.status).toBe(400);
      const prep = db.prepare('SELECT * FROM preparaciones WHERE id=?').get(id);
      expect(prep.estado).toBe('completada');
    });
  });

  // Mismo criterio que 'cerrada_sin_evidencia': un estado que no se puede consultar no
  // sirve para nada (hallazgo del revisor — el frontend ya construyó la pestaña esperando
  // GET /despachadas-sin-verificar, mismo patrón que /cerradas-sin-evidencia).
  describe('despachada_sin_verificar', () => {
    async function nuevaPrepDespachadaSinVerificar() {
      const id = await nuevaPrep();
      db.prepare("UPDATE preparaciones SET estado='despachada_sin_verificar', completado_en=? WHERE id=?")
        .run(new Date().toISOString(), id);
      return id;
    }

    it('GET /despachadas-sin-verificar lista solo ese estado, no las completadas ni las cerradas sin evidencia', async () => {
      const despachada = await nuevaPrepDespachadaSinVerificar();
      const completada = crearPreparacion(db, { canal: 'web', wcOrderId: 620, numeroPedido: '620', comprador: 'Beto', items: [] });
      db.prepare("UPDATE preparaciones SET estado='completada', completado_en=? WHERE id=?").run(new Date().toISOString(), completada);
      const cerrada = crearPreparacion(db, { canal: 'web', wcOrderId: 621, numeroPedido: '621', comprador: 'Caro', items: [] });
      db.prepare("UPDATE preparaciones SET estado='cerrada_sin_evidencia' WHERE id=?").run(cerrada);

      const r = await request(app).get('/api/preparacion/despachadas-sin-verificar');
      expect(r.status).toBe(200);
      const ids = r.body.data.map(p => p.id);
      expect(ids).toContain(despachada);
      expect(ids).not.toContain(completada);
      expect(ids).not.toContain(cerrada);
    });

    it('GET /despachadas-sin-verificar devuelve total_items y total_fotos, mismo shape que /cerradas-sin-evidencia', async () => {
      const id = await nuevaPrepDespachadaSinVerificar();
      const r = await request(app).get('/api/preparacion/despachadas-sin-verificar');
      const fila = r.body.data.find(p => p.id === id);
      expect(fila).toMatchObject({ estado: 'despachada_sin_verificar', total_items: 3, total_fotos: 0 });
    });

    // I6 (revisor): este estado no es terminal y a propósito no tiene ventana temporal (el
    // criterio de la pantalla es que nada se oculte) — pero eso solo se sostiene si la
    // lista avisa cuando el LIMIT 200 la corta, igual que a_medias_total/truncado en
    // GET /seguimientos.
    // wc_order_id distinto por fila: nuevaPrep()/nuevaPrepDespachadaSinVerificar() usan
    // siempre wcOrderId=500 (crearPreparacion es idempotente por clave), así que para varias
    // filas reales hay que insertar directo con claves únicas.
    function nuevaDespachadaSinVerificarConId(wcOrderId) {
      const iso = new Date().toISOString();
      return db.prepare(`INSERT INTO preparaciones (canal, clave, wc_order_id, etiqueta_lista, estado, creado_en, completado_en)
        VALUES ('web', ?, ?, 1, 'despachada_sin_verificar', ?, ?)`)
        .run(`web:${wcOrderId}`, wcOrderId, iso, iso).lastInsertRowid;
    }

    it('GET /despachadas-sin-verificar expone total y truncado:false cuando entran todas', async () => {
      nuevaDespachadaSinVerificarConId(600);
      nuevaDespachadaSinVerificarConId(601);
      const r = await request(app).get('/api/preparacion/despachadas-sin-verificar');
      expect(r.body.total).toBe(2);
      expect(r.body.truncado).toBe(false);
      expect(r.body.data).toHaveLength(2);
    });

    it('GET /despachadas-sin-verificar corta en 200 pero avisa truncado:true si hay más', async () => {
      for (let i = 0; i < 201; i++) nuevaDespachadaSinVerificarConId(700 + i);
      const r = await request(app).get('/api/preparacion/despachadas-sin-verificar');
      expect(r.body.total).toBe(201);
      expect(r.body.data).toHaveLength(200);
      expect(r.body.truncado).toBe(true);
    });

    it('GET /despachadas-sin-verificar solo cuenta/lista canal web, igual que el chip de GET /seguimientos', async () => {
      nuevaDespachadaSinVerificarConId(602);
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO preparaciones (canal, clave, ml_order_id, etiqueta_lista, estado, creado_en)
        VALUES ('ml','ml:ORD-1',NULL,1,'despachada_sin_verificar',?)`).run(now);
      const r = await request(app).get('/api/preparacion/despachadas-sin-verificar');
      expect(r.body.total).toBe(1);
      expect(r.body.data).toHaveLength(1);
    });

    it('GET /historial NO mezcla despachadas sin verificar con las completadas (MUTATION: si se agregara ese estado al IN de /historial, este test se pone en rojo)', async () => {
      const id = await nuevaPrepDespachadaSinVerificar();
      const r = await request(app).get('/api/preparacion/historial');
      expect(r.body.data.some(p => p.id === id)).toBe(false);
    });

    it('GET /pendientes no muestra una preparación despachada sin verificar como trabajo pendiente (ya salió, no es "por hacer") (MUTATION: sin el estado en RESUELTAS, este test se pone en rojo)', async () => {
      const id = await nuevaPrepDespachadaSinVerificar();
      const prep = db.prepare('SELECT clave FROM preparaciones WHERE id=?').get(id);
      const iso = new Date().toISOString();
      db.prepare(`INSERT INTO pedidos_cache (clave, canal, wc_order_id, numero_pedido, comprador, fecha, estado_envio, items_json, actualizado_en)
        VALUES (?, 'web', 500, '500', 'Ana Gomez', ?, 'pendiente', '[]', ?)`).run(prep.clave, iso, iso);

      const r = await request(app).get('/api/preparacion/pendientes');
      expect(r.body.data.find(p => p.wc_order_id === 500)).toBeUndefined();
    });
  });

  // A partir de acá, la subida NO convierte de forma sincrónica (plan 2026-08-12-fotos-
  // preparacion.md): guarda el archivo tal como llegó y responde al instante. La conversión/
  // achicado corre en segundo plano (lib/fotosPreparacionCola.js, testeado en su propio
  // archivo) — acá solo se verifica lo que hace el endpoint mismo.

  it('POST /:id/foto guarda el archivo TAL COMO LLEGÓ (sin convertir) y responde al instante', async () => {
    const id = await nuevaPrep();
    const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 255, g: 0, b: 0 } } })
      .png()
      .toBuffer();

    const r = await request(app)
      .post(`/api/preparacion/${id}/foto`)
      .attach('archivo', png, { filename: 'foto.png', contentType: 'image/png' });

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    // Extensión ORIGINAL preservada (.png), no convertida a .jpg — la conversión es trabajo
    // de la cola, no del request.
    expect(r.body.foto.url).toMatch(/\.png$/);
    expect(r.body.foto.estado_proceso).toBe('pendiente');
    expect(r.body.foto.url_liviana).toBeNull();
    expect(r.body.foto.es_heic).toBe(0);

    const fotos = db.prepare('SELECT * FROM preparacion_fotos WHERE preparacion_id=?').all(id);
    expect(fotos).toHaveLength(1);
    expect(fotos[0].estado_proceso).toBe('pendiente');
    // El archivo YA está en disco y sería servible por HTTP desde el instante de la subida.
    expect(fs.existsSync(rutaAbsoluta(fotos[0].url))).toBe(true);
  });

  it('POST /:id/foto NO valida que el buffer sea una imagen real: lo guarda igual (fail-open acá; la cola lo marca error después)', async () => {
    const id = await nuevaPrep();
    const buffer = Buffer.from('esto no es una imagen');

    const r = await request(app)
      .post(`/api/preparacion/${id}/foto`)
      .attach('archivo', buffer, { filename: 'foto.jpg', contentType: 'image/jpeg' });

    // A diferencia del pipeline viejo (que rechazaba con 400 porque sharp fallaba en el
    // request), ahora el guard es solo por mimetype/extensión declarados — decodificar el
    // contenido de verdad es trabajo de la cola, no del request (por eso el request es
    // instantáneo). Ver test/fotos-preparacion-cola.test.js para el caso "termina en error".
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.foto.estado_proceso).toBe('pendiente');

    const fotos = db.prepare('SELECT * FROM preparacion_fotos WHERE preparacion_id=?').all(id);
    expect(fotos).toHaveLength(1);
  });

  it('POST /:id/foto detecta HEIC por mimetype y marca es_heic=1, sin decodificar nada en el request', async () => {
    const id = await nuevaPrep();
    const heicBuffer = Buffer.from('ftypheic no es una imagen que sharp entienda');
    const r = await request(app)
      .post(`/api/preparacion/${id}/foto`)
      .attach('archivo', heicBuffer, { filename: 'IMG_1234.heic', contentType: 'image/heic' });

    // heic-convert NUNCA se llama desde el request — solo desde el worker de la cola.
    expect(heicConvert).not.toHaveBeenCalled();
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.foto.url).toMatch(/\.heic$/i);
    expect(r.body.foto.es_heic).toBe(1);
    expect(r.body.foto.estado_proceso).toBe('pendiente');
  });

  it('POST /:id/foto detecta HEIC por extensión aunque el mimetype llegue vacío/octet-stream (iPhone al compartir)', async () => {
    const id = await nuevaPrep();
    // iPhone al compartir manda el .heic con application/octet-stream (no arranca con image/):
    // el guard temprano NO debe cortarlo, la detección por extensión lo acepta igual.
    const heicBuffer = Buffer.from('ftypheic compartido desde iPhone');
    const r = await request(app)
      .post(`/api/preparacion/${id}/foto`)
      .attach('archivo', heicBuffer, { filename: 'IMG_9999.heic', contentType: 'application/octet-stream' });

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.foto.es_heic).toBe(1);
  });

  it('POST /:id/foto rechaza un archivo que no es imagen ni HEIC (mimetype no-image y sin extensión heic/heif)', async () => {
    const id = await nuevaPrep();
    const r = await request(app)
      .post(`/api/preparacion/${id}/foto`)
      .attach('archivo', Buffer.from('contenido pdf'), { filename: 'factura.pdf', contentType: 'application/pdf' });

    expect(r.status).toBe(400);
    expect(r.body).toEqual({ ok: false, error: 'solo imágenes' });
    expect(db.prepare('SELECT * FROM preparacion_fotos').all()).toHaveLength(0);
  });

  it('POST /:id/foto/:fotoId/reintentar reinicia una foto en error a pendiente y dispara la cola', async () => {
    const id = await nuevaPrep();
    const buf = await sharp({ create: { width: 4, height: 4, channels: 3, background: 'red' } }).jpeg().toBuffer();
    const subida = await request(app).post(`/api/preparacion/${id}/foto`).attach('archivo', buf, 'a.jpg');
    const fotoId = subida.body.foto.id;
    db.prepare("UPDATE preparacion_fotos SET estado_proceso='error', intentos=3, ultimo_error='x' WHERE id=?").run(fotoId);

    const r = await request(app).post(`/api/preparacion/${id}/foto/${fotoId}/reintentar`);

    expect(r.status).toBe(200);
    expect(r.body.foto.estado_proceso).toBe('pendiente');
    expect(r.body.foto.intentos).toBe(0);
  });

  it('POST /:id/foto/:fotoId/reintentar responde 400 si la foto no está en estado de error', async () => {
    const id = await nuevaPrep();
    const buf = await sharp({ create: { width: 4, height: 4, channels: 3, background: 'red' } }).jpeg().toBuffer();
    const subida = await request(app).post(`/api/preparacion/${id}/foto`).attach('archivo', buf, 'a.jpg');
    const fotoId = subida.body.foto.id; // recién subida: estado_proceso='pendiente', no 'error'

    const r = await request(app).post(`/api/preparacion/${id}/foto/${fotoId}/reintentar`);

    expect(r.status).toBe(400);
    expect(r.body.ok).toBe(false);
  });

  it('POST /:id/foto/:fotoId/reintentar responde 404 si la foto no existe', async () => {
    const id = await nuevaPrep();
    const r = await request(app).post(`/api/preparacion/${id}/foto/999999/reintentar`);
    expect(r.status).toBe(404);
  });

  it('POST /:id/foto responde 400 JSON (no 500 HTML) cuando la foto supera el límite de multer', async () => {
    const id = await nuevaPrep();
    // Buffer de 16MB: supera el límite de 15MB de multer (fotos de cámara nativa
    // de iPhones modernos). Antes esto propagaba un MulterError sin error-handler
    // y el frontend recibía HTML → flash genérico. Ahora es 400 con JSON claro.
    const gordo = Buffer.alloc(16 * 1024 * 1024, 0);
    const r = await request(app)
      .post(`/api/preparacion/${id}/foto`)
      .attach('archivo', gordo, { filename: 'IMG_1234.jpg', contentType: 'image/jpeg' });

    expect(r.status).toBe(400);
    expect(r.body.ok).toBe(false);
    expect(typeof r.body.error).toBe('string');
    expect(r.body.error).toMatch(/pesada/i);

    const fotos = db.prepare('SELECT * FROM preparacion_fotos WHERE preparacion_id=?').all(id);
    expect(fotos).toHaveLength(0);
  });

  it('POST /seguimientos/:wcOrderId valida wcOrderId y tracking', async () => {
    let r = await request(app).post('/api/preparacion/seguimientos/abc').send({ tracking: '123' });
    expect(r.status).toBe(400);
    r = await request(app).post('/api/preparacion/seguimientos/900').send({});
    expect(r.status).toBe(400);
  });

  // El camino real que produce 'despachada_sin_verificar' (marcarPreparacionEnviada, disparado
  // desde acá) no tenía NINGÚN test hasta ahora — solo estaban cubiertas las consultas
  // (GET /despachadas-sin-verificar) sobre un estado sembrado a mano por UPDATE directo, nunca
  // la transición en sí. Gap encontrado en la revisión de cobertura del 2026-08-13.
  it('POST /seguimientos/:wcOrderId con el único ítem verificado y todas las fotos marca la preparación completada', async () => {
    const id = crearPreparacion(db, {
      canal: 'web', wcOrderId: 950, numeroPedido: '950', comprador: 'Full',
      items: [{ line_item_id: 1, product_id: 20, sku: 'CUB-1', nombre: 'Cubierta Maxxis', categoria: 'CUBIERTAS', cantidad: 1 }],
    });
    await tomarPorApi(app, id);
    const item = db.prepare('SELECT * FROM preparacion_items WHERE preparacion_id=?').get(id);
    await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'CUB-1' });
    db.prepare('INSERT INTO preparacion_fotos (preparacion_id, item_id, tipo, url, creado_en) VALUES (?,?,?,?,?)')
      .run(id, item.id, 'articulo', '/uploads/x.jpg', new Date().toISOString());
    insertarFotosPaquete(id);

    wooFetch
      .mockResolvedValueOnce({ data: { status: 'lpaandreani', meta_data: [] } }) // GET
      .mockResolvedValueOnce({ data: {} }) // PUT completed
      .mockResolvedValueOnce({ data: {} }); // PUT enviadoandreani

    const r = await request(app).post('/api/preparacion/seguimientos/950').send({ tracking: 'AND777' });
    expect(r.status).toBe(200);

    const prep = db.prepare('SELECT * FROM preparaciones WHERE id=?').get(id);
    expect(prep.estado).toBe('completada');
    expect(prep.completado_en).toBeTruthy();
  });

  it('POST /seguimientos/:wcOrderId con el ítem sin verificar marca despachada_sin_verificar (no completada) y registra el evento (MUTATION: si marcarPreparacionEnviada pusiera siempre \'completada\' sin llamar a preparacionEstaVerificada, este test se pone en rojo)', async () => {
    const id = crearPreparacion(db, {
      canal: 'web', wcOrderId: 951, numeroPedido: '951', comprador: 'Sin verificar',
      items: [{ line_item_id: 1, product_id: 20, sku: 'CUB-1', nombre: 'Cubierta Maxxis', categoria: 'CUBIERTAS', cantidad: 5 }],
    });
    await tomarPorApi(app, id);
    // No se escanea nada: el ítem queda 'pendiente'.

    wooFetch
      .mockResolvedValueOnce({ data: { status: 'lpaandreani', meta_data: [] } })
      .mockResolvedValueOnce({ data: {} })
      .mockResolvedValueOnce({ data: {} });

    const r = await request(app).post('/api/preparacion/seguimientos/951').send({ tracking: 'AND778' });
    expect(r.status).toBe(200);

    const prep = db.prepare('SELECT * FROM preparaciones WHERE id=?').get(id);
    expect(prep.estado).toBe('despachada_sin_verificar');
    expect(prep.completado_en).toBeTruthy();

    const ev = db.prepare("SELECT * FROM preparacion_eventos WHERE preparacion_id=? AND tipo='despachado_sin_verificar'").get(id);
    expect(ev).toBeTruthy();
    expect(ev.usuario).toBe('tester');
  });

  it('GET /tracking-actual: corregible=true si el pedido está completed/enviadoandreani con tracking', async () => {
    wooFetch.mockResolvedValueOnce({ data: {
      status: 'enviadoandreani',
      meta_data: [{ id: 5, key: '_andreani_tracking', value: 'AND111' }],
    }});
    const r = await request(app).get('/api/preparacion/seguimientos/900/tracking-actual');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, status: 'enviadoandreani', tracking_actual: 'AND111', corregible: true });
  });

  it('GET /tracking-actual: corregible=false si el pedido sigue en lpaandreani (todavía no se cargó tracking)', async () => {
    wooFetch.mockResolvedValueOnce({ data: { status: 'lpaandreani', meta_data: [] } });
    const r = await request(app).get('/api/preparacion/seguimientos/901/tracking-actual');
    expect(r.body).toMatchObject({ ok: true, corregible: false });
  });

  it('POST /corregir-tracking: 409 si el pedido no está completed/enviadoandreani', async () => {
    wooFetch.mockResolvedValueOnce({ data: { status: 'lpaandreani', meta_data: [] } });
    const r = await request(app).post('/api/preparacion/seguimientos/902/corregir-tracking').send({ tracking: 'AND222' });
    expect(r.status).toBe(409);
  });

  it('POST /corregir-tracking: 409 si no hay tracking previo cargado', async () => {
    wooFetch.mockResolvedValueOnce({ data: { status: 'completed', meta_data: [] } });
    const r = await request(app).post('/api/preparacion/seguimientos/903/corregir-tracking').send({ tracking: 'AND222' });
    expect(r.status).toBe(409);
  });

  it('POST /corregir-tracking: mismo valor es no-op, no llama PUT', async () => {
    wooFetch.mockResolvedValueOnce({ data: {
      status: 'enviadoandreani',
      meta_data: [{ id: 5, key: '_andreani_tracking', value: 'AND111' }],
    }});
    const llamadasAntes = wooFetch.mock.calls.length;
    const r = await request(app).post('/api/preparacion/seguimientos/904/corregir-tracking').send({ tracking: 'AND111' });
    expect(r.body).toMatchObject({ ok: true, tracking_anterior: 'AND111', tracking_nuevo: 'AND111' });
    expect(wooFetch.mock.calls.length - llamadasAntes).toBe(1); // solo el GET, ningún PUT
  });

  it('POST /corregir-tracking: valor distinto hace UN PUT con solo meta_data (sin status) y registra evento', async () => {
    db.prepare(`INSERT INTO preparaciones (canal, clave, wc_order_id, etiqueta_lista, estado, creado_en, completado_en)
      VALUES ('web','web:905',905,1,'completada',?,?)`).run(new Date().toISOString(), new Date().toISOString());

    wooFetch
      .mockResolvedValueOnce({ data: {
        status: 'enviadoandreani',
        meta_data: [{ id: 5, key: '_andreani_tracking', value: 'AND111' }],
      }})
      .mockResolvedValueOnce({ data: {} });

    await tomarPorApi(app, db.prepare("SELECT id FROM preparaciones WHERE clave='web:905'").get().id);
    const llamadasAntes = wooFetch.mock.calls.length;
    const r = await request(app).post('/api/preparacion/seguimientos/905/corregir-tracking').send({ tracking: 'AND999' });
    expect(r.body).toMatchObject({ ok: true, tracking_anterior: 'AND111', tracking_nuevo: 'AND999' });
    expect(wooFetch.mock.calls.length - llamadasAntes).toBe(2);
    const putCall = wooFetch.mock.calls[wooFetch.mock.calls.length - 1];
    expect(putCall[2]).toBe('put');
    expect(putCall[3]).toEqual({ meta_data: [{ id: 5, key: '_andreani_tracking', value: 'AND999' }] });
    expect(putCall[3].status).toBeUndefined();

    const ev = db.prepare("SELECT * FROM preparacion_eventos WHERE tipo='tracking_corregido'").get();
    expect(ev).toBeTruthy();
    expect(JSON.parse(ev.detalle_json)).toEqual({ tracking_anterior: 'AND111', tracking_nuevo: 'AND999' });
  });

  it('POST /corregir-tracking: actualiza también preparaciones.tracking (espejo local, hallazgo del revisor)', async () => {
    db.prepare(`INSERT INTO preparaciones (canal, clave, wc_order_id, etiqueta_lista, estado, creado_en, completado_en, tracking)
      VALUES ('web','web:907',907,1,'completada',?,?,'AND111')`).run(new Date().toISOString(), new Date().toISOString());

    wooFetch
      .mockResolvedValueOnce({ data: {
        status: 'enviadoandreani',
        meta_data: [{ id: 5, key: '_andreani_tracking', value: 'AND111' }],
      }})
      .mockResolvedValueOnce({ data: {} });

    await tomarPorApi(app, db.prepare("SELECT id FROM preparaciones WHERE clave='web:907'").get().id);
    const r = await request(app).post('/api/preparacion/seguimientos/907/corregir-tracking').send({ tracking: 'AND999' });
    expect(r.status).toBe(200);

    const prep = db.prepare("SELECT tracking FROM preparaciones WHERE clave='web:907'").get();
    expect(prep.tracking).toBe('AND999');
  });

  it('POST /corregir-tracking: si no existe fila en preparaciones, igual corrige el tracking (evento se saltea fail-open)', async () => {
    wooFetch
      .mockResolvedValueOnce({ data: {
        status: 'completed',
        meta_data: [{ id: 5, key: '_andreani_tracking', value: 'AND111' }],
      }})
      .mockResolvedValueOnce({ data: {} });
    const r = await request(app).post('/api/preparacion/seguimientos/906/corregir-tracking').send({ tracking: 'AND222' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  it('GET /:id devuelve detalle con items, fotos y requisitos', async () => {
    const id = await nuevaPrep();
    const r = await request(app).get(`/api/preparacion/${id}`);
    expect(r.status).toBe(200);
    expect(r.body.data.items).toHaveLength(3);
    expect(r.body.data.items.find(i => i.sku === 'BICI-1').requisitos_foto.length).toBeGreaterThan(0);
  });

  it('GET /:id incluye eventos (más reciente primero)', async () => {
    const id = await nuevaPrep();
    await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'CUB-1' });
    await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'CUB-1' });
    const r = await request(app).get(`/api/preparacion/${id}`);
    expect(r.body.data.eventos.length).toBe(2);
    expect(r.body.data.eventos[0].id).toBeGreaterThan(r.body.data.eventos[1].id);
  });

  it('GET /:id/eventos devuelve solo los eventos, sin items ni fotos', async () => {
    const id = await nuevaPrep();
    await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'CUB-1' });
    const r = await request(app).get(`/api/preparacion/${id}/eventos`);
    expect(r.body.ok).toBe(true);
    expect(r.body.eventos).toHaveLength(1);
    expect(r.body.items).toBeUndefined();
  });

  it('GET /:id y GET /:id/eventos no rompen si un evento tiene detalle_json inválido', async () => {
    const id = await nuevaPrep();
    await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'CUB-1' });
    db.prepare("UPDATE preparacion_eventos SET detalle_json='{rota' WHERE preparacion_id=?").run(id);

    const rDetalle = await request(app).get(`/api/preparacion/${id}`);
    expect(rDetalle.status).toBe(200);
    expect(rDetalle.body.data.eventos[0].detalle).toEqual({});

    const rEventos = await request(app).get(`/api/preparacion/${id}/eventos`);
    expect(rEventos.status).toBe(200);
    expect(rEventos.body.eventos[0].detalle).toEqual({});
  });

  it('GET /:id y GET /:id/eventos devuelven detalle:{} si detalle_json es el string literal "null"', async () => {
    // JSON.parse('null') no lanza excepción, devuelve `null` (no un objeto): caso aparte
    // del JSON inválido de arriba, que sí dispara el catch.
    const id = await nuevaPrep();
    await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'CUB-1' });
    db.prepare("UPDATE preparacion_eventos SET detalle_json='null' WHERE preparacion_id=?").run(id);

    const rDetalle = await request(app).get(`/api/preparacion/${id}`);
    expect(rDetalle.status).toBe(200);
    expect(rDetalle.body.data.eventos[0].detalle).toEqual({});

    const rEventos = await request(app).get(`/api/preparacion/${id}/eventos`);
    expect(rEventos.status).toBe(200);
    expect(rEventos.body.eventos[0].detalle).toEqual({});
  });

  it('GET /:id/eventos?desde=N devuelve solo eventos con id>N', async () => {
    const id = await nuevaPrep();
    await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'CUB-1' });
    const primeros = db.prepare("SELECT id FROM preparacion_eventos WHERE preparacion_id=?").all(id);
    const ultimoId = Math.max(...primeros.map(e => e.id));
    await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'CUB-1' });
    await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'BICI-1' });

    const r = await request(app).get(`/api/preparacion/${id}/eventos?desde=${ultimoId}`);
    expect(r.body.ok).toBe(true);
    expect(r.body.eventos.every(e => e.id > ultimoId)).toBe(true);
    expect(r.body.eventos.length).toBe(2);
  });

  it('heartbeat informa el id del último evento', async () => {
    const id = await nuevaPrep();
    let r = await request(app).post(`/api/preparacion/${id}/heartbeat`);
    expect(r.body.ultimo_evento_id).toBe(0);
    await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'CUB-1' });
    r = await request(app).post(`/api/preparacion/${id}/heartbeat`);
    expect(r.body.ultimo_evento_id).toBeGreaterThan(0);
  });

  it('escanear con match registra un evento tipo escaneo; no_coincide y sobrante no registran nada', async () => {
    const id = await nuevaPrep();
    await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'CUB-1', origen: 'camara' });
    await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'NOEXISTE' }); // no_coincide
    await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'CUB-1' }); // match, sin origen -> default lector_teclado
    await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'CUB-1' }); // sobrante (ya está 2/2)

    const eventos = db.prepare("SELECT * FROM preparacion_eventos WHERE preparacion_id=? AND tipo='escaneo' ORDER BY id").all(id);
    expect(eventos).toHaveLength(2);
    const d0 = JSON.parse(eventos[0].detalle_json);
    expect(d0).toMatchObject({ sku: 'CUB-1', cantidad_nueva: 1, cantidad_esperada: 2, origen: 'camara' });
    const d1 = JSON.parse(eventos[1].detalle_json);
    expect(d1.origen).toBe('lector_teclado');
    expect(eventos[0].usuario).toBe('tester');
  });

  it('escanear con origen fuera de la whitelist cae al default lector_teclado (no se puede simplificar a ||)', async () => {
    const id = await nuevaPrep();
    await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'CUB-1', origen: 'inyectado' });

    const evento = db.prepare("SELECT * FROM preparacion_eventos WHERE preparacion_id=? AND tipo='escaneo'").get(id);
    expect(JSON.parse(evento.detalle_json).origen).toBe('lector_teclado');
  });

  it('confirmar-manual registra un evento tipo escaneo con origen manual, motivo y detalle_texto', async () => {
    const id = await nuevaPrep();
    const item = db.prepare("SELECT * FROM preparacion_items WHERE preparacion_id=? AND sku=''").get(id);
    await request(app).post(`/api/preparacion/${id}/item/${item.id}/confirmar-manual`).send({ motivo: 'codigo_ilegible' });
    const ev = db.prepare("SELECT * FROM preparacion_eventos WHERE preparacion_id=? AND tipo='escaneo'").get(id);
    expect(JSON.parse(ev.detalle_json)).toMatchObject({
      sku: '', origen: 'manual', cantidad_nueva: item.cantidad_esperada, cantidad_esperada: item.cantidad_esperada,
      motivo: 'codigo_ilegible', detalle_texto: null,
    });
    expect(ev.usuario).toBe('tester');
  });

  it('confirmar-manual dos veces seguidas sobre el mismo ítem no duplica el evento (re-confirmación es no-op)', async () => {
    const id = await nuevaPrep();
    const item = db.prepare("SELECT * FROM preparacion_items WHERE preparacion_id=? AND sku=''").get(id);

    await request(app).post(`/api/preparacion/${id}/item/${item.id}/confirmar-manual`).send({ motivo: 'codigo_ilegible' });
    const r2 = await request(app).post(`/api/preparacion/${id}/item/${item.id}/confirmar-manual`).send({ motivo: 'sin_etiqueta' });
    expect(r2.body.ok).toBe(true);

    const eventos = db.prepare(
      "SELECT * FROM preparacion_eventos WHERE preparacion_id=? AND item_id=? AND tipo='escaneo'"
    ).all(id, item.id);
    expect(eventos).toHaveLength(1);
  });

  it('subir foto registra un evento foto_subida', async () => {
    const id = await nuevaPrep();
    const item = db.prepare("SELECT * FROM preparacion_items WHERE preparacion_id=? AND sku='CUB-1'").get(id);
    const buf = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'red' } }).jpeg().toBuffer();
    const r = await request(app).post(`/api/preparacion/${id}/foto`)
      .field('item_id', String(item.id)).field('tipo', 'articulo').field('upload_id', 'tmp-e2e-68570').attach('archivo', buf, 'a.jpg');
    const ev = db.prepare("SELECT * FROM preparacion_eventos WHERE preparacion_id=? AND tipo='foto_subida'").get(id);
    expect(JSON.parse(ev.detalle_json)).toMatchObject({ sku: 'CUB-1', tipo_foto: 'articulo', foto_id: r.body.foto.id, upload_id: 'tmp-e2e-68570' });
  });

  it('purgarFotosBorradas borra archivo y fila si borrado_en tiene más de 60 días; conserva las más recientes', async () => {
    const id = await nuevaPrep();
    const item = db.prepare("SELECT * FROM preparacion_items WHERE preparacion_id=? AND sku='CUB-1'").get(id);
    const buf = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'red' } }).jpeg().toBuffer();

    const vieja = await request(app).post(`/api/preparacion/${id}/foto`).field('item_id', String(item.id)).field('tipo', 'articulo').attach('archivo', buf, 'vieja.jpg');
    const reciente = await request(app).post(`/api/preparacion/${id}/foto`).field('item_id', String(item.id)).field('tipo', 'articulo').attach('archivo', buf, 'reciente.jpg');

    const hace70dias = new Date(Date.now() - 70 * 24 * 3600 * 1000).toISOString();
    db.prepare('UPDATE preparacion_fotos SET borrado_en=? WHERE id=?').run(hace70dias, vieja.body.foto.id);
    db.prepare('UPDATE preparacion_fotos SET borrado_en=? WHERE id=?').run(new Date().toISOString(), reciente.body.foto.id);

    const rutaVieja = rutaAbsoluta(vieja.body.foto.url);
    expect(fs.existsSync(rutaVieja)).toBe(true);

    const purgadas = purgarFotosBorradas(db);

    expect(purgadas).toBe(1);
    expect(fs.existsSync(rutaVieja)).toBe(false);
    expect(db.prepare('SELECT * FROM preparacion_fotos WHERE id=?').get(vieja.body.foto.id)).toBeUndefined();
    expect(db.prepare('SELECT * FROM preparacion_fotos WHERE id=?').get(reciente.body.foto.id)).toBeTruthy();
  });

  it('purgarFotosBorradas NO borra archivo ni fila si la url resuelta cae fuera de uploads/ (defensa en profundidad)', async () => {
    const id = await nuevaPrep();
    const hace70dias = new Date(Date.now() - 70 * 24 * 3600 * 1000).toISOString();
    // Fila insertada directamente en la tabla (sin pasar por guardarArchivo/sanitize),
    // simulando el caso hipotético de una url maliciosa que llegara por otra vía.
    const ins = db.prepare('INSERT INTO preparacion_fotos (preparacion_id, item_id, tipo, url, creado_en, borrado_en) VALUES (?,?,?,?,?,?)')
      .run(id, null, 'articulo', '/uploads/../../../etc/passwd', new Date().toISOString(), hace70dias);
    const fotoId = ins.lastInsertRowid;

    const purgadas = purgarFotosBorradas(db);

    expect(purgadas).toBe(0);
    expect(db.prepare('SELECT * FROM preparacion_fotos WHERE id=?').get(fotoId)).toBeTruthy();
  });

  it('borrar foto NO borra la fila (soft-delete), registra evento foto_borrada, y deja de contar para /completar', async () => {
    const id = await nuevaPrep();
    const item = db.prepare("SELECT * FROM preparacion_items WHERE preparacion_id=? AND sku='CUB-1'").get(id);
    const buf = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'red' } }).jpeg().toBuffer();
    const subida = await request(app).post(`/api/preparacion/${id}/foto`)
      .field('item_id', String(item.id)).field('tipo', 'articulo').attach('archivo', buf, 'a.jpg');
    const fotoId = subida.body.foto.id;

    await request(app).delete(`/api/preparacion/${id}/foto/${fotoId}`);

    const fila = db.prepare('SELECT * FROM preparacion_fotos WHERE id=?').get(fotoId);
    expect(fila).toBeTruthy(); // NO se borró la fila
    expect(fila.borrado_en).toBeTruthy();

    const ev = db.prepare("SELECT * FROM preparacion_eventos WHERE preparacion_id=? AND tipo='foto_borrada'").get(id);
    expect(JSON.parse(ev.detalle_json)).toMatchObject({ sku: 'CUB-1', foto_id: fotoId, subida_por: 'tester' });

    const detalle = await request(app).get(`/api/preparacion/${id}`);
    const itemDetalle = detalle.body.data.items.find(i => i.id === item.id);
    expect(itemDetalle.fotos).toHaveLength(0); // la foto borrada no cuenta como presente
  });

  it('borrar la misma foto dos veces seguidas: la segunda es no-op y no duplica el evento foto_borrada', async () => {
    const id = await nuevaPrep();
    const item = db.prepare("SELECT * FROM preparacion_items WHERE preparacion_id=? AND sku='CUB-1'").get(id);
    const buf = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'red' } }).jpeg().toBuffer();
    const subida = await request(app).post(`/api/preparacion/${id}/foto`)
      .field('item_id', String(item.id)).field('tipo', 'articulo').attach('archivo', buf, 'a.jpg');
    const fotoId = subida.body.foto.id;

    const r1 = await request(app).delete(`/api/preparacion/${id}/foto/${fotoId}`);
    expect(r1.body).toMatchObject({ ok: true, borradas: 1 });

    const r2 = await request(app).delete(`/api/preparacion/${id}/foto/${fotoId}`);
    expect(r2.body).toMatchObject({ ok: true, borradas: 0 });

    const eventos = db.prepare(
      "SELECT * FROM preparacion_eventos WHERE preparacion_id=? AND tipo='foto_borrada'"
    ).all(id);
    expect(eventos).toHaveLength(1);
  });

  it('borrar una foto sin evento foto_subida previo (foto preexistente) responde ok y subida_por queda null', async () => {
    const id = await nuevaPrep();
    const item = db.prepare("SELECT * FROM preparacion_items WHERE preparacion_id=? AND sku='CUB-1'").get(id);
    const buf = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'red' } }).jpeg().toBuffer();
    const subida = await request(app).post(`/api/preparacion/${id}/foto`)
      .field('item_id', String(item.id)).field('tipo', 'articulo').attach('archivo', buf, 'a.jpg');
    const fotoId = subida.body.foto.id;

    // Simulamos una foto preexistente al ciclo de instrumentación: borramos su evento
    // foto_subida para que la búsqueda de subida_por no encuentre nada.
    db.prepare("DELETE FROM preparacion_eventos WHERE preparacion_id=? AND tipo='foto_subida' AND json_extract(detalle_json,'$.foto_id')=?").run(id, fotoId);

    const r = await request(app).delete(`/api/preparacion/${id}/foto/${fotoId}`);
    expect(r.body).toMatchObject({ ok: true, borradas: 1 });

    const ev = db.prepare("SELECT * FROM preparacion_eventos WHERE preparacion_id=? AND tipo='foto_borrada'").get(id);
    expect(JSON.parse(ev.detalle_json)).toMatchObject({ foto_id: fotoId, subida_por: null });
  });

  // -- Integración end-to-end del disparo de la cola (con un worker de prueba, no el real) --
  describe('cola de fotos: disparo inmediato tras la subida', () => {
    const WORKER_OK = new URL('./fixtures/workerFakeOk.js', import.meta.url).pathname;

    function buildTestAppConCola(db) {
      const appCola = express();
      appCola.use(express.json());
      appCola.use((req, _res, next) => { req.user = { username: 'tester', is_admin: 1 }; next(); });
      appCola.use('/api/preparacion', preparacionRouter(db, {
        woo: null, ml: null, andreaniStatus: 'lpaandreani',
        colaFotos: { disparoInmediato: true, workerPath: WORKER_OK },
      }));
      return appCola;
    }

    it('el request responde con estado_proceso=pendiente al instante, y la foto pasa a listo en segundo plano', async () => {
      const appCola = buildTestAppConCola(db);
      const id = crearPreparacion(db, { canal: 'web', wcOrderId: 950, numeroPedido: '950', comprador: 'Ana', items: [] });
      await tomarPorApi(appCola, id);
      const buf = await sharp({ create: { width: 4, height: 4, channels: 3, background: 'red' } }).jpeg().toBuffer();

      const r = await request(appCola).post(`/api/preparacion/${id}/foto`).attach('archivo', buf, 'a.jpg');
      expect(r.body.foto.estado_proceso).toBe('pendiente'); // la respuesta NO espera al procesamiento

      // El disparo es fire-and-forget (después de responder): esperamos un tick del event loop
      // para que el worker (rápido, es el fake) termine y actualice la fila.
      await new Promise(resolve => setTimeout(resolve, 300));

      const foto = db.prepare('SELECT * FROM preparacion_fotos WHERE id=?').get(r.body.foto.id);
      expect(foto.estado_proceso).toBe('listo');
      expect(foto.url_liviana).toMatch(/-liviana\.jpg$/);
    });
  });

  // -- Override de perfil por SKU exacto (prioridad sobre la regla de categoria) --
  describe('override de perfil por SKU', () => {
    it('un SKU con regla propia tiene prioridad sobre la regla de categoria', () => {
      // La categoria diria 'sellado'...
      db.prepare("INSERT INTO preparacion_perfiles (categoria, perfil, actualizado_en) VALUES ('ACCESORIOS','sellado',?)").run(new Date().toISOString());
      // ...pero este SKU puntual es en realidad un kit de transmision.
      db.prepare("INSERT INTO preparacion_perfiles_sku (sku, perfil, actualizado_en) VALUES ('KIT-777','kit_transmision',?)").run(new Date().toISOString());

      const id = crearPreparacion(db, {
        canal: 'web', wcOrderId: 950, numeroPedido: '950', comprador: 'X',
        items: [{ line_item_id: 1, product_id: 1, sku: 'KIT-777', nombre: 'Producto generico', categoria: 'ACCESORIOS', cantidad: 1 }],
      });
      const item = db.prepare('SELECT * FROM preparacion_items WHERE preparacion_id=?').get(id);
      expect(item.perfil).toBe('kit_transmision');
    });

    it('sin regla de SKU, sigue aplicando la regla de categoria como hasta ahora', () => {
      db.prepare("INSERT INTO preparacion_perfiles (categoria, perfil, actualizado_en) VALUES ('ACCESORIOS','sellado',?)").run(new Date().toISOString());
      const id = crearPreparacion(db, {
        canal: 'web', wcOrderId: 951, numeroPedido: '951', comprador: 'X',
        items: [{ line_item_id: 1, product_id: 1, sku: 'CUALQUIERA', nombre: 'Otro producto', categoria: 'ACCESORIOS', cantidad: 1 }],
      });
      const item = db.prepare('SELECT * FROM preparacion_items WHERE preparacion_id=?').get(id);
      expect(item.perfil).toBe('sellado');
    });

    it('item con sku vacio o null no rompe y cae a la regla de categoria (no matchea la fila "" si existiera)', () => {
      db.prepare("INSERT INTO preparacion_perfiles (categoria, perfil, actualizado_en) VALUES ('ACCESORIOS','sellado',?)").run(new Date().toISOString());
      // Regla "vacia" maliciosa/accidental: no deberia poder matchear items sin sku.
      db.prepare("INSERT INTO preparacion_perfiles_sku (sku, perfil, actualizado_en) VALUES ('','kit_transmision',?)").run(new Date().toISOString());

      const id = crearPreparacion(db, {
        canal: 'web', wcOrderId: 957, numeroPedido: '957', comprador: 'X',
        items: [
          { line_item_id: 1, product_id: 1, sku: null, nombre: 'Sin sku', categoria: 'ACCESORIOS', cantidad: 1 },
          { line_item_id: 2, product_id: 2, sku: '', nombre: 'Sku vacio', categoria: 'ACCESORIOS', cantidad: 1 },
          { line_item_id: 3, product_id: 3, sku: '   ', nombre: 'Sku solo espacios', categoria: 'ACCESORIOS', cantidad: 1 },
        ],
      });
      const items = db.prepare('SELECT perfil FROM preparacion_items WHERE preparacion_id=? ORDER BY id').all(id);
      expect(items.map(i => i.perfil)).toEqual(['sellado', 'sellado', 'sellado']);
    });

    it('dos reglas de SKU distintas no se pisan entre si', () => {
      db.prepare("INSERT INTO preparacion_perfiles_sku (sku, perfil, actualizado_en) VALUES ('KIT-A','kit_transmision',?)").run(new Date().toISOString());
      db.prepare("INSERT INTO preparacion_perfiles_sku (sku, perfil, actualizado_en) VALUES ('KIT-B','bici',?)").run(new Date().toISOString());

      const id = crearPreparacion(db, {
        canal: 'web', wcOrderId: 958, numeroPedido: '958', comprador: 'X',
        items: [
          { line_item_id: 1, product_id: 1, sku: 'KIT-A', nombre: 'A', categoria: 'ACCESORIOS', cantidad: 1 },
          { line_item_id: 2, product_id: 2, sku: 'KIT-B', nombre: 'B', categoria: 'ACCESORIOS', cantidad: 1 },
        ],
      });
      const items = db.prepare('SELECT sku, perfil FROM preparacion_items WHERE preparacion_id=? ORDER BY id').all(id);
      expect(items.map(i => i.perfil)).toEqual(['kit_transmision', 'bici']);
    });

    it('GET /perfiles-sku devuelve las reglas guardadas', async () => {
      const r0 = await request(app).get('/api/preparacion/perfiles-sku');
      expect(r0.body.data).toEqual([]);
      await request(app).put('/api/preparacion/perfiles-sku/ABC-1').send({ perfil: 'kit_transmision' });
      const r1 = await request(app).get('/api/preparacion/perfiles-sku');
      expect(r1.body.data).toHaveLength(1);
      expect(r1.body.data[0]).toMatchObject({ sku: 'ABC-1', perfil: 'kit_transmision' });
    });

    it('PUT /perfiles-sku/:sku normaliza a mayusculas y hace upsert (no duplica)', async () => {
      await request(app).put('/api/preparacion/perfiles-sku/xyz-9').send({ perfil: 'bici' });
      await request(app).put('/api/preparacion/perfiles-sku/XYZ-9').send({ perfil: 'kit_transmision' });
      const r = await request(app).get('/api/preparacion/perfiles-sku');
      expect(r.body.data).toHaveLength(1);
      expect(r.body.data[0].perfil).toBe('kit_transmision');
    });

    it('PUT /perfiles-sku/:sku con perfil invalido -> 400', async () => {
      const r = await request(app).put('/api/preparacion/perfiles-sku/ABC-2').send({ perfil: 'invalido' });
      expect(r.status).toBe(400);
    });

    it('DELETE /perfiles-sku/:sku borra la regla', async () => {
      await request(app).put('/api/preparacion/perfiles-sku/DEL-1').send({ perfil: 'bici' });
      await request(app).delete('/api/preparacion/perfiles-sku/DEL-1');
      const r = await request(app).get('/api/preparacion/perfiles-sku');
      expect(r.body.data).toHaveLength(0);
    });

    it('el match de SKU es exacto, no substring', () => {
      db.prepare("INSERT INTO preparacion_perfiles (categoria, perfil, actualizado_en) VALUES ('ACCESORIOS','sellado',?)").run(new Date().toISOString());
      db.prepare("INSERT INTO preparacion_perfiles_sku (sku, perfil, actualizado_en) VALUES ('KIT-777','kit_transmision',?)").run(new Date().toISOString());

      const id = crearPreparacion(db, {
        canal: 'web', wcOrderId: 952, numeroPedido: '952', comprador: 'X',
        items: [
          { line_item_id: 1, product_id: 1, sku: 'KIT-7777', nombre: 'Mas largo', categoria: 'ACCESORIOS', cantidad: 1 },
          { line_item_id: 2, product_id: 2, sku: 'KIT-77', nombre: 'Mas corto', categoria: 'ACCESORIOS', cantidad: 1 },
          { line_item_id: 3, product_id: 3, sku: 'KIT-777', nombre: 'Exacto', categoria: 'ACCESORIOS', cantidad: 1 },
        ],
      });
      const items = db.prepare('SELECT sku, perfil FROM preparacion_items WHERE preparacion_id=? ORDER BY id').all(id);
      expect(items.map(i => i.perfil)).toEqual(['sellado', 'sellado', 'kit_transmision']);
    });

    it('el trim() aplica en ambas puntas: al guardar la regla y al resolver el item', async () => {
      db.prepare("INSERT INTO preparacion_perfiles (categoria, perfil, actualizado_en) VALUES ('ACCESORIOS','sellado',?)").run(new Date().toISOString());
      // Regla guardada con espacios alrededor -> se normaliza sin espacios.
      await request(app).put(`/api/preparacion/perfiles-sku/${encodeURIComponent('  KIT-888  ')}`).send({ perfil: 'kit_transmision' });
      const reglas = db.prepare('SELECT sku FROM preparacion_perfiles_sku').all();
      expect(reglas.map(r => r.sku)).toEqual(['KIT-888']);

      // Item con SKU con espacios alrededor -> igual matchea la regla.
      const id = crearPreparacion(db, {
        canal: 'web', wcOrderId: 953, numeroPedido: '953', comprador: 'X',
        items: [{ line_item_id: 1, product_id: 1, sku: '  KIT-888  ', nombre: 'Con espacios', categoria: 'ACCESORIOS', cantidad: 1 }],
      });
      const item = db.prepare('SELECT * FROM preparacion_items WHERE preparacion_id=?').get(id);
      expect(item.perfil).toBe('kit_transmision');
    });

    // -- requisitos_foto: la regla de SKU cortocircuita la de categoria --
    const requisitosDelPrimerItem = async (id) => {
      const r = await request(app).get(`/api/preparacion/${id}`);
      return r.body.data.items[0].requisitos_foto;
    };

    it('requisitos_json de la regla de SKU gana sobre el de la categoria', async () => {
      db.prepare("INSERT INTO preparacion_perfiles (categoria, perfil, requisitos_json, actualizado_en) VALUES ('ACCESORIOS','sellado',?,?)")
        .run(JSON.stringify({ default: [{ tipos: ['articulo'], min: 1, etiqueta: 'DE CATEGORIA' }] }), new Date().toISOString());
      db.prepare("INSERT INTO preparacion_perfiles_sku (sku, perfil, requisitos_json, actualizado_en) VALUES ('KIT-777','kit_transmision',?,?)")
        .run(JSON.stringify({ default: [{ tipos: ['piezas'], min: 2, etiqueta: 'DE SKU' }] }), new Date().toISOString());

      const id = crearPreparacion(db, {
        canal: 'web', wcOrderId: 954, numeroPedido: '954', comprador: 'X',
        items: [{ line_item_id: 1, product_id: 1, sku: 'KIT-777', nombre: 'Generico', categoria: 'ACCESORIOS', cantidad: 1 }],
      });
      expect(await requisitosDelPrimerItem(id)).toEqual([{ tipos: ['piezas'], min: 2, etiqueta: 'DE SKU' }]);
    });

    it('requisitos_json invalido en la regla de SKU cae a la heuristica base sin lanzar', async () => {
      db.prepare("INSERT INTO preparacion_perfiles (categoria, perfil, requisitos_json, actualizado_en) VALUES ('ACCESORIOS','sellado',?,?)")
        .run(JSON.stringify({ default: [{ tipos: ['articulo'], min: 1, etiqueta: 'DE CATEGORIA' }] }), new Date().toISOString());
      db.prepare("INSERT INTO preparacion_perfiles_sku (sku, perfil, requisitos_json, actualizado_en) VALUES ('KIT-777','kit_transmision','{no-es-json',?)")
        .run(new Date().toISOString());

      const id = crearPreparacion(db, {
        canal: 'web', wcOrderId: 955, numeroPedido: '955', comprador: 'X',
        items: [{ line_item_id: 1, product_id: 1, sku: 'KIT-777', nombre: 'Generico', categoria: 'ACCESORIOS', cantidad: 1 }],
      });
      expect(await requisitosDelPrimerItem(id)).toEqual(requisitosFoto('kit_transmision', null));
    });

    it('override de perfil por SKU sin requisitos_json propio usa la heuristica del perfil nuevo, no la de la categoria', async () => {
      // La categoria tiene requisitos_json propios (perfil 'sellado')...
      db.prepare("INSERT INTO preparacion_perfiles (categoria, perfil, requisitos_json, actualizado_en) VALUES ('ACCESORIOS','sellado',?,?)")
        .run(JSON.stringify({ default: [{ tipos: ['articulo'], min: 1, etiqueta: 'DE CATEGORIA' }] }), new Date().toISOString());
      // ...pero el SKU fuerza el perfil kit_transmision sin requisitos propios.
      db.prepare("INSERT INTO preparacion_perfiles_sku (sku, perfil, actualizado_en) VALUES ('KIT-777','kit_transmision',?)").run(new Date().toISOString());

      const id = crearPreparacion(db, {
        canal: 'web', wcOrderId: 956, numeroPedido: '956', comprador: 'X',
        items: [{ line_item_id: 1, product_id: 1, sku: 'KIT-777', nombre: 'Generico', categoria: 'ACCESORIOS', cantidad: 1 }],
      });
      expect(await requisitosDelPrimerItem(id)).toEqual(requisitosFoto('kit_transmision', null));
    });
  });
});

import { wooFetch } from '../routes/woo.js';
import { mlFetch } from '../lib/mlClient.js';
import { syncPedidosCache } from '../routes/preparacion.js';

describe('POST /iniciar — confirmación de envío vs. facturación', () => {
  let db;
  const orderBase = (overrides = {}) => ({
    id: 950, number: '950', status: 'lpaandreani', meta_data: [],
    shipping: { first_name: 'Ana', last_name: 'Gomez', address_1: 'Belgrano 123', city: 'Córdoba', state: 'X', phone: '3511234567' },
    billing: { first_name: 'Ana', last_name: 'Gomez', address_1: 'Belgrano 123', city: 'Córdoba', state: 'X', phone: '3511234567', email: 'ana@mail.com' },
    line_items: [],
    ...overrides,
  });

  beforeEach(() => { db = openDb(TEST_DB); vi.clearAllMocks(); });
  afterEach(() => { db.close(); if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('no molesta cuando envío y facturación son la misma dirección', async () => {
    wooFetch.mockResolvedValueOnce({ data: orderBase() });
    const r = await request(buildTestApp(db)).post('/api/preparacion/iniciar').send({ canal: 'web', id: 950 });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  it('guarda la nota del pedido (customer_note) en la preparación creada', async () => {
    wooFetch.mockResolvedValueOnce({ data: orderBase({ customer_note: 'dejar con el portero' }) });
    const r = await request(buildTestApp(db)).post('/api/preparacion/iniciar').send({ canal: 'web', id: 950 });
    expect(r.status).toBe(200);
    const prep = db.prepare('SELECT notas FROM preparaciones WHERE id=?').get(r.body.id);
    expect(prep.notas).toBe('dejar con el portero');
  });

  it('bloquea con 409 cuando difieren de verdad, sin crear la preparación', async () => {
    wooFetch.mockResolvedValueOnce({ data: orderBase({
      billing: { first_name: 'Otro', last_name: 'Nombre', address_1: 'Otra calle 999', city: 'Rosario', state: 'S', phone: '3419999999', email: 'ana@mail.com' },
    }) });
    const r = await request(buildTestApp(db)).post('/api/preparacion/iniciar').send({ canal: 'web', id: 950 });
    expect(r.status).toBe(409);
    expect(r.body.direcciones_difieren).toBe(true);
    expect(r.body.campos_distintos).toEqual(expect.arrayContaining(['calle', 'localidad_provincia', 'nombre']));
    expect(r.body.envio.calle).toBe('Belgrano');
    expect(r.body.facturacion.calle).toBe('Otra calle');
    expect(db.prepare('SELECT id FROM preparaciones WHERE clave=?').get('web:950')).toBeUndefined();
  });

  it('no molesta por acentos/mayúsculas distintas, solo por diferencias reales', async () => {
    wooFetch.mockResolvedValueOnce({ data: orderBase({
      shipping: { first_name: 'Ana', last_name: 'Gomez', address_1: 'belgrano 123', city: 'CORDOBA', state: 'X', phone: '3511234567' },
    }) });
    const r = await request(buildTestApp(db)).post('/api/preparacion/iniciar').send({ canal: 'web', id: 950 });
    expect(r.status).toBe(200);
  });

  it('POST /iniciar Woo devuelve 409 y no crea preparación si el estado no es elegible', async () => {
    wooFetch.mockResolvedValueOnce({ data: orderBase({ status: 'cancelled' }) });
    const r = await request(buildTestApp(db)).post('/api/preparacion/iniciar').send({ canal: 'web', id: 950 });
    expect(r.status).toBe(409);
    expect(db.prepare("SELECT * FROM preparaciones WHERE clave='web:950'").get()).toBeUndefined();
  });

  it('con direccion_elegida crea la preparación y guarda la decisión', async () => {
    wooFetch.mockResolvedValueOnce({ data: orderBase({
      billing: { first_name: 'Otro', last_name: 'Nombre', address_1: 'Otra calle 999', city: 'Rosario', state: 'S', phone: '3419999999', email: 'ana@mail.com' },
    }) });
    const r = await request(buildTestApp(db)).post('/api/preparacion/iniciar').send({ canal: 'web', id: 950, direccion_elegida: 'billing' });
    expect(r.status).toBe(200);
    const prep = db.prepare('SELECT * FROM preparaciones WHERE clave=?').get('web:950');
    expect(prep.direccion_confirmada_fuente).toBe('billing');
    expect(prep.direccion_confirmada_por).toBe('tester');
    expect(prep.direccion_confirmada_en).toBeTruthy();
  });

  it('una segunda llamada a /iniciar no vuelve a preguntar si ya se confirmó', async () => {
    wooFetch.mockResolvedValueOnce({ data: orderBase({
      billing: { first_name: 'Otro', last_name: 'Nombre', address_1: 'Otra calle 999', city: 'Rosario', state: 'S', phone: '3419999999', email: 'ana@mail.com' },
    }) });
    await request(buildTestApp(db)).post('/api/preparacion/iniciar').send({ canal: 'web', id: 950, direccion_elegida: 'shipping' });

    wooFetch.mockResolvedValueOnce({ data: orderBase({
      billing: { first_name: 'Otro', last_name: 'Nombre', address_1: 'Otra calle 999', city: 'Rosario', state: 'S', phone: '3419999999', email: 'ana@mail.com' },
    }) });
    const r2 = await request(buildTestApp(db)).post('/api/preparacion/iniciar').send({ canal: 'web', id: 950 });
    expect(r2.status).toBe(200);
  });

  it('conflicto de claim web no persiste cambios de la preparación', async () => {
    const id = crearPreparacion(db, {
      canal: 'web', wcOrderId: 951, numeroPedido: '951', comprador: 'Original', items: [],
    });
    db.prepare('UPDATE preparaciones SET direccion_confirmada_fuente=NULL, direccion_confirmada_por=NULL WHERE id=?').run(id);
    const claimedAt = new Date().toISOString();
    db.prepare(`INSERT INTO preparacion_claims
      (preparacion_id, usuario, claimed_at, expires_at, renovado_en) VALUES (?,?,?,?,?)`)
      .run(id, 'ana', claimedAt, new Date(Date.now() + 600000).toISOString(), claimedAt);

    wooFetch.mockResolvedValueOnce({ data: orderBase({ id: 951, number: '951',
      billing: { first_name: 'Nueva', last_name: 'Persona', address_1: 'Otra calle 9', city: 'Rosario', state: 'S', phone: '3419999999', email: 'nueva@mail.com' },
    }) });
    const r = await request(buildTestApp(db)).post('/api/preparacion/iniciar')
      .send({ canal: 'web', id: 951, direccion_elegida: 'billing' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('PREPARATION_CLAIMED');
    const after = db.prepare('SELECT comprador, direccion_confirmada_fuente, direccion_confirmada_por FROM preparaciones WHERE id=?').get(id);
    expect(after).toEqual({ comprador: 'Original', direccion_confirmada_fuente: null, direccion_confirmada_por: null });
  });
});

describe('POST /iniciar — atomicidad del claim ML', () => {
  let db;
  beforeEach(() => { db = openDb(TEST_DB); vi.clearAllMocks(); });
  afterEach(() => { db.close(); if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('conflicto de claim ML no persiste una preparación nueva ni sus ítems', async () => {
    const id = crearPreparacion(db, {
      canal: 'ml', mlOrderId: 'ML-951', numeroPedido: 'ML-951', comprador: 'Original', items: [],
    });
    const claimedAt = new Date().toISOString();
    db.prepare(`INSERT INTO preparacion_claims
      (preparacion_id, usuario, claimed_at, expires_at, renovado_en) VALUES (?,?,?,?,?)`)
      .run(id, 'ana', claimedAt, new Date(Date.now() + 600000).toISOString(), claimedAt);
    mlFetch.mockResolvedValueOnce({ status: 200, data: {
      id: 'ML-951', buyer: { nickname: 'Nuevo comprador' }, order_items: [
        { item: { id: 'SKU-951', title: 'Producto nuevo' }, quantity: 2 },
      ],
    } });
    const r = await request(buildTestApp(db)).post('/api/preparacion/iniciar')
      .send({ canal: 'ml', id: 'ML-951' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('PREPARATION_CLAIMED');
    expect(db.prepare('SELECT comprador FROM preparaciones WHERE id=?').get(id).comprador).toBe('Original');
    expect(db.prepare('SELECT COUNT(*) AS n FROM preparacion_items WHERE preparacion_id=?').get(id).n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM preparaciones WHERE clave=?').get('ml:ML-951').n).toBe(1);
  });
});

describe('syncPedidosCache', () => {
  let db;
  const CFG = {
    woo: { url: 'https://fusionbikes.com.ar', ck: 'ck_x', cs: 'cs_x' },
    ml: { clientId: 'cid', clientSecret: 'cs', userId: '99999' },
    andreaniStatus: 'lpaandreani',
    enviadoAndreaniStatus: 'enviadoandreani',
  };

  beforeEach(() => {
    db = openDb(TEST_DB);
    vi.clearAllMocks();
  });
  afterEach(() => { db.close(); if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('guarda en pedidos_cache un pedido web pendiente (lpaandreani) con estado_envio=pendiente', async () => {
    const orderPend = {
      id: 900, number: '900', status: 'lpaandreani', date_created: '2026-07-01T00:00:00Z',
      billing: { first_name: 'Juan', last_name: 'Perez' }, meta_data: [],
      customer_note: 'entregar después de las 18h',
      line_items: [{ id: 1, product_id: 501, variation_id: 0, sku: 'BIKE-1', name: 'Bici', quantity: 1 }],
    };
    wooFetch
      .mockResolvedValueOnce({ data: [orderPend] })  // status=lpaandreani
      .mockResolvedValueOnce({ data: [] })            // status=completed
      .mockResolvedValueOnce({ data: [] });           // status=enviadoandreani
    mlFetch.mockResolvedValueOnce({ status: 200, data: { results: [] } }); // pendientesMl (paid)

    await syncPedidosCache(db, CFG);

    const row = db.prepare('SELECT * FROM pedidos_cache WHERE clave=?').get('web:900');
    expect(row).toBeTruthy();
    expect(row.estado_envio).toBe('pendiente');
    expect(row.canal).toBe('web');
    expect(row.numero_pedido).toBe('900');
    expect(JSON.parse(row.items_json)).toHaveLength(1);
    expect(row.customer_note).toBe('entregar después de las 18h');
  });

  it('un pedido ML no tiene equivalente de nota — queda vacía, no inventada', async () => {
    wooFetch.mockResolvedValueOnce({ data: [] }).mockResolvedValueOnce({ data: [] }).mockResolvedValueOnce({ data: [] });
    mlFetch.mockResolvedValueOnce({
      status: 200,
      data: { results: [{ id: 'ORD-1', status: 'paid', date_created: '2026-07-01T00:00:00Z', buyer: { nickname: 'compradorml' }, order_items: [], shipping: { id: 555 } }] },
    });
    mlFetch.mockResolvedValueOnce({ status: 200, data: { status: 'ready_to_ship', logistic_type: 'self_service' } });

    await syncPedidosCache(db, CFG);

    const row = db.prepare('SELECT * FROM pedidos_cache WHERE clave=?').get('ml:ORD-1');
    expect(row).toBeTruthy();
    expect(row.customer_note).toBe('');
  });

  it('guarda en pedidos_cache un pedido web ya enviado (completed) con estado_envio=enviado', async () => {
    // Fecha relativa, adentro de la ventana móvil de 60 días para 'enviado' (routes/preparacion.js
    // línea ~1296): si se hardcodea una fecha absoluta, el test se pudre solo cuando pasan
    // 60 días y la fila queda podada antes de que la aserción la vea.
    const haceCincoDias = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();
    const orderEnv = {
      id: 950, number: '950', status: 'completed', date_created: haceCincoDias,
      billing: { first_name: 'Ana', last_name: 'Gomez' }, meta_data: [],
      line_items: [{ id: 2, product_id: 502, variation_id: 0, sku: 'CASCO-1', name: 'Casco', quantity: 1 }],
    };
    wooFetch
      .mockResolvedValueOnce({ data: [] })            // status=lpaandreani
      .mockResolvedValueOnce({ data: [orderEnv] })    // status=completed
      .mockResolvedValueOnce({ data: [] });           // status=enviadoandreani
    mlFetch.mockResolvedValueOnce({ status: 200, data: { results: [] } });

    await syncPedidosCache(db, CFG);

    const row = db.prepare('SELECT * FROM pedidos_cache WHERE clave=?').get('web:950');
    expect(row).toBeTruthy();
    expect(row.estado_envio).toBe('enviado');
  });

  it('no duplica candado: si ya hay una corrida en curso, la segunda llamada no hace fetch', async () => {
    let resolveWoo;
    wooFetch.mockImplementationOnce(() => new Promise(r => { resolveWoo = r; }));
    wooFetch.mockResolvedValue({ data: [] }); // llamadas siguientes (wcCompleted, wcEnviado), ya destrabado
    mlFetch.mockResolvedValueOnce({ status: 200, data: { results: [] } });
    const p1 = syncPedidosCache(db, CFG);
    await syncPedidosCache(db, CFG); // debe retornar de inmediato sin llamar wooFetch de nuevo
    expect(wooFetch).toHaveBeenCalledTimes(1);
    resolveWoo({ data: [] });
    await p1;
  });

  it('registra el resultado en sync_log con direccion=pedidos_cache', async () => {
    wooFetch.mockResolvedValue({ data: [] });
    mlFetch.mockResolvedValueOnce({ status: 200, data: { results: [] } });

    await syncPedidosCache(db, CFG);

    const log = db.prepare("SELECT * FROM sync_log WHERE direccion='pedidos_cache' ORDER BY id DESC LIMIT 1").get();
    expect(log).toBeTruthy();
    expect(log.estado).toBe('ok');
  });

  it('si wooFetch falla, registra error en sync_log y no revienta el proceso', async () => {
    wooFetch.mockRejectedValueOnce(new Error('WC caído'));

    await expect(syncPedidosCache(db, CFG)).rejects.toThrow('WC caído');

    const log = db.prepare("SELECT * FROM sync_log WHERE direccion='pedidos_cache' ORDER BY id DESC LIMIT 1").get();
    expect(log.estado).toBe('error');
    expect(log.error).toContain('WC caído');
  });

  it('acota las consultas de pedidos enviados (completed/enviadoandreani) a los últimos 60 días con after=, y no acota los pendientes', async () => {
    wooFetch.mockResolvedValue({ data: [] });
    mlFetch.mockResolvedValueOnce({ status: 200, data: { results: [] } });

    await syncPedidosCache(db, CFG);

    const [urlPend, urlCompleted, urlEnviado] = wooFetch.mock.calls.map(c => c[1]);
    expect(urlPend).not.toContain('after=');
    expect(urlCompleted).toMatch(/status=completed&dates_are_gmt=true&after=/);
    expect(urlEnviado).toMatch(/status=enviadoandreani&dates_are_gmt=true&after=/);
  });

  // `dates_are_gmt=true` es obligatorio junto con `after` (incidente 2026-07-29): sin él,
  // Woo interpreta `after` en hora local del sitio (UTC-3) en vez de UTC, y el rango pedido
  // queda corrido, produciendo falsos negativos. Se verifica explícito en ambas consultas
  // acotadas por fecha (completed y enviadoandreani), no solo que "contengan after=".
  it('las dos consultas acotadas por fecha (completed, enviadoandreani) incluyen dates_are_gmt=true', async () => {
    wooFetch.mockResolvedValue({ data: [] });
    mlFetch.mockResolvedValueOnce({ status: 200, data: { results: [] } });

    await syncPedidosCache(db, CFG);

    const [, urlCompleted, urlEnviado] = wooFetch.mock.calls.map(c => c[1]);
    expect(urlCompleted).toContain('dates_are_gmt=true');
    expect(urlEnviado).toContain('dates_are_gmt=true');
  });

  it('borra de pedidos_cache las filas enviado que quedaron fuera de la ventana de 60 días', async () => {
    buildTestApp(db); // asegura las tablas (ensureTables) antes de sembrar directo
    const fechaVieja = new Date(Date.now() - 120 * 24 * 3600 * 1000).toISOString();
    db.prepare(`
      INSERT INTO pedidos_cache (clave, canal, wc_order_id, ml_order_id, numero_pedido, comprador, fecha, estado_envio, estado_wc, espejo_ml, logistic_type, substatus, items_json, actualizado_en)
      VALUES ('web:100','web',100,NULL,'100','Viejo Cliente',?,'enviado','completed',0,NULL,NULL,'[]',?)
    `).run(fechaVieja, fechaVieja);

    wooFetch.mockResolvedValue({ data: [] });
    mlFetch.mockResolvedValueOnce({ status: 200, data: { results: [] } });

    await syncPedidosCache(db, CFG);

    const row = db.prepare("SELECT * FROM pedidos_cache WHERE clave='web:100'").get();
    expect(row).toBeUndefined();
  });

  it('poda de pedidos_cache las filas ML pendientes que ya no están ready_to_ship (pedido despachado)', async () => {
    buildTestApp(db); // asegura las tablas (ensureTables) antes de sembrar directo
    // Fecha relativa, adentro de la ventana móvil de 30 días que usa la poda ML (routes/preparacion.js
    // línea ~1308): con fecha absoluta el test se pudre solo cuando pasan 30 días.
    const haceCincoDias = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();
    db.prepare(`
      INSERT INTO pedidos_cache (clave, canal, wc_order_id, ml_order_id, numero_pedido, comprador, fecha, estado_envio, estado_wc, espejo_ml, logistic_type, substatus, items_json, actualizado_en)
      VALUES ('ml:1111','ml',NULL,'1111','1111','Cliente Viejo',?,'pendiente',NULL,0,'self_service',NULL,'[]',?)
    `).run(haceCincoDias, haceCincoDias);

    wooFetch.mockResolvedValue({ data: [] });
    mlFetch
      .mockResolvedValueOnce({ status: 200, data: { results: [{ id: 2222, status: 'paid', date_created: '2026-07-20T00:00:00Z', buyer: { nickname: 'compradorNuevo' }, shipping: { id: 555 }, order_items: [] }] } }) // orders/search
      .mockResolvedValueOnce({ status: 200, data: { status: 'ready_to_ship', logistic_type: 'self_service' } }); // shipments/555

    await syncPedidosCache(db, CFG);

    const filaVieja = db.prepare("SELECT * FROM pedidos_cache WHERE clave='ml:1111'").get();
    expect(filaVieja).toBeUndefined();
    const filaNueva = db.prepare("SELECT * FROM pedidos_cache WHERE clave='ml:2222'").get();
    expect(filaNueva).toBeTruthy();
    expect(filaNueva.estado_envio).toBe('pendiente');
  });

  it('guard fail-closed: si pendientesMl devuelve vacío pero confiable (sin truncar, sin fallos), SÍ poda (nada quedó pendiente de verdad)', async () => {
    buildTestApp(db); // asegura las tablas (ensureTables) antes de sembrar directo
    // Fecha relativa, adentro de la ventana móvil de 30 días (ver comentario en el test anterior).
    const haceCincoDias = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();
    db.prepare(`
      INSERT INTO pedidos_cache (clave, canal, wc_order_id, ml_order_id, numero_pedido, comprador, fecha, estado_envio, estado_wc, espejo_ml, logistic_type, substatus, items_json, actualizado_en)
      VALUES ('ml:1111','ml',NULL,'1111','1111','Cliente Viejo',?,'pendiente',NULL,0,'self_service',NULL,'[]',?)
    `).run(haceCincoDias, haceCincoDias);

    wooFetch.mockResolvedValue({ data: [] });
    mlFetch.mockResolvedValueOnce({ status: 200, data: { results: [] } }); // orders/search: sin resultados, listado confiable

    await syncPedidosCache(db, CFG);

    const filaVieja = db.prepare("SELECT * FROM pedidos_cache WHERE clave='ml:1111'").get();
    expect(filaVieja).toBeUndefined();
  });

  it('la poda NO borra filas web ni filas ML ya enviado, solo pendientes ML ausentes del listado vigente', async () => {
    buildTestApp(db);
    // Fecha relativa, adentro de la ventana móvil de 30 días (ver comentario más arriba).
    const haceCincoDias = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();
    db.prepare(`
      INSERT INTO pedidos_cache (clave, canal, wc_order_id, ml_order_id, numero_pedido, comprador, fecha, estado_envio, estado_wc, espejo_ml, logistic_type, substatus, items_json, actualizado_en)
      VALUES
        ('ml:1111','ml',NULL,'1111','1111','Cliente Viejo',?,'pendiente',NULL,0,'self_service',NULL,'[]',?),
        ('web:200','web',200,NULL,'200','Cliente Web',?,'pendiente','lpaandreani',0,NULL,NULL,'[]',?),
        ('ml:3333','ml',NULL,'3333','3333','Cliente Enviado ML',?,'enviado',NULL,0,'self_service',NULL,'[]',?)
    `).run(haceCincoDias, haceCincoDias, haceCincoDias, haceCincoDias, haceCincoDias, haceCincoDias);

    wooFetch.mockResolvedValue({ data: [] });
    mlFetch.mockResolvedValueOnce({ status: 200, data: { results: [] } }); // sin pendientes vigentes, listado confiable

    await syncPedidosCache(db, CFG);

    expect(db.prepare("SELECT * FROM pedidos_cache WHERE clave='ml:1111'").get()).toBeUndefined();
    expect(db.prepare("SELECT * FROM pedidos_cache WHERE clave='web:200'").get()).toBeTruthy();
    expect(db.prepare("SELECT * FROM pedidos_cache WHERE clave='ml:3333'").get()).toBeTruthy();
  });

  it('si falla un GET /shipments/:id, la poda se omite esa corrida (listado no confiable)', async () => {
    buildTestApp(db);
    // Fecha relativa por consistencia (no participa de la comparación de ventana acá, porque
    // mlConfiable queda en false y la poda se omite entera, pero evita confusión a futuro).
    const haceCincoDias = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();
    db.prepare(`
      INSERT INTO pedidos_cache (clave, canal, wc_order_id, ml_order_id, numero_pedido, comprador, fecha, estado_envio, estado_wc, espejo_ml, logistic_type, substatus, items_json, actualizado_en)
      VALUES ('ml:1111','ml',NULL,'1111','1111','Cliente Viejo',?,'pendiente',NULL,0,'self_service',NULL,'[]',?)
    `).run(haceCincoDias, haceCincoDias);

    wooFetch.mockResolvedValue({ data: [] });
    mlFetch
      .mockResolvedValueOnce({ status: 200, data: { results: [{ id: 2222, date_created: '2026-07-20T00:00:00Z', buyer: { nickname: 'compradorNuevo' }, shipping: { id: 555 }, order_items: [] }] } }) // orders/search
      .mockResolvedValueOnce({ status: 500, data: {} }); // shipments/555 falla

    await syncPedidosCache(db, CFG);

    const filaVieja = db.prepare("SELECT * FROM pedidos_cache WHERE clave='ml:1111'").get();
    expect(filaVieja).toBeTruthy();
    expect(filaVieja.estado_envio).toBe('pendiente');
  });

  it('no repregunta /shipments/:id de un envío ya en estado terminal (shipped) reciente — usa la caché local y no cuenta como fallo', async () => {
    buildTestApp(db); // asegura las tablas de preparaciones (ensureTables); ml_shipment_estado la crea openDb (db/index.js), ya aplicado en el beforeEach vía openDb(TEST_DB)
    const haceCincoDias = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();
    // Ya sabíamos, de una corrida anterior (hace 5 días, dentro de la vigencia de 7), que
    // el envío 555 está 'shipped' (terminal).
    db.prepare(`
      INSERT INTO ml_shipment_estado (shipment_id, status, logistic_type, actualizado_en)
      VALUES ('555', 'shipped', 'self_service', ?)
    `).run(haceCincoDias);

    wooFetch.mockResolvedValue({ data: [] });
    mlFetch
      .mockResolvedValueOnce({ status: 200, data: { results: [{ id: 2222, date_created: '2026-07-20T00:00:00Z', buyer: { nickname: 'compradorNuevo' }, shipping: { id: 555 }, order_items: [] }] } }); // orders/search — sin mock de /shipments/555: si lo llamara, el test fallaría por falta de mock

    await syncPedidosCache(db, CFG);

    // Un solo GET a ML (orders/search); el GET de /shipments/555 se salteó por estado terminal.
    expect(mlFetch).toHaveBeenCalledTimes(1);
    // El salteo no es un fallo: el listado sigue confiable y sí poda lo que ya no aparece.
    const log = db.prepare("SELECT * FROM sync_log WHERE direccion='pedidos_cache' ORDER BY id DESC LIMIT 1").get();
    expect(log.estado).toBe('ok');
    // El envío terminal no es 'pendiente' -> el pedido 2222 no debe entrar a pedidos_cache como pendiente.
    const fila2222 = db.prepare("SELECT * FROM pedidos_cache WHERE clave='ml:2222'").get();
    expect(fila2222).toBeUndefined();
  });

  it('un GET real con status:"shipped" persiste la fila en ml_shipment_estado (no solo el salteo)', async () => {
    buildTestApp(db);
    wooFetch.mockResolvedValue({ data: [] });
    mlFetch
      .mockResolvedValueOnce({ status: 200, data: { results: [{ id: 3333, date_created: '2026-07-20T00:00:00Z', buyer: { nickname: 'x' }, shipping: { id: 777 }, order_items: [] }] } }) // orders/search
      .mockResolvedValueOnce({ status: 200, data: { status: 'shipped', logistic_type: 'self_service' } }); // shipments/777

    await syncPedidosCache(db, CFG);

    const fila = db.prepare("SELECT * FROM ml_shipment_estado WHERE shipment_id='777'").get();
    expect(fila).toBeTruthy();
    expect(fila.status).toBe('shipped');
  });

  it('un status cacheado NO terminal (ready_to_ship) sí se repregunta contra ML', async () => {
    buildTestApp(db);
    const haceCincoDias = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();
    db.prepare(`
      INSERT INTO ml_shipment_estado (shipment_id, status, logistic_type, actualizado_en)
      VALUES ('888', 'ready_to_ship', 'self_service', ?)
    `).run(haceCincoDias);

    wooFetch.mockResolvedValue({ data: [] });
    mlFetch
      .mockResolvedValueOnce({ status: 200, data: { results: [{ id: 4444, status: 'paid', date_created: '2026-07-20T00:00:00Z', buyer: { nickname: 'x' }, shipping: { id: 888 }, order_items: [] }] } }) // orders/search
      .mockResolvedValueOnce({ status: 200, data: { status: 'ready_to_ship', logistic_type: 'self_service' } }); // shipments/888 -- SE repregunta

    await syncPedidosCache(db, CFG);

    // 2 llamadas: orders/search + shipments/888. Si el status no-terminal se hubiera
    // salteado igual que un terminal, acá quedaría en 1.
    expect(mlFetch).toHaveBeenCalledTimes(2);
    const fila4444 = db.prepare("SELECT * FROM pedidos_cache WHERE clave='ml:4444'").get();
    expect(fila4444).toBeTruthy();
  });

  it('un 200 sin status en el body no se cachea y cuenta como fallo (listado no confiable, no revienta el proceso)', async () => {
    buildTestApp(db);
    wooFetch.mockResolvedValue({ data: [] });
    mlFetch
      .mockResolvedValueOnce({ status: 200, data: { results: [{ id: 5555, date_created: '2026-07-20T00:00:00Z', buyer: { nickname: 'x' }, shipping: { id: 999 }, order_items: [] }] } }) // orders/search
      .mockResolvedValueOnce({ status: 200, data: {} }); // shipments/999 -- 200 pero sin status

    await expect(syncPedidosCache(db, CFG)).resolves.not.toThrow();

    // Nunca se cachea un status vacío: si se hubiera intentado, la columna NOT NULL habría
    // tirado SqliteError (el `resolves.not.toThrow()` de arriba ya lo cubre indirectamente).
    const fila = db.prepare("SELECT * FROM ml_shipment_estado WHERE shipment_id='999'").get();
    expect(fila).toBeUndefined();
    // Se trató como fallo de shipment (fallosShipment++) -> listado no confiable -> la poda
    // se omite esta corrida (no se borra nada con datos incompletos), pero la corrida en sí
    // no revienta: sync_log sigue en 'ok' (mismo comportamiento que un 500 de /shipments).
    const log = db.prepare("SELECT * FROM sync_log WHERE direccion='pedidos_cache' ORDER BY id DESC LIMIT 1").get();
    expect(log.estado).toBe('ok');
  });

  it('un status terminal cacheado hace más de 7 días se vuelve a verificar contra ML', async () => {
    buildTestApp(db);
    const hace10Dias = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
    db.prepare(`
      INSERT INTO ml_shipment_estado (shipment_id, status, logistic_type, actualizado_en)
      VALUES ('111', 'shipped', 'self_service', ?)
    `).run(hace10Dias);

    wooFetch.mockResolvedValue({ data: [] });
    mlFetch
      .mockResolvedValueOnce({ status: 200, data: { results: [{ id: 6666, date_created: '2026-07-20T00:00:00Z', buyer: { nickname: 'x' }, shipping: { id: 111 }, order_items: [] }] } }) // orders/search
      .mockResolvedValueOnce({ status: 200, data: { status: 'shipped', logistic_type: 'self_service' } }); // shipments/111 -- SE repregunta por vencimiento de vigencia

    await syncPedidosCache(db, CFG);

    // 2 llamadas: si el cacheo viejo se hubiera respetado igual, acá quedaría en 1.
    expect(mlFetch).toHaveBeenCalledTimes(2);
    const fila = db.prepare("SELECT * FROM ml_shipment_estado WHERE shipment_id='111'").get();
    expect(fila.actualizado_en).not.toBe(hace10Dias); // se refrescó
  });

  it('not_delivered NO se trata como terminal: se repregunta siempre (puede volver a ready_to_ship)', async () => {
    buildTestApp(db);
    const haceCincoDias = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();
    db.prepare(`
      INSERT INTO ml_shipment_estado (shipment_id, status, logistic_type, actualizado_en)
      VALUES ('222', 'not_delivered', 'self_service', ?)
    `).run(haceCincoDias);

    wooFetch.mockResolvedValue({ data: [] });
    mlFetch
      .mockResolvedValueOnce({ status: 200, data: { results: [{ id: 7777, status: 'paid', date_created: '2026-07-20T00:00:00Z', buyer: { nickname: 'x' }, shipping: { id: 222 }, order_items: [] }] } }) // orders/search
      .mockResolvedValueOnce({ status: 200, data: { status: 'ready_to_ship', logistic_type: 'self_service' } }); // shipments/222 -- reintento de visita, ahora está pendiente de nuevo

    await syncPedidosCache(db, CFG);

    expect(mlFetch).toHaveBeenCalledTimes(2);
    // El pedido vuelve a aparecer como pendiente -- si not_delivered se hubiera tratado
    // como terminal, este pedido real habría quedado invisible para siempre.
    const fila7777 = db.prepare("SELECT * FROM pedidos_cache WHERE clave='ml:7777'").get();
    expect(fila7777).toBeTruthy();
    expect(fila7777.estado_envio).toBe('pendiente');
  });

  it('poda ml_shipment_estado por antigüedad: filas de hace 90 días desaparecen, filas de hace 5 días sobreviven', async () => {
    buildTestApp(db);
    const hace90Dias = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
    const haceCincoDias = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();
    db.prepare(`
      INSERT INTO ml_shipment_estado (shipment_id, status, logistic_type, actualizado_en)
      VALUES ('333', 'shipped', 'self_service', ?)
    `).run(hace90Dias);
    db.prepare(`
      INSERT INTO ml_shipment_estado (shipment_id, status, logistic_type, actualizado_en)
      VALUES ('444', 'shipped', 'self_service', ?)
    `).run(haceCincoDias);

    wooFetch.mockResolvedValue({ data: [] });
    mlFetch.mockResolvedValueOnce({ status: 200, data: { results: [] } }); // orders/search sin resultados

    await syncPedidosCache(db, CFG);

    expect(db.prepare("SELECT * FROM ml_shipment_estado WHERE shipment_id='333'").get()).toBeUndefined();
    expect(db.prepare("SELECT * FROM ml_shipment_estado WHERE shipment_id='444'").get()).toBeTruthy();
  });

  it('con más de 50 órdenes paid, pagina /orders/search hasta agotar el resultado (no se queda con la primera página) y sí poda si queda confiable', async () => {
    buildTestApp(db);
    // Fecha relativa, adentro de la ventana móvil de 30 días (ver comentario más arriba).
    const haceCincoDias = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();
    db.prepare(`
      INSERT INTO pedidos_cache (clave, canal, wc_order_id, ml_order_id, numero_pedido, comprador, fecha, estado_envio, estado_wc, espejo_ml, logistic_type, substatus, items_json, actualizado_en)
      VALUES ('ml:1111','ml',NULL,'1111','1111','Cliente Viejo',?,'pendiente',NULL,0,'self_service',NULL,'[]',?)
    `).run(haceCincoDias, haceCincoDias);

    // Sin shipping.id para no tener que mockear /shipments por cada una: lo que importa acá
    // es que la paginación agote las 2 páginas, no el filtrado de shipments.
    const pagina1 = Array.from({ length: 50 }, (_, i) => ({
      id: 9000 + i, date_created: '2026-07-20T00:00:00Z', buyer: { nickname: 'x' }, shipping: null, order_items: [],
    }));
    const pagina2 = [
      { id: 9100, date_created: '2026-07-20T00:00:00Z', buyer: { nickname: 'y' }, shipping: null, order_items: [] },
      { id: 9101, date_created: '2026-07-20T00:00:00Z', buyer: { nickname: 'z' }, shipping: null, order_items: [] },
    ];

    wooFetch.mockResolvedValue({ data: [] });
    mlFetch
      .mockResolvedValueOnce({ status: 200, data: { results: pagina1 } }) // orders/search offset=0
      .mockResolvedValueOnce({ status: 200, data: { results: pagina2 } }); // orders/search offset=50

    await syncPedidosCache(db, CFG);

    const urlsOrdersSearch = mlFetch.mock.calls.filter(c => c[3]?.includes('/orders/search')).map(c => c[3]);
    expect(urlsOrdersSearch).toHaveLength(2);
    expect(urlsOrdersSearch[0]).toContain('offset=0');
    expect(urlsOrdersSearch[1]).toContain('offset=50');

    // Ninguna orden tiene shipping.id, así que pendientesMl no encuentra pendientes vigentes,
    // pero pudo confirmarlo (paginación agotada, sin fallos) -> poda de la fila vieja.
    const filaVieja = db.prepare("SELECT * FROM pedidos_cache WHERE clave='ml:1111'").get();
    expect(filaVieja).toBeUndefined();
  });

  it('fila ml:vieja con fecha anterior a la ventana de 30 días NO se poda aunque no aparezca en el listado vigente', async () => {
    buildTestApp(db);
    const fechaFueraDeVentana = new Date(Date.now() - 45 * 24 * 3600 * 1000).toISOString();
    db.prepare(`
      INSERT INTO pedidos_cache (clave, canal, wc_order_id, ml_order_id, numero_pedido, comprador, fecha, estado_envio, estado_wc, espejo_ml, logistic_type, substatus, items_json, actualizado_en)
      VALUES ('ml:vieja','ml',NULL,'vieja','vieja','Cliente Fuera De Ventana',?,'pendiente',NULL,0,'self_service',NULL,'[]',?)
    `).run(fechaFueraDeVentana, fechaFueraDeVentana);

    wooFetch.mockResolvedValue({ data: [] });
    mlFetch.mockResolvedValueOnce({ status: 200, data: { results: [] } }); // listado confiable, sin pendientes vigentes

    await syncPedidosCache(db, CFG);

    const fila = db.prepare("SELECT * FROM pedidos_cache WHERE clave='ml:vieja'").get();
    expect(fila).toBeTruthy();
  });

  it('fila ml:vieja con fecha en offset de zona horaria distinto a UTC se poda según su tiempo real (comparación normalizada, no texto plano)', async () => {
    buildTestApp(db);
    // '-04:00' es lexicográficamente MENOR que 'Z' -- con comparación de texto plano
    // ("...-04:00" >= "...Z" como strings) esta fecha se leería como más vieja de lo que es
    // en tiempo real y podría quedar mal clasificada según el corte de 30 días.
    // Instante real: 20 días atrás (bien adentro de la ventana de 30 días), pero escrito
    // con offset -04:00 en vez de 'Z' -- mismo instante, distinta representación de texto.
    const veinteDiasAtrasUtc = new Date(Date.now() - 20 * 24 * 3600 * 1000);
    const mismoInstanteOffset4 = new Date(veinteDiasAtrasUtc.getTime() + 4 * 3600 * 1000)
      .toISOString().replace('Z', '-04:00');
    db.prepare(`
      INSERT INTO pedidos_cache (clave, canal, wc_order_id, ml_order_id, numero_pedido, comprador, fecha, estado_envio, estado_wc, espejo_ml, logistic_type, substatus, items_json, actualizado_en)
      VALUES ('ml:vieja','ml',NULL,'vieja','vieja','Cliente Offset TZ',?,'pendiente',NULL,0,'self_service',NULL,'[]',?)
    `).run(mismoInstanteOffset4, mismoInstanteOffset4);

    wooFetch.mockResolvedValue({ data: [] });
    mlFetch.mockResolvedValueOnce({ status: 200, data: { results: [] } }); // listado confiable, sin pendientes vigentes

    await syncPedidosCache(db, CFG);

    // El instante real está dentro de la ventana de 30 días -> debe podarse porque no
    // aparece en el listado vigente ML. Con comparación de texto plano ignorando el offset,
    // este caso podía quedar mal clasificado según el corte.
    const fila = db.prepare("SELECT * FROM pedidos_cache WHERE clave='ml:vieja'").get();
    expect(fila).toBeUndefined();
  });

  it('una fila con preparación completada no se poda aunque no aparezca en el listado de pendientesMl', async () => {
    buildTestApp(db);
    // Fecha relativa, adentro de la ventana móvil de 30 días (ver comentario más arriba). Esta
    // fila igual queda a salvo por el filtro de estado_prep='completada' de la poda, pero se
    // mantiene dentro de la ventana para que el test siga probando ese camino y no el otro
    // (fuera de ventana), que ya se cubre en un test aparte.
    const haceCincoDias = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();
    db.prepare(`
      INSERT INTO pedidos_cache (clave, canal, wc_order_id, ml_order_id, numero_pedido, comprador, fecha, estado_envio, estado_wc, espejo_ml, logistic_type, substatus, items_json, actualizado_en)
      VALUES ('ml:1111','ml',NULL,'1111','1111','Cliente Completado',?,'pendiente',NULL,0,'self_service',NULL,'[]',?)
    `).run(haceCincoDias, haceCincoDias);
    db.prepare(`
      INSERT INTO preparaciones (canal, clave, estado, etiqueta_lista, creado_en)
      VALUES ('ml', 'ml:1111', 'completada', 0, ?)
    `).run(haceCincoDias);

    wooFetch.mockResolvedValue({ data: [] });
    mlFetch.mockResolvedValueOnce({ status: 200, data: { results: [] } }); // no vuelve a aparecer: pendientesMl no la refetchea

    await syncPedidosCache(db, CFG);

    const fila = db.prepare("SELECT * FROM pedidos_cache WHERE clave='ml:1111'").get();
    expect(fila).toBeTruthy();
  });

  it('borra de pedidos_cache una fila ml pendiente cuya preparación se completó hace más de 60 días (limpieza por antigüedad)', async () => {
    buildTestApp(db);
    const hace70Dias = new Date(Date.now() - 70 * 24 * 3600 * 1000).toISOString();
    db.prepare(`
      INSERT INTO pedidos_cache (clave, canal, wc_order_id, ml_order_id, numero_pedido, comprador, fecha, estado_envio, estado_wc, espejo_ml, logistic_type, substatus, items_json, actualizado_en)
      VALUES ('ml:2222','ml',NULL,'2222','2222','Cliente Viejo','2026-01-01T00:00:00Z','pendiente',NULL,0,'self_service',NULL,'[]','2026-01-01T00:00:00Z')
    `).run();
    db.prepare(`
      INSERT INTO preparaciones (canal, clave, estado, etiqueta_lista, creado_en, completado_en)
      VALUES ('ml', 'ml:2222', 'completada', 1, '2026-01-01T00:00:00Z', ?)
    `).run(hace70Dias);

    wooFetch.mockResolvedValue({ data: [] });
    mlFetch.mockResolvedValueOnce({ status: 200, data: { results: [] } });

    await syncPedidosCache(db, CFG);

    const fila = db.prepare("SELECT * FROM pedidos_cache WHERE clave='ml:2222'").get();
    expect(fila).toBeUndefined();
  });

  it('NO borra una fila ml pendiente cuya preparación se completó hace 10 días (sigue en la tabla, aunque no aparezca en /pendientes)', async () => {
    buildTestApp(db);
    const hace10Dias = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
    db.prepare(`
      INSERT INTO pedidos_cache (clave, canal, wc_order_id, ml_order_id, numero_pedido, comprador, fecha, estado_envio, estado_wc, espejo_ml, logistic_type, substatus, items_json, actualizado_en)
      VALUES ('ml:3333','ml',NULL,'3333','3333','Cliente Reciente','2026-07-01T00:00:00Z','pendiente',NULL,0,'self_service',NULL,'[]','2026-07-01T00:00:00Z')
    `).run();
    db.prepare(`
      INSERT INTO preparaciones (canal, clave, estado, etiqueta_lista, creado_en, completado_en)
      VALUES ('ml', 'ml:3333', 'completada', 1, '2026-07-01T00:00:00Z', ?)
    `).run(hace10Dias);

    wooFetch.mockResolvedValue({ data: [] });
    mlFetch.mockResolvedValueOnce({ status: 200, data: { results: [] } });

    await syncPedidosCache(db, CFG);

    const fila = db.prepare("SELECT * FROM pedidos_cache WHERE clave='ml:3333'").get();
    expect(fila).toBeTruthy();
  });

  it('GET /pendientes no muestra una fila cuya preparación local ya está completada (bug real: pedido ya entregado seguía en la cola)', async () => {
    const app = buildTestApp(db);
    db.prepare(`
      INSERT INTO pedidos_cache (clave, canal, wc_order_id, ml_order_id, numero_pedido, comprador, fecha, estado_envio, estado_wc, espejo_ml, logistic_type, substatus, items_json, actualizado_en)
      VALUES ('ml:2000017571249972','ml',NULL,'2000017571249972','2000017571249972','Cliente Ya Entregado','2026-07-01T00:00:00Z','pendiente',NULL,0,'self_service',NULL,'[]','2026-07-01T00:00:00Z')
    `).run();
    db.prepare(`
      INSERT INTO preparaciones (canal, clave, estado, etiqueta_lista, creado_en, completado_en, preparado_por)
      VALUES ('ml', 'ml:2000017571249972', 'completada', 1, '2026-07-24T00:00:00Z', '2026-07-24T01:00:00Z', 'Joaco')
    `).run();

    const r = await request(app).get('/api/preparacion/pendientes');

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.data.find(p => p.ml_order_id === '2000017571249972')).toBeUndefined();
  });

  it('GET /pendientes no muestra una fila con preparación en pendiente_deposito (tiene pantalla propia en Historial)', async () => {
    const app = buildTestApp(db);
    db.prepare(`
      INSERT INTO pedidos_cache (clave, canal, wc_order_id, ml_order_id, numero_pedido, comprador, fecha, estado_envio, estado_wc, espejo_ml, logistic_type, substatus, items_json, actualizado_en)
      VALUES ('ml:3333','ml',NULL,'3333','3333','Cliente Deposito','2026-07-01T00:00:00Z','pendiente',NULL,0,'self_service',NULL,'[]','2026-07-01T00:00:00Z')
    `).run();
    db.prepare(`
      INSERT INTO preparaciones (canal, clave, estado, etiqueta_lista, creado_en)
      VALUES ('ml', 'ml:3333', 'pendiente_deposito', 0, '2026-07-24T00:00:00Z')
    `).run();

    const r = await request(app).get('/api/preparacion/pendientes');

    expect(r.body.data.find(p => p.ml_order_id === '3333')).toBeUndefined();
  });

  it('GET /pendientes SÍ muestra filas sin preparación todavía o en_preparacion (no rompe el flujo normal)', async () => {
    const app = buildTestApp(db);
    db.prepare(`
      INSERT INTO pedidos_cache (clave, canal, wc_order_id, ml_order_id, numero_pedido, comprador, fecha, estado_envio, estado_wc, espejo_ml, logistic_type, substatus, items_json, actualizado_en)
      VALUES ('ml:4444','ml',NULL,'4444','4444','Cliente Sin Preparar','2026-07-01T00:00:00Z','pendiente',NULL,0,'self_service',NULL,'[]','2026-07-01T00:00:00Z')
    `).run();
    db.prepare(`
      INSERT INTO pedidos_cache (clave, canal, wc_order_id, ml_order_id, numero_pedido, comprador, fecha, estado_envio, estado_wc, espejo_ml, logistic_type, substatus, items_json, actualizado_en)
      VALUES ('ml:5555','ml',NULL,'5555','5555','Cliente En Preparacion','2026-07-01T00:00:00Z','pendiente',NULL,0,'self_service',NULL,'[]','2026-07-01T00:00:00Z')
    `).run();
    db.prepare(`
      INSERT INTO preparaciones (canal, clave, estado, etiqueta_lista, creado_en)
      VALUES ('ml', 'ml:5555', 'en_preparacion', 0, '2026-07-24T00:00:00Z')
    `).run();

    const r = await request(app).get('/api/preparacion/pendientes');

    expect(r.body.data.find(p => p.ml_order_id === '4444')).toBeTruthy();
    expect(r.body.data.find(p => p.ml_order_id === '5555')).toBeTruthy();
  });
});

// ─── A.1: camino rápido por webhook (sin esperar al cron de 10 min) ─────────────
import { syncPedidoWebPuntual, syncPedidoMlPuntual } from '../routes/preparacion.js';

describe('syncPedidoWebPuntual', () => {
  let db;
  const CFG = {
    woo: { url: 'https://fusionbikes.com.ar', ck: 'ck_x', cs: 'cs_x' },
    andreaniStatus: 'lpaandreani',
    enviadoAndreaniStatus: 'enviadoandreani',
  };

  beforeEach(() => { db = openDb(TEST_DB); vi.clearAllMocks(); });
  afterEach(() => { db.close(); if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('trae SOLO la orden pedida y hace upsert inmediato en pedidos_cache (sin correr el cron)', async () => {
    wooFetch.mockResolvedValueOnce({
      data: {
        id: 901, number: '901', status: 'lpaandreani', date_created: '2026-08-26T00:00:00Z',
        billing: { first_name: 'Juan', last_name: 'Perez' }, meta_data: [],
        line_items: [{ id: 1, product_id: 501, variation_id: 0, sku: 'BIKE-1', name: 'Bici', quantity: 1 }],
      },
    });

    await syncPedidoWebPuntual(db, CFG, 901);

    expect(wooFetch).toHaveBeenCalledTimes(1); // una sola llamada — no los 3 barridos del cron
    expect(wooFetch).toHaveBeenCalledWith(CFG.woo, '/orders/901');
    const row = db.prepare('SELECT * FROM pedidos_cache WHERE clave=?').get('web:901');
    expect(row).toBeTruthy();
    expect(row.estado_envio).toBe('pendiente');
  });

  it('una segunda llegada (duplicada) no duplica la fila — mismo upsert ON CONFLICT', async () => {
    const order = {
      id: 902, number: '902', status: 'lpaandreani', date_created: '2026-08-26T00:00:00Z',
      billing: { first_name: 'Juan', last_name: 'Perez' }, meta_data: [], line_items: [],
    };
    wooFetch.mockResolvedValueOnce({ data: order }).mockResolvedValueOnce({ data: order });

    await syncPedidoWebPuntual(db, CFG, 902);
    await syncPedidoWebPuntual(db, CFG, 902);

    const filas = db.prepare("SELECT * FROM pedidos_cache WHERE clave='web:902'").all();
    expect(filas).toHaveLength(1);
  });

  it('ignora en silencio un estado que no es relevante para la cola de preparación', async () => {
    wooFetch.mockResolvedValueOnce({
      data: { id: 903, number: '903', status: 'pending', date_created: '2026-08-26T00:00:00Z', billing: {}, meta_data: [], line_items: [] },
    });

    await syncPedidoWebPuntual(db, CFG, 903);

    expect(db.prepare("SELECT * FROM pedidos_cache WHERE clave='web:903'").get()).toBeUndefined();
  });

  it('invalida una fila pendiente cacheada al confirmar un estado no elegible, sin borrar la preparación', async () => {
    buildTestApp(db); // inicializa las tablas de preparación/cache antes de sembrar la transición
    db.prepare(`INSERT INTO pedidos_cache
      (clave, canal, wc_order_id, numero_pedido, comprador, fecha, estado_envio, items_json, actualizado_en)
      VALUES ('web:906', 'web', 906, '906', 'Juan', ?, 'pendiente', '[]', ?)`)
      .run(new Date().toISOString(), new Date().toISOString());
    db.prepare(`INSERT INTO preparaciones (canal, clave, estado, etiqueta_lista, creado_en)
      VALUES ('web', 'web:906', 'en_preparacion', 0, ?)`)
      .run(new Date().toISOString());
    wooFetch.mockResolvedValueOnce({ data: { id: 906, status: 'cancelled', billing: {}, line_items: [] } });

    await syncPedidoWebPuntual(db, CFG, 906);

    expect(db.prepare("SELECT estado_envio, estado_wc FROM pedidos_cache WHERE clave='web:906'").get())
      .toMatchObject({ estado_envio: 'no_elegible', estado_wc: 'cancelled' });
    expect(db.prepare("SELECT estado FROM preparaciones WHERE clave='web:906'").get().estado).toBe('en_preparacion');
  });

  it('fail-open: si el webhook falla (wooFetch rechaza), no revienta y el pedido queda para el cron siguiente', async () => {
    wooFetch.mockRejectedValueOnce(new Error('WC caído'));

    await expect(syncPedidoWebPuntual(db, CFG, 904)).rejects.toThrow('WC caído');
    // El caller real (server.js) engancha esto con .catch() fire-and-forget: acá solo
    // verificamos que no dejó nada corrupto y que la fila simplemente no está — el cron de
    // syncPedidosCache la va a traer en su próxima corrida normal, sin que este camino
    // puntual haya hecho nada especial que lo impida.
    expect(db.prepare("SELECT * FROM pedidos_cache WHERE clave='web:904'").get()).toBeUndefined();
  });

  it('tras fallar el camino puntual, la corrida de cron siguiente (syncPedidosCache) sí trae el pedido — no se pierde', async () => {
    wooFetch.mockRejectedValueOnce(new Error('WC caído'));
    await expect(syncPedidoWebPuntual(db, CFG, 905)).rejects.toThrow('WC caído');
    expect(db.prepare("SELECT * FROM pedidos_cache WHERE clave='web:905'").get()).toBeUndefined();

    // Corrida normal del cron de respaldo: mismo pedido, ahora vía el barrido de 3 estados.
    const orderPend = {
      id: 905, number: '905', status: 'lpaandreani', date_created: '2026-08-26T00:00:00Z',
      billing: { first_name: 'Juan', last_name: 'Perez' }, meta_data: [], line_items: [],
    };
    wooFetch
      .mockResolvedValueOnce({ data: [orderPend] }) // status=lpaandreani
      .mockResolvedValueOnce({ data: [] })          // status=completed
      .mockResolvedValueOnce({ data: [] });         // status=enviadoandreani
    mlFetch.mockResolvedValueOnce({ status: 200, data: { results: [] } });

    await syncPedidosCache(db, { ...CFG, ml: { clientId: 'cid', clientSecret: 'cs', userId: '99999' } });

    const row = db.prepare("SELECT * FROM pedidos_cache WHERE clave='web:905'").get();
    expect(row).toBeTruthy();
    expect(row.estado_envio).toBe('pendiente');
  });
});

describe('syncPedidoMlPuntual', () => {
  let db;
  const MLCFG = { clientId: 'cid', clientSecret: 'cs', userId: '99999' };

  it('clasifica evidencia ML como elegible, no elegible o inconclusa sin cerrar de más', () => {
    expect(clasificarElegibilidadMl({ status: 'paid', shipping: { id: 1 } }, { status: 'ready_to_ship', logistic_type: 'self_service' }).estado).toBe('elegible');
    expect(clasificarElegibilidadMl({ status: 'paid', shipping: { id: 1 } }, { status: 'ready_to_ship', logistic_type: 'fulfillment' }).estado).toBe('no_elegible');
    expect(clasificarElegibilidadMl({ status: 'paid' }, null).estado).toBe('inconcluso');
    expect(clasificarElegibilidadMl({ status: 'paid', shipping: { id: 1 } }, { status: 'ready_to_ship' }).estado).toBe('inconcluso');
  });

  it('sync puntual conserva como pendiente una orden paga sin shipping.id (inconclusa)', async () => {
    mlFetch.mockResolvedValueOnce({ status: 200, data: { id: 'ORD-INCONCLUSA', status: 'paid', buyer: { nickname: 'x' }, order_items: [] } });
    await syncPedidoMlPuntual(db, MLCFG, 'ORD-INCONCLUSA');
    expect(db.prepare("SELECT estado_envio, logistic_type FROM pedidos_cache WHERE clave='ml:ORD-INCONCLUSA'").get())
      .toMatchObject({ estado_envio: 'pendiente', logistic_type: null });
  });

  beforeEach(() => { db = openDb(TEST_DB); vi.clearAllMocks(); });
  afterEach(() => { db.close(); if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('POST /iniciar ML devuelve 409 y no crea preparación si el envío no es elegible', async () => {
    mlFetch.mockResolvedValueOnce({ status: 200, data: { id: 'ORD-14', status: 'paid', shipping: { id: 814 }, buyer: { nickname: 'x' } } })
      .mockResolvedValueOnce({ status: 200, data: { status: 'shipped', logistic_type: 'self_service' } });
    const res = await request(buildTestApp(db)).post('/api/preparacion/iniciar').send({ canal: 'ml', id: 'ORD-14' });
    expect(res.status).toBe(409);
    expect(db.prepare("SELECT * FROM preparaciones WHERE clave='ml:ORD-14'").get()).toBeUndefined();
  });

  it('POST /iniciar ML bloquea evidencia inconclusa y no crea preparación', async () => {
    mlFetch.mockResolvedValueOnce({ status: 200, data: { id: 'ORD-INCONCLUSA-2', status: 'paid', buyer: { nickname: 'x' } } });
    const res = await request(buildTestApp(db)).post('/api/preparacion/iniciar').send({ canal: 'ml', id: 'ORD-INCONCLUSA-2' });
    expect(res.status).toBe(409);
    expect(res.body.estado_elegibilidad).toBe('inconcluso');
    expect(db.prepare("SELECT * FROM preparaciones WHERE clave='ml:ORD-INCONCLUSA-2'").get()).toBeUndefined();
  });

  it('trae SOLO la orden pedida (paid + ready_to_ship + envío local) y hace upsert inmediato', async () => {
    mlFetch
      .mockResolvedValueOnce({ status: 200, data: { id: 'ORD-9', status: 'paid', date_created: '2026-08-26T00:00:00Z', buyer: { nickname: 'compradorml' }, order_items: [], shipping: { id: 777 } } })
      .mockResolvedValueOnce({ status: 200, data: { status: 'ready_to_ship', logistic_type: 'self_service' } });

    await syncPedidoMlPuntual(db, MLCFG, 'ORD-9');

    expect(mlFetch).toHaveBeenCalledTimes(2); // orden + shipment — no el listado completo de pendientesMl
    const row = db.prepare('SELECT * FROM pedidos_cache WHERE clave=?').get('ml:ORD-9');
    expect(row).toBeTruthy();
    expect(row.estado_envio).toBe('pendiente');
    expect(row.canal).toBe('ml');
  });

  it('una segunda llegada (duplicada) no duplica la fila — mismo upsert ON CONFLICT', async () => {
    const ordenResp = { status: 200, data: { id: 'ORD-10', status: 'paid', date_created: '2026-08-26T00:00:00Z', buyer: { nickname: 'x' }, order_items: [], shipping: { id: 778 } } };
    const shipResp = { status: 200, data: { status: 'ready_to_ship', logistic_type: 'self_service' } };
    mlFetch.mockResolvedValueOnce(ordenResp).mockResolvedValueOnce(shipResp)
      .mockResolvedValueOnce(ordenResp).mockResolvedValueOnce(shipResp);

    await syncPedidoMlPuntual(db, MLCFG, 'ORD-10');
    await syncPedidoMlPuntual(db, MLCFG, 'ORD-10');

    const filas = db.prepare("SELECT * FROM pedidos_cache WHERE clave='ml:ORD-10'").all();
    expect(filas).toHaveLength(1);
  });

  it('ignora en silencio una orden que todavía no está paga', async () => {
    mlFetch.mockResolvedValueOnce({ status: 200, data: { id: 'ORD-11', status: 'confirmed', shipping: { id: 779 } } });

    await syncPedidoMlPuntual(db, MLCFG, 'ORD-11');

    expect(db.prepare("SELECT * FROM pedidos_cache WHERE clave='ml:ORD-11'").get()).toBeUndefined();
  });

  it('fail-open: si el webhook falla (mlFetch rechaza), no revienta — el cron siguiente lo trae vía pendientesMl', async () => {
    mlFetch.mockRejectedValueOnce(new Error('ML caído'));

    await expect(syncPedidoMlPuntual(db, MLCFG, 'ORD-12')).rejects.toThrow('ML caído');
    expect(db.prepare("SELECT * FROM pedidos_cache WHERE clave='ml:ORD-12'").get()).toBeUndefined();
  });

  it('tras fallar el camino puntual, la corrida de cron siguiente (syncPedidosCache) sí trae el pedido ML — no se pierde', async () => {
    mlFetch.mockRejectedValueOnce(new Error('ML caído'));
    await expect(syncPedidoMlPuntual(db, MLCFG, 'ORD-13')).rejects.toThrow('ML caído');
    expect(db.prepare("SELECT * FROM pedidos_cache WHERE clave='ml:ORD-13'").get()).toBeUndefined();

    const CFG = {
      woo: { url: 'https://fusionbikes.com.ar', ck: 'ck_x', cs: 'cs_x' },
      ml: MLCFG,
      andreaniStatus: 'lpaandreani',
      enviadoAndreaniStatus: 'enviadoandreani',
    };
    wooFetch.mockResolvedValueOnce({ data: [] }).mockResolvedValueOnce({ data: [] }).mockResolvedValueOnce({ data: [] });
    mlFetch.mockResolvedValueOnce({
      status: 200,
      data: { results: [{ id: 'ORD-13', status: 'paid', date_created: '2026-08-26T00:00:00Z', buyer: { nickname: 'compradorml' }, order_items: [], shipping: { id: 780 } }] },
    });
    mlFetch.mockResolvedValueOnce({ status: 200, data: { status: 'ready_to_ship', logistic_type: 'self_service' } });

    await syncPedidosCache(db, CFG);

    const row = db.prepare("SELECT * FROM pedidos_cache WHERE clave='ml:ORD-13'").get();
    expect(row).toBeTruthy();
    expect(row.estado_envio).toBe('pendiente');
  });
});
