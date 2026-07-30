import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import express from 'express';
import request from 'supertest';
import { openDb } from '../db/index.js';

vi.mock('../lib/mlClient.js', () => ({
  mlFetch: vi.fn(),
  bootstrapToken: vi.fn(),
  getAccessToken: vi.fn(),
}));
vi.mock('../routes/woo.js', () => ({ wooFetch: vi.fn() }));

import { mlFetch } from '../lib/mlClient.js';
import { syncRouter } from '../routes/sync.js';

const TEST_DB = './test/tmp-vinculos-route.sqlite';

// cfg sin credenciales de ML: alcanza para los tests que no llaman a mlFetch
// (GET /frenadas es puramente local).
const CFG = { ml: {}, woo: {} };
// cfg con ML "configurado" (mlCfgOk pide clientId/clientSecret/userId), usado en los tests
// que ejercitan /frenadas/forzar de verdad contra mlFetch mockeado.
const CFG_ML = { ml: { clientId: 'cid', clientSecret: 'cs', userId: '99999' }, woo: {} };

describe('Rutas de publicaciones frenadas por precio', () => {
  let db, app;

  beforeEach(() => {
    db = openDb(TEST_DB);
    app = express();
    app.use(express.json());
    app.use('/api/sync', syncRouter(db, CFG));
    mlFetch.mockReset();
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
    appConfigurado.use('/api/sync', syncRouter(db, CFG_ML));
    const res = await request(appConfigurado).post('/api/sync/frenadas/forzar').send({});
    expect(res.status).toBe(400);
  });

  describe('POST /api/sync/frenadas/forzar — comportamiento central contra ML', () => {
    let appMl;

    /** Siembra una publicación pausada+frenada, mapeada, con stock web disponible. */
    function sembrarFrenada({ clave = 'MLA1|', itemId = 'MLA1', sku = 'FB-1', stockWc = 3, precioWc = 300000 } = {}) {
      db.prepare(`INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, stock, precio, actualizado_en)
        VALUES (?, ?, ?, 'simple', ?, ?, '2026-07-30T00:00:00Z')`)
        .run(Math.floor(Math.random() * 1e6), 'Producto ' + sku, sku, stockWc, precioWc);
      db.prepare(`INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en)
        VALUES (?, ?, ?, 'asignar', '2026-07-30T00:00:00Z')`).run(clave, sku, 'Producto ' + sku);
      db.prepare(`INSERT INTO ml_publicaciones_cache (clave, item_id, variation_id, titulo, status, sub_status, es_variante, actualizado_en)
        VALUES (?, ?, '', ?, 'paused', 'out_of_stock', 0, '2026-07-30T00:00:00Z')`).run(clave, itemId, 'Pub ' + sku);
      db.prepare(`INSERT INTO ml_reactivacion_frenada (clave, sku, motivo, neto, precio_contado, deficit_pct, detectado_en)
        VALUES (?, ?, 'viejo', 1, 2, 0.5, '2026-07-29T00:00:00Z')`).run(clave, sku);
    }

    beforeEach(() => {
      appMl = express();
      appMl.use(express.json());
      appMl.use('/api/sync', syncRouter(db, CFG_ML));
    });

    it('el precio SIGUE mal: no reactiva, la frenada sigue en la tabla, y el resultado la marca bloqueada', async () => {
      sembrarFrenada({ precioWc: 900000 }); // precio web alto → neto por debajo, sigue bloqueada
      mlFetch.mockImplementation(async (_db, _cfg, metodo, path) => {
        if (metodo === 'get' && path.startsWith('/items/MLA1?')) {
          return { status: 200, data: { id: 'MLA1', status: 'paused', sub_status: ['out_of_stock'], price: 200000, category_id: 'MLA1234', listing_type_id: 'gold_special', shipping: { free_shipping: false } } };
        }
        if (metodo === 'get' && path.includes('listing_prices')) return { status: 200, data: { sale_fee_amount: 30000 } };
        return { status: 200, data: {} };
      });

      const res = await request(appMl).post('/api/sync/frenadas/forzar').send({ itemIds: ['MLA1'] });
      expect(res.status).toBe(200);
      expect(res.body.resultados).toHaveLength(1);
      expect(res.body.resultados[0]).toMatchObject({ item_id: 'MLA1', ok: false, bloqueado: true });
      // No se activó en ML.
      expect(db.prepare("SELECT status FROM ml_publicaciones_cache WHERE clave='MLA1|'").get().status).toBe('paused');
      // La frenada sigue estando: fail-closed, "forzar" no la borra si el precio no pasó.
      expect(db.prepare('SELECT COUNT(*) n FROM ml_reactivacion_frenada').get().n).toBe(1);
    });

    it('camino feliz: precio ya corregido → reactiva y borra la frenada', async () => {
      sembrarFrenada({ precioWc: 300000 }); // precio web bajo → neto pasa el chequeo
      mlFetch.mockImplementation(async (_db, _cfg, metodo, path) => {
        if (metodo === 'get' && path.startsWith('/items/MLA1?')) {
          return { status: 200, data: { id: 'MLA1', status: 'paused', sub_status: ['out_of_stock'], price: 400000, category_id: 'MLA1234', listing_type_id: 'gold_special', shipping: { free_shipping: false } } };
        }
        if (metodo === 'get' && path.includes('listing_prices')) return { status: 200, data: { sale_fee_amount: 40000 } };
        return { status: 200, data: {} };
      });

      const res = await request(appMl).post('/api/sync/frenadas/forzar').send({ itemIds: ['MLA1'] });
      expect(res.status).toBe(200);
      expect(res.body.resultados[0]).toMatchObject({ item_id: 'MLA1', ok: true });
      expect(db.prepare("SELECT status FROM ml_publicaciones_cache WHERE clave='MLA1|'").get().status).toBe('active');
      expect(db.prepare('SELECT COUNT(*) n FROM ml_reactivacion_frenada').get().n).toBe(0);
    });

    it('trunca en 50: pide 51, procesa 50 y lo declara en pedidos/procesados/truncado', async () => {
      // 51 publicaciones reactivables reales, todas con precio ok, para que
      // reactivarItems las encuentre de verdad (no solo que existan en itemIds).
      for (let i = 0; i < 51; i++) {
        sembrarFrenada({ clave: `MLA${i}|`, itemId: `MLA${i}`, sku: `FB-${i}`, precioWc: 300000 });
      }
      mlFetch.mockImplementation(async (_db, _cfg, metodo, path) => {
        if (metodo === 'get' && /^\/items\/MLA\d+\?/.test(path)) {
          return { status: 200, data: { status: 'paused', sub_status: ['out_of_stock'], price: 400000, category_id: 'MLA1234', listing_type_id: 'gold_special', shipping: { free_shipping: false } } };
        }
        if (metodo === 'get' && path.includes('listing_prices')) return { status: 200, data: { sale_fee_amount: 40000 } };
        return { status: 200, data: {} };
      });

      const itemIds = Array.from({ length: 51 }, (_, i) => `MLA${i}`);
      const res = await request(appMl).post('/api/sync/frenadas/forzar').send({ itemIds });
      expect(res.status).toBe(200);
      expect(res.body.pedidos).toBe(51);
      expect(res.body.procesados).toBe(50);
      expect(res.body.truncado).toBe(true);
      // La publicación excluida por el truncamiento no se tocó.
      expect(db.prepare('SELECT COUNT(*) n FROM ml_reactivacion_frenada').get().n).toBe(1);
    });
  });
});
