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
import { ingerirPregunta, ingerirMensaje, ingerirReclamo, reintentarReclamosSinConsultar, notificacionesMlRouter, reconciliarPreguntasMl } from '../routes/notificacionesMl.js';

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
    expect(db.prepare("SELECT event_type, channel, resource_id, dedupe_key FROM integration_events WHERE resource_id='123'").get())
      .toMatchObject({ event_type: 'question.received', channel: 'ml', resource_id: '123', dedupe_key: 'ml:question:123:UNANSWERED' });
    expect(db.prepare("SELECT title, preview, status FROM inbox_items WHERE resource_id='question:123'").get())
      .toMatchObject({ title: 'Pregunta ML · MLA1', preview: '¿Tiene stock?', status: 'unread' });
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

describe('ordenamiento durable del inbox', () => {
  it('aplica una actualización posterior legítima y conserva ANSWERED ante evento viejo', async () => {
    const db = tmpDb();
    mlFetch.mockResolvedValueOnce({ status: 200, data: { id: 42, item_id: 'A', text: 'respondida', status: 'ANSWERED', date_created: '2026-08-30T18:00:00.000Z' } });
    await ingerirPregunta(db, {}, '/questions/42');
    mlFetch.mockResolvedValueOnce({ status: 200, data: { id: 42, item_id: 'A', text: 'vieja', status: 'UNANSWERED', date_created: '2026-08-30T17:00:00.000Z' } });
    await ingerirPregunta(db, {}, '/questions/42');
    const row = db.prepare("SELECT preview, updated_at FROM inbox_items WHERE resource_id='question:42'").get();
    expect(row.preview).toBe('respondida');
    expect(row.updated_at).toBe('2026-08-30T18:00:00.000Z');
    db.close();
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

  it('no borra el reclamo provisional si el lease vence durante la canonicalización', async () => {
    await ingerirReclamo(db, {}, '/invalid-resource');
    db.prepare(`INSERT INTO ml_reclamos
      (id, recurso, estado, actualizado_en, consultado_en_ml)
      VALUES (?, ?, 'sin_consultar', ?, 0)`).run('provisional', '/claims/provisional', new Date().toISOString());
    mlFetch.mockResolvedValueOnce({
      status: 200,
      data: { id: 'canonico', status: 'opened', title: 'Canónico' },
    });
    // El worker tenía lease al iniciar el GET; al volver de await ya venció.
    const leaseGuard = () => false;

    await expect(ingerirReclamo(
      db, {}, '/claims/provisional', '/claims/provisional', null, { leaseGuard },
    )).rejects.toMatchObject({ code: 'lease_expired' });
    expect(db.prepare("SELECT id FROM ml_reclamos WHERE id='provisional'").get()).toBeTruthy();
    expect(db.prepare("SELECT id FROM ml_reclamos WHERE id='canonico'").get()).toBeUndefined();
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

    // Segundo evento: closed a las 18:00.
    mlFetch.mockResolvedValueOnce({
      status: 200,
      data: { id: 'c_idem', status: 'closed', title: 'Resuelto', date_closed: '2026-08-26T18:00:00.000Z' },
    });
    await ingerirReclamo(db, {}, '/post-purchase/v1/claims/c_idem');
    row = db.prepare("SELECT * FROM ml_reclamos WHERE id='c_idem'").get();
    expect(row.estado).toBe('closed');
    expect(row.cerrado_en).toBeTruthy();

    // Reapertura real posterior: updated_at 19:00.
    mlFetch.mockResolvedValueOnce({
      status: 200,
      data: { id: 'c_idem', status: 'opened', title: 'Reclamo reabierto', updated_at: '2026-08-26T19:00:00.000Z' },
    });
    await ingerirReclamo(db, {}, '/post-purchase/v1/claims/c_idem');
    row = db.prepare("SELECT * FROM ml_reclamos WHERE id='c_idem'").get();
    expect(row.estado).toBe('opened');
    expect(row.cerrado_en).toBeNull();
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
    expect(r.body).toMatchObject({ ok: true, preguntas: 0, preguntas_no_accionables: 1, mensajes: 1, reclamos: 2, reclamos_sin_confirmar: 1, total: 3 });
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

    const file = path.join(os.tmpdir(), `notif_ml_http_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
    app = buildServerApp({ dbPath: file, sessionSecret: 'test-session', mobileJwtSecret, wooCfg: {}, geminiKey: '', mlCfg: {} });
    app._tmpFile = file;
    const r = await request(app).post('/api/ml/notificacion').send({
      topic: 'post_purchase', actions: ['claims'], user_id: '123',
      resource: `/post-purchase/v1/claims/${claimId}`,
    });
    expect(r.status).toBe(200);
    const duplicate = await request(app).post('/api/ml/notificacion').send({
      topic: 'post_purchase', actions: ['claims'], user_id: '123',
      resource: `/post-purchase/v1/claims/${claimId}`,
    });
    expect(duplicate.status).toBe(200);
    expect(duplicate.body).toMatchObject({ ok: true, duplicate: true });
    const event = app._db.prepare('SELECT * FROM integration_events WHERE resource_id=?').get(`/post-purchase/v1/claims/${claimId}`);
    expect(event).toBeTruthy();
    expect(app._db.prepare('SELECT job_type FROM integration_jobs WHERE event_id=?').get(event.event_id).job_type).toBe('claim.project');
    expect(mlFetch).not.toHaveBeenCalled();
  });

  it('acepta claims desde claim_id en body, resource de claims, o ambos', async () => {
    const file = path.join(os.tmpdir(), `notif_ml_http_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
    app = buildServerApp({ dbPath: file, sessionSecret: 'test-session', mobileJwtSecret, wooCfg: {}, geminiKey: '', mlCfg: {} });
    app._tmpFile = file;

    // Caso 1: claim_id en body sin resource /claims → audit-only
    const r1 = await request(app).post('/api/ml/notificacion').send({
      topic: 'post_purchase', action: 'claims', claim_id: 'body_id', user_id: '123',
    });
    expect(r1.status).toBe(200);
    const event1 = app._db.prepare('SELECT event_id FROM integration_events WHERE resource_id=?').get('/post-purchase/v1/claims/body_id');
    expect(event1).toBeTruthy();
    const job1 = app._db.prepare('SELECT job_type FROM integration_jobs WHERE event_id=?').get(event1.event_id);
    expect(job1.job_type).toBe('webhook.audit');

    // Caso 2: resource de claims sin action='claims' → audit-only
    const r2 = await request(app).post('/api/ml/notificacion').send({
      topic: 'post_purchase', action: 'created', resource: '/post-purchase/v1/claims/resource_id', user_id: '123',
    });
    expect(r2.status).toBe(200);
    const event2 = app._db.prepare('SELECT event_id FROM integration_events WHERE resource_id=?').get('/post-purchase/v1/claims/resource_id');
    expect(event2).toBeTruthy();
    const job2 = app._db.prepare('SELECT job_type FROM integration_jobs WHERE event_id=?').get(event2.event_id);
    expect(job2.job_type).toBe('webhook.audit');

    // Caso 3: no claim — resource de orders → webhook.audit
    const r3 = await request(app).post('/api/ml/notificacion').send({
      topic: 'post_purchase', action: 'claims', resource: '/orders/o1', user_id: '123',
    });
    expect(r3.status).toBe(200);
    const event3 = app._db.prepare('SELECT event_id FROM integration_events WHERE resource_id=?').get('/orders/o1');
    expect(event3).toBeTruthy();
    const job3 = app._db.prepare('SELECT job_type FROM integration_jobs WHERE event_id=?').get(event3.event_id);
    expect(job3.job_type).toBe('webhook.audit');

    expect(mlFetch).not.toHaveBeenCalled();
  });

  it('procesa el topic legado claims por HTTP real', async () => {
    const file = path.join(os.tmpdir(), `notif_ml_http_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
    app = buildServerApp({ dbPath: file, sessionSecret: 'test-session', mobileJwtSecret, wooCfg: {}, geminiKey: '', mlCfg: {} });
    app._tmpFile = file;
    const r = await request(app).post('/api/ml/notificacion').send({
      topic: 'claims', resource: '/claims/legacy_http', user_id: '123',
    });
    expect(r.status).toBe(200);
    // El resource_id normalizado debe quedar en formato vigente, no en el legado del webhook.
    const event = app._db.prepare("SELECT * FROM integration_events WHERE resource_id=?").get('/post-purchase/v1/claims/legacy_http');
    expect(event).toBeTruthy();
    expect(app._db.prepare('SELECT job_type FROM integration_jobs WHERE event_id=?').get(event.event_id).job_type).toBe('claim.project');
    // Un solo evento durable: el topic legado no debe caer en la rama de "evento derivado".
    expect(app._db.prepare('SELECT COUNT(*) n FROM integration_events').get().n).toBe(1);
    expect(mlFetch).not.toHaveBeenCalled();
  });

  it('acepta (200, no reintentable) una cuenta ML distinta sin llamar a ML', async () => {
    const file = path.join(os.tmpdir(), `notif_ml_http_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
    app = buildServerApp({ dbPath: file, sessionSecret: 'test-session', mobileJwtSecret, wooCfg: {}, geminiKey: '', mlCfg: {} });
    app._tmpFile = file;
    const r = await request(app).post('/api/ml/notificacion').send({
      topic: 'post_purchase', actions: ['claims'], user_id: 'otro',
      resource: '/post-purchase/v1/claims/ignored',
    });
    // Cuenta ajena: responder 200 (no reintentable) e ignored:true, como siempre. Lo que cambió
    // (E1 T3 C2) es que ahora deja traza: una fila `excluded/foreign_account`, acotada por la defensa
    // por IP de lib/sombra.js. Lo que NO cambia, y es la garantía que importa: cero jobs. La traza no
    // agenda trabajo sobre el recurso de una cuenta que el emisor elige a voluntad.
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, ignored: true });
    expect(app._db.prepare('SELECT COUNT(*) n FROM integration_events').get().n).toBe(1);
    expect(app._db.prepare('SELECT shadow_status,shadow_reason,status FROM integration_events').get())
      .toMatchObject({ shadow_status: 'excluded', shadow_reason: 'foreign_account', status: 'completed' });
    expect(app._db.prepare('SELECT COUNT(*) n FROM integration_jobs').get().n).toBe(0);
    expect(mlFetch).not.toHaveBeenCalled();
  });
});

describe('Webhook HTTP: caminos de error del envelope', () => {
  const mobileJwtSecret = 'claims-http-test-mobile-secret-32-chars';
  let app;
  beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('ML_USER_ID', '123'); });
  afterEach(() => {
    app?._db?.close();
    if (app?._tmpFile && fs.existsSync(app._tmpFile)) fs.unlinkSync(app._tmpFile);
    app = null;
    vi.unstubAllEnvs();
  });

  function buildApp() {
    const file = path.join(os.tmpdir(), `notif_ml_http_err_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
    app = buildServerApp({ dbPath: file, sessionSecret: 'test-session', mobileJwtSecret, wooCfg: {}, geminiKey: '', mlCfg: {} });
    app._tmpFile = file;
    return app;
  }

  it('400 envelope inválido: topic no matchea el patrón', async () => {
    buildApp();
    const r = await request(app).post('/api/ml/notificacion').send({
      topic: '¡inválido!', resource: '/orders/1', user_id: '123',
    });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ ok: false, error: 'envelope inválido' });
    expect(app._db.prepare('SELECT COUNT(*) n FROM integration_events').get().n).toBe(0);
    expect(app._db.prepare('SELECT COUNT(*) n FROM integration_jobs').get().n).toBe(0);
  });

  it('400 envelope inválido: resource no es una ruta válida y no es el caso legacyClaimEnvelope', async () => {
    buildApp();
    const r = await request(app).post('/api/ml/notificacion').send({
      topic: 'orders', resource: '/', user_id: '123',
    });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ ok: false, error: 'envelope inválido' });
    expect(app._db.prepare('SELECT COUNT(*) n FROM integration_events').get().n).toBe(0);
    expect(app._db.prepare('SELECT COUNT(*) n FROM integration_jobs').get().n).toBe(0);
  });

  it('400 user_id faltante: ausente, null o string vacío tras trim', async () => {
    buildApp();
    for (const user_id of [undefined, null, '   ']) {
      const body = { topic: 'orders', resource: '/orders/1' };
      if (user_id !== undefined) body.user_id = user_id;
      const r = await request(app).post('/api/ml/notificacion').send(body);
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ ok: false, error: 'user_id requerido' });
    }
    expect(app._db.prepare('SELECT COUNT(*) n FROM integration_events').get().n).toBe(0);
    expect(app._db.prepare('SELECT COUNT(*) n FROM integration_jobs').get().n).toBe(0);
  });

  it('503 config ML ausente: process.env.ML_USER_ID no está seteado', async () => {
    vi.unstubAllEnvs();
    vi.stubEnv('ML_USER_ID', '');
    buildApp();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await request(app).post('/api/ml/notificacion').send({
      topic: 'orders', resource: '/orders/1', user_id: '123',
    });
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ ok: false, error: 'integración ML no configurada' });
    expect(app._db.prepare('SELECT COUNT(*) n FROM integration_events').get().n).toBe(0);
    expect(app._db.prepare('SELECT COUNT(*) n FROM integration_jobs').get().n).toBe(0);
    expect(spy.mock.calls.some(args => String(args[0]).includes('config-ml-ausente'))).toBe(true);
    spy.mockRestore();
  });

  it('503 persistencia falla: registrarWebhookMl lanza excepción y no crashea el proceso', async () => {
    buildApp();
    // Forzamos el fallo real de persistencia rompiendo la tabla que usa registrarWebhookMl,
    // sin mockear el módulo (evita interferir con el resto de los tests de este archivo,
    // que dependen de la persistencia real vía integration_events/integration_jobs).
    app._db.exec('DROP TABLE integration_events');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await request(app).post('/api/ml/notificacion').send({
      topic: 'orders', resource: '/orders/1', user_id: '123',
    });
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ ok: false, error: 'no se pudo persistir el evento' });
    expect(app._db.prepare('SELECT COUNT(*) n FROM integration_jobs').get().n).toBe(0);
    expect(spy.mock.calls.some(args => String(args[0]).includes('persistencia-fallo'))).toBe(true);
    spy.mockRestore();
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

describe('red de reconciliación de preguntas', () => {
  const CFG = { clientId: 'c', clientSecret: 's', userId: '99' };
  const respuesta = (qs, total) => ({ status: 200, data: { total: total ?? qs.length, questions: qs } });

  // Medido contra la API el 2026-09-06: de 10 preguntas sin responder, 6 no estaban en la
  // base. El usuario lo confirmó desde la pantalla: veía 4. Un aviso perdido era una consulta
  // de cliente que no aparecía nunca.
  it('persiste las preguntas sin responder que el webhook no trajo', async () => {
    const db = openDb(':memory:');
    mlFetch.mockResolvedValue(respuesta([
      { id: 1, item_id: 'MLA1', text: '¿Tienen talle S?', status: 'UNANSWERED', date_created: '2026-03-29T03:48:47Z' },
      { id: 2, item_id: 'MLA2', text: '¿Qué aceite es?', status: 'UNANSWERED', date_created: '2026-04-04T10:00:00Z' },
    ]));
    const r = await reconciliarPreguntasMl(db, CFG);
    expect(r).toMatchObject({ omitido: false, vistas: 2, recuperadas: 2 });
    expect(db.prepare('SELECT COUNT(*) n FROM ml_preguntas').get().n).toBe(2);
    expect(db.prepare('SELECT texto FROM ml_preguntas WHERE id=1').get().texto).toBe('¿Tienen talle S?');
    db.close();
  });

  // `deleted_from_listing` = eliminada de la publicación (doc oficial de ML). No es trabajo
  // pendiente ni se puede responder. Medido: 2 de las 6 que faltaban estaban así, incluida una
  // que a primera vista parecía un aviso perdido legítimo.
  it('descarta las eliminadas de la publicación y las retenidas', async () => {
    const db = openDb(':memory:');
    mlFetch.mockResolvedValue(respuesta([
      { id: 1, item_id: 'MLA1', text: 'vale', status: 'UNANSWERED', date_created: '2026-09-01T10:00:00Z', deleted_from_listing: false },
      { id: 2, item_id: 'MLA2', text: 'borrada', status: 'UNANSWERED', date_created: '2026-03-29T10:00:00Z', deleted_from_listing: true },
      { id: 3, item_id: 'MLA3', text: 'retenida', status: 'UNANSWERED', date_created: '2026-08-01T10:00:00Z', hold: true },
    ]));
    const r = await reconciliarPreguntasMl(db, CFG);
    expect(r).toMatchObject({ vistas: 1, recuperadas: 1, descartadas: 2 });
    expect(db.prepare('SELECT COUNT(*) n FROM ml_preguntas').get().n).toBe(1);
    expect(db.prepare('SELECT 1 FROM ml_preguntas WHERE id=2').get()).toBeUndefined();
    db.close();
  });

  // La red solo agregaba: una pregunta contestada despues quedaba pendiente para siempre y le
  // fabricaba trabajo falso al operario. Lo detecto el usuario el 2026-09-06 — cuatro de las
  // que le mostrabamos ya estaban respondidas en ML.
  it('cierra las que ML ya no lista como sin responder', async () => {
    const db = openDb(':memory:');
    mlFetch.mockResolvedValue(respuesta([
      { id: 1, item_id: 'MLA1', text: 'sigue viva', status: 'UNANSWERED', date_created: '2026-09-01T10:00:00Z' },
      { id: 2, item_id: 'MLA2', text: 'la contestan luego', status: 'UNANSWERED', date_created: '2026-09-01T11:00:00Z' },
    ]));
    await reconciliarPreguntasMl(db, CFG);
    expect(db.prepare("SELECT COUNT(*) n FROM ml_preguntas WHERE estado='UNANSWERED'").get().n).toBe(2);
    // La 2 se responde en ML: deja de aparecer en la lista de sin responder.
    mlFetch.mockResolvedValue(respuesta([
      { id: 1, item_id: 'MLA1', text: 'sigue viva', status: 'UNANSWERED', date_created: '2026-09-01T10:00:00Z' },
    ]));
    const r = await reconciliarPreguntasMl(db, CFG);
    expect(r.cerradas).toBe(1);
    expect(db.prepare('SELECT estado FROM ml_preguntas WHERE id=2').get().estado).toBe('ANSWERED');
    expect(db.prepare('SELECT estado FROM ml_preguntas WHERE id=1').get().estado).toBe('UNANSWERED');
    db.close();
  });

  // Si ML dice que hay mas de las que trajo esta pagina, una ausente puede estar en la
  // siguiente y seguir sin responder. Cerrarla seria afirmar algo que no sabemos.
  it('no cierra nada si la pagina no trajo el total', async () => {
    const db = openDb(':memory:');
    mlFetch.mockResolvedValue(respuesta([{ id: 1, item_id: 'MLA1', text: 'a', status: 'UNANSWERED', date_created: '2026-09-01T10:00:00Z' }]));
    await reconciliarPreguntasMl(db, CFG);
    mlFetch.mockResolvedValue(respuesta([{ id: 9, item_id: 'MLA9', text: 'b', status: 'UNANSWERED', date_created: '2026-09-02T10:00:00Z' }], 80));
    const r = await reconciliarPreguntasMl(db, CFG);
    expect(r.cerradas).toBe(0);
    expect(db.prepare('SELECT estado FROM ml_preguntas WHERE id=1').get().estado).toBe('UNANSWERED');
    db.close();
  });

  it('es idempotente: correrla de nuevo no cuenta recuperadas', async () => {
    const db = openDb(':memory:');
    mlFetch.mockResolvedValue(respuesta([{ id: 1, item_id: 'MLA1', text: 'hola', status: 'UNANSWERED', date_created: '2026-03-29T03:48:47Z' }]));
    await reconciliarPreguntasMl(db, CFG);
    expect((await reconciliarPreguntasMl(db, CFG)).recuperadas).toBe(0);
    expect(db.prepare('SELECT COUNT(*) n FROM ml_preguntas').get().n).toBe(1);
    db.close();
  });

  // La guarda que ya tenía el camino del webhook: una respondida no se pisa con una sin
  // responder, aunque ML la devuelva en el listado por atraso de indexación.
  it('no pisa una pregunta ya respondida', async () => {
    const db = openDb(':memory:');
    notificacionesMlRouter(db); // crea las tablas: openDb no las trae, las hace ensureTables
    db.prepare(`INSERT INTO ml_preguntas (id,item_id,texto,estado,fecha_creacion,respondida_en,actualizado_en)
      VALUES (1,'MLA1','hola','ANSWERED','2026-03-29T03:48:47Z',?,?)`).run(new Date().toISOString(), new Date().toISOString());
    mlFetch.mockResolvedValue(respuesta([{ id: 1, item_id: 'MLA1', text: 'hola', status: 'UNANSWERED', date_created: '2026-03-29T03:48:47Z' }]));
    await reconciliarPreguntasMl(db, CFG);
    expect(db.prepare('SELECT estado FROM ml_preguntas WHERE id=1').get().estado).toBe('ANSWERED');
    db.close();
  });

  it('si ML no responde 200, no toca nada y lo dice', async () => {
    const db = openDb(':memory:');
    mlFetch.mockResolvedValue({ status: 500, data: null });
    expect(await reconciliarPreguntasMl(db, CFG)).toMatchObject({ omitido: true, motivo: 'http_500' });
    expect(db.prepare('SELECT COUNT(*) n FROM ml_preguntas').get().n).toBe(0);
    db.close();
  });

  it('el contador separa las preguntas de publicaciones que no se pueden vender', async () => {
    const db = openDb(':memory:');
    const app = express(); app.use('/api/notificaciones-ml', notificacionesMlRouter(db));
    const ts = new Date().toISOString();
    const pub = (item, status, stock) => db.prepare(`INSERT INTO ml_publicaciones_cache
      (clave,item_id,variation_id,titulo,status,available_quantity,actualizado_en) VALUES (?,?,'','t',?,?,?)`)
      .run(item + '|', item, status, stock, ts);
    const preg = (id, item) => db.prepare(`INSERT INTO ml_preguntas (id,item_id,texto,estado,fecha_creacion,actualizado_en)
      VALUES (?,?,'q','UNANSWERED',?,?)`).run(id, item, ts, ts);
    pub('MLA-OK', 'active', 5);   preg(1, 'MLA-OK');
    pub('MLA-PAUSA', 'paused', 0); preg(2, 'MLA-PAUSA');
    pub('MLA-CERO', 'active', 0);  preg(3, 'MLA-CERO');
    preg(4, 'MLA-DESCONOCIDA'); // sin fila en el cache

    const res = await request(app).get('/api/notificaciones-ml/count');
    expect(res.body.preguntas).toBe(1);
    expect(res.body.preguntas_no_accionables).toBe(3);
    // Sólo la publicación activa con stock es una acción del Home. Las demás se conservan
    // pero no compiten por atención.
    expect(res.body.preguntas_sin_stock).toBe(2);
    db.close();
  });

  // Brecha 6 del documento de arquitectura. Hasta ahora un job muerto se quedaba ahi para
  // siempre y nadie se enteraba: los 39 mensajes y 3 preguntas muertos solo aparecieron porque
  // alguien fue a mirar la base a mano.
  it('expone los jobs muertos agrupados por tipo y motivo', async () => {
    const db = openDb(':memory:');
    const app = express(); app.use('/api/notificaciones-ml', notificacionesMlRouter(db));
    const ts = new Date().toISOString();
    for (const [id, tipo] of [['e1','message.project'], ['e2','message.project'], ['e3','question.project']]) {
      db.prepare(`INSERT INTO integration_events (event_id,event_type,channel,source,resource_id,received_at,correlation_id,dedupe_key)
        VALUES (?,'webhook.received','ml','mercadolibre','/x',?,?,?)`).run(id, ts, 'c'+id, 'd'+id);
      db.prepare("INSERT INTO integration_jobs (event_id,job_type,available_at,status) VALUES (?,?,?,'dead_lettered')").run(id, tipo, ts);
      db.prepare(`INSERT INTO integration_event_history (event_id,stage,to_status,correlation_id,safe_message,created_at)
        VALUES (?,'job.process','dead_lettered',?,?,?)`).run(id, 'c' + id, 'ML no confirmo', ts);
    }
    const res = await request(app).get('/api/notificaciones-ml/dead-letters');
    expect(res.body.total).toBe(3);
    expect(res.body.grupos[0]).toMatchObject({ job_type: 'message.project', n: 2, motivo: 'ML no confirmo' });
    // Y el contador liviano lo expone para el aviso del home.
    expect((await request(app).get('/api/notificaciones-ml/count')).body.dead_letters).toBe(3);
    db.close();
  });

  it('pide sólo las UNANSWERED: una llamada, no el histórico de 1111', async () => {
    const db = openDb(':memory:');
    // El mock es compartido entre tests: sin limpiarlo se cuentan las llamadas de los demás.
    mlFetch.mockClear();
    mlFetch.mockResolvedValue(respuesta([]));
    await reconciliarPreguntasMl(db, CFG);
    expect(mlFetch).toHaveBeenCalledTimes(1);
    expect(mlFetch.mock.calls[0][3]).toContain('status=UNANSWERED');
    db.close();
  });
});
