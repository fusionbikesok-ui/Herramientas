import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import { openDb } from '../db/index.js';
import { hashPassword, mobileAuthMiddleware, mobileRequirePermission } from '../lib/auth.js';
import { mobileAuthRouter } from '../routes/mobileAuth.js';
import { inboxClaimsRouter } from '../routes/inboxClaims.js';

const DB = './test/tmp-inbox-ciclo-vida.sqlite';
const SECRET = 'test-mobile-jwt-secret-which-is-long-enough-123';

/**
 * Ciclo reconocer/escalar/reasignar de la bandeja (E6, §14). Reconocer NO resuelve: frena la
 * repetición y deja constancia de quién mira el caso, pero el status sigue abierto.
 */
describe('POST /api/v1/inbox/:id/acknowledge y /:id/assign', () => {
  let db, app, authUno, authDos;

  const nuevoCaso = ({ eventId, extra = {} }) => {
    const t = new Date().toISOString();
    db.prepare(`INSERT INTO integration_events (event_id,event_type,channel,source,received_at,correlation_id,dedupe_key)
      VALUES (?,?,?,?,?,?,?)`).run(eventId, 'claim.received', 'ml', 'mercadolibre', t, `corr-${eventId}`, `dedupe-${eventId}`);
    const columnas = ['event_id', 'channel', 'title', 'status', 'version', 'created_at', 'updated_at'];
    const valores = [eventId, 'ml', 'Caso', 'unread', 1, t, t];
    for (const [clave, valor] of Object.entries(extra)) { columnas.push(clave); valores.push(valor); }
    const marcas = columnas.map(() => '?').join(',');
    const info = db.prepare(`INSERT INTO inbox_items (${columnas.join(',')}) VALUES (${marcas})`).run(...valores);
    return Number(info.lastInsertRowid);
  };

  beforeEach(async () => {
    if (fs.existsSync(DB)) fs.unlinkSync(DB);
    db = openDb(DB);
    const t = new Date().toISOString();
    db.prepare('INSERT INTO users (username,pass_hash,is_admin,activo,creado_en,actualizado_en) VALUES (?,?,?,?,?,?)')
      .run('ciclo-uno', hashPassword('correcta123'), 0, 1, t, t);
    db.prepare("INSERT INTO user_permisos (user_id,herramienta,nivel) VALUES (1,'notificaciones-ml','write')").run();
    db.prepare('INSERT INTO users (username,pass_hash,is_admin,activo,creado_en,actualizado_en) VALUES (?,?,?,?,?,?)')
      .run('ciclo-dos', hashPassword('correcta123'), 0, 1, t, t);
    db.prepare("INSERT INTO user_permisos (user_id,herramienta,nivel) VALUES (2,'notificaciones-ml','write')").run();

    app = express();
    app.use(express.json());
    const authMiddleware = [mobileAuthMiddleware(db, SECRET), mobileRequirePermission('notificaciones-ml')];
    app.use('/api/v1/auth', mobileAuthRouter(db, SECRET));
    app.use('/api/v1/inbox', inboxClaimsRouter(db, authMiddleware));
    const loginUno = await request(app).post('/api/v1/auth/login').send({
      username: 'ciclo-uno', password: 'correcta123', platform: 'ios', push_token: 'ciclo-device-1',
    });
    authUno = { Authorization: `Bearer ${loginUno.body.access_token}` };
    const loginDos = await request(app).post('/api/v1/auth/login').send({
      username: 'ciclo-dos', password: 'correcta123', platform: 'android', push_token: 'ciclo-device-2',
    });
    authDos = { Authorization: `Bearer ${loginDos.body.access_token}` };
  });

  afterEach(() => { db.close(); if (fs.existsSync(DB)) fs.unlinkSync(DB); });

  describe('acknowledge', () => {
    it('reconoce un caso propio: 200, frena repetición y el status sigue abierto', async () => {
      const id = nuevoCaso({ eventId: 'evt-ack-1', extra: { next_repeat_at: new Date().toISOString() } });
      const r = await request(app).post(`/api/v1/inbox/${id}/acknowledge`).set(authUno);
      expect(r.status).toBe(200);
      expect(r.body.ya_reconocido).toBe(false);
      expect(r.body.status).toBe('unread');
      expect(r.body.acknowledged_by).toBe('1');
    });

    it('doble acknowledge devuelve 200 con ya_reconocido:true', async () => {
      const id = nuevoCaso({ eventId: 'evt-ack-2' });
      await request(app).post(`/api/v1/inbox/${id}/acknowledge`).set(authUno);
      const r = await request(app).post(`/api/v1/inbox/${id}/acknowledge`).set(authUno);
      expect(r.status).toBe(200);
      expect(r.body.ya_reconocido).toBe(true);
    });

    it('un caso inexistente devuelve 404', async () => {
      const r = await request(app).post('/api/v1/inbox/99999/acknowledge').set(authUno);
      expect(r.status).toBe(404);
    });

    // Un caso asignado a otra persona no debería poder reconocerse desde afuera: el mismo
    // criterio de ownership que el resto de las rutas de este router (read/claim/resolve).
    it('un caso asignado a otra persona responde 404, no 200', async () => {
      const id = nuevoCaso({ eventId: 'evt-ack-3', extra: { assigned_user_id: 2 } });
      const r = await request(app).post(`/api/v1/inbox/${id}/acknowledge`).set(authUno);
      expect(r.status).toBe(404);
    });
  });

  describe('assign', () => {
    it('reasigna con expected_version correcto', async () => {
      const id = nuevoCaso({ eventId: 'evt-asg-1' });
      const r = await request(app).post(`/api/v1/inbox/${id}/assign`).set(authUno)
        .send({ to_user_id: 2, expected_version: 1 });
      expect(r.status).toBe(200);
      expect(r.body.assigned_user_id).toBe('2');
    });

    it('expected_version vieja devuelve 409', async () => {
      const id = nuevoCaso({ eventId: 'evt-asg-2' });
      // Version actual es 1; se pide vieja=99 a propósito.
      const r = await request(app).post(`/api/v1/inbox/${id}/assign`).set(authUno)
        .send({ to_user_id: 2, expected_version: 99 });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('version_conflicto');
    });

    it('conserva la historia de la reasignación en inbox_assignments', async () => {
      const id = nuevoCaso({ eventId: 'evt-asg-3', extra: { assigned_user_id: 1 } });
      await request(app).post(`/api/v1/inbox/${id}/assign`).set(authUno)
        .send({ to_user_id: 2, motivo: 'vacaciones' });
      const historia = db.prepare('SELECT * FROM inbox_assignments WHERE inbox_id = ?').get(id);
      expect(historia).toMatchObject({ from_user_id: 1, to_user_id: 2, actor_user_id: 1, motivo: 'vacaciones' });
    });

    it('un caso inexistente devuelve 404', async () => {
      const r = await request(app).post('/api/v1/inbox/99999/assign').set(authUno).send({ to_user_id: 2 });
      expect(r.status).toBe(404);
    });
  });
});
