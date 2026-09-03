import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import express from 'express';
import request from 'supertest';
import { openDb } from '../db/index.js';
import { hashPassword, mobileAuthMiddleware } from '../lib/auth.js';
import { mobileAuthRouter } from '../routes/mobileAuth.js';
import { devicesRouter } from '../routes/devices.js';

const TEST_DB = './test/tmp-mobile-device.sqlite';
const SECRET = 'test-mobile-jwt-secret-which-is-long-enough-123';

function app(db) {
  const a = express(); a.use(express.json());
  const auth = mobileAuthMiddleware(db, SECRET);
  a.use('/api/v1/auth', mobileAuthRouter(db, SECRET));
  a.use('/api/v1/devices', devicesRouter(db, auth));
  return a;
}

describe('vínculo móvil dispositivo-refresh', () => {
  afterEach(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('vincula el refresh vigente y lo revoca al eliminar el dispositivo', async () => {
    const db = openDb(TEST_DB); const now = new Date().toISOString();
    db.prepare(`INSERT INTO users (username, pass_hash, is_admin, activo, creado_en, actualizado_en)
      VALUES (?, ?, 0, 1, ?, ?)`).run('device-user', hashPassword('correcta123'), now, now);
    const a = app(db);
    const login = await request(a).post('/api/v1/auth/login').send({
      username: 'device-user', password: 'correcta123', platform: 'android', push_token: 'push-device-1',
    });
    const auth = { Authorization: `Bearer ${login.body.access_token}` };
    const row = db.prepare('SELECT device_id FROM mobile_refresh_tokens').get();
    expect(String(row.device_id)).toBe(login.body.device_id);
    expect((await request(a).delete(`/api/v1/devices/${login.body.device_id}`).set(auth)).status).toBe(200);
    expect(db.prepare('SELECT revocado_en FROM mobile_refresh_tokens WHERE device_id = ?').get(row.device_id).revocado_en).toBeTruthy();
    expect((await request(a).post('/api/v1/auth/refresh').send({ refresh_token: login.body.refresh_token })).status).toBe(401);
    db.close();
  });

  it('registra otro dispositivo con el access token ligado a una sesión vigente', async () => {
    const db = openDb(TEST_DB); const now = new Date().toISOString();
    db.prepare(`INSERT INTO users (username, pass_hash, is_admin, activo, creado_en, actualizado_en)
      VALUES (?, ?, 0, 1, ?, ?)`).run('device-user-2', hashPassword('correcta123'), now, now);
    const a = app(db); const login = await request(a).post('/api/v1/auth/login').send({
      username: 'device-user-2', password: 'correcta123', platform: 'ios', push_token: 'push-device-login',
    });
    const res = await request(a).post('/api/v1/devices').set('Authorization', `Bearer ${login.body.access_token}`).send({ platform: 'ios', push_token: 'push-device-2' });
    expect(res.status).toBe(200); expect(res.body.id).not.toBe(login.body.device_id); db.close();
  });
});
