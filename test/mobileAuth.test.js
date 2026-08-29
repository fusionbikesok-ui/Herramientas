import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import express from 'express';
import request from 'supertest';
import { openDb } from '../db/index.js';
import { hashPassword, mobileAuthMiddleware, _resetIntentosLoginParaTest } from '../lib/auth.js';
import { mobileAuthRouter } from '../routes/mobileAuth.js';

const TEST_DB = './test/tmp-mobile-auth.sqlite';
const SECRET = 'mobile-auth-test-secret-at-least-32-chars';

function buildApp(db) {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/auth', mobileAuthRouter(db, SECRET));
  app.get('/api/v1/me', mobileAuthMiddleware(db, SECRET), (req, res) => res.json({ id: req.user.id }));
  return app;
}

function seedUser(db, username = 'mobile') {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO users (username, pass_hash, is_admin, activo, creado_en, actualizado_en)
    VALUES (?, ?, 0, 1, ?, ?)`).run(username, hashPassword('correcta123'), now, now);
}

afterEach(() => {
  _resetIntentosLoginParaTest();
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
});

describe('API móvil — sesiones, asociación y rate limit', () => {
  it('no emite refresh huérfano: login exige device_id o alta segura del dispositivo', async () => {
    const db = openDb(TEST_DB);
    seedUser(db);
    const res = await request(buildApp(db)).post('/api/v1/auth/login')
      .send({ username: 'mobile', password: 'correcta123' });
    expect(res.status).toBe(422);
    expect(db.prepare('SELECT COUNT(*) AS n FROM mobile_refresh_tokens').get().n).toBe(0);
    db.close();
  });

  it.each([
    ['platform', { platform: 'android' }],
    ['push_token', { push_token: 'token-no-valido' }],
    ['device_name', { device_name: 'iPhone de Juan' }],
    ['todos los campos de alta', { platform: 'android', push_token: 'token-no-valido', device_name: 'iPhone de Juan' }],
  ])('rechaza device_id combinado con %s', async (_campo, camposAlta) => {
    const db = openDb(TEST_DB);
    seedUser(db);
    const res = await request(buildApp(db)).post('/api/v1/auth/login').send({
      username: 'mobile', password: 'correcta123', device_id: '12',
      ...camposAlta,
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toEqual({
      code: 'body_invalido',
      message: 'device_id no puede combinarse con platform, push_token o device_name',
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM device_tokens').get().n).toBe(0);
    db.close();
  });

  it('liga login, refresh y access al mismo dispositivo y no deja escritura parcial', async () => {
    const db = openDb(TEST_DB);
    seedUser(db);
    const app = buildApp(db);
    const login = await request(app).post('/api/v1/auth/login').send({
      username: 'mobile', password: 'correcta123', platform: 'android', push_token: 'token-1',
    });
    expect(login.status).toBe(200);
    expect(login.body.device_id).toBeTruthy();
    const token = db.prepare('SELECT device_id FROM mobile_refresh_tokens').get();
    expect(String(token.device_id)).toBe(login.body.device_id);
    expect((await request(app).get('/api/v1/me').set('Authorization', `Bearer ${login.body.access_token}`)).status)
      .toBe(200);
    const refreshed = await request(app).post('/api/v1/auth/refresh').send({ refresh_token: login.body.refresh_token });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.device_id).toBe(login.body.device_id);

    db.prepare(`CREATE TRIGGER fail_mobile_refresh BEFORE INSERT ON mobile_refresh_tokens
      BEGIN SELECT RAISE(ABORT, 'refresh insert blocked'); END`).run();
    const failed = await request(app).post('/api/v1/auth/login').send({
      username: 'mobile', password: 'correcta123', platform: 'android', push_token: 'token-2',
    });
    expect(failed.status).toBe(500);
    expect(db.prepare("SELECT COUNT(*) AS n FROM device_tokens WHERE token = 'token-2'").get().n).toBe(0);
    db.close();
  });

  it('rechaza con 401 un refresh cuyo dispositivo ya no existe', async () => {
    const db = openDb(TEST_DB);
    db.pragma('foreign_keys = OFF');
    seedUser(db);
    db.prepare(`INSERT INTO mobile_refresh_tokens
      (token_hash, user_id, device_id, expires_at, creado_en)
      VALUES ('refresh-orphan', 1, 999999, '2099-01-01T00:00:00.000Z', ?)`)
      .run(new Date().toISOString());
    db.pragma('foreign_keys = ON');

    const res = await request(buildApp(db)).post('/api/v1/auth/refresh')
      .send({ refresh_token: 'refresh-orphan' });

    expect(res.status).toBe(401);
    expect(res.body.error).toEqual({
      code: 'refresh_revocado',
      message: 'El refresh_token es inválido, expiró o fue revocado',
    });
    db.close();
  });

  it('devuelve 422 controlado si falta refresh_token', async () => {
    const db = openDb(TEST_DB);
    const res = await request(buildApp(db)).post('/api/v1/auth/refresh').send({});

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('body_invalido');
    db.close();
  });

  it('logout requiere el body documentado y revoca access + refresh efectivamente', async () => {
    const db = openDb(TEST_DB);
    seedUser(db);
    const app = buildApp(db);
    const login = await request(app).post('/api/v1/auth/login').send({
      username: 'mobile', password: 'correcta123', platform: 'ios', push_token: 'token-logout',
    });
    const auth = { Authorization: `Bearer ${login.body.access_token}` };
    expect((await request(app).post('/api/v1/auth/logout').set(auth).send({})).status).toBe(422);
    const logout = await request(app).post('/api/v1/auth/logout').set(auth)
      .send({ refresh_token: login.body.refresh_token });
    expect(logout.status).toBe(200);
    expect((await request(app).get('/api/v1/me').set(auth)).status).toBe(401);
    expect((await request(app).post('/api/v1/auth/refresh').send({ refresh_token: login.body.refresh_token })).status)
      .toBe(401);
    db.close();
  });

  it('aplica rate limit al login móvil por usuario + IP', async () => {
    const db = openDb(TEST_DB);
    seedUser(db, 'mobile-rate-limit');
    const app = buildApp(db);
    const statuses = [];
    for (let i = 0; i < 8; i++) {
      statuses.push((await request(app).post('/api/v1/auth/login').send({
        username: 'mobile-rate-limit', password: 'incorrecta', platform: 'android', push_token: 'token-rate',
      })).status);
    }
    expect(statuses.slice(0, 6)).toEqual([401, 401, 401, 401, 401, 401]);
    expect(statuses.slice(6)).toEqual([429, 429]);
    db.close();
  });

  it('aplica límite agregado por IP sin bloquear antes de 30 fallos entre usuarios', async () => {
    const db = openDb(TEST_DB);
    const app = buildApp(db);
    const statuses = [];
    for (let i = 0; i < 32; i++) {
      statuses.push((await request(app).post('/api/v1/auth/login').send({
        username: `usuario-inexistente-${i}`, password: 'incorrecta', device_id: '1',
      })).status);
    }
    expect(statuses.slice(0, 31).every((status) => status === 401)).toBe(true);
    expect(statuses[31]).toBe(429);
    db.close();
  });
});
