import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import { openDb } from '../db/index.js';
import { hashPassword, mobileAuthMiddleware, mobileRequirePermission } from '../lib/auth.js';
import { mobileAuthRouter } from '../routes/mobileAuth.js';
import { inboxClaimsRouter } from '../routes/inboxClaims.js';

const DB = './test/tmp-inbox-claims.sqlite';
const SECRET = 'test-mobile-jwt-secret-which-is-long-enough-123';

describe('API móvil de inbox Claims', () => {
  let db, app, auth;
  beforeEach(async () => {
    db = openDb(DB);
    const t = new Date().toISOString();
    db.prepare('INSERT INTO users (username,pass_hash,is_admin,activo,creado_en,actualizado_en) VALUES (?,?,?,?,?,?)')
      .run('inbox-user', hashPassword('correcta123'), 0, 1, t, t);
    db.prepare("INSERT INTO user_permisos (user_id,herramienta,nivel) VALUES (1,'notificaciones-ml','read')").run();
    db.prepare(`INSERT INTO integration_events (event_id,event_type,channel,source,received_at,correlation_id,dedupe_key)
      VALUES ('evt-inbox','claim.received','ml','mercadolibre',?,?,?)`).run(t, 'corr-inbox', `dedupe-${t}`);
    db.prepare(`INSERT INTO inbox_items (event_id,channel,resource_id,title,preview,status,version,created_at,updated_at)
      VALUES ('evt-inbox','ml','c-1','Reclamo','Detalle','unread',1,?,?)`).run(t, t);
    app = express(); app.use(express.json());
    const authMiddleware = [mobileAuthMiddleware(db, SECRET), mobileRequirePermission('notificaciones-ml')];
    app.use('/api/v1/auth', mobileAuthRouter(db, SECRET));
    app.use('/api/v1/inbox', inboxClaimsRouter(db, authMiddleware));
    const login = await request(app).post('/api/v1/auth/login').send({
      username: 'inbox-user', password: 'correcta123', platform: 'android', push_token: 'inbox-device',
    });
    auth = { Authorization: `Bearer ${login.body.access_token}` };
  });
  afterEach(() => { db.close(); if (fs.existsSync(DB)) fs.unlinkSync(DB); });

  it('rechaza acceso sin bearer y permite listar/marcar leído', async () => {
    expect((await request(app).get('/api/v1/inbox')).status).toBe(401);
    const list = await request(app).get('/api/v1/inbox').set(auth);
    expect(list.status).toBe(200); expect(list.body.items[0].status).toBe('unread');
    const read = await request(app).post('/api/v1/inbox/1/read').set(auth);
    expect(read.status).toBe(200); expect(read.body.status).toBe('read');
  });

  it('documenta el detalle unificado y sus errores semánticos en OpenAPI', () => {
    const contract = fs.readFileSync('./openapi/mobile-v1.yaml', 'utf8');
    expect(contract).toContain('/inbox/{id}/detail:');
    expect(contract).toContain('InboxDetail:');
    expect(contract).toContain("'401': { $ref: '#/components/responses/Unauthorized' }");
    expect(contract).toContain("'403': { $ref: '#/components/responses/Forbidden' }");
    expect(contract).toContain("'422': { $ref: '#/components/responses/UnprocessableEntity' }");
  });

  it('migra el contexto externo durable de inbox de forma aditiva', () => {
    const columns = db.prepare('PRAGMA table_info(inbox_items)').all().map((column) => column.name);
    expect(columns).toEqual(expect.arrayContaining([
      'external_type', 'question_id', 'pack_id', 'order_id', 'claim_id', 'item_id', 'last_synced_at', 'external_status',
    ]));
  });

  it('expone el detalle seguro y fresco de una pregunta sólo al usuario autorizado', async () => {
    const syncedAt = '2026-09-07T12:00:00.000Z';
    db.prepare("UPDATE inbox_items SET resource_id='question:123', kind='pregunta', question_id='123', item_id='MLA123', external_type='question', external_status='UNANSWERED', last_synced_at=?, title='Pregunta ML · MLA123', preview='¿Tiene stock?', updated_at=? WHERE inbox_id=1").run(syncedAt, syncedAt);

    const detail = await request(app).get('/api/v1/inbox/1/detail').set(auth);

    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      id: '1', kind: 'pregunta', external_id: '123', external_status: 'UNANSWERED',
      last_synced_at: syncedAt,
      item: { item_id: 'MLA123', name: 'MLA123', photo_url: null },
      context: { question: '¿Tiene stock?' },
      available_actions: ['reply', 'mark_read'],
    });
    expect(JSON.stringify(detail.body)).not.toMatch(/token|authorization|buyer|customer/i);
  });

  it('resuelve con versión y rechaza una versión obsoleta', async () => {
    const ok = await request(app).post('/api/v1/inbox/1/resolve').set(auth).send({ version: 1 });
    expect(ok.status).toBe(200); expect(ok.body.status).toBe('resolved');
    const stale = await request(app).post('/api/v1/inbox/1/resolve').set(auth).send({ version: 1 });
    expect(stale.status).toBe(409); expect(stale.body.error.code).toBe('version_conflicto');
  });

  it('permite tomar el ítem y crea una notificación lógica idempotente', async () => {
    const claimed = await request(app).post('/api/v1/inbox/1/claim').set(auth);
    expect(claimed.status).toBe(200);
    expect(claimed.body.status).toBe('read');
    expect(db.prepare('SELECT assigned_user_id FROM inbox_items WHERE inbox_id=1').get().assigned_user_id).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM user_notifications WHERE inbox_id=1').get().n).toBe(1);
    const again = await request(app).post('/api/v1/inbox/1/claim').set(auth);
    expect(again.status).toBe(200);
    expect(db.prepare('SELECT COUNT(*) AS n FROM user_notifications WHERE inbox_id=1').get().n).toBe(1);
  });

  it('rechaza a un usuario autenticado sin permiso Claims', async () => {
    const other = db.prepare('INSERT INTO users (username,pass_hash,is_admin,activo,creado_en,actualizado_en) VALUES (?,?,?,?,?,?)')
      .run('sin-permiso', hashPassword('correcta123'), 0, 1, new Date().toISOString(), new Date().toISOString());
    const login = await request(app).post('/api/v1/auth/login').send({
      username: 'sin-permiso', password: 'correcta123', platform: 'android', push_token: 'sin-permiso-device',
    });
    expect(other.lastInsertRowid).toBe(2);
    const denied = await request(app).get('/api/v1/inbox').set('Authorization', `Bearer ${login.body.access_token}`);
    expect(denied.status).toBe(403); expect(denied.body.error.code).toBe('sin_permiso');
  });
});
