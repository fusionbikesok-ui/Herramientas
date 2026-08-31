import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import { openDb } from '../db/index.js';
import { hashPassword, mobileAuthMiddleware, mobileRequirePermission } from '../lib/auth.js';
import { mobileAuthRouter } from '../routes/mobileAuth.js';
import { operacionesMobileRouter } from '../routes/operacionesMobile.js';

const DB = './test/tmp-operaciones-mobile.sqlite';
const SECRET = 'test-mobile-jwt-secret-which-is-long-enough-123';

describe('API móvil de operaciones', () => {
  let db, app, auth;
  beforeEach(async () => {
    db = openDb(DB);
    const t = new Date().toISOString();
    db.prepare('INSERT INTO users (username,pass_hash,is_admin,activo,creado_en,actualizado_en) VALUES (?,?,?,?,?,?)')
      .run('ops-user', hashPassword('correcta123'), 0, 1, t, t);
    db.prepare("INSERT INTO user_permisos (user_id,herramienta,nivel) VALUES (1,'notificaciones-ml','read')").run();
    db.prepare(`INSERT INTO integration_events (event_id,event_type,channel,source,received_at,correlation_id,dedupe_key)
      VALUES ('evt-ops','claim.received','ml','mercadolibre',?,?,?)`).run(t, 'corr-ops', `dedupe-ops-${t}`);
    db.prepare(`INSERT INTO conversations (channel,external_thread_id,subject,created_at,updated_at)
      VALUES ('ml','thread-ops','Reclamo',?,?)`).run(t, t);
    db.prepare(`INSERT INTO conversation_messages (conversation_id,event_id,direction,body,created_at)
      VALUES (1,'evt-ops','inbound','Detalle',?)`).run(t);
    db.prepare(`INSERT INTO inbox_items (event_id,channel,resource_id,conversation_id,title,preview,status,created_at,updated_at)
      VALUES ('evt-ops','ml','claim-ops',1,'Reclamo','Detalle','unread',?,?)`).run(t, t);
    db.prepare(`INSERT INTO user_notifications (event_id,inbox_id,user_id,title,body,deep_link,created_at)
      VALUES ('evt-ops',1,1,'Aviso','Detalle','/inbox/1',?)`).run(t);
    app = express(); app.use(express.json());
    const authMiddleware = [mobileAuthMiddleware(db, SECRET), mobileRequirePermission('notificaciones-ml')];
    app.use('/api/v1/auth', mobileAuthRouter(db, SECRET));
    app.use('/api/v1', operacionesMobileRouter(db, authMiddleware));
    const login = await request(app).post('/api/v1/auth/login').send({
      username: 'ops-user', password: 'correcta123', platform: 'android', push_token: 'ops-device',
    });
    auth = { Authorization: `Bearer ${login.body.access_token}` };
  });
  afterEach(() => { db.close(); if (fs.existsSync(DB)) fs.unlinkSync(DB); });

  it('protege y expone conversaciones, notificaciones y operaciones', async () => {
    expect((await request(app).get('/api/v1/integration-notifications')).status).toBe(401);
    const conversation = await request(app).get('/api/v1/conversations/1').set(auth);
    expect(conversation.status).toBe(200); expect(conversation.body.messages).toHaveLength(1);
    const read = await request(app).post('/api/v1/conversations/1/read').set(auth);
    expect(read.status).toBe(200); expect(read.body.updated).toBe(1);
    const notifications = await request(app).get('/api/v1/integration-notifications').set(auth);
    expect(notifications.status).toBe(200); expect(notifications.body.items).toHaveLength(1);
    const operation = await request(app).get('/api/v1/operations/corr-ops').set(auth);
    expect(operation.status).toBe(200); expect(operation.body.history).toBeInstanceOf(Array);
  });
});
