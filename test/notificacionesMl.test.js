/**
 * test/notificacionesMl.test.js — preguntas y mensajes de ML sin responder.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import os from 'os';
import path from 'path';
import fs from 'fs';
import express from 'express';
import { buildApp as buildServerApp } from '../server.js';
import { openDb } from '../db/index.js';

vi.mock('../lib/mlClient.js', () => ({ mlFetch: vi.fn() }));
import { mlFetch } from '../lib/mlClient.js';
import { ingerirPregunta, ingerirMensaje, ingerirReclamo, reintentarReclamosSinConsultar, notificacionesMlRouter } from '../routes/notificacionesMl.js';

function tmpDb() {
  const f = path.join(os.tmpdir(), `notif_ml_test_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
  const db = new Database(f);
  db._tmpFile = f;
  return db;
}

function buildRouterApp(db) {
  const app = express();
  app.use(express.json());
  app.use('/api/notificaciones-ml', notificacionesMlRouter(db));
  return app;
}

describe('ingerirPregunta', () => {
  let db;
  beforeEach(() => { db = tmpDb(); vi.clearAllMocks(); });
  afterEach(() => { db.close(); fs.unlinkSync(db._tmpFile); });

  it('guarda una pregunta sin responder', async () => {
    mlFetch.mockResolvedValueOnce({
      status: 200,
      data: { id: 123, item_id: 'MLA1', text: '¿Tiene stock?', status: 'UNANSWERED', date_created: '2026-08-26T10:00:00.000Z' },
    });
    await ingerirPregunta(db, {}, '/questions/123');
    const row = db.prepare('SELECT * FROM ml_preguntas WHERE id=123').get();
    expect(row).toBeTruthy();
    expect(row.texto).toBe('¿Tiene stock?');
    expect(row.estado).toBe('UNANSWERED');
    expect(row.respondida_en).toBeNull();
  });

  it('marca respondida_en cuando la pregunta ya está ANSWERED', async () => {
    mlFetch.mockResolvedValueOnce({
      status: 200,
      data: { id: 124, item_id: 'MLA1', text: 'gracias', status: 'ANSWERED', date_created: '2026-08-26T10:00:00.000Z', answer: { date_created: '2026-08-26T11:00:00.000Z' } },
    });
    await ingerirPregunta(db, {}, '/questions/124');
    const row = db.prepare('SELECT * FROM ml_preguntas WHERE id=124').get();
    expect(row.respondida_en).toBe('2026-08-26T11:00:00.000Z');
  });

  it('upsert: una segunda notificación de la misma pregunta actualiza, no duplica', async () => {
    mlFetch.mockResolvedValueOnce({ status: 200, data: { id: 125, text: 'v1', status: 'UNANSWERED' } });
    await ingerirPregunta(db, {}, '/questions/125');
    mlFetch.mockResolvedValueOnce({ status: 200, data: { id: 125, text: 'v1', status: 'ANSWERED', answer: { date_created: '2026-08-26T12:00:00.000Z' } } });
    await ingerirPregunta(db, {}, '/questions/125');
    const total = db.prepare('SELECT COUNT(*) n FROM ml_preguntas WHERE id=125').get().n;
    expect(total).toBe(1);
    const row = db.prepare('SELECT * FROM ml_preguntas WHERE id=125').get();
    expect(row.estado).toBe('ANSWERED');
  });

  it('no hace nada si el resource no matchea /questions/<id>', async () => {
    await ingerirPregunta(db, {}, '/orders/999');
    expect(mlFetch).not.toHaveBeenCalled();
  });

  it('fail-open: si ML no responde 200, no rompe ni escribe nada', async () => {
    mlFetch.mockResolvedValueOnce({ status: 500, data: null });
    await expect(ingerirPregunta(db, {}, '/questions/126')).resolves.not.toThrow();
    const row = db.prepare('SELECT * FROM ml_preguntas WHERE id=126').get();
    expect(row).toBeUndefined();
  });
});

describe('ingerirMensaje', () => {
  let db;
  beforeEach(() => { db = tmpDb(); vi.clearAllMocks(); });
  afterEach(() => { db.close(); fs.unlinkSync(db._tmpFile); });

  it('guarda un mensaje sin responder desde una respuesta de array', async () => {
    mlFetch.mockResolvedValueOnce({
      status: 200,
      data: [{ id: 'm1', pack_id: '999', text: { plain: 'hola' }, from: { user_id: 111 }, message_date: { created: '2026-08-26T09:00:00.000Z' } }],
    });
    await ingerirMensaje(db, {}, '/packs/999/messages');
    const row = db.prepare("SELECT * FROM ml_mensajes WHERE id='m1'").get();
    expect(row).toBeTruthy();
    expect(row.texto).toBe('hola');
    expect(row.respondido_en).toBeNull();
  });

  it('guarda desde una respuesta objeto único (no array)', async () => {
    mlFetch.mockResolvedValueOnce({
      status: 200,
      data: { id: 'm2', text: 'consulta', message_date: { created: '2026-08-26T09:00:00.000Z' } },
    });
    await ingerirMensaje(db, {}, '/messages/m2');
    const row = db.prepare("SELECT * FROM ml_mensajes WHERE id='m2'").get();
    expect(row).toBeTruthy();
  });

  it('sin resource no llama a ML', async () => {
    await ingerirMensaje(db, {}, null);
    expect(mlFetch).not.toHaveBeenCalled();
  });
});

describe('ingerirReclamo', () => {
  let db;
  beforeEach(() => { db = tmpDb(); vi.clearAllMocks(); });
  afterEach(() => { db.close(); fs.unlinkSync(db._tmpFile); });

  it('guarda un reclamo abierto con estado "opened"', async () => {
    mlFetch.mockResolvedValueOnce({
      status: 200,
      data: {
        id: 'c1',
        status: 'opened',
        title: 'Faltante',
        description: 'Producto no llegó',
        date_created: '2026-08-26T09:00:00.000Z',
        type: 'item_not_received',
        reason_id: 'r123',
        resource_id: 'res456',
      },
    });
    await ingerirReclamo(db, {}, '/post-purchase/v1/claims/c1');
    const row = db.prepare("SELECT * FROM ml_reclamos WHERE id='c1'").get();
    expect(row).toBeTruthy();
    expect(row.estado).toBe('opened');
    expect(row.cerrado_en).toBeNull();
    expect(row.type).toBe('item_not_received');
    expect(row.reason_id).toBe('r123');
    expect(row.resource_id).toBe('res456');
    // Verificar que se llamó al endpoint vigente.
    expect(mlFetch).toHaveBeenCalledWith(db, {}, 'get', '/post-purchase/v1/claims/c1');
  });

  it('actualiza a estado "closed" y marca cerrado_en', async () => {
    mlFetch.mockResolvedValueOnce({
      status: 200,
      data: {
        id: 'c2',
        status: 'opened',
        title: 'Reclamo inicial',
        date_created: '2026-08-26T09:00:00.000Z',
      },
    });
    await ingerirReclamo(db, {}, '/post-purchase/v1/claims/c2');
    let row = db.prepare("SELECT * FROM ml_reclamos WHERE id='c2'").get();
    expect(row.estado).toBe('opened');
    expect(row.cerrado_en).toBeNull();

    // Segunda notificación: cambió a cerrado.
    mlFetch.mockResolvedValueOnce({
      status: 200,
      data: {
        id: 'c2',
        status: 'closed',
        title: 'Reclamo resuelto',
        date_closed: '2026-08-26T11:30:00.000Z',
      },
    });
    await ingerirReclamo(db, {}, '/post-purchase/v1/claims/c2');
    row = db.prepare("SELECT * FROM ml_reclamos WHERE id='c2'").get();
    expect(row.estado).toBe('closed');
    expect(row.cerrado_en).toBeTruthy();
    // Verificar que el contador de filas no cambió (upsert, no duplicado).
    expect(db.prepare("SELECT COUNT(*) n FROM ml_reclamos WHERE id='c2'").get().n).toBe(1);

    // Re-notificación cerrada parcial: no mueve fecha ni borra datos buenos.
    mlFetch.mockResolvedValueOnce({ status: 200, data: { id: 'c2', status: 'closed' } });
    await ingerirReclamo(db, {}, '/post-purchase/v1/claims/c2');
    row = db.prepare("SELECT * FROM ml_reclamos WHERE id='c2'").get();
    expect(row.cerrado_en).toBe('2026-08-26T11:30:00.000Z');
    expect(row.titulo).toBe('Reclamo resuelto');
  });

  it('soporta resource path legado /claims/{id}', async () => {
    mlFetch.mockResolvedValueOnce({
      status: 200,
      data: {
        id: 'c_legacy',
        status: 'opened',
        title: 'Legacy path',
        date_created: '2026-08-26T09:00:00.000Z',
      },
    });
    await ingerirReclamo(db, {}, '/claims/c_legacy');
    // Debe haber llamado al endpoint vigente, no al path legacy.
    expect(mlFetch).toHaveBeenCalledWith(db, {}, 'get', '/post-purchase/v1/claims/c_legacy');
    const row = db.prepare("SELECT * FROM ml_reclamos WHERE id='c_legacy'").get();
    expect(row).toBeTruthy();
    // El recurso guardado debe ser el que vino en el webhook (legacy).
    expect(row.recurso).toBe('/claims/c_legacy');
  });

  it('soporta resource path /v1/claims/{id}', async () => {
    mlFetch.mockResolvedValueOnce({
      status: 200,
      data: {
        id: 'c_v1',
        status: 'opened',
        title: 'V1 path',
      },
    });
    await ingerirReclamo(db, {}, '/v1/claims/c_v1');
    expect(mlFetch).toHaveBeenCalledWith(db, {}, 'get', '/post-purchase/v1/claims/c_v1');
    const row = db.prepare("SELECT * FROM ml_reclamos WHERE id='c_v1'").get();
    expect(row.recurso).toBe('/v1/claims/c_v1');
  });

  it('idempotencia: upsert y estado autoritativo permiten una reapertura real de ML', async () => {
    // Primer evento: opened.
    mlFetch.mockResolvedValueOnce({
      status: 200,
      data: { id: 'c_idem', status: 'opened', title: 'Reclamo' },
    });
    await ingerirReclamo(db, {}, '/post-purchase/v1/claims/c_idem');
    let row = db.prepare("SELECT * FROM ml_reclamos WHERE id='c_idem'").get();
    expect(row.estado).toBe('opened');

    // Segundo evento: closed.
    mlFetch.mockResolvedValueOnce({
      status: 200,
      data: { id: 'c_idem', status: 'closed', title: 'Resuelto', date_closed: '2026-08-26T12:00:00.000Z' },
    });
    await ingerirReclamo(db, {}, '/post-purchase/v1/claims/c_idem');
    row = db.prepare("SELECT * FROM ml_reclamos WHERE id='c_idem'").get();
    expect(row.estado).toBe('closed');
    expect(row.cerrado_en).toBeTruthy();

    // Tercer GET autoritativo: ML reabrió realmente el reclamo.
    mlFetch.mockResolvedValueOnce({
      status: 200,
      data: { id: 'c_idem', status: 'opened', title: 'Reclamo viejo' },
    });
    await ingerirReclamo(db, {}, '/post-purchase/v1/claims/c_idem');
    row = db.prepare("SELECT * FROM ml_reclamos WHERE id='c_idem'").get();
    expect(row.estado).toBe('opened');
    expect(row.cerrado_en).toBeNull();
    expect(row.titulo).toBe('Reclamo viejo');
  });

  it('fail-open: si ML devuelve status no-200', async () => {
    mlFetch.mockResolvedValueOnce({ status: 404, data: null });
    await expect(ingerirReclamo(db, {}, '/post-purchase/v1/claims/c_missing')).resolves.not.toThrow();
    expect(db.prepare("SELECT estado FROM ml_reclamos WHERE id='c_missing'").get().estado).toBe('sin_consultar');
  });

  it('fail-open: si ML devuelve 503 (server error)', async () => {
    mlFetch.mockResolvedValueOnce({ status: 503, data: null });
    await expect(ingerirReclamo(db, {}, '/post-purchase/v1/claims/c_error')).resolves.not.toThrow();
    expect(db.prepare("SELECT estado FROM ml_reclamos WHERE id='c_error'").get().estado).toBe('sin_consultar');
  });

  it('fail-open: si mlFetch lanza una excepción', async () => {
    mlFetch.mockRejectedValueOnce(new Error('timeout o error de conexión'));
    await expect(ingerirReclamo(db, {}, '/post-purchase/v1/claims/c_exception')).resolves.not.toThrow();
    expect(db.prepare("SELECT estado FROM ml_reclamos WHERE id='c_exception'").get().estado).toBe('sin_consultar');
  });

  it('fail-open sobre un reclamo confirmado no lo duplica ni lo saca de la bandeja', async () => {
    mlFetch.mockResolvedValueOnce({ status: 200, data: { id: 'c_confirmado', status: 'opened', title: 'Pendiente' } });
    await ingerirReclamo(db, {}, '/claims/c_confirmado');
    mlFetch.mockResolvedValueOnce({ status: 503, data: null });
    await ingerirReclamo(db, {}, '/claims/c_confirmado');
    const filas = db.prepare("SELECT * FROM ml_reclamos WHERE id='c_confirmado'").all();
    expect(filas).toHaveLength(1);
    expect(filas[0].consultado_en_ml).toBe(1);
    const router = notificacionesMlRouter(db);
    const app = express();
    app.use(router);
    const r = await request(app).get('/pendientes');
    expect(r.body.reclamos).toHaveLength(1);
    expect(r.body.reclamos_sin_confirmar).toHaveLength(0);
    expect(r.body.total).toBe(1);
  });

  it('reintenta solo fallos vencidos y limpia el diagnóstico al recuperar', async () => {
    await ingerirReclamo(db, {}, '/orders/not-a-claim');
    db.prepare(`INSERT INTO ml_reclamos (id, recurso, estado, actualizado_en, consultado_en_ml, ultimo_error_en, intentos, proximo_intento_en)
      VALUES ('c_retry', '/claims/c_retry', 'sin_consultar', ?, 0, ?, 2, ?),
             ('c_later', '/claims/c_later', 'sin_consultar', ?, 0, ?, 1, ?)`)
      .run('2026-08-28T00:00:00.000Z', '2026-08-28T00:00:00.000Z', '2000-01-01T00:00:00.000Z',
        '2026-08-28T00:00:00.000Z', '2026-08-28T00:00:00.000Z', '2999-01-01T00:00:00.000Z');
    mlFetch.mockResolvedValueOnce({ status: 200, data: { id: 'c_retry', status: 'opened', title: 'Recuperado' } });
    await expect(reintentarReclamosSinConsultar(db, {}, 10)).resolves.toBe(1);
    expect(mlFetch).toHaveBeenCalledWith(db, {}, 'get', '/post-purchase/v1/claims/c_retry');
    expect(db.prepare("SELECT consultado_en_ml, ultimo_error_en, intentos FROM ml_reclamos WHERE id='c_retry'").get())
      .toMatchObject({ consultado_en_ml: 1, ultimo_error_en: null, intentos: 0 });
  });

  it('no hace nada si el resource no matchea el patrón /*/claims/<id>', async () => {
    await ingerirReclamo(db, {}, '/orders/123');
    expect(mlFetch).not.toHaveBeenCalled();
  });

  it('conserva campos unknown en estado si no son opened/closed', async () => {
    mlFetch.mockResolvedValueOnce({
      status: 200,
      data: {
        id: 'c_unknown',
        status: 'SOME_FUTURE_STATE',
        title: 'Estado desconocido',
      },
    });
    await ingerirReclamo(db, {}, '/post-purchase/v1/claims/c_unknown');
    const row = db.prepare("SELECT * FROM ml_reclamos WHERE id='c_unknown'").get();
    expect(row).toBeTruthy();
    expect(row.estado).toBe('some_future_state'); // Se conserva normalizado.
    expect(row.cerrado_en).toBeNull(); // No se marca como cerrado.
  });
});

describe('GET /api/notificaciones-ml/pendientes y /count', () => {
  let db, app;
  beforeEach(() => {
    db = tmpDb();
    app = buildRouterApp(db);
    db.prepare(`INSERT INTO ml_preguntas (id, item_id, texto, estado, fecha_creacion, actualizado_en)
      VALUES (1, 'MLA1', 'pregunta vieja', 'UNANSWERED', '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO ml_preguntas (id, item_id, texto, estado, fecha_creacion, respondida_en, actualizado_en)
      VALUES (2, 'MLA2', 'ya respondida', 'ANSWERED', '2026-08-19T00:00:00.000Z', '2026-08-19T01:00:00.000Z', '2026-08-19T01:00:00.000Z')`).run();
    db.prepare(`INSERT INTO ml_mensajes (id, pack_id, texto, de_quien, fecha_creacion, actualizado_en)
      VALUES ('m1', '999', 'hola', '111', '2026-08-21T00:00:00.000Z', '2026-08-21T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO ml_reclamos (id, recurso, estado, titulo, fecha_creacion, actualizado_en)
      VALUES ('c1', '/claims/c1', 'opened', 'faltante', '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO ml_reclamos (id, recurso, estado, titulo, fecha_creacion, actualizado_en, consultado_en_ml)
      VALUES ('c_unknown', '/claims/c_unknown', 'sin_consultar', 'no confirmado', '2026-08-28T00:00:00.000Z', '2026-08-28T00:00:00.000Z', 0)`).run();
    db.prepare(`INSERT INTO ml_reclamos (id, recurso, estado, titulo, fecha_creacion, actualizado_en)
      VALUES ('c_dispute', '/claims/c_dispute', 'dispute', 'en disputa', '2026-08-21T00:00:00.000Z', '2026-08-21T00:00:00.000Z')`).run();
  });
  afterEach(() => { db.close(); fs.unlinkSync(db._tmpFile); });

  it('/pendientes lista solo lo sin responder, ordenado por más viejo primero', async () => {
    const r = await request(app).get('/api/notificaciones-ml/pendientes');
    expect(r.status).toBe(200);
    expect(r.body.preguntas).toHaveLength(1);
    expect(r.body.preguntas[0].id).toBe(1);
    expect(r.body.mensajes).toHaveLength(1);
    expect(r.body.reclamos).toHaveLength(2);
    expect(r.body.reclamos_sin_confirmar).toHaveLength(1);
    expect(r.body.total).toBe(4);
  });

  it('/count devuelve los mismos totales sin traer las filas', async () => {
    const r = await request(app).get('/api/notificaciones-ml/count');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, preguntas: 1, mensajes: 1, reclamos: 2, reclamos_sin_confirmar: 1, total: 4 });
  });
});

describe('Webhook HTTP: topic post_purchase con acción claims', () => {
  const mobileJwtSecret = 'claims-http-test-mobile-secret-32-chars';
  let app;
  beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('ML_USER_ID', '123'); });
  afterEach(() => {
    app?._db?.close();
    if (app?._tmpFile && fs.existsSync(app._tmpFile)) fs.unlinkSync(app._tmpFile);
    app = null;
    vi.unstubAllEnvs();
  });

  it('persiste el reclamo desde el resource real y actions del envelope', async () => {
    const claimId = 'claim_from_envelope_001';
    mlFetch.mockResolvedValueOnce({
      status: 200,
      data: {
        id: claimId,
        status: 'opened',
        title: 'Producto no entregado',
        type: 'item_not_received',
        reason_id: 'r789',
      },
    });

    const file = path.join(os.tmpdir(), `notif_ml_http_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
    app = buildServerApp({ dbPath: file, sessionSecret: 'test-session', mobileJwtSecret, wooCfg: {}, geminiKey: '', mlCfg: {} });
    app._tmpFile = file;
    const r = await request(app).post('/api/ml/notificacion').send({
      topic: 'post_purchase', actions: ['claims'], user_id: '123',
      resource: `/post-purchase/v1/claims/${claimId}`,
    });
    expect(r.status).toBe(200);
    await vi.waitFor(() => expect(app._db.prepare(`SELECT * FROM ml_reclamos WHERE id=?`).get(claimId)).toBeTruthy());
    expect(mlFetch).toHaveBeenCalledWith(app._db, {}, 'get', `/post-purchase/v1/claims/${claimId}`);
    const row = app._db.prepare(`SELECT * FROM ml_reclamos WHERE id=?`).get(claimId);
    expect(row).toBeTruthy();
    expect(row.estado).toBe('opened');
    expect(row.type).toBe('item_not_received');
    expect(row.reason_id).toBe('r789');
  });

  it('usa claim_id del body o resource y descarta action distinta/sin id', async () => {
    const file = path.join(os.tmpdir(), `notif_ml_http_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
    app = buildServerApp({ dbPath: file, sessionSecret: 'test-session', mobileJwtSecret, wooCfg: {}, geminiKey: '', mlCfg: {} });
    app._tmpFile = file;
    mlFetch.mockResolvedValueOnce({ status: 200, data: { id: 'body_id', status: 'opened' } });
    await request(app).post('/api/ml/notificacion').send({
      topic: 'post_purchase', action: 'claims', claim_id: 'body_id', user_id: '123',
    });
    await request(app).post('/api/ml/notificacion').send({
      topic: 'post_purchase', action: 'other', envelope: { claim_id: 'ignored' }, user_id: '123',
    });
    await request(app).post('/api/ml/notificacion').send({
      topic: 'post_purchase', action: 'claims', resource: '/orders/o1', user_id: '123',
    });
    await vi.waitFor(() => expect(mlFetch).toHaveBeenCalledTimes(1));
    expect(mlFetch).toHaveBeenCalledTimes(1);
    expect(mlFetch).toHaveBeenCalledWith(app._db, {}, 'get', '/post-purchase/v1/claims/body_id');
  });

  it('procesa el topic legado claims por HTTP real', async () => {
    const file = path.join(os.tmpdir(), `notif_ml_http_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
    app = buildServerApp({ dbPath: file, sessionSecret: 'test-session', mobileJwtSecret, wooCfg: {}, geminiKey: '', mlCfg: {} });
    app._tmpFile = file;
    mlFetch.mockResolvedValueOnce({ status: 200, data: { id: 'legacy_http', status: 'opened' } });
    const r = await request(app).post('/api/ml/notificacion').send({
      topic: 'claims', resource: '/claims/legacy_http', user_id: '123',
    });
    expect(r.status).toBe(200);
    await vi.waitFor(() => expect(app._db.prepare("SELECT estado FROM ml_reclamos WHERE id='legacy_http'").get()).toBeTruthy());
    expect(mlFetch).toHaveBeenCalledWith(app._db, {}, 'get', '/post-purchase/v1/claims/legacy_http');
    expect(app._db.prepare("SELECT estado FROM ml_reclamos WHERE id='legacy_http'").get().estado).toBe('opened');
  });

  it('rechaza una cuenta ML distinta sin llamar a ML', async () => {
    const file = path.join(os.tmpdir(), `notif_ml_http_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
    app = buildServerApp({ dbPath: file, sessionSecret: 'test-session', mobileJwtSecret, wooCfg: {}, geminiKey: '', mlCfg: {} });
    app._tmpFile = file;
    const r = await request(app).post('/api/ml/notificacion').send({
      topic: 'post_purchase', actions: ['claims'], user_id: 'otro',
      resource: '/post-purchase/v1/claims/ignored',
    });
    expect(r.status).toBe(200);
    expect(mlFetch).not.toHaveBeenCalled();
  });
});

describe('Migración de columnas de reclamos ML', () => {
  it('agrega columnas a una tabla ml_reclamos existente', () => {
    const file = path.join(os.tmpdir(), `notif_ml_migration_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
    const legacy = new Database(file);
    legacy.exec(`CREATE TABLE ml_reclamos (
      id TEXT PRIMARY KEY, recurso TEXT, estado TEXT NOT NULL, titulo TEXT,
      detalle TEXT, fecha_creacion TEXT, cerrado_en TEXT, actualizado_en TEXT NOT NULL
    )`);
    legacy.close();

    const migrated = openDb(file);
    const columns = migrated.prepare('PRAGMA table_info(ml_reclamos)').all().map(column => column.name);
    expect(columns).toEqual(expect.arrayContaining(['type', 'reason_id', 'resource_id', 'consultado_en_ml']));
    migrated.close();
    fs.unlinkSync(file);
  });
});
