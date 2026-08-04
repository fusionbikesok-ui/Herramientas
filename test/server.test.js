import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import request from 'supertest';
import { buildApp } from '../server.js';
import { hashPassword } from '../lib/auth.js';

const TEST_DB = './test/tmp-server.sqlite';
let currentApp;

// La app usa sesión (cookie, /api/auth/login) — no HTTP Basic Auth. Sembrar un
// admin y devolver un agente supertest con la sesión ya iniciada (conserva cookies).
async function loginComoAdmin(app, { username = 'tester', password = 'test1234' } = {}) {
  const now = new Date().toISOString();
  app._db.prepare(`INSERT INTO users (username, pass_hash, is_admin, activo, creado_en, actualizado_en)
              VALUES (?, ?, 1, 1, ?, ?)`)
    .run(username, hashPassword(password), now, now);
  const agent = request.agent(app);
  const login = await agent.post('/api/auth/login').send({ username, password });
  if (login.status !== 200) throw new Error(`login de prueba falló: ${login.status} ${JSON.stringify(login.body)}`);
  return agent;
}

describe('server', () => {
  afterEach(() => {
    if (currentApp && currentApp._db) {
      try { currentApp._db.close(); } catch { /* already closed */ }
      currentApp = undefined;
    }
    try {
      if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    } catch { /* Windows may briefly retain the handle; safe to ignore in cleanup */ }
  });

  it('serves static pages without credentials (auth is on /api only)', async () => {
    const app = buildApp({ dbPath: TEST_DB, sessionSecret: 's', wooCfg: {}, geminiKey: 'k' });
    currentApp = app;
    const stock = await request(app).get('/stock/');
    const etiquetas = await request(app).get('/etiquetas/');
    const inventario = await request(app).get('/inventario/');
    const login = await request(app).get('/login/');
    const matcher = await request(app).get('/matcher/');
    const vendorZxing = await request(app).get('/vendor/zxing.min.js');
    const scannerGate = await request(app).get('/lib/scannerGate.js');
    const scanner = await request(app).get('/lib/scanner.js');
    expect(stock.status).toBe(200);
    expect(etiquetas.status).toBe(200);
    expect(inventario.status).toBe(200);
    expect(login.status).toBe(200);
    expect(matcher.status).toBe(200);
    expect(vendorZxing.status).toBe(200);
    expect(scannerGate.status).toBe(200);
    expect(scanner.status).toBe(200);
  });

  it('redirects the root (/) to /herramientas/home/', async () => {
    const app = buildApp({ dbPath: TEST_DB, sessionSecret: 's', wooCfg: {}, geminiKey: 'k' });
    currentApp = app;
    const res = await request(app).get('/').redirects(0);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/herramientas/home/');
  });

  it('rejects API requests without sesión', async () => {
    const app = buildApp({ dbPath: TEST_DB, sessionSecret: 's', wooCfg: {}, geminiKey: 'k' });
    currentApp = app;
    const res = await request(app).get('/api/woo/catalogo');
    expect(res.status).toBe(401);
  });

  it('mounts the woo, gemini, nuevos-productos, mapeo, csv, matcher and sync API routers', async () => {
    const app = buildApp({ dbPath: TEST_DB, sessionSecret: 's', wooCfg: {}, geminiKey: 'k' });
    currentApp = app;
    const agent = await loginComoAdmin(app);

    const catalogo = await agent.get('/api/woo/catalogo');
    const categorias = await agent.get('/api/nuevos-productos/categorias');
    const mapeo = await agent.get('/api/mapeo/conocido');
    const decisiones = await agent.get('/api/matcher/decisiones');
    const syncEstado = await agent.get('/api/sync/estado');
    expect(catalogo.status).toBe(200);
    expect(categorias.status).toBe(200);
    expect(mapeo.status).toBe(200);
    expect(decisiones.status).toBe(200);
    expect(syncEstado.status).toBe(200);
    expect(syncEstado.body.ok).toBe(true);
  });

  it('GET /api/ml/token-estado: accesible por cualquier autenticado, fail-closed sin token', async () => {
    const app = buildApp({ dbPath: TEST_DB, sessionSecret: 's', wooCfg: {}, geminiKey: 'k' });
    currentApp = app;
    const agent = await loginComoAdmin(app);

    const res = await agent.get('/api/ml/token-estado');
    expect(res.status).toBe(200);
    // Sin bootstrap OAuth previo: vencido y requiere re-autorización (fail-closed).
    expect(res.body).toMatchObject({
      ok: false,
      vencido: true,
      requiere_reautorizacion: true,
      reautorizar_url: '/api/sync/ml-auth-url',
    });
  });

  it('GET /api/ml/token-estado: token vigente reporta ok:true', async () => {
    const app = buildApp({ dbPath: TEST_DB, sessionSecret: 's', wooCfg: {}, geminiKey: 'k' });
    currentApp = app;
    const now = new Date().toISOString();
    const vence = new Date(Date.now() + 4 * 3600 * 1000).toISOString();
    app._db.prepare(`INSERT INTO ml_oauth_token (id, access_token, refresh_token, expires_at, actualizado_en)
      VALUES (1, 'tok', 'ref', ?, ?)`).run(vence, now);
    const agent = await loginComoAdmin(app);

    const res = await agent.get('/api/ml/token-estado');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.vencido).toBe(false);
    expect(res.body.requiere_reautorizacion).toBe(false);
    expect(res.body.minutos_restantes).toBeGreaterThan(0);
  });
});
