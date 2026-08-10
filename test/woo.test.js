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

  // Hallazgo del revisor (2026-08-03): el contado de una venta ML se calcula sobre el precio
  // de LISTA (regular_price), no sobre el vigente (que puede ser sale_price en oferta).
  // refrescarCatalogo tiene que persistir regular_price por separado de precio.
  it('refrescarCatalogo persiste regular_price (precio de LISTA) separado de precio (vigente)', async () => {
    axios.request.mockResolvedValue({
      status: 200,
      headers: {},
      data: [{
        id: 16, name: 'Bici en oferta', sku: 'BO-1', type: 'simple', parent_id: 0,
        stock_quantity: 2, price: '800000', regular_price: '1000000',
      }],
    });
    const db = openDb(TEST_DB);
    const cfg = { url: 'https://fusionbikes.com.ar', ck: 'ck_x', cs: 'cs_x' };
    await refrescarCatalogo(db, cfg);
    const fila = db.prepare('SELECT precio, regular_price FROM catalogo_cache WHERE id_woo = 16').get();
    expect(fila.precio).toBe(800000);
    expect(fila.regular_price).toBe(1000000);
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

// Paso 2 del plan 2026-08-10-codigos-frescura-y-catalogo-incremental.md: refresco incremental.
describe('refrescarCatalogo — modo incremental', () => {
  const TEST_DB2 = './test/tmp-woo-incremental.sqlite';
  const cfg = { url: 'https://fusionbikes.com.ar', ck: 'ck_x', cs: 'cs_x' };

  afterEach(() => {
    if (fs.existsSync(TEST_DB2)) fs.unlinkSync(TEST_DB2);
    vi.resetAllMocks();
  });

  function marcarComoRecienCompleto(db) {
    // Simula que ya corrió un barrido completo hace instantes, para que la próxima corrida
    // tome el camino incremental (completo = false).
    const ahora = new Date().toISOString();
    db.prepare(`
      INSERT INTO sync_estado (clave, valor, actualizado_en) VALUES (?, ?, ?)
      ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en
    `).run('catalogo_ultimo_completo', ahora, ahora);
    db.prepare(`
      INSERT INTO sync_estado (clave, valor, actualizado_en) VALUES (?, ?, ?)
      ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en
    `).run('catalogo_ultimo_refresco', ahora, ahora);
  }

  // Criterio 1: en régimen estable (nada cambió en Woo), una corrida incremental hace UNA
  // sola llamada a /products y CERO llamadas de variaciones. Es el criterio que da sentido
  // a todo el cambio: si esto se rompe, volvemos al costo original de ~584 llamadas.
  //
  // Mutation testing: comenté `if (idsActuales.length === 0) { ... return 0; }`'s rama
  // `completo` (forzando siempre el camino de poda/tx) — sin la rama incremental temprana,
  // el test de abajo que cuenta llamadas seguía en 1 (no dispara variaciones porque no hay
  // productos variables en el fixture), así que el mutation real que prueba esta rama es
  // revertir `completo` a `forzarCompleto` puro (sacar `!ultimoCompleto` / el chequeo de
  // tiempo) — ver el test de fallback más abajo, que sí lo cubre en rojo.
  it('en régimen estable hace 1 sola llamada a /products y 0 de variaciones', async () => {
    const db = openDb(TEST_DB2);
    marcarComoRecienCompleto(db);
    // El mock distingue completo (sin modified_after) de incremental: si por un mutante
    // `completo` quedara pegado en `true`, esta consulta SÍ traería un padre variable con
    // variaciones — el test lo detectaría por la cantidad de llamadas y por `total`.
    axios.request.mockImplementation(async ({ url }) => {
      if (url.includes('modified_after')) return { status: 200, headers: {}, data: [] };
      if (url.includes('/products?')) {
        return { status: 200, headers: {}, data: [
          { id: 99, name: 'Padre existente', sku: '', type: 'variable', parent_id: 0, stock_quantity: 0 },
        ] };
      }
      return { status: 200, headers: {}, data: [{ id: 991, sku: 'FB-991', stock_quantity: 1, attributes: [] }] };
    });

    const total = await refrescarCatalogo(db, cfg);

    expect(total).toBe(0);
    expect(axios.request).toHaveBeenCalledTimes(1);
    const [[llamada]] = axios.request.mock.calls;
    expect(llamada.url).toMatch(/\/products\?per_page=100&page=1&status=any/);
    expect(llamada.url).toMatch(/modified_after=/);
    expect(llamada.url).not.toMatch(/variations/);
    db.close();
  });

  // Criterio 5: dates_are_gmt=true no es opcional en una consulta con modified_after.
  it('la corrida incremental manda dates_are_gmt=true junto con modified_after', async () => {
    const db = openDb(TEST_DB2);
    marcarComoRecienCompleto(db);
    axios.request.mockResolvedValue({ status: 200, headers: {}, data: [] });

    await refrescarCatalogo(db, cfg);

    const [[llamada]] = axios.request.mock.calls;
    expect(llamada.url).toMatch(/modified_after=/);
    expect(llamada.url).toMatch(/dates_are_gmt=true/);
    db.close();
  });

  // Criterio 2: un cambio en una variación se refleja en catalogo_cache en la siguiente
  // corrida incremental (solo se traen variaciones de los padres que volvió la consulta).
  it('trae variaciones solo de los padres devueltos por la consulta incremental', async () => {
    const db = openDb(TEST_DB2);
    marcarComoRecienCompleto(db);
    // Un padre "modificado" existente ya en catalogo_cache, y otro padre no tocado que NO
    // debería disparar una llamada de variaciones.
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, actualizado_en) VALUES (?,?,?,?,?,?,?)'
    ).run(50, 'Padre no tocado', '', 'variable', null, 0, now);

    axios.request
      .mockResolvedValueOnce({ status: 200, headers: {}, data: [
        { id: 60, name: 'Padre modificado', sku: '', type: 'variable', parent_id: 0, stock_quantity: 0 },
      ] })
      .mockResolvedValueOnce({ status: 200, headers: {}, data: [
        { id: 61, sku: 'FB-61', stock_quantity: 9, attributes: [] },
      ] })
      .mockResolvedValue({ status: 200, headers: {}, data: [] });

    await refrescarCatalogo(db, cfg);

    const llamadas = axios.request.mock.calls.map(([c]) => c.url);
    expect(llamadas.some(u => u.includes('/products/60/variations'))).toBe(true);
    expect(llamadas.some(u => u.includes('/products/50/variations'))).toBe(false);
    const v = db.prepare('SELECT * FROM catalogo_cache WHERE id_woo=?').get(61);
    expect(v).toBeTruthy();
    expect(v.stock).toBe(9);
    db.close();
  });

  // Criterio 3: la poda de borrados SOLO corre en el barrido completo. Una corrida
  // incremental con universo parcial no debe borrar productos que simplemente no vinieron
  // porque no cambiaron desde la marca.
  it('la corrida incremental NO poda productos que no vinieron en su consulta parcial', async () => {
    const db = openDb(TEST_DB2);
    marcarComoRecienCompleto(db);
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, actualizado_en) VALUES (?,?,?,?,?,?,?)'
    ).run(70, 'Producto no tocado (no vino en el incremental)', 'FB-70', 'simple', null, 3, now);

    axios.request.mockResolvedValue({
      status: 200, headers: {},
      data: [{ id: 71, name: 'Producto modificado', sku: 'FB-71', type: 'simple', parent_id: 0, stock_quantity: 5 }],
    });

    await refrescarCatalogo(db, cfg);

    const rows = getCatalogo(db);
    expect(rows.map(r => r.id_woo).sort()).toEqual([70, 71]);
    db.close();
  });

  // Criterio 3 (parte 2): el barrido completo SÍ sigue podando como siempre.
  it('un barrido completo (forzarCompleto) poda un producto borrado en Woo', async () => {
    const db = openDb(TEST_DB2);
    marcarComoRecienCompleto(db);
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, actualizado_en) VALUES (?,?,?,?,?,?,?)'
    ).run(80, 'Producto borrado en Woo', 'FB-80', 'simple', null, 3, now);

    axios.request.mockResolvedValue({
      status: 200, headers: {},
      data: [{ id: 81, name: 'Producto vigente', sku: 'FB-81', type: 'simple', parent_id: 0, stock_quantity: 5 }],
    });

    await refrescarCatalogo(db, cfg, { forzarCompleto: true });

    const rows = getCatalogo(db);
    expect(rows.map(r => r.id_woo)).toEqual([81]);
    // Y no manda modified_after: es un barrido completo real.
    const [[llamada]] = axios.request.mock.calls;
    expect(llamada.url).not.toMatch(/modified_after/);
    db.close();
  });

  // Criterio 4: si una llamada a Woo falla, la marca no avanza y no se persiste catálogo
  // parcial (fail-closed).
  it('si la corrida falla, la marca catalogo_ultimo_refresco NO avanza', async () => {
    const db = openDb(TEST_DB2);
    marcarComoRecienCompleto(db);
    const marcaVieja = db.prepare("SELECT valor FROM sync_estado WHERE clave='catalogo_ultimo_refresco'").get().valor;

    axios.request
      .mockResolvedValueOnce({ status: 200, headers: {}, data: [
        { id: 90, name: 'Padre', sku: '', type: 'variable', parent_id: 0, stock_quantity: 0 },
      ] })
      .mockResolvedValueOnce({ status: 500, headers: {}, data: {} }); // falla la llamada de variaciones

    await expect(refrescarCatalogo(db, cfg)).rejects.toThrow(/WooCommerce API error 500/);

    const marcaNueva = db.prepare("SELECT valor FROM sync_estado WHERE clave='catalogo_ultimo_refresco'").get().valor;
    expect(marcaNueva).toBe(marcaVieja);
    db.close();
  });

  // Fallback de marca: si por algún motivo faltara catalogo_ultimo_refresco (no debería
  // pasar en operación normal: completo=false implica que ya hubo un barrido completo
  // previo, que siempre deja las dos marcas), la corrida incremental no debe explotar ni
  // caer a "sin marca" (que equivaldría a un completo disfrazado): usa catalogo_ultimo_completo.
  it('si falta catalogo_ultimo_refresco, la incremental usa catalogo_ultimo_completo como base', async () => {
    const db = openDb(TEST_DB2);
    const ahora = new Date().toISOString();
    db.prepare(`
      INSERT INTO sync_estado (clave, valor, actualizado_en) VALUES ('catalogo_ultimo_completo', ?, ?)
    `).run(ahora, ahora);
    axios.request.mockResolvedValue({ status: 200, headers: {}, data: [] });

    await refrescarCatalogo(db, cfg);

    const [[llamada]] = axios.request.mock.calls;
    expect(llamada.url).toMatch(/modified_after=/);
    db.close();
  });

  // El barrido completo periódico (red de seguridad) se dispara solo cuando ya pasó
  // INTERVALO_COMPLETO_MS (1h, provisorio — ver comentario en routes/woo.js) desde el
  // último completo, aunque no se fuerce por parámetro.
  it('dispara un barrido completo automático si pasó más de 1h desde el último completo', async () => {
    const db = openDb(TEST_DB2);
    const hace2h = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    db.prepare(`
      INSERT INTO sync_estado (clave, valor, actualizado_en) VALUES ('catalogo_ultimo_completo', ?, ?)
    `).run(hace2h, hace2h);
    db.prepare(`
      INSERT INTO sync_estado (clave, valor, actualizado_en) VALUES ('catalogo_ultimo_refresco', ?, ?)
    `).run(hace2h, hace2h);
    // Con productos reales (no vacío): el guard fail-closed de "0 productos" es para el caso
    // sospechoso, no aplica acá y no debe tapar que la marca sí avanza en un completo normal.
    axios.request.mockResolvedValue({
      status: 200, headers: {},
      data: [{ id: 95, name: 'Producto', sku: 'FB-95', type: 'simple', parent_id: 0, stock_quantity: 1 }],
    });

    await refrescarCatalogo(db, cfg); // sin forzarCompleto: debe detectar solo que toca completo

    const [[llamada]] = axios.request.mock.calls;
    expect(llamada.url).not.toMatch(/modified_after/);
    const marcaCompleto = db.prepare("SELECT valor FROM sync_estado WHERE clave='catalogo_ultimo_completo'").get();
    expect(marcaCompleto.valor).not.toBe(hace2h); // se actualizó
    db.close();
  });

  // Hallazgo del revisor: margen de solape sin cubrir. Si SOLAPE_INCREMENTAL_MS se rompiera
  // a 0, la marca guardada se usaría tal cual como `modified_after` — este test lo detecta
  // afirmando que el `modified_after` enviado es estrictamente ANTERIOR a la marca (por lo
  // menos los 5 min de margen), no igual a ella.
  it('el modified_after enviado tiene el margen de solape de ~5 min respecto de la marca guardada', async () => {
    const db = openDb(TEST_DB2);
    const marca = new Date(Date.now() - 20 * 60 * 1000).toISOString(); // hace 20 min, bien dentro de la ventana incremental (< 1h)
    db.prepare(`
      INSERT INTO sync_estado (clave, valor, actualizado_en) VALUES ('catalogo_ultimo_completo', ?, ?)
    `).run(marca, marca);
    db.prepare(`
      INSERT INTO sync_estado (clave, valor, actualizado_en) VALUES ('catalogo_ultimo_refresco', ?, ?)
    `).run(marca, marca);
    axios.request.mockResolvedValue({ status: 200, headers: {}, data: [] });

    await refrescarCatalogo(db, cfg);

    const [[llamada]] = axios.request.mock.calls;
    const m = llamada.url.match(/modified_after=([^&]+)/);
    expect(m).toBeTruthy();
    const modifiedAfter = new Date(decodeURIComponent(m[1])).getTime();
    const marcaMs = new Date(marca).getTime();
    expect(modifiedAfter).toBeLessThan(marcaMs); // no manda la marca tal cual
    const solapeMinutos = (marcaMs - modifiedAfter) / 60000;
    expect(solapeMinutos).toBeCloseTo(5, 1); // ~5 min de margen
    db.close();
  });

  // Hallazgo del revisor (BLOQUEANTE): con 0 resultados en incremental, la marca NO debe
  // avanzar — 0 es indistinguible entre "nada cambió" y "Woo falló en silencio", y avanzar
  // la marca en ese caso salteaba la ventana para siempre sin dejar rastro.
  it('con 0 resultados en incremental, catalogo_ultimo_refresco NO avanza (la ventana se reintenta)', async () => {
    const db = openDb(TEST_DB2);
    marcarComoRecienCompleto(db);
    const marcaVieja = db.prepare("SELECT valor FROM sync_estado WHERE clave='catalogo_ultimo_refresco'").get().valor;
    axios.request.mockResolvedValue({ status: 200, headers: {}, data: [] });

    const total = await refrescarCatalogo(db, cfg);

    expect(total).toBe(0);
    const marcaNueva = db.prepare("SELECT valor FROM sync_estado WHERE clave='catalogo_ultimo_refresco'").get().valor;
    expect(marcaNueva).toBe(marcaVieja);
    db.close();
  });
});

// Hallazgo del revisor (BLOQUEANTE): candado anti-solape en memoria, mismo patrón que
// _mlToWcEnCurso/_wcToMlEnCurso/_reconciliarStockEnCurso de routes/sync.js.
describe('refrescarCatalogo — candado anti-solape', () => {
  const TEST_DB3 = './test/tmp-woo-candado.sqlite';
  const cfg = { url: 'https://fusionbikes.com.ar', ck: 'ck_x', cs: 'cs_x' };

  afterEach(() => {
    if (fs.existsSync(TEST_DB3)) fs.unlinkSync(TEST_DB3);
    vi.resetAllMocks();
  });

  it('una segunda corrida disparada mientras la primera sigue en vuelo se omite (no duplica llamadas a Woo)', async () => {
    const db = openDb(TEST_DB3);
    let resolverPrimeraLlamada;
    const primeraLlamadaColgada = new Promise((r) => { resolverPrimeraLlamada = r; });
    let llamadas = 0;
    axios.request.mockImplementation(async () => {
      llamadas++;
      if (llamadas === 1) await primeraLlamadaColgada; // la 1ra corrida queda "en vuelo"
      return { status: 200, headers: {}, data: [] };
    });

    const p1 = refrescarCatalogo(db, cfg); // arranca y se cuelga en la 1ra llamada a Woo
    // Deja que arranque de verdad antes de disparar la segunda (microtask flush).
    await new Promise((r) => setTimeout(r, 0));
    const r2 = await refrescarCatalogo(db, cfg); // debe omitirse: la 1ra sigue en curso

    expect(r2).toMatchObject({ omitido: true, motivo: 'en_curso' });
    expect(llamadas).toBe(1); // la 2da corrida no llegó a pegarle a Woo

    resolverPrimeraLlamada();
    await p1; // deja terminar la 1ra corrida, no queda una promesa colgada
    db.close();
  });

  it('el candado se libera al terminar: una corrida posterior (ya no solapada) sí corre normal', async () => {
    const db = openDb(TEST_DB3);
    axios.request.mockResolvedValue({ status: 200, headers: {}, data: [] });

    const r1 = await refrescarCatalogo(db, cfg);
    const r2 = await refrescarCatalogo(db, cfg);

    expect(r1).not.toMatchObject({ omitido: true });
    expect(r2).not.toMatchObject({ omitido: true });
    db.close();
  });

  it('POST /catalogo/recargar devuelve {ok:true, omitido:true} si ya había una corrida en curso, no un falso total:0', async () => {
    const db = openDb(TEST_DB3);
    let resolverPrimeraLlamada;
    const primeraLlamadaColgada = new Promise((r) => { resolverPrimeraLlamada = r; });
    let llamadas = 0;
    axios.request.mockImplementation(async () => {
      llamadas++;
      if (llamadas === 1) await primeraLlamadaColgada;
      return { status: 200, headers: {}, data: [] };
    });
    const app = express();
    app.use(express.json());
    app.use('/api/woo', wooRouter(db, cfg));

    // Deja una corrida "en vuelo" llamando directo a la función (el candado es un mutex de
    // módulo, no depende de si se dispara por HTTP o por cron), y recién ahí golpea la ruta.
    const primeraEnVuelo = refrescarCatalogo(db, cfg, { forzarCompleto: true });
    await new Promise((r) => setTimeout(r, 10));
    const r2 = await request(app).post('/api/woo/catalogo/recargar');

    expect(r2.body).toMatchObject({ ok: true, omitido: true, motivo: 'en_curso' });
    expect(r2.body.total).toBeUndefined();

    resolverPrimeraLlamada();
    await primeraEnVuelo;
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
