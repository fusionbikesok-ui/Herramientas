import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import { wooFetch, refrescarCatalogo, getCatalogo, wooRouter } from '../routes/woo.js';
import axios from 'axios';
import express from 'express';
import request from 'supertest';

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

  it('refrescarCatalogo borra de catalogo_cache los productos que ya no vienen en WooCommerce (borrados)', async () => {
    // Incidente real 2026-07-25: dos productos borrados en WooCommerce hacía tiempo seguían
    // en catalogo_cache para siempre (el upsert solo agrega/actualiza, nunca borraba), y
    // terminaron compartiendo SKU con un producto real vigente — WooCommerce no permite SKUs
    // duplicados de verdad, así que esa fila fantasma solo podía venir de un borrado no
    // limpiado. refrescarCatalogo ahora debe podar lo que no vino en el fetch actual.
    const db = openDb('./test/tmp-woo.sqlite');
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, actualizado_en) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(999, 'Producto borrado en WC hace tiempo', 'CBL', 'simple', null, 3, now);

    axios.request.mockResolvedValue({
      status: 200,
      headers: {},
      data: [{ id: 10, name: 'Casco Bell L', sku: 'CBL', type: 'simple', parent_id: 0, stock_quantity: 4 }]
    });
    const cfg = { url: 'https://fusionbikes.com.ar', ck: 'ck_x', cs: 'cs_x' };
    await refrescarCatalogo(db, cfg);

    const rows = getCatalogo(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].id_woo).toBe(10);
    const fantasma = db.prepare('SELECT * FROM catalogo_cache WHERE id_woo = 999').get();
    expect(fantasma).toBeUndefined();
    db.close();
  });

  it('refrescarCatalogo poda una variación fantasma (tipo=variation, con id_padre) igual que un producto simple', async () => {
    // La poda es por id_woo, no por tipo — pero hay que confirmar explícitamente que una
    // variación borrada en WC (que además arrastra id_padre) se limpia igual, y no queda
    // "protegida" por tener un padre que sí sigue vigente.
    const db = openDb('./test/tmp-woo.sqlite');
    const now = new Date().toISOString();
    // Variación fantasma: el padre (id_woo 5) sigue vigente, pero esta variación (id_woo 998)
    // ya no viene en el fetch.
    db.prepare(
      'INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, actualizado_en) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(998, 'Casco X — Rojo / M (borrada)', 'FB-998', 'variation', 5, 2, now);

    axios.request
      .mockResolvedValueOnce({ status: 200, headers: {}, data: [
        { id: 5, name: 'Casco X', sku: '', type: 'variable', parent_id: 0, stock_quantity: 0 },
      ] })
      .mockResolvedValueOnce({ status: 200, headers: {}, data: [
        { id: 21, sku: 'FB-21', stock_quantity: 3, attributes: [{ name: 'Color', option: 'Rojo' }] },
      ] })
      .mockResolvedValue({ status: 200, headers: {}, data: [] });
    const cfg = { url: 'https://fusionbikes.com.ar', ck: 'ck_x', cs: 'cs_x' };
    await refrescarCatalogo(db, cfg);

    const fantasma = db.prepare('SELECT * FROM catalogo_cache WHERE id_woo = 998').get();
    expect(fantasma).toBeUndefined();
    const vigente = db.prepare('SELECT * FROM catalogo_cache WHERE id_woo = 21').get();
    expect(vigente).toBeTruthy();
    db.close();
  });

  it('refrescarCatalogo poda filas fantasma aunque ninguna tenga SKU (SKU vacío/null no las protege)', async () => {
    // La poda usa id_woo NOT IN (...), no el SKU — confirma que un fantasma sin SKU (ej. un
    // producto 'variable' padre borrado, que nunca tiene SKU propio) se limpia igual.
    const db = openDb('./test/tmp-woo.sqlite');
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, actualizado_en) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(997, 'Producto variable borrado (sin SKU)', null, 'variable', null, 0, now);
    db.prepare(
      'INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, actualizado_en) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(996, 'Otro producto borrado (sin SKU)', '', 'simple', null, 0, now);

    axios.request.mockResolvedValue({
      status: 200,
      headers: {},
      data: [{ id: 10, name: 'Casco Bell L', sku: 'CBL', type: 'simple', parent_id: 0, stock_quantity: 4 }]
    });
    const cfg = { url: 'https://fusionbikes.com.ar', ck: 'ck_x', cs: 'cs_x' };
    await refrescarCatalogo(db, cfg);

    const rows = getCatalogo(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].id_woo).toBe(10);
    db.close();
  });

  it('refrescarCatalogo NO borra catalogo_cache si WooCommerce responde 200 con 0 productos (fail-closed)', async () => {
    // Hallazgo del revisor: "id_woo NOT IN (<conjunto vacío>)" es siempre verdadero en SQL —
    // sin este guard, un fetch de 0 productos (corte/permiso raro en WC, sin ser un error que
    // wooFetch propague) borraría el 100% del catálogo real en la próxima poda.
    const db = openDb('./test/tmp-woo.sqlite');
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, actualizado_en) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(10, 'Casco Bell L', 'CBL', 'simple', null, 4, now);

    axios.request.mockResolvedValue({ status: 200, headers: {}, data: [] });
    const cfg = { url: 'https://fusionbikes.com.ar', ck: 'ck_x', cs: 'cs_x' };
    await refrescarCatalogo(db, cfg);

    const rows = getCatalogo(db);
    expect(rows).toHaveLength(1); // el producto real previo sigue ahí, no se vació el catálogo
    expect(rows[0].id_woo).toBe(10);
    db.close();
  });

  it('el guard de fetch vacío es solo para esa corrida: la corrida siguiente con datos reales poda normalmente', async () => {
    // El guard evita que UN fetch vacío borre todo el catálogo, pero no debe dejarlo
    // "congelado" para siempre: en cuanto WooCommerce vuelve a responder con productos
    // reales, la poda normal debe seguir funcionando y limpiar lo que ya no viene.
    const db = openDb('./test/tmp-woo.sqlite');
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, actualizado_en) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(10, 'Casco Bell L', 'CBL', 'simple', null, 4, now);
    db.prepare(
      'INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, actualizado_en) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(999, 'Producto borrado en WC hace tiempo', 'CBL', 'simple', null, 3, now);
    const cfg = { url: 'https://fusionbikes.com.ar', ck: 'ck_x', cs: 'cs_x' };

    // Corrida 1: WC responde 0 productos (corte/permiso raro) -> guard, no se toca nada.
    axios.request.mockResolvedValueOnce({ status: 200, headers: {}, data: [] });
    await refrescarCatalogo(db, cfg);
    expect(getCatalogo(db)).toHaveLength(2); // ambos siguen ahí, incluido el fantasma

    // Corrida 2: WC vuelve a responder con productos reales -> la poda debe correr normal.
    axios.request.mockResolvedValueOnce({
      status: 200, headers: {},
      data: [{ id: 10, name: 'Casco Bell L', sku: 'CBL', type: 'simple', parent_id: 0, stock_quantity: 4 }]
    });
    await refrescarCatalogo(db, cfg);
    const rows = getCatalogo(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].id_woo).toBe(10);
    const fantasma = db.prepare('SELECT * FROM catalogo_cache WHERE id_woo = 999').get();
    expect(fantasma).toBeUndefined();
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

describe('POST /stock/aplicar', () => {
  const DB_PATH = './test/tmp-woo-aplicar.sqlite';
  let db;

  function app() {
    const a = express();
    a.use(express.json());
    a.use('/api/woo', wooRouter(db, { url: 'https://fusionbikes.com.ar', ck: 'ck_x', cs: 'cs_x' }));
    return a;
  }

  beforeEach(() => {
    if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
    db = openDb(DB_PATH);
    db.prepare("INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, actualizado_en) VALUES (?,?,?,?,?,?,?)")
      .run(29985, 'Venzo Raptor Negro/Rojo L', 'FB-29985', 'variation', 24452, 0, '2026-08-03T00:00:00.000Z');
    db.prepare("INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, actualizado_en) VALUES (?,?,?,?,?,?,?)")
      .run(1001, 'Producto simple', 'FB-1001', 'simple', null, 0, '2026-08-03T00:00:00.000Z');
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
    vi.resetAllMocks();
  });

  it('usa el endpoint de variaciones para un producto variation (regresión del 404)', async () => {
    axios.request.mockResolvedValue({ status: 200, data: {}, headers: {} });
    const r = await request(app()).post('/api/woo/stock/aplicar')
      .send({ updates: [{ sku: 'FB-29985', id_woo: 29985, stock_nuevo: 4 }] });

    expect(r.body).toMatchObject({ ok: true, aplicados: 1, errores: 0 });
    expect(axios.request).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://fusionbikes.com.ar/wp-json/wc/v3/products/24452/variations/29985',
      method: 'put',
      data: { stock_quantity: 4, manage_stock: true }
    }));
    expect(db.prepare('SELECT stock FROM catalogo_cache WHERE id_woo=?').get(29985).stock).toBe(4);
  });

  it('usa /products/{id} para un producto simple', async () => {
    axios.request.mockResolvedValue({ status: 200, data: {}, headers: {} });
    const r = await request(app()).post('/api/woo/stock/aplicar')
      .send({ updates: [{ sku: 'FB-1001', id_woo: 1001, stock_nuevo: 7 }] });

    expect(r.body.aplicados).toBe(1);
    expect(axios.request).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://fusionbikes.com.ar/wp-json/wc/v3/products/1001'
    }));
  });

  it('falla cerrado si el producto no está en catalogo_cache', async () => {
    axios.request.mockResolvedValue({ status: 200, data: {}, headers: {} });
    const r = await request(app()).post('/api/woo/stock/aplicar')
      .send({ updates: [{ sku: 'FB-9999', id_woo: 9999, stock_nuevo: 3 }] });

    expect(r.body).toMatchObject({ ok: false, aplicados: 0, errores: 1 });
    expect(r.body.resultados[0].error).toMatch(/catalogo_cache/);
    expect(axios.request).not.toHaveBeenCalled();
  });
});
