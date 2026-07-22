import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import { wooFetch, refrescarCatalogo, getCatalogo } from '../routes/woo.js';
import axios from 'axios';

vi.mock('axios');

const TEST_DB = './test/tmp-woo.sqlite';

describe('woo route', () => {
  afterEach(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    vi.resetAllMocks();
  });

  it('wooFetch calls WooCommerce REST API with basic auth header', async () => {
    axios.request.mockResolvedValue({ status: 200, data: [{ id: 1 }], headers: {} });
    const cfg = { url: 'https://fusionbikes.com.ar', ck: 'ck_x', cs: 'cs_x' };
    await wooFetch(cfg, '/products?per_page=1');
    expect(axios.request).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://fusionbikes.com.ar/wp-json/wc/v3/products?per_page=1',
      method: 'get',
      auth: { username: 'ck_x', password: 'cs_x' }
    }));
  });

  it('refrescarCatalogo writes fetched products into catalogo_cache', async () => {
    axios.request.mockResolvedValue({
      status: 200,
      headers: {},
      data: [{ id: 10, name: 'Casco Bell L', sku: 'CBL', type: 'simple', parent_id: 0, stock_quantity: 4 }]
    });
    const db = openDb(TEST_DB);
    const cfg = { url: 'https://fusionbikes.com.ar', ck: 'ck_x', cs: 'cs_x' };
    await refrescarCatalogo(db, cfg);
    const rows = getCatalogo(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].nombre).toBe('Casco Bell L');
    db.close();
  });

  it('refrescarCatalogo persiste atributos estructurados de variaciones (H-06)', async () => {
    axios.request
      .mockResolvedValueOnce({ status: 200, headers: {}, data: [
        { id: 20, name: 'Casco X', sku: '', type: 'variable', parent_id: 0, stock_quantity: 0 },
      ] })
      .mockResolvedValueOnce({ status: 200, headers: {}, data: [
        { id: 21, sku: 'FB-21', stock_quantity: 3, attributes: [
          { name: 'Color', option: 'Rojo' }, { name: 'Talle', option: 'M' },
        ] },
      ] })
      .mockResolvedValue({ status: 200, headers: {}, data: [] });
    const db = openDb(TEST_DB);
    await refrescarCatalogo(db, { url: 'https://fusionbikes.com.ar', ck: 'x', cs: 'y' });
    const v = getCatalogo(db).find(r => r.sku === 'FB-21');
    expect(v).toBeTruthy();
    expect(JSON.parse(v.atributos_json)).toEqual([
      { name: 'Color', option: 'Rojo' }, { name: 'Talle', option: 'M' },
    ]);
    db.close();
  });

  it('refrescarCatalogo persiste la marca desde brands', async () => {
    axios.request.mockResolvedValue({
      status: 200, headers: {},
      data: [{ id: 40, name: 'Cinta SUPACAZ', sku: 'FB-40', type: 'simple', parent_id: 0,
        stock_quantity: 2, brands: [{ id: 9, name: 'SUPACAZ', slug: 'supacaz' }] }],
    });
    const db = openDb(TEST_DB);
    await refrescarCatalogo(db, { url: 'https://fusionbikes.com.ar', ck: 'x', cs: 'y' });
    const row = getCatalogo(db).find(r => r.sku === 'FB-40');
    expect(row.marca).toBe('SUPACAZ');
    db.close();
  });

  it('getCatalogo respeta limit/offset (tope defensivo)', () => {
    const db = openDb(TEST_DB);
    const now = new Date().toISOString();
    const ins = db.prepare('INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, stock, actualizado_en) VALUES (?,?,?,?,?,?)');
    for (let i = 1; i <= 5; i++) ins.run(i, 'P' + i, 'FB-' + i, 'simple', 1, now);
    expect(getCatalogo(db)).toHaveLength(5);          // sin límite explícito: todo
    expect(getCatalogo(db, { limit: 2 })).toHaveLength(2);
    expect(getCatalogo(db, { limit: 2, offset: 4 })).toHaveLength(1);
    db.close();
  });

  it('openDb crea la tabla ean_sku', () => {
    const db = openDb(TEST_DB);
    const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ean_sku'").get();
    expect(t).toBeTruthy();
    db.close();
  });
});
