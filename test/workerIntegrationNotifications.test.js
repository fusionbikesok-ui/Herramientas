import { describe, it, expect } from 'vitest';
import { openDb } from '../db/index.js';
import { procesarEntregasPush } from '../lib/workerIntegrationNotifications.js';

function fixture() {
  const db = openDb(':memory:'); const t = new Date().toISOString();
  db.prepare('INSERT INTO users (username,pass_hash,is_admin,activo,creado_en,actualizado_en) VALUES (?,?,?,?,?,?)').run('u', 'x', 0, 1, t, t);
  db.prepare('INSERT INTO device_tokens (user_id,token,plataforma,creado_en,actualizado_en) VALUES (?,?,?,?,?)').run(1, 'tok', 'web', t, t);
  db.prepare('INSERT INTO user_notifications (user_id,title,body,deep_link,created_at) VALUES (?,?,?,?,?)').run(1, 'Reclamo', 'Detalle', '/inbox/1', t);
  db.prepare('INSERT INTO notification_deliveries (notification_id,device_id,provider,created_at,updated_at) VALUES (1,1,?,?,?)').run('push', t, t);
  return db;
}

describe('worker durable de entregas push', () => {
  it('con feature desactivada conserva delivery pendiente y no llama al proveedor', async () => {
    const db = fixture(); const send = async () => { throw new Error('no debe enviarse'); };
    const previous = process.env.PUSH_REAL_ENABLED;
    process.env.PUSH_REAL_ENABLED = 'false';
    await procesarEntregasPush(db, { send });
    expect(db.prepare('SELECT status,last_error_code FROM notification_deliveries').get())
      .toEqual({ status: 'pending', last_error_code: null });
    process.env.PUSH_REAL_ENABLED = previous;
    db.close();
  });

  it('envía y marca delivery/notificación como sent', async () => {
    process.env.PUSH_REAL_ENABLED = 'true';
    const db = fixture(); const calls = [];
    const result = await procesarEntregasPush(db, { send: async (...args) => { calls.push(args); return { ok: true, providerMessageId: 'm1' }; } });
    expect(result.processed).toBe(1); expect(calls[0][0]).toBe('tok');
    expect(db.prepare('SELECT status,provider_message_id FROM notification_deliveries').get()).toEqual({ status: 'sent', provider_message_id: 'm1' });
    expect(db.prepare('SELECT status FROM user_notifications').get().status).toBe('sent'); db.close();
  });

  it('reintenta con backoff y termina en failed sin lanzar', async () => {
    process.env.PUSH_REAL_ENABLED = 'true';
    const db = fixture();
    for (let i = 0; i < 5; i++) {
      await procesarEntregasPush(db, { send: async () => ({ ok: false, error: 'down' }) });
      db.prepare("UPDATE notification_deliveries SET last_attempt_at='2000-01-01T00:00:00.000Z'").run();
    }
    const row = db.prepare('SELECT status,attempts,last_error_code FROM notification_deliveries').get();
    expect(row).toMatchObject({ status: 'failed', attempts: 5, last_error_code: 'push.send_failed' });
    expect(db.prepare('SELECT status FROM user_notifications').get().status).toBe('failed'); db.close();
  });
});
