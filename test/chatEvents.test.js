import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/index.js';
import { chatEventsRouter } from '../routes/chatEvents.js';

const NOW = Date.parse('2026-09-07T00:00:00.000Z');
const ENV = { FUSION_CHAT_EVENTS_API_KEY: 'shared-key', FUSION_CHAT_EVENTS_SECRET: 'shared-secret' };

function fixture() {
  const db = openDb(':memory:');
  const at = new Date(NOW).toISOString();
  db.prepare(`INSERT INTO users (username,pass_hash,is_admin,activo,creado_en,actualizado_en)
    VALUES ('operator','x',1,1,?,?)`).run(at, at);
  db.prepare(`INSERT INTO device_tokens (user_id,token,plataforma,creado_en,actualizado_en)
    VALUES (1,'device-token','ios',?,?)`).run(at, at);
  const app = express();
  app.use(chatEventsRouter(db, { env: ENV, now: () => NOW }));
  return { app, db };
}

function event(overrides = {}) {
  return {
    event_id: '550e8400-e29b-41d4-a716-446655440000', event_type: 'message_created',
    occurred_at: '2026-09-07T00:00:00+00:00', site_url: 'https://fusionbikes.com.ar/',
    conversation: { id: 123, token: 'abc123', channel: 'web', customer_name: 'Ana' },
    message: { text: 'Necesito hablar con una persona', sender: 'customer', status: 'sent' },
    ...overrides,
  };
}

function signed(app, payload, { timestamp = String(NOW / 1000), key = ENV.FUSION_CHAT_EVENTS_API_KEY, secret = ENV.FUSION_CHAT_EVENTS_SECRET } = {}) {
  const raw = JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');
  return request(app).post('/v1/events').set('content-type', 'application/json')
    .set('x-fusion-api-key', key).set('x-fusion-timestamp', timestamp)
    .set('x-fusion-signature', signature).send(raw);
}

describe('ingesta firmada de eventos del chat WordPress', () => {
  it('proyecta una sola vez inbox, notificación y delivery, priorizando handoff', async () => {
    const { app, db } = fixture();
    const payload = event({ handoff: { requested: true, reason: 'lo pidió', priority: 'urgent' } });
    const first = await signed(app, payload);
    const duplicate = await signed(app, payload);
    expect(first.status).toBe(200);
    expect(duplicate.body).toMatchObject({ ok: true, duplicate: true, inbox_id: first.body.inbox_id });
    expect(db.prepare('SELECT COUNT(*) n FROM inbox_items').get().n).toBe(1);
    expect(db.prepare('SELECT channel,resource_id,title,preview,status,kind,priority,version FROM inbox_items').get())
      .toEqual({ channel: 'web', resource_id: 'abc123', title: 'Ana', preview: 'Necesito hablar con una persona', status: 'unread', kind: 'mensaje', priority: 'urgent', version: 1 });
    expect(db.prepare('SELECT status,deep_link FROM user_notifications').get())
      .toEqual({ status: 'pending', deep_link: `/inbox/${first.body.inbox_id}` });
    expect(db.prepare('SELECT status FROM notification_deliveries').get().status).toBe('pending');
    db.close();
  });

  it.each([
    ['clave incorrecta', { key: 'wrong' }],
    ['firma incorrecta', { secret: 'wrong' }],
    ['timestamp vencido', { timestamp: String(NOW / 1000 - 301) }],
  ])('rechaza %s sin persistir', async (_label, auth) => {
    const { app, db } = fixture();
    expect((await signed(app, event(), auth)).status).toBe(401);
    expect(db.prepare('SELECT COUNT(*) n FROM integration_events').get().n).toBe(0);
    db.close();
  });

  it('responde 503 cuando faltan secretos', async () => {
    const db = openDb(':memory:'); const app = express();
    app.use(chatEventsRouter(db, { env: {}, now: () => NOW }));
    expect((await request(app).post('/v1/events').set('content-type', 'application/json').send('{}')).status).toBe(503);
    db.close();
  });
});
