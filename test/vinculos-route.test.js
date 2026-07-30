import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import express from 'express';
import request from 'supertest';
import { openDb } from '../db/index.js';
import { syncRouter } from '../routes/sync.js';

const TEST_DB = './test/tmp-vinculos-route.sqlite';

// cfg sin credenciales de ML: alcanza para estos tests, que no llaman a mlFetch
// (GET /frenadas es puramente local; el forzar con ML configurado se prueba aparte).
const CFG = { ml: {}, woo: {} };

describe('Rutas de publicaciones frenadas por precio', () => {
  let db, app;

  beforeEach(() => {
    db = openDb(TEST_DB);
    app = express();
    app.use(express.json());
    app.use('/api/sync', syncRouter(db, CFG));
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('GET /api/sync/frenadas devuelve las frenadas con datos de la publicación', async () => {
    db.prepare(`INSERT INTO ml_publicaciones_cache (clave, item_id, variation_id, titulo, status, sub_status, es_variante, thumbnail, permalink, actualizado_en)
      VALUES ('MLA1|', 'MLA1', '', 'Bici Sava Deck', 'paused', 'out_of_stock', 0, 'http://img', 'http://ml', '2026-07-30T00:00:00Z')`).run();
    db.prepare(`INSERT INTO ml_reactivacion_frenada (clave, sku, motivo, neto, precio_contado, deficit_pct, detectado_en)
      VALUES ('MLA1|', 'FB-1', 'El neto de ML queda por debajo del precio web', 120000, 200000, 0.4, '2026-07-30T10:00:00Z')`).run();

    const res = await request(app).get('/api/sync/frenadas');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ clave: 'MLA1|', sku: 'FB-1', titulo: 'Bici Sava Deck', deficit_pct: 0.4 });
  });

  it('GET /api/sync/dashboard incluye el contador de frenadas', async () => {
    db.prepare(`INSERT INTO ml_reactivacion_frenada (clave, sku, motivo, neto, precio_contado, deficit_pct, detectado_en)
      VALUES ('MLA9|', 'FB-9', 'x', 1, 2, 0.5, '2026-07-30T10:00:00Z')`).run();
    const res = await request(app).get('/api/sync/dashboard');
    expect(res.body.frenadas).toBe(1);
  });

  it('POST /api/sync/frenadas/forzar sin ML configurado responde 400', async () => {
    const res = await request(app).post('/api/sync/frenadas/forzar').send({ itemIds: ['MLA1'] });
    expect(res.status).toBe(400);
  });

  it('POST /api/sync/frenadas/forzar sin itemIds responde 400', async () => {
    const appConfigurado = express();
    appConfigurado.use(express.json());
    appConfigurado.use('/api/sync', syncRouter(db, { ml: { userId: '1', accessToken: 'x' }, woo: {} }));
    const res = await request(appConfigurado).post('/api/sync/frenadas/forzar').send({});
    expect(res.status).toBe(400);
  });
});
