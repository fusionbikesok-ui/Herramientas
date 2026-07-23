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

  // Helper: mockea axios ruteando por URL. `variables` es un mapa id -> array de variaciones.
  // Cuenta llamadas concurrentes a endpoints de variaciones para verificar el límite.
  function mockCatalogoConVariables(variables, { fallarId = null, tracker = null } = {}) {
    const padres = Object.keys(variables).map((id) => ({
      id: Number(id), name: 'Padre ' + id, sku: '', type: 'variable', parent_id: 0, stock_quantity: 0,
    }));
    axios.request.mockImplementation(async ({ url }) => {
      // Listado de productos
      const mProducts = url.match(/\/products\?per_page=100&page=(\d+)/);
      if (mProducts) {
        const page = Number(mProducts[1]);
        return { status: 200, headers: {}, data: page === 1 ? padres : [] };
      }
      // Variaciones de un padre
      const mVar = url.match(/\/products\/(\d+)\/variations\?per_page=100&page=(\d+)/);
      if (mVar) {
        const id = Number(mVar[1]);
        const page = Number(mVar[2]);
        if (tracker) {
          tracker.enVuelo++;
          tracker.max = Math.max(tracker.max, tracker.enVuelo);
        }
        // pequeña espera para que las tareas se solapen y el tracker mida concurrencia real
        await new Promise((r) => setTimeout(r, 5));
        if (tracker) tracker.enVuelo--;
        if (fallarId != null && id === fallarId) {
          return { status: 500, headers: {}, data: {} };
        }
        return { status: 200, headers: {}, data: page === 1 ? (variables[id] || []) : [] };
      }
      return { status: 200, headers: {}, data: [] };
    });
  }

  it('refrescarCatalogo paraleliza variaciones respetando WOO_CONCURRENCIA_MAX', async () => {
    // 10 productos variables, cada uno con 1 variación -> con límite 4 nunca debe haber >4 en vuelo
    const variables = {};
    for (let i = 1; i <= 10; i++) {
      variables[i] = [{ id: 100 + i, sku: 'FB-' + i, stock_quantity: 1, attributes: [] }];
    }
    const tracker = { enVuelo: 0, max: 0 };
    mockCatalogoConVariables(variables, { tracker });
    const db = openDb(TEST_DB);
    const total = await refrescarCatalogo(db, { url: 'https://fusionbikes.com.ar', ck: 'x', cs: 'y' });
    expect(tracker.max).toBeGreaterThan(1);         // efectivamente hubo paralelismo
    expect(tracker.max).toBeLessThanOrEqual(4);     // pero acotado a WOO_CONCURRENCIA_MAX
    // 10 padres + 10 variaciones persistidas
    expect(total).toBe(20);
    expect(getCatalogo(db)).toHaveLength(20);
    db.close();
  });

  it('refrescarCatalogo persiste TODAS las variaciones de todos los padres (equivalente al serial)', async () => {
    const variables = {
      1: [{ id: 201, sku: 'A-1', stock_quantity: 3, attributes: [] }, { id: 202, sku: 'A-2', stock_quantity: 1, attributes: [] }],
      2: [{ id: 203, sku: 'B-1', stock_quantity: 5, attributes: [] }],
    };
    mockCatalogoConVariables(variables);
    const db = openDb(TEST_DB);
    await refrescarCatalogo(db, { url: 'https://fusionbikes.com.ar', ck: 'x', cs: 'y' });
    const skus = getCatalogo(db).map((r) => r.sku).filter(Boolean).sort();
    expect(skus).toEqual(['A-1', 'A-2', 'B-1']);
    db.close();
  });

  it('refrescarCatalogo falla fail-closed si una variación falla (no persiste parcial)', async () => {
    const variables = {
      1: [{ id: 301, sku: 'OK-1', stock_quantity: 1, attributes: [] }],
      2: [{ id: 302, sku: 'BAD-2', stock_quantity: 1, attributes: [] }],
      3: [{ id: 303, sku: 'OK-3', stock_quantity: 1, attributes: [] }],
    };
    mockCatalogoConVariables(variables, { fallarId: 2 });
    const db = openDb(TEST_DB);
    await expect(
      refrescarCatalogo(db, { url: 'https://fusionbikes.com.ar', ck: 'x', cs: 'y' })
    ).rejects.toThrow(/WooCommerce API error 500/);
    // Como en el comportamiento serial anterior: si falla una llamada, no se persiste nada
    expect(getCatalogo(db)).toHaveLength(0);
    db.close();
  });

  it('openDb crea la tabla ean_sku', () => {
    const db = openDb(TEST_DB);
    const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ean_sku'").get();
    expect(t).toBeTruthy();
    db.close();
  });
});
