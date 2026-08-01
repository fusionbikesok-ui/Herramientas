import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import { openDb } from '../db/index.js';
import { authRouter } from '../routes/auth.js';
import { hashPassword } from '../lib/auth.js';

const TEST_DB = './test/tmp-auth-route.sqlite';

function buildApp(db) {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 's', resave: false, saveUninitialized: false }));
  app.use('/api/auth', authRouter(db));
  return app;
}

function seedUser(db, { username = 'tester', password = 'test1234' } = {}) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO users (username, pass_hash, is_admin, activo, creado_en, actualizado_en)
              VALUES (?, ?, 1, 1, ?, ?)`).run(username, hashPassword(password), now, now);
}

describe('routes/auth — cabeceras y rate limiting', () => {
  afterEach(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('GET /api/auth/me trae Cache-Control: no-store (evita "atrás" tras logout mostrando sesión vieja)', async () => {
    const db = openDb(TEST_DB);
    const app = buildApp(db);
    const res = await request(app).get('/api/auth/me');
    expect(res.headers['cache-control']).toContain('no-store');
    db.close();
  });

  it('POST /api/auth/login también trae Cache-Control: no-store', async () => {
    const db = openDb(TEST_DB);
    const app = buildApp(db);
    const res = await request(app).post('/api/auth/login').send({ username: 'x', password: 'y' });
    expect(res.headers['cache-control']).toContain('no-store');
    db.close();
  });

  it('tras varios intentos fallidos, el login legítimo posterior sigue funcionando (no bloquea de por vida)', async () => {
    const db = openDb(TEST_DB);
    seedUser(db, { username: 'rl-ok', password: 'correcta123' });
    const app = buildApp(db);
    const agent = request.agent(app);
    for (let i = 0; i < 3; i++) {
      await agent.post('/api/auth/login').send({ username: 'rl-ok', password: 'mala' });
    }
    const res = await agent.post('/api/auth/login').send({ username: 'rl-ok', password: 'correcta123' });
    expect(res.status).toBe(200);
    db.close();
  });

  it('8 intentos fallidos consecutivos → a partir del 6to responde 429 (backoff), no 401 inmediato', async () => {
    const db = openDb(TEST_DB);
    seedUser(db, { username: 'rl-bloqueo', password: 'correcta123' });
    const app = buildApp(db);
    const agent = request.agent(app);
    const resultados = [];
    for (let i = 0; i < 8; i++) {
      const r = await agent.post('/api/auth/login').send({ username: 'rl-bloqueo', password: 'mala' });
      resultados.push(r.status);
    }
    // Las primeras 6 son intentos evaluados (401 normal, la 6ta dispara el bloqueo);
    // de la 7ma en adelante, ya bloqueado (429) sin ni siquiera tocar la contraseña.
    expect(resultados.slice(0, 6)).toEqual([401, 401, 401, 401, 401, 401]);
    expect(resultados.slice(6)).toEqual([429, 429]);
    db.close();
  });

  it('el bloqueo es por usuario+IP: otro usuario desde el mismo cliente no se ve afectado', async () => {
    const db = openDb(TEST_DB);
    seedUser(db, { username: 'rl-victima', password: 'correcta123' });
    seedUser(db, { username: 'rl-atacado', password: 'otra123456' });
    const app = buildApp(db);
    const agent = request.agent(app);
    for (let i = 0; i < 8; i++) {
      await agent.post('/api/auth/login').send({ username: 'rl-victima', password: 'mala' });
    }
    const res = await agent.post('/api/auth/login').send({ username: 'rl-atacado', password: 'otra123456' });
    expect(res.status).toBe(200);
    db.close();
  });
});
