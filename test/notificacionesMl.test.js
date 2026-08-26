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

vi.mock('../lib/mlClient.js', () => ({ mlFetch: vi.fn() }));
import { mlFetch } from '../lib/mlClient.js';
import { ingerirPregunta, ingerirMensaje, notificacionesMlRouter } from '../routes/notificacionesMl.js';

function tmpDb() {
  const f = path.join(os.tmpdir(), `notif_ml_test_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
  const db = new Database(f);
  db._tmpFile = f;
  return db;
}

function buildApp(db) {
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

describe('GET /api/notificaciones-ml/pendientes y /count', () => {
  let db, app;
  beforeEach(() => {
    db = tmpDb();
    app = buildApp(db);
    db.prepare(`INSERT INTO ml_preguntas (id, item_id, texto, estado, fecha_creacion, actualizado_en)
      VALUES (1, 'MLA1', 'pregunta vieja', 'UNANSWERED', '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO ml_preguntas (id, item_id, texto, estado, fecha_creacion, respondida_en, actualizado_en)
      VALUES (2, 'MLA2', 'ya respondida', 'ANSWERED', '2026-08-19T00:00:00.000Z', '2026-08-19T01:00:00.000Z', '2026-08-19T01:00:00.000Z')`).run();
    db.prepare(`INSERT INTO ml_mensajes (id, pack_id, texto, de_quien, fecha_creacion, actualizado_en)
      VALUES ('m1', '999', 'hola', '111', '2026-08-21T00:00:00.000Z', '2026-08-21T00:00:00.000Z')`).run();
  });
  afterEach(() => { db.close(); fs.unlinkSync(db._tmpFile); });

  it('/pendientes lista solo lo sin responder, ordenado por más viejo primero', async () => {
    const r = await request(app).get('/api/notificaciones-ml/pendientes');
    expect(r.status).toBe(200);
    expect(r.body.preguntas).toHaveLength(1);
    expect(r.body.preguntas[0].id).toBe(1);
    expect(r.body.mensajes).toHaveLength(1);
    expect(r.body.total).toBe(2);
  });

  it('/count devuelve los mismos totales sin traer las filas', async () => {
    const r = await request(app).get('/api/notificaciones-ml/count');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, preguntas: 1, mensajes: 1, total: 2 });
  });
});
