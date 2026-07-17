import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import request from 'supertest';
import { buildApp } from '../server.js';

const TEST_DB = './test/tmp-server.sqlite';
let currentApp;

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
    const app = buildApp({ dbPath: TEST_DB, basicAuthUser: 'u', basicAuthPass: 'p', wooCfg: {}, geminiKey: 'k' });
    currentApp = app;
    const stock = await request(app).get('/stock/');
    const etiquetas = await request(app).get('/etiquetas/');
    const inventario = await request(app).get('/inventario/');
    const login = await request(app).get('/login/');
    const matcher = await request(app).get('/matcher/');
    expect(stock.status).toBe(200);
    expect(etiquetas.status).toBe(200);
    expect(inventario.status).toBe(200);
    expect(login.status).toBe(200);
    expect(matcher.status).toBe(200);
  });

  it('rejects API requests without credentials', async () => {
    const app = buildApp({ dbPath: TEST_DB, basicAuthUser: 'u', basicAuthPass: 'p', wooCfg: {}, geminiKey: 'k' });
    currentApp = app;
    const res = await request(app).get('/api/woo/catalogo');
    expect(res.status).toBe(401);
  });

  it('mounts the woo, gemini, nuevos-productos, mapeo, csv, matcher and sync API routers', async () => {
    const app = buildApp({ dbPath: TEST_DB, basicAuthUser: 'u', basicAuthPass: 'p', wooCfg: {}, geminiKey: 'k' });
    currentApp = app;
    const catalogo = await request(app).get('/api/woo/catalogo').auth('u', 'p');
    const categorias = await request(app).get('/api/nuevos-productos/categorias').auth('u', 'p');
    const mapeo = await request(app).get('/api/mapeo/conocido').auth('u', 'p');
    const decisiones = await request(app).get('/api/matcher/decisiones').auth('u', 'p');
    const syncEstado = await request(app).get('/api/sync/estado').auth('u', 'p');
    expect(catalogo.status).toBe(200);
    expect(categorias.status).toBe(200);
    expect(mapeo.status).toBe(200);
    expect(decisiones.status).toBe(200);
    expect(syncEstado.status).toBe(200);
    expect(syncEstado.body.ok).toBe(true);
  });
});
