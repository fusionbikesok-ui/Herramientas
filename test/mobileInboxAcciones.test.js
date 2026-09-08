import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import { openDb } from '../db/index.js';
import { hashPassword, mobileAuthMiddleware, mobileRequirePermission } from '../lib/auth.js';
import { mobileAuthRouter } from '../routes/mobileAuth.js';
import { ensureTables } from '../routes/notificacionesMl.js';

vi.mock('../lib/mlClient.js', () => ({ mlFetch: vi.fn() }));

import { mlFetch } from '../lib/mlClient.js';
import { mobileInboxAccionesRouter } from '../routes/mobileInboxAcciones.js';

const DB = './test/tmp-mobile-inbox-acciones.sqlite';
const SECRET = 'test-mobile-jwt-secret-which-is-long-enough-123';
const MLCFG = { clientId: 'cid', clientSecret: 'cs', userId: '99999' };

/**
 * Ruta delgada sobre lib/mobileInboxActions.js: valida forma HTTP y traduce el error de
 * negocio a status. Toda escritura exige `Idempotency-Key` — sin ella se rechaza 422, porque
 * hacerla opcional deja abierto el camino de mandarle dos respuestas al comprador.
 */
describe('POST /api/v1/inbox-acciones (mobileInboxAccionesRouter)', () => {
  let db, app, auth;
  let seq = 0;

  const seedCaso = ({ resourceId = null, packId = null, assignedUserId = null } = {}) => {
    seq += 1;
    const eventId = `evt-seed-${seq}`;
    const t = new Date().toISOString();
    db.prepare(`INSERT INTO integration_events (event_id,event_type,channel,source,received_at,correlation_id,dedupe_key)
      VALUES (?,?,?,?,?,?,?)`).run(eventId, 'caso.received', 'ml', 'mercadolibre', t, `corr-${eventId}`, `dedupe-${eventId}`);
    db.prepare(`INSERT INTO inbox_items (event_id,channel,resource_id,pack_id,title,status,version,created_at,updated_at,assigned_user_id)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(eventId, 'ml', resourceId, packId, 'Caso', 'unread', 1, t, t, assignedUserId);
  };

  beforeEach(async () => {
    if (fs.existsSync(DB)) fs.unlinkSync(DB);
    db = openDb(DB);
    ensureTables(db);
    mlFetch.mockReset();
    const t = new Date().toISOString();
    db.prepare('INSERT INTO users (username,pass_hash,is_admin,activo,creado_en,actualizado_en) VALUES (?,?,?,?,?,?)')
      .run('accion-user', hashPassword('correcta123'), 0, 1, t, t);
    db.prepare("INSERT INTO user_permisos (user_id,herramienta,nivel) VALUES (1,'notificaciones-ml','write')").run();
    db.prepare('INSERT INTO users (username,pass_hash,is_admin,activo,creado_en,actualizado_en) VALUES (?,?,?,?,?,?)')
      .run('otro-user', hashPassword('correcta123'), 0, 1, t, t);

    app = express();
    app.use(express.json());
    const authMiddleware = [mobileAuthMiddleware(db, SECRET), mobileRequirePermission('notificaciones-ml', 'write')];
    app.use('/api/v1/auth', mobileAuthRouter(db, SECRET));
    app.use('/api/v1/inbox-acciones', mobileInboxAccionesRouter(db, authMiddleware, MLCFG));
    const login = await request(app).post('/api/v1/auth/login').send({
      username: 'accion-user', password: 'correcta123', platform: 'ios', push_token: 'accion-device',
    });
    auth = { Authorization: `Bearer ${login.body.access_token}` };
  });

  afterEach(() => { db.close(); if (fs.existsSync(DB)) fs.unlinkSync(DB); });

  it('rechaza sin Idempotency-Key con 422', async () => {
    const r = await request(app).post('/api/v1/inbox-acciones/questions/1/reply').set(auth).send({ text: 'hola' });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('idempotency_key_requerida');
    expect(mlFetch).not.toHaveBeenCalled();
  });

  it('exige autenticación', async () => {
    const r = await request(app).post('/api/v1/inbox-acciones/questions/1/reply')
      .set('Idempotency-Key', 'k-1').send({ text: 'hola' });
    expect(r.status).toBe(401);
  });

  it('responde una pregunta y traduce el resultado a 200', async () => {
    seedCaso({ resourceId: 'question:7001' });
    mlFetch
      .mockResolvedValueOnce({ status: 200, data: { status: 'UNANSWERED' } })
      .mockResolvedValueOnce({ status: 200, data: {} })
      .mockResolvedValueOnce({ status: 200, data: { status: 'ANSWERED' } });

    const r = await request(app).post('/api/v1/inbox-acciones/questions/7001/reply')
      .set(auth).set('Idempotency-Key', 'k-2').send({ text: 'Sí, tenemos stock' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ question_id: '7001', external_status: 'ANSWERED' });
  });

  it('traduce un AccionError de negocio (409) sin filtrar detalles internos', async () => {
    seedCaso({ resourceId: 'question:7002' });
    mlFetch.mockResolvedValueOnce({ status: 200, data: { status: 'ANSWERED' } });

    const r = await request(app).post('/api/v1/inbox-acciones/questions/7002/reply')
      .set(auth).set('Idempotency-Key', 'k-3').send({ text: 'hola' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('pregunta_no_abierta');
  });

  it('una acción económica de reclamo se rechaza con 422 sin llamar a ML', async () => {
    const r = await request(app).post('/api/v1/inbox-acciones/claims/CLM-9/actions/refund')
      .set(auth).set('Idempotency-Key', 'k-4').send({ text: 'hola' });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('accion_economica');
    expect(mlFetch).not.toHaveBeenCalled();
  });

  it('un caso inexistente (o de otra persona) responde 404 sin llamar a ML', async () => {
    seedCaso({ resourceId: 'question:7004', assignedUserId: 2 });
    const r = await request(app).post('/api/v1/inbox-acciones/questions/7004/reply')
      .set(auth).set('Idempotency-Key', 'k-6').send({ text: 'hola' });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('no_encontrado');
    expect(mlFetch).not.toHaveBeenCalled();
  });

  it('un error inesperado no filtra el mensaje interno al cliente', async () => {
    seedCaso({ resourceId: 'question:7003' });
    mlFetch.mockRejectedValueOnce(new Error('boom interno con detalle sensible'));

    const r = await request(app).post('/api/v1/inbox-acciones/questions/7003/reply')
      .set(auth).set('Idempotency-Key', 'k-5').send({ text: 'hola' });
    expect(r.status).toBe(500);
    expect(r.body.error.code).toBe('error_interno');
    expect(JSON.stringify(r.body)).not.toContain('boom interno');
  });
});
