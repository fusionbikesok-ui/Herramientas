import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import express from 'express';
import request from 'supertest';
import { openDb } from '../db/index.js';
import { hashPassword } from '../lib/auth.js';
import { mobileAuthRouter } from '../routes/mobileAuth.js';

const TEST_DB = './test/tmp-mobile-auth.sqlite';
process.env.MOBILE_JWT_SECRET = 'test-mobile-jwt-secret-which-is-long-enough-123';

function seed(db) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO users (username, pass_hash, is_admin, activo, creado_en, actualizado_en)
    VALUES (?, ?, 0, 1, ?, ?)`).run('mobile-user', hashPassword('correcta123'), now, now);
}
function app(db) { const a = express(); a.use(express.json()); a.use('/api/v1/auth', mobileAuthRouter(db)); return a; }

describe('auth móvil JWT', () => {
  afterEach(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('login emite access y refresh, /me acepta bearer y refresh rota el token', async () => {
    const db = openDb(TEST_DB); seed(db); const a = app(db);
    const login = await request(a).post('/api/v1/auth/login').send({ username: 'mobile-user', password: 'correcta123' });
    expect(login.status).toBe(200); expect(login.body.access_token).toBeTruthy(); expect(login.body.refresh_token).toBeTruthy();
    expect((await request(a).get('/api/v1/auth/me').set('Authorization', `Bearer ${login.body.access_token}`)).status).toBe(200);
    const refresh = await request(a).post('/api/v1/auth/refresh').send({ refresh_token: login.body.refresh_token });
    expect(refresh.status).toBe(200); expect(refresh.body.refresh_token).not.toBe(login.body.refresh_token);
    expect((await request(a).post('/api/v1/auth/refresh').send({ refresh_token: login.body.refresh_token })).status).toBe(401);
    db.close();
  });

  it('rechaza credenciales inválidas, bearer ausente y secreto débil', async () => {
    const db = openDb(TEST_DB); seed(db); const a = app(db);
    expect((await request(a).post('/api/v1/auth/login').send({ username: 'mobile-user', password: 'mala' })).status).toBe(401);
    expect((await request(a).get('/api/v1/auth/me')).status).toBe(401);
    const old = process.env.MOBILE_JWT_SECRET; process.env.MOBILE_JWT_SECRET = 'corto';
    expect((await request(a).post('/api/v1/auth/login').send({ username: 'mobile-user', password: 'correcta123' })).status).toBe(500);
    process.env.MOBILE_JWT_SECRET = old; db.close();
  });
});
