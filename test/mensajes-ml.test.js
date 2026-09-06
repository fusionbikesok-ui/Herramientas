import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { openDb } from '../db/index.js';
import * as mlClient from '../lib/mlClient.js';
import express from 'express';
import request from 'supertest';
import { notificacionesMlRouter, reconciliarMensajesMl } from '../routes/notificacionesMl.js';

const FILE = './test/tmp-mensajes-ml.sqlite';
const CFG = { userId: '91406604', clientId: 'x', clientSecret: 'y' };
const PACK = '2000014571459685';
const RECURSO = `/packs/${PACK}/sellers/91406604`;

const mensaje = (id, from, texto, fecha) => ({
  id, from: { user_id: from }, to: { user_id: 91406604 },
  text: texto, message_date: { created: fecha },
});

function mockMl(porPath) {
  return vi.spyOn(mlClient, 'mlFetch').mockImplementation(async (_db, _cfg, _m, path) => {
    for (const [frag, resp] of Object.entries(porPath)) if (path.includes(frag)) return resp;
    return { status: 404, data: null };
  });
}

describe('reconciliación de mensajes post-venta de ML', () => {
  let db;
  beforeEach(() => { db = openDb(FILE); });
  afterEach(() => {
    vi.restoreAllMocks();
    try { db.close(); } catch { /* ya estaba cerrada */ }
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(`${FILE}${s}`)) fs.unlinkSync(`${FILE}${s}`);
  });

  it('lee los packs con pendientes y proyecta sus mensajes', () => {
    mockMl({
      '/messages/unread': { status: 200, data: { total: 1, results: [{ resource: RECURSO, count: 1 }] } },
      [RECURSO]: { status: 200, data: { messages: [
        mensaje('m1', 164915442, 'Hola. 345 4954838', '2026-09-04T20:10:22Z'),
        mensaje('m2', 91406604, 'te paso el repuesto', '2026-09-04T19:40:29Z'),
      ] } },
    });
    return reconciliarMensajesMl(db, CFG).then((r) => {
      expect(r).toMatchObject({ ok: true, packs: 1, mensajes: 2 });
      expect(db.prepare('SELECT COUNT(*) n FROM ml_mensajes').get().n).toBe(2);
    });
  });

  it('NUNCA marca los mensajes como leídos', async () => {
    // Sin `mark_as_read=false`, leer los marca como leídos en MercadoLibre: un cron no puede
    // decidir por una persona que ya vio un mensaje.
    const spy = mockMl({
      '/messages/unread': { status: 200, data: { total: 1, results: [{ resource: RECURSO }] } },
      [RECURSO]: { status: 200, data: { messages: [mensaje('m1', 1, 'hola', '2026-09-04T20:10:22Z')] } },
    });
    await reconciliarMensajesMl(db, CFG);

    const paths = spy.mock.calls.map((c) => c[3]);
    expect(paths.some((p) => p.includes(RECURSO))).toBe(true);
    for (const p of paths.filter((x) => x.includes('/packs/'))) expect(p).toContain('mark_as_read=false');
  });

  it('vincula cada mensaje con su pack y su pedido', async () => {
    // Sin eso la bandeja no puede unir la conversación con la venta.
    db.prepare(`CREATE TABLE IF NOT EXISTS pedidos_cache (clave TEXT PRIMARY KEY, canal TEXT,
      ml_order_id TEXT, wc_order_id INTEGER, pack_id TEXT, items_json TEXT, actualizado_en TEXT)`).run();
    db.prepare("INSERT INTO pedidos_cache (clave,canal,ml_order_id,pack_id,actualizado_en) VALUES ('k','ml','2000017976464120',?,?)")
      .run(PACK, '2026-09-04T00:00:00Z');
    mockMl({
      '/messages/unread': { status: 200, data: { total: 1, results: [{ resource: RECURSO }] } },
      [RECURSO]: { status: 200, data: { messages: [mensaje('m1', 164915442, 'hola', '2026-09-04T20:10:22Z')] } },
    });
    await reconciliarMensajesMl(db, CFG);

    expect(db.prepare('SELECT pack_id, order_id FROM ml_mensajes WHERE id=?').get('m1'))
      .toEqual({ pack_id: PACK, order_id: '2000017976464120' });
  });

  it('es idempotente: repetir no duplica', async () => {
    mockMl({
      '/messages/unread': { status: 200, data: { total: 1, results: [{ resource: RECURSO }] } },
      [RECURSO]: { status: 200, data: { messages: [mensaje('m1', 1, 'hola', '2026-09-04T20:10:22Z')] } },
    });
    await reconciliarMensajesMl(db, CFG);
    await reconciliarMensajesMl(db, CFG);
    expect(db.prepare('SELECT COUNT(*) n FROM ml_mensajes').get().n).toBe(1);
  });

  it('ignora un recurso que no tenga la forma esperada', async () => {
    // Se usa el `resource` tal como lo da ML en vez de rearmarlo: rearmarlo mal es exactamente
    // lo que dejó 39 jobs muertos pidiendo un host inexistente.
    mockMl({
      '/messages/unread': { status: 200, data: { total: 2, results: [
        { resource: '01a07256e972738f9bccbb89d60264b3' },
        { resource: '/packs/../etc' },
      ] } },
    });
    expect(await reconciliarMensajesMl(db, CFG)).toMatchObject({ ok: true, packs: 0, mensajes: 0 });
  });

  it('no falla cuando ML responde con error', async () => {
    mockMl({ '/messages/unread': { status: 500, data: null } });
    expect(await reconciliarMensajesMl(db, CFG)).toMatchObject({ omitido: true, motivo: 'http_500' });
  });

  it('no hace nada sin userId', async () => {
    expect(await reconciliarMensajesMl(db, {})).toMatchObject({ omitido: true, motivo: 'sin userId' });
  });
});

describe('reencolar dead letters', () => {
  let db;
  beforeEach(() => { db = openDb(FILE); });
  afterEach(() => {
    try { db.close(); } catch { /* ya estaba cerrada */ }
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(`${FILE}${s}`)) fs.unlinkSync(`${FILE}${s}`);
  });

  const ISO_E = '2026-08-30T13:53:26.366Z';
  function muerto(evId, tipo) {
    db.prepare(`INSERT INTO integration_events
      (event_id,event_type,channel,source,occurred_at,received_at,correlation_id,dedupe_key,status)
      VALUES (?,'x','ml','webhook',?,?,?,?,'dead_lettered')`).run(evId, ISO_E, ISO_E, 'c-' + evId, 'd-' + evId);
    db.prepare(`INSERT INTO integration_jobs
      (event_id,job_type,status,attempts,max_attempts,available_at,locked_by,lease_token,last_error_message)
      VALUES (?,?,'dead_lettered',8,8,?,'worker-viejo','tok','se murió')`).run(evId, tipo, ISO_E);
  }

  function app(admin = true) {
    const a = express(); a.use(express.json());
    a.use((req, _res, next) => { req.user = { username: 'ana', is_admin: admin }; next(); });
    a.use('/api/notificaciones-ml', notificacionesMlRouter(db, {}));
    return a;
  }

  it('devuelve los jobs a la cola y suelta sus locks', async () => {
    // Sin soltar el lease, el worker los saltearía por considerarlos tomados por otro.
    muerto('e1', 'message.project');
    const r = await request(app()).post('/api/notificaciones-ml/dead-letters/reintentar').send({});

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ reencolados: 1 });
    const j = db.prepare('SELECT * FROM integration_jobs').get();
    expect(j).toMatchObject({ status: 'pending', attempts: 0, locked_by: null, lease_token: null });
  });

  it('acota la tanda: cada job reencolado es al menos una llamada a ML', async () => {
    for (let i = 0; i < 6; i += 1) muerto('e' + i, 'message.project');
    const r = await request(app()).post('/api/notificaciones-ml/dead-letters/reintentar').send({ limite: 2 });

    expect(r.body.reencolados).toBe(2);
    expect(db.prepare("SELECT COUNT(*) n FROM integration_jobs WHERE status='dead_lettered'").get().n).toBe(4);
  });

  it('permite reencolar sólo un tipo', async () => {
    muerto('e1', 'message.project');
    muerto('e2', 'question.project');
    await request(app()).post('/api/notificaciones-ml/dead-letters/reintentar').send({ job_type: 'question.project' });

    expect(db.prepare("SELECT job_type FROM integration_jobs WHERE status='pending'").get().job_type).toBe('question.project');
  });

  it('es cosa de Administración', async () => {
    muerto('e1', 'message.project');
    const r = await request(app(false)).post('/api/notificaciones-ml/dead-letters/reintentar').send({});
    expect(r.status).toBe(403);
    expect(db.prepare("SELECT COUNT(*) n FROM integration_jobs WHERE status='dead_lettered'").get().n).toBe(1);
  });

  it('no rompe cuando no hay nada muerto', async () => {
    const r = await request(app()).post('/api/notificaciones-ml/dead-letters/reintentar').send({});
    expect(r.body).toMatchObject({ ok: true, reencolados: 0 });
  });
});
