import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import express from 'express';
import request from 'supertest';

vi.mock('../lib/mlClient.js', () => ({ mlFetch: vi.fn(), bootstrapToken: vi.fn(), getAccessToken: vi.fn() }));
import { mlFetch } from '../lib/mlClient.js';
import { openDb } from '../db/index.js';
import { syncRouter } from '../routes/sync.js';

const TEST_DB = './test/pausadas-con-stock-endpoints.sqlite';
const CFG = { clientId: 'cid', clientSecret: 'cs', userId: '99999' };

function sembrar(db, n, { sub = 'paused_by_seller', stock = 5, modo = null } = {}) {
  const sku = `FB-${n}`;
  db.prepare(`INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, stock, precio, regular_price, actualizado_en)
    VALUES (?, 'Prod', ?, 'simple', ?, 300000, 300000, datetime('now'))`).run(1000 + n, sku, stock);
  db.prepare(`INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en)
    VALUES (?, ?, 'WC', 'confirmar', datetime('now'))`).run(`MLA${n}|`, sku);
  db.prepare(`INSERT INTO ml_publicaciones_cache
    (clave, item_id, variation_id, titulo, status, sub_status, es_variante, seller_sku, available_quantity, actualizado_en)
    VALUES (?, ?, '', 'Pub', 'paused', ?, 0, ?, 0, datetime('now'))`).run(`MLA${n}|`, `MLA${n}`, sub, sku);
  if (modo) db.prepare("INSERT INTO skus_config_ml (sku,nombre,modo,reserva,actualizado_en) VALUES (?,'x',?,0,datetime('now'))").run(sku, modo);
}

describe('Pausadas con stock en Woo: endpoints', () => {
  let db, app;
  beforeEach(() => {
    db = openDb(TEST_DB);
    vi.clearAllMocks();
    mlFetch.mockResolvedValue({ status: 200, data: {} });
    app = express();
    app.use(express.json());
    app.use('/api/sync', syncRouter(db, { ml: CFG }));
  });
  afterEach(() => { db.close(); for (const s of ['', '-wal', '-shm']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s); });

  it('GET lista con causa, resumen y solo_local; ?causa filtra y una causa inválida da 400', async () => {
    sembrar(db, 1); sembrar(db, 2, { sub: 'out_of_stock' }); sembrar(db, 3, { modo: 'solo_local' });
    const r = await request(app).get('/api/sync/pausadas-con-stock');
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(3);
    expect(r.body.resumen).toMatchObject({ paused_by_seller: 1, out_of_stock: 1, solo_local: 1 });
    expect(r.body.solo_local).toMatchObject({ skus: 1 });
    const f = await request(app).get('/api/sync/pausadas-con-stock?causa=paused_by_seller');
    expect(f.body.data.map((x) => x.item_id)).toEqual(['MLA1']);
    expect((await request(app).get('/api/sync/pausadas-con-stock?causa=inventada')).status).toBe(400);
  });

  it('POST reactivar valida el cuerpo', async () => {
    expect((await request(app).post('/api/sync/pausadas-con-stock/reactivar').send({})).status).toBe(400);
    const muchos = Array.from({ length: 51 }, (_, i) => `MLA${i}`);
    expect((await request(app).post('/api/sync/pausadas-con-stock/reactivar').send({ itemIds: muchos })).status).toBe(400);
  });

  it('POST reactivar levanta una paused_by_seller a pedido, y rechaza solo_local sin tocar ML por ella', async () => {
    sembrar(db, 1); sembrar(db, 3, { modo: 'solo_local' });
    mlFetch.mockImplementation(async (_db, _cfg, metodo, path) => {
      if (metodo === 'get' && path.startsWith('/items/bulk?ids=')) {
        const ids = path.match(/ids=([^&]*)/)[1].split(',');
        return { status: 200, data: ids.map((id) => ({ code: 200, body: { id, status: 'paused', sub_status: ['paused_by_seller'], price: 400000, category_id: 'MLA1234', listing_type_id: 'gold_special', shipping: { free_shipping: false } } })) };
      }
      if (metodo === 'get' && path.includes('listing_prices')) return { status: 200, data: { sale_fee_amount: 40000 } };
      return { status: 200, data: {} };
    });
    const r = await request(app).post('/api/sync/pausadas-con-stock/reactivar').send({ itemIds: ['MLA1', 'MLA3', 'MLA999'] });
    expect(r.status).toBe(200);
    expect(r.body.no_reactivables.sort()).toEqual(['MLA3', 'MLA999']);
    const puts = mlFetch.mock.calls.filter((c) => c[2] === 'put').map((c) => c[3]);
    expect(puts.some((u) => u.includes('MLA1'))).toBe(true);
    expect(puts.some((u) => u.includes('MLA3'))).toBe(false);
  });

  it('el reactivador automático NO toma las paused_by_seller (sólo la acción manual)', async () => {
    sembrar(db, 1);
    const { getReactivablesRows } = await import('../routes/sync.js');
    expect(getReactivablesRows(db).map((x) => x.item_id)).not.toContain('MLA1');
  });

  it('dashboard trae los contadores nuevos', async () => {
    sembrar(db, 1); sembrar(db, 3, { modo: 'solo_local' });
    const r = await request(app).get('/api/sync/dashboard');
    expect(r.body.pausadas_con_stock).toMatchObject({ paused_by_seller: 1, solo_local: 1 });
    expect(r.body.solo_local.skus).toBe(1);
  });

  it('revisar sin reactivar ofrece reactivar si sigue pausada con stock en Woo', async () => {
    sembrar(db, 1);
    const id = db.prepare(`INSERT INTO ml_publicacion_cambios (clave,item_id,sku,campo,valor_anterior,valor_nuevo,pausada,detectado_en)
      VALUES ('MLA1|','MLA1','FB-1','SALE_FORMAT','Unidad','Pack',1,datetime('now'))`).run().lastInsertRowid;
    const r = await request(app).post(`/api/sync/cambios-formato/${id}/revisar`).send({});
    expect(r.body.oferta_reactivar).toEqual({ item_id: 'MLA1', stock_woo: 5 });
    expect(mlFetch).not.toHaveBeenCalled();
  });
});
