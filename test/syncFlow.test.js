/**
 * Tests para los flujos de sincronización:
 *   syncMlToWc, syncWcToMl, procesarReintentos
 *
 * El código desplegado cambió respecto a versiones anteriores:
 *   - syncMlToWc ya no descuenta stock en WC: crea un PEDIDO en WooCommerce
 *     (POST /orders) y deja que WC reduzca el stock de forma nativa.
 *   - syncWcToMl solo actualiza publicaciones ACTIVAS (lee ml_publicaciones_cache);
 *     para variaciones usa el endpoint puntual /items/{id}/variations/{varId}.
 *   - procesarReintentos ya NO llama a ninguna API: solo envejece el contador de
 *     los errores viejos (los syncs principales ya reintentan de forma idempotente).
 *
 * Los mocks de mlFetch (ML) y wooFetch (WooCommerce) aíslan la orquestación sin
 * credenciales ni red. buscarEnCache/buildWooPath se usan reales (helpers puros de
 * DB). sleep() se acelera con fake timers para mantener el suite rápido.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import { syncMlToWc, syncWcToMl, procesarReintentos, limpiarVariacionesMuertas } from '../routes/sync.js';

vi.mock('../lib/mlClient.js', () => ({
  mlFetch: vi.fn(),
  bootstrapToken: vi.fn(),
  getAccessToken: vi.fn(),
}));
// wooFetch es la única dependencia de red del lado WooCommerce que usa el flujo
// (buscarEnCache/buildWooPath son puros y se dejan reales).
vi.mock('../routes/woo.js', () => ({
  wooFetch: vi.fn(),
}));

import { mlFetch } from '../lib/mlClient.js';
import { wooFetch } from '../routes/woo.js';

const TEST_DB = './test/tmp-syncflow.sqlite';

const CFG = {
  ml: { clientId: 'cid', clientSecret: 'cs', userId: '99999' },
  woo: { url: 'https://fusionbikes.com.ar', ck: 'ck_x', cs: 'cs_x' },
};

function seedMatcher(db) {
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en) VALUES (?, ?, ?, ?, ?)'
  ).run('MLA100|', 'BIKE-001', 'Bicicleta Simple', 'confirmar', now);
  db.prepare(
    'INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en) VALUES (?, ?, ?, ?, ?)'
  ).run('MLA200|987', 'CASCO-L', 'Casco L', 'asignar', now);
}

function seedCatalogo(db) {
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, actualizado_en) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(100, 'Bicicleta Simple', 'BIKE-001', 'simple', null, 5, now);
}

// Publicación ML en cache — syncWcToMl solo empuja stock a publicaciones activas.
function seedPublicacion(db, { clave, itemId, variationId = '', status = 'active' }) {
  db.prepare(
    'INSERT INTO ml_publicaciones_cache (clave, item_id, variation_id, status, actualizado_en) VALUES (?, ?, ?, ?, ?)'
  ).run(clave, itemId, variationId, status, new Date().toISOString());
}

describe('syncMlToWc', () => {
  let db;

  beforeEach(() => {
    db = openDb(TEST_DB);
    seedMatcher(db);
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('happy path: orden pagada → crea pedido en WC con el precio real de venta ML y marca procesada', async () => {
    seedCatalogo(db); // BIKE-001 → id_woo 100
    const orden = {
      id: 'ORD-001',
      date_created: new Date().toISOString(),
      order_items: [{ item: { id: 'MLA100', variation_id: '' }, quantity: 2, unit_price: 150 }],
    };
    mlFetch.mockResolvedValue({ status: 200, data: { results: [orden] } });
    wooFetch.mockImplementation(async (cfg, path, method = 'get') => {
      if (path === '/orders' && method === 'post') return { data: { id: 5001 } };
      return { data: { price: '999.99' } }; // catálogo Woo distinto — NO debe usarse
    });

    const p = syncMlToWc(db, CFG);
    await vi.runAllTimersAsync();
    await p;

    // El precio sale de la venta ML (unit_price 150 × qty 2 = 300), no del catálogo Woo
    const orderCall = wooFetch.mock.calls.find(c => c[1] === '/orders' && c[2] === 'post');
    expect(orderCall).toBeTruthy();
    expect(orderCall[3].line_items).toEqual([
      { quantity: 2, subtotal: '300.00', total: '300.00', product_id: 100 },
    ]);

    // Vínculo ML→WC persistido
    const pedido = db.prepare('SELECT * FROM ordenes_ml_wc_pedidos WHERE ml_order_id = ?').get('ORD-001');
    expect(pedido).toBeTruthy();
    expect(pedido.wc_order_id).toBe(5001);

    // Orden marcada como procesada
    const proc = db.prepare('SELECT * FROM ordenes_ml_procesadas WHERE order_id = ?').get('ORD-001');
    expect(proc).toBeTruthy();
    expect(proc.estado).toBe('ok');

    // log de sync ok con el id del pedido WC
    const log = db.prepare("SELECT * FROM sync_log WHERE direccion = 'ml_wc' AND clave = 'ORD-001'").get();
    expect(log).toBeTruthy();
    expect(log.estado).toBe('ok');
    expect(log.cant_nueva).toBe(5001);
  });

  // Bug 1 (regresión): el pedido WC debe grabar el precio REAL de venta ML, aunque
  // el catálogo Woo haya cambiado entre la venta y el sync. Caso real: WC 66275 /
  // ML 2000017564338280, vendido a $2.660.000, catálogo Woo $3.352.500 al sync.
  it('bug1: usa el unit_price de la venta ML, ignora el catálogo Woo cambiado', async () => {
    seedCatalogo(db);
    const orden = {
      id: '2000017564338280',
      date_created: new Date().toISOString(),
      order_items: [{ item: { id: 'MLA100', variation_id: '' }, quantity: 1, unit_price: 2660000 }],
    };
    mlFetch.mockResolvedValue({ status: 200, data: { results: [orden] } });
    wooFetch.mockImplementation(async (cfg, path, method = 'get') => {
      if (path === '/orders' && method === 'post') return { data: { id: 66275 } };
      return { data: { price: '3352500', regular_price: '3352500' } }; // catálogo al sync
    });

    const p = syncMlToWc(db, CFG);
    await vi.runAllTimersAsync();
    await p;

    const orderCall = wooFetch.mock.calls.find(c => c[1] === '/orders' && c[2] === 'post');
    expect(orderCall[3].line_items).toEqual([
      { quantity: 1, subtotal: '2660000.00', total: '2660000.00', product_id: 100 },
    ]);
  });

  // Bug 1 fail-closed: si ML no informó unit_price, no se inventa un precio.
  it('bug1: orden ML sin unit_price → fail-closed, item con error, sin pedido WC', async () => {
    seedCatalogo(db);
    const orden = {
      id: 'ORD-NOPRICE',
      date_created: new Date().toISOString(),
      order_items: [{ item: { id: 'MLA100', variation_id: '' }, quantity: 1 }], // sin unit_price
    };
    mlFetch.mockResolvedValue({ status: 200, data: { results: [orden] } });

    const p = syncMlToWc(db, CFG);
    await vi.runAllTimersAsync();
    await p;

    const log = db.prepare("SELECT * FROM sync_log WHERE estado = 'error' AND sku = 'BIKE-001'").get();
    expect(log).toBeTruthy();
    expect(log.error).toMatch(/unit_price/);
    // Nada válido → no se crea pedido WC
    expect(wooFetch.mock.calls.some(c => c[1] === '/orders' && c[2] === 'post')).toBe(false);
    const proc = db.prepare('SELECT * FROM ordenes_ml_procesadas WHERE order_id = ?').get('ORD-NOPRICE');
    expect(proc.estado).toBe('parcial');
  });

  // Bug 2: candado de reentrancia. Dos corridas en paralelo sobre la misma orden ML
  // no deben crear dos pedidos WC. La segunda invocación retorna sin hacer nada.
  it('bug2: candado impide corridas ML→WC concurrentes (sin doble pedido WC)', async () => {
    vi.useRealTimers(); // se controla el POST con una promesa diferida
    seedCatalogo(db);
    const orden = {
      id: 'ORD-CONC',
      date_created: new Date().toISOString(),
      order_items: [{ item: { id: 'MLA100', variation_id: '' }, quantity: 1, unit_price: 100 }],
    };
    mlFetch.mockResolvedValue({ status: 200, data: { results: [orden] } });

    let resolvePost;
    const postGate = new Promise(r => { resolvePost = r; });
    wooFetch.mockImplementation(async (cfg, path, method = 'get') => {
      if (path === '/orders' && method === 'post') {
        await postGate; // mantiene la primera corrida en vuelo
        return { data: { id: 7001 } };
      }
      return { data: {} };
    });

    const p1 = syncMlToWc(db, CFG); // toma el candado y queda esperando el POST
    const p2 = syncMlToWc(db, CFG); // debe salir de inmediato por el candado
    const r2 = await p2;
    expect(r2).toEqual({ omitido: true });

    // Mientras la primera sigue en vuelo, la segunda no disparó otro POST
    const postsAntes = wooFetch.mock.calls.filter(c => c[1] === '/orders' && c[2] === 'post').length;
    expect(postsAntes).toBe(1);

    resolvePost();
    const r1 = await p1;
    expect(r1).toEqual({ omitido: false });

    const posts = wooFetch.mock.calls.filter(c => c[1] === '/orders' && c[2] === 'post').length;
    expect(posts).toBe(1);
    const filas = db.prepare('SELECT COUNT(*) n FROM ordenes_ml_wc_pedidos WHERE ml_order_id = ?').get('ORD-CONC');
    expect(filas.n).toBe(1);
  });

  it('sale sin credenciales ML → retorna omitido:true', async () => {
    const r = await syncMlToWc(db, { ml: {}, woo: CFG.woo });
    expect(r).toEqual({ omitido: true });
  });

  it('idempotencia: orden ya procesada no se vuelve a procesar', async () => {
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO ordenes_ml_procesadas (order_id, fecha_orden, items_json, estado, procesado_en) VALUES (?, ?, ?, ?, ?)"
    ).run('ORD-DUP', now, '[]', 'ok', now);

    const orden = {
      id: 'ORD-DUP',
      date_created: now,
      order_items: [{ item: { id: 'MLA100', variation_id: '' }, quantity: 1 }],
    };
    mlFetch.mockResolvedValue({ status: 200, data: { results: [orden] } });

    const p = syncMlToWc(db, CFG);
    await vi.runAllTimersAsync();
    await p;

    // No debe haber intentado crear pedido en WC
    expect(wooFetch).not.toHaveBeenCalled();
  });

  it('sin_mapeo: item sin SKU asignado → log sin_mapeo, orden marcada parcial', async () => {
    const orden = {
      id: 'ORD-NOMATCH',
      date_created: new Date().toISOString(),
      order_items: [{ item: { id: 'MLA999', variation_id: '' }, quantity: 1 }],
    };
    mlFetch.mockResolvedValue({ status: 200, data: { results: [orden] } });

    const p = syncMlToWc(db, CFG);
    await vi.runAllTimersAsync();
    await p;

    const proc = db.prepare('SELECT * FROM ordenes_ml_procesadas WHERE order_id = ?').get('ORD-NOMATCH');
    expect(proc.estado).toBe('parcial');

    const log = db.prepare("SELECT * FROM sync_log WHERE estado = 'sin_mapeo'").get();
    expect(log).toBeTruthy();
    expect(log.clave).toBe('MLA999|');

    // Nada mapeable → no se crea pedido en WC
    expect(wooFetch).not.toHaveBeenCalled();
  });

  it('SKU mapeado ausente del catálogo WC → log error, orden marcada parcial', async () => {
    // Sin seedCatalogo: BIKE-001 no existe en catalogo_cache
    const orden = {
      id: 'ORD-NOCAT',
      date_created: new Date().toISOString(),
      order_items: [{ item: { id: 'MLA100', variation_id: '' }, quantity: 1 }],
    };
    mlFetch.mockResolvedValue({ status: 200, data: { results: [orden] } });

    const p = syncMlToWc(db, CFG);
    await vi.runAllTimersAsync();
    await p;

    const proc = db.prepare('SELECT * FROM ordenes_ml_procesadas WHERE order_id = ?').get('ORD-NOCAT');
    expect(proc.estado).toBe('parcial');

    const log = db.prepare("SELECT * FROM sync_log WHERE estado = 'error' AND sku = 'BIKE-001'").get();
    expect(log).toBeTruthy();
    expect(log.error).toMatch(/no encontrado/i);

    // No se llega a consultar precio ni a crear pedido en WC
    expect(wooFetch).not.toHaveBeenCalled();
  });

  it('sale sin credenciales ML → retorna sin hacer nada', async () => {
    const p = syncMlToWc(db, { ml: {}, woo: CFG.woo });
    await vi.runAllTimersAsync();
    await p;
    expect(mlFetch).not.toHaveBeenCalled();
  });
});

describe('syncWcToMl', () => {
  let db;

  beforeEach(() => {
    db = openDb(TEST_DB);
    seedMatcher(db);
    seedCatalogo(db);
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('publicación simple activa: PUT con available_quantity', async () => {
    seedPublicacion(db, { clave: 'MLA100|', itemId: 'MLA100', status: 'active' });
    // Sin entrada en ml_stock_estado → diff detectado
    mlFetch.mockResolvedValue({ status: 200, data: {} });

    const p = syncWcToMl(db, CFG);
    await vi.runAllTimersAsync();
    await p;

    expect(mlFetch).toHaveBeenCalledWith(
      db, CFG.ml, 'put', '/items/MLA100',
      { available_quantity: 5 }
    );

    const estado = db.prepare("SELECT * FROM ml_stock_estado WHERE clave = 'MLA100|'").get();
    expect(estado).toBeTruthy();
    expect(estado.cantidad_ml).toBe(5);

    const log = db.prepare("SELECT * FROM sync_log WHERE estado = 'ok' AND direccion = 'wc_ml'").get();
    expect(log).toBeTruthy();
  });

  it('publicación con variación activa: PUT al endpoint puntual de la variación', async () => {
    // Insertar en catalogo_cache y publicaciones_cache para la variación
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, actualizado_en) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(200, 'Casco L', 'CASCO-L', 'variation', 150, 3, now);
    seedPublicacion(db, { clave: 'MLA100|', itemId: 'MLA100', status: 'active' });
    seedPublicacion(db, { clave: 'MLA200|987', itemId: 'MLA200', variationId: '987', status: 'active' });

    mlFetch.mockResolvedValue({ status: 200, data: {} });

    const p = syncWcToMl(db, CFG);
    await vi.runAllTimersAsync();
    await p;

    // La variación usa el endpoint puntual /items/{id}/variations/{varId}
    const varCall = mlFetch.mock.calls.find(c => c[3] === '/items/MLA200/variations/987');
    expect(varCall).toBeTruthy();
    expect(varCall[4]).toEqual({ available_quantity: 3 });
  });

  it('error HTTP de ML → log error sin actualizar ml_stock_estado', async () => {
    seedPublicacion(db, { clave: 'MLA100|', itemId: 'MLA100', status: 'active' });
    mlFetch.mockResolvedValue({ status: 500, data: {} });

    const p = syncWcToMl(db, CFG);
    await vi.runAllTimersAsync();
    await p;

    const log = db.prepare("SELECT * FROM sync_log WHERE estado = 'error' AND direccion = 'wc_ml'").get();
    expect(log).toBeTruthy();
    expect(log.error).toMatch(/HTTP 500/);

    const estado = db.prepare("SELECT * FROM ml_stock_estado WHERE clave = 'MLA100|'").get();
    expect(estado).toBeUndefined();
  });

  it('SKU repetido en más de un producto de catalogo_cache: usa siempre el de menor stock (fail-closed), sin oscilar ni duplicar el PUT', async () => {
    // Incidente real 2026-07-25: BIKE-001 quedó cargado por error en dos productos WC
    // distintos (id_woo 100 con stock 5, id_woo 999 con stock 2). Sin deduplicar, el JOIN
    // multiplicaba la fila de la publicación ML y el stock empujado alternaba entre 5 y 2
    // según el orden interno de SQLite — a veces incluso con dos PUT por corrida (uno por
    // cada fila duplicada). id_woo 999 tiene menos stock pero un id_woo MAYOR a propósito,
    // para distinguir "menor stock" (el criterio correcto, fail-closed) de "id_woo más
    // bajo" (que hubiera elegido mal, 5 en vez de 2, arriesgando sobreventa en ML).
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, actualizado_en) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(999, 'Bicicleta Simple (duplicada)', 'BIKE-001', 'simple', null, 2, now);
    seedPublicacion(db, { clave: 'MLA100|', itemId: 'MLA100', status: 'active' });

    for (let i = 0; i < 3; i++) {
      mlFetch.mockClear();
      mlFetch.mockResolvedValue({ status: 200, data: {} });
      db.prepare("DELETE FROM ml_stock_estado WHERE clave = 'MLA100|'").run();

      const p = syncWcToMl(db, CFG);
      await vi.runAllTimersAsync();
      await p;

      // Una publicación → un solo PUT de stock por corrida, nunca dos (el bug original
      // también duplicaba la llamada a ML, no solo el valor final).
      expect(mlFetch).toHaveBeenCalledTimes(1);
      expect(mlFetch).toHaveBeenCalledWith(db, CFG.ml, 'put', '/items/MLA100', { available_quantity: 2 });

      const estado = db.prepare("SELECT * FROM ml_stock_estado WHERE clave = 'MLA100|'").get();
      expect(estado.cantidad_ml).toBe(2); // siempre el de menor stock, nunca 5
    }
  });

  it('SKU repetido en 3+ filas de catalogo_cache: sigue eligiendo el de menor stock, no solo entre las dos primeras', async () => {
    // El dedup usa ROW_NUMBER() OVER (PARTITION BY sku ORDER BY stock ASC, id_woo ASC) — hay
    // que confirmar que el criterio se sostiene con más de dos filas duplicadas (no es un caso
    // especial de "la primera vs la segunda"), y que el orden en que se insertan no importa.
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, actualizado_en) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(998, 'Bicicleta Simple (duplicada 2)', 'BIKE-001', 'simple', null, 1, now);
    db.prepare(
      'INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, actualizado_en) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(999, 'Bicicleta Simple (duplicada 3)', 'BIKE-001', 'simple', null, 7, now);
    seedPublicacion(db, { clave: 'MLA100|', itemId: 'MLA100', status: 'active' });
    mlFetch.mockResolvedValue({ status: 200, data: {} });

    const p = syncWcToMl(db, CFG);
    await vi.runAllTimersAsync();
    await p;

    // Entre 5 (id_woo 100, seedCatalogo), 1 (id_woo 998) y 7 (id_woo 999) gana el menor: 1.
    expect(mlFetch).toHaveBeenCalledTimes(1);
    expect(mlFetch).toHaveBeenCalledWith(db, CFG.ml, 'put', '/items/MLA100', { available_quantity: 1 });
  });

  it('SKU repetido con stock empatado entre dos filas: desempata por id_woo (determinístico, no oscila)', async () => {
    // Con stock igual, ROW_NUMBER ordena también por id_woo ASC — el resultado debe ser
    // siempre el mismo sin importar el orden físico de inserción/lectura de SQLite.
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, actualizado_en) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(999, 'Bicicleta Simple (duplicada, mismo stock)', 'BIKE-001', 'simple', null, 5, now);
    seedPublicacion(db, { clave: 'MLA100|', itemId: 'MLA100', status: 'active' });

    for (let i = 0; i < 3; i++) {
      mlFetch.mockClear();
      mlFetch.mockResolvedValue({ status: 200, data: {} });
      db.prepare("DELETE FROM ml_stock_estado WHERE clave = 'MLA100|'").run();

      const p = syncWcToMl(db, CFG);
      await vi.runAllTimersAsync();
      await p;

      // Empate 5 vs 5: gana id_woo 100 (menor), siempre el mismo resultado en cada corrida.
      expect(mlFetch).toHaveBeenCalledTimes(1);
      expect(mlFetch).toHaveBeenCalledWith(db, CFG.ml, 'put', '/items/MLA100', { available_quantity: 5 });
    }
  });

  it('publicación no activa (paused) → se saltea sin PUT ni error', async () => {
    seedPublicacion(db, { clave: 'MLA100|', itemId: 'MLA100', status: 'paused' });
    mlFetch.mockResolvedValue({ status: 200, data: {} });

    const p = syncWcToMl(db, CFG);
    await vi.runAllTimersAsync();
    await p;

    // No se intenta el PUT de stock sobre una publicación pausada
    expect(mlFetch).not.toHaveBeenCalled();
    const estado = db.prepare("SELECT * FROM ml_stock_estado WHERE clave = 'MLA100|'").get();
    expect(estado).toBeUndefined();
  });

  it('ML dice "doesn\'t have a variation" → borra el mapeo, loguea remapeo_requerido y DESCARTA la clave', async () => {
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, actualizado_en) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(200, 'Casco L', 'CASCO-L', 'variation', 150, 3, now);
    seedPublicacion(db, { clave: 'MLA200|987', itemId: 'MLA200', variationId: '987', status: 'active' });

    mlFetch.mockResolvedValue({
      status: 400,
      data: { cause: [{ message: "Item MLA200 doesn't have a variation with id 987" }] },
    });

    const p = syncWcToMl(db, CFG);
    await vi.runAllTimersAsync();
    await p;

    // mapeo borrado
    expect(db.prepare("SELECT 1 FROM sku_matcher_decisiones WHERE clave='MLA200|987'").get()).toBeUndefined();
    // trail de auditoría conservado
    expect(db.prepare("SELECT 1 FROM sync_log WHERE clave='MLA200|987' AND estado='remapeo_requerido'").get()).toBeTruthy();
    // descartada → no vuelve a aparecer en ninguna vista de atención
    expect(db.prepare("SELECT 1 FROM errores_descartados WHERE clave='MLA200|987'").get()).toBeTruthy();
  });

  it('sin diff → mlFetch no es llamado', async () => {
    seedPublicacion(db, { clave: 'MLA100|', itemId: 'MLA100', status: 'active' });
    // Insertar ml_stock_estado con el mismo valor que el cache
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO ml_stock_estado (clave, sku, cantidad_ml, actualizado_en) VALUES (?, ?, ?, ?)'
    ).run('MLA100|', 'BIKE-001', 5, now);

    const p = syncWcToMl(db, CFG);
    await vi.runAllTimersAsync();
    const r = await p;

    expect(mlFetch).not.toHaveBeenCalled();
    expect(r).toEqual({ omitido: false });
  });

  it('caso normal (sin candado activo) → retorna omitido:false', async () => {
    seedPublicacion(db, { clave: 'MLA100|', itemId: 'MLA100', status: 'active' });
    mlFetch.mockResolvedValue({ status: 200, data: {} });

    const p = syncWcToMl(db, CFG);
    await vi.runAllTimersAsync();
    const r = await p;

    expect(r).toEqual({ omitido: false });
  });

  it('sale sin credenciales ML → retorna omitido:true', async () => {
    const r = await syncWcToMl(db, { ml: {}, woo: CFG.woo });
    expect(r).toEqual({ omitido: true });
  });

  // Bug 2 (candado análogo): dos corridas WC→ML en paralelo. La segunda debe
  // salir de inmediato con omitido:true, sin volver a llamar a mlFetch mientras
  // la primera sigue en vuelo.
  it('candado impide corridas WC→ML concurrentes (segunda omitido:true, sin doble PUT)', async () => {
    vi.useRealTimers(); // se controla el PUT con una promesa diferida
    seedPublicacion(db, { clave: 'MLA100|', itemId: 'MLA100', status: 'active' });

    let resolvePut;
    const putGate = new Promise(r => { resolvePut = r; });
    mlFetch.mockImplementation(async () => {
      await putGate;
      return { status: 200, data: {} };
    });

    const p1 = syncWcToMl(db, CFG); // toma el candado y queda esperando el PUT
    const p2 = syncWcToMl(db, CFG); // debe salir de inmediato por el candado
    const r2 = await p2;
    expect(r2).toEqual({ omitido: true });

    const llamadasAntes = mlFetch.mock.calls.length;
    expect(llamadasAntes).toBe(1);

    resolvePut();
    const r1 = await p1;
    expect(r1).toEqual({ omitido: false });

    expect(mlFetch.mock.calls.length).toBe(1);
  });
});

describe('limpiarVariacionesMuertas', () => {
  let db;

  beforeEach(() => {
    db = openDb(TEST_DB);
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  // ML devuelve el item con sus variaciones actuales. MLA_UNREACH se omite (no lo devuelve).
  function mockMlItems() {
    mlFetch.mockImplementation(async (d, cfg, method, path) => {
      if (typeof path === 'string' && path.startsWith('/items?ids=')) {
        const ids = new URLSearchParams(path.split('?')[1]).get('ids').split(',');
        const data = ids
          .filter(id => id !== 'MLA_UNREACH')
          .map(id => ({
            code: 200,
            body: id === 'MLA_LIVE'
              ? { id, status: 'active', variations: [{ id: 222 }] }   // la variación 222 sigue viva
              : { id, status: 'active', variations: [] },             // simple → sin variaciones
          }));
        return { status: 200, data };
      }
      return { status: 200, data: {} };
    });
  }

  function seedDecision(clave, sku, accion = 'asignar') {
    db.prepare('INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en) VALUES (?, ?, ?, ?, ?)')
      .run(clave, sku, null, accion, new Date().toISOString());
  }

  it('descarta variaciones muertas, conserva las vivas y saltea las que ML no confirma (fail-closed)', async () => {
    seedDecision('MLA_DEAD|111', 'FB-D');       // item ahora simple → variación muerta
    seedDecision('MLA_LIVE|222', 'FB-L');       // variación sigue existiendo → intacta
    seedDecision('MLA_UNREACH|333', 'FB-U');    // ML no devuelve el item → no se toca
    mockMlItems();

    const p = limpiarVariacionesMuertas(db, CFG.ml);
    await vi.runAllTimersAsync();
    const res = await p;

    expect(db.prepare("SELECT 1 FROM sku_matcher_decisiones WHERE clave='MLA_DEAD|111'").get()).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM errores_descartados WHERE clave='MLA_DEAD|111'").get()).toBeTruthy();

    expect(db.prepare("SELECT 1 FROM sku_matcher_decisiones WHERE clave='MLA_LIVE|222'").get()).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM errores_descartados WHERE clave='MLA_LIVE|222'").get()).toBeUndefined();

    expect(db.prepare("SELECT 1 FROM sku_matcher_decisiones WHERE clave='MLA_UNREACH|333'").get()).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM errores_descartados WHERE clave='MLA_UNREACH|333'").get()).toBeUndefined();

    expect(res.muertas).toBe(1);
    expect(res.saltados).toBe(1);
  });

  it('también descarta claves remapeo_requerido pendientes que ML confirma muertas', async () => {
    // Sin decisión activa; solo un log remapeo_requerido pendiente de una variación muerta.
    db.prepare(
      "INSERT INTO sync_log (direccion, clave, sku, estado, creado_en, actualizado_en) VALUES ('wc_ml', 'MLA_DEAD|999', 'FB-Z', 'remapeo_requerido', ?, ?)"
    ).run(new Date().toISOString(), new Date().toISOString());
    mockMlItems();

    const p = limpiarVariacionesMuertas(db, CFG.ml);
    await vi.runAllTimersAsync();
    const res = await p;

    expect(db.prepare("SELECT 1 FROM errores_descartados WHERE clave='MLA_DEAD|999'").get()).toBeTruthy();
    expect(res.muertas).toBe(1);
  });

  it('no toca decisiones de publicaciones simples (sin variation_id)', async () => {
    seedDecision('MLA_SIMPLE|', 'FB-S', 'confirmar');
    mockMlItems();

    const p = limpiarVariacionesMuertas(db, CFG.ml);
    await vi.runAllTimersAsync();
    await p;

    expect(db.prepare("SELECT 1 FROM sku_matcher_decisiones WHERE clave='MLA_SIMPLE|'").get()).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM errores_descartados WHERE clave='MLA_SIMPLE|'").get()).toBeUndefined();
  });
});

describe('procesarReintentos', () => {
  let db;

  beforeEach(() => {
    db = openDb(TEST_DB);
    seedMatcher(db);
    seedCatalogo(db);
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  function insertErrorLog(db, { direccion = 'wc_ml', clave = 'MLA100|', sku = 'BIKE-001', intentos = 0 } = {}) {
    const now = new Date().toISOString();
    const r = db.prepare(
      "INSERT INTO sync_log (direccion, clave, sku, cant_anterior, cant_nueva, estado, error, intentos, creado_en, actualizado_en) VALUES (?, ?, ?, ?, ?, 'error', 'fallo previo', ?, ?, ?)"
    ).run(direccion, clave, sku, 5, 3, intentos, now, now);
    return r.lastInsertRowid;
  }

  // procesarReintentos ya no reintenta contra la API: solo envejece el contador
  // (los syncs principales reintentan de forma idempotente cada ciclo).
  it('envejece un error wc_ml pendiente sin llamar a la API', async () => {
    insertErrorLog(db, { direccion: 'wc_ml', intentos: 0 });

    const p = procesarReintentos(db, CFG);
    await vi.runAllTimersAsync();
    await p;

    expect(mlFetch).not.toHaveBeenCalled();
    const log = db.prepare("SELECT estado, intentos FROM sync_log WHERE direccion = 'wc_ml'").get();
    expect(log.estado).toBe('error'); // sigue pendiente, solo envejeció
    expect(log.intentos).toBe(1);

    // No hay upsert de estado de stock (el proceso ya no toca la API)
    const estado = db.prepare("SELECT * FROM ml_stock_estado WHERE clave = 'MLA100|'").get();
    expect(estado).toBeUndefined();
  });

  it('envejece un error ml_wc pendiente sin llamar a la API', async () => {
    insertErrorLog(db, { direccion: 'ml_wc', clave: 'MLA100|', sku: 'BIKE-001', intentos: 2 });

    const p = procesarReintentos(db, CFG);
    await vi.runAllTimersAsync();
    await p;

    expect(mlFetch).not.toHaveBeenCalled();
    const log = db.prepare("SELECT estado, intentos FROM sync_log WHERE direccion = 'ml_wc'").get();
    expect(log.estado).toBe('error');
    expect(log.intentos).toBe(3);
  });

  it('MAX_RETRIES alcanzado (intentos=4) → estado=agotado', async () => {
    insertErrorLog(db, { intentos: 4 }); // 4 + 1 = 5 >= MAX_RETRIES

    const p = procesarReintentos(db, CFG);
    await vi.runAllTimersAsync();
    await p;

    const log = db.prepare('SELECT estado, intentos FROM sync_log').get();
    expect(log.estado).toBe('agotado');
    expect(log.intentos).toBe(5);
  });

  it('error transitorio sin agotar reintentos → estado=error, intentos++', async () => {
    insertErrorLog(db, { intentos: 1 });

    const p = procesarReintentos(db, CFG);
    await vi.runAllTimersAsync();
    await p;

    const log = db.prepare('SELECT estado, intentos FROM sync_log').get();
    expect(log.estado).toBe('error');
    expect(log.intentos).toBe(2);
  });

  it('sin credenciales ML → no procesa nada', async () => {
    insertErrorLog(db);

    const p = procesarReintentos(db, { ml: {}, woo: CFG.woo });
    await vi.runAllTimersAsync();
    await p;

    expect(mlFetch).not.toHaveBeenCalled();
    const log = db.prepare('SELECT estado, intentos FROM sync_log').get();
    expect(log.estado).toBe('error'); // sin modificar
    expect(log.intentos).toBe(0);
  });
});

// ─── Fix duplicado por timeout del POST /orders (2026-07-28) ──────────────────
//
// Hueco cerrado: si el POST /orders a Woo tiene exito en el servidor pero la respuesta
// se pierde/timeoutea del lado del cliente, el codigo viejo borraba la reserva atomica y
// el proximo ciclo del cron creaba un pedido DUPLICADO real. Ahora, antes de liberar la
// reserva, se verifica contra la API de Woo si el pedido ya existe (meta _ml_order_id).
describe('syncMlToWc — timeout del POST /orders (verificacion anti-duplicado)', () => {
  let db;

  beforeEach(() => {
    db = openDb(TEST_DB);
    seedMatcher(db);
    seedCatalogo(db);
    vi.clearAllMocks();
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  function ordenSimple(id) {
    return {
      id,
      date_created: new Date().toISOString(),
      order_items: [{ item: { id: 'MLA100', variation_id: '' }, quantity: 1, unit_price: 100 }],
    };
  }

  it('POST timeoutea pero el pedido SI existe en Woo → completa la reserva con el id real, sin duplicar', async () => {
    const orden = ordenSimple('ORD-TIMEOUT-OK');
    mlFetch.mockResolvedValue({ status: 200, data: { results: [orden] } });

    wooFetch.mockImplementation(async (cfg, path, method = 'get') => {
      if (path === '/orders' && method === 'post') {
        throw new Error('timeout of 20000ms exceeded');
      }
      if (path.startsWith('/orders?')) {
        // Woo si habia creado el pedido: lo devuelve con el meta correspondiente
        return {
          data: [
            { id: 66542, meta_data: [{ key: '_ml_order_id', value: 'ORD-TIMEOUT-OK' }] },
          ],
        };
      }
      return { data: {} };
    });

    await syncMlToWc(db, CFG);

    // Un solo POST: no se creo un segundo pedido
    const posts = wooFetch.mock.calls.filter(c => c[1] === '/orders' && c[2] === 'post');
    expect(posts).toHaveLength(1);

    // Reserva completada con el wc_order_id real encontrado en Woo
    const pedido = db.prepare('SELECT * FROM ordenes_ml_wc_pedidos WHERE ml_order_id = ?').get('ORD-TIMEOUT-OK');
    expect(pedido).toBeTruthy();
    expect(pedido.wc_order_id).toBe(66542);

    // Marcada como procesada → el cron no la reintenta
    const proc = db.prepare('SELECT * FROM ordenes_ml_procesadas WHERE order_id = ?').get('ORD-TIMEOUT-OK');
    expect(proc.estado).toBe('ok');

    const log = db.prepare("SELECT * FROM sync_log WHERE clave = 'ORD-TIMEOUT-OK'").get();
    expect(log.estado).toBe('ok');
    expect(log.cant_nueva).toBe(66542);
  });

  it('no confia en el filtro por meta de Woo: si devuelve pedidos ajenos, NO los toma como propios', async () => {
    const orden = ordenSimple('ORD-META-AJENA');
    mlFetch.mockResolvedValue({ status: 200, data: { results: [orden] } });

    wooFetch.mockImplementation(async (cfg, path, method = 'get') => {
      if (path === '/orders' && method === 'post') throw new Error('socket hang up');
      if (path.startsWith('/orders?')) {
        // Woo ignoro el filtro y devolvio los ultimos pedidos, de OTRAS ventas
        return {
          data: [
            { id: 999, meta_data: [{ key: '_ml_order_id', value: 'OTRA-ORDEN' }] },
            { id: 998, meta_data: [] },
          ],
        };
      }
      return { data: {} };
    });

    await syncMlToWc(db, CFG);

    // Ningun pedido ajeno adoptado → reserva liberada para reintento
    const pedido = db.prepare('SELECT * FROM ordenes_ml_wc_pedidos WHERE ml_order_id = ?').get('ORD-META-AJENA');
    expect(pedido).toBeUndefined();
  });

  it('POST falla y el pedido NO existe en Woo → libera la reserva, permite reintento (regresion)', async () => {
    const orden = ordenSimple('ORD-TIMEOUT-NO');
    mlFetch.mockResolvedValue({ status: 200, data: { results: [orden] } });

    wooFetch.mockImplementation(async (cfg, path, method = 'get') => {
      if (path === '/orders' && method === 'post') throw new Error('WooCommerce API error 500');
      if (path.startsWith('/orders?')) return { data: [] };
      return { data: {} };
    });

    await syncMlToWc(db, CFG);

    const pedido = db.prepare('SELECT * FROM ordenes_ml_wc_pedidos WHERE ml_order_id = ?').get('ORD-TIMEOUT-NO');
    expect(pedido).toBeUndefined(); // reserva liberada
    const proc = db.prepare('SELECT * FROM ordenes_ml_procesadas WHERE order_id = ?').get('ORD-TIMEOUT-NO');
    expect(proc).toBeUndefined(); // no marcada como procesada → reintentable
    const log = db.prepare("SELECT * FROM sync_log WHERE clave = 'ORD-TIMEOUT-NO'").get();
    expect(log.estado).toBe('error');
  });

  it('POST falla y la verificacion TAMBIEN falla → fail-closed: la reserva NO se libera', async () => {
    const orden = ordenSimple('ORD-TIMEOUT-CIEGO');
    mlFetch.mockResolvedValue({ status: 200, data: { results: [orden] } });

    wooFetch.mockImplementation(async (cfg, path, method = 'get') => {
      if (path === '/orders' && method === 'post') throw new Error('timeout of 20000ms exceeded');
      if (path.startsWith('/orders?')) throw new Error('ECONNREFUSED');
      return { data: {} };
    });

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await syncMlToWc(db, CFG);
    errSpy.mockRestore();

    // Reserva retenida (wc_order_id sigue en 0) → ningun ciclo posterior puede duplicar
    const pedido = db.prepare('SELECT * FROM ordenes_ml_wc_pedidos WHERE ml_order_id = ?').get('ORD-TIMEOUT-CIEGO');
    expect(pedido).toBeTruthy();
    expect(pedido.wc_order_id).toBe(0);

    const log = db.prepare("SELECT * FROM sync_log WHERE clave = 'ORD-TIMEOUT-CIEGO'").get();
    expect(log.estado).toBe('error');
    expect(log.error).toMatch(/fail-closed/);

    // La verificacion reintenta con backoff antes de rendirse (4 intentos)
    const gets = wooFetch.mock.calls.filter(c => String(c[1]).startsWith('/orders?'));
    expect(gets.length).toBe(4);
  }, 30000);

  it('fail-closed: la limpieza de reservas abandonadas (60min) NO libera una reserva retenida', async () => {
    const orden = ordenSimple('ORD-RETENIDA');
    mlFetch.mockResolvedValue({ status: 200, data: { results: [orden] } });
    wooFetch.mockImplementation(async (cfg, path, method = 'get') => {
      if (path === '/orders' && method === 'post') throw new Error('timeout of 20000ms exceeded');
      if (path.startsWith('/orders?')) throw new Error('ECONNREFUSED');
      return { data: {} };
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await syncMlToWc(db, CFG);

    // Se envejece la reserva mas alla del umbral de 60min y se vuelve a correr el sync
    db.prepare('UPDATE ordenes_ml_wc_pedidos SET creado_en = ? WHERE ml_order_id = ?')
      .run(new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(), 'ORD-RETENIDA');
    await syncMlToWc(db, CFG);
    errSpy.mockRestore();

    const pedido = db.prepare('SELECT * FROM ordenes_ml_wc_pedidos WHERE ml_order_id = ?').get('ORD-RETENIDA');
    expect(pedido).toBeTruthy();
    expect(pedido.wc_order_id).toBe(0);
    // Y no se disparo un segundo POST de creacion
    const posts = wooFetch.mock.calls.filter(c => c[1] === '/orders' && c[2] === 'post');
    expect(posts).toHaveLength(1);
  }, 30000);

  // Hallazgo #1 del review: si `yaCreado` contara la reserva retenida, el ciclo siguiente
  // sellaria la orden como 'ok' en ordenes_ml_procesadas y la venta de ML se perderia en
  // silencio (el panel filtra wc_order_id<>0 y las cancelaciones la saltean).
  it('fail-closed: el ciclo siguiente NO sella la orden como procesada mientras la reserva este retenida', async () => {
    const orden = ordenSimple('ORD-NO-SELLAR');
    mlFetch.mockResolvedValue({ status: 200, data: { results: [orden] } });
    wooFetch.mockImplementation(async (cfg, path, method = 'get') => {
      if (path === '/orders' && method === 'post') throw new Error('timeout of 20000ms exceeded');
      if (path.startsWith('/orders?')) throw new Error('ECONNREFUSED');
      return { data: {} };
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await syncMlToWc(db, CFG);
    await syncMlToWc(db, CFG); // segundo ciclo, sin tocar nada a mano
    errSpy.mockRestore();

    // Nunca se marca procesada: la orden sigue siendo visible como pendiente real
    const proc = db.prepare('SELECT * FROM ordenes_ml_procesadas WHERE order_id = ?').get('ORD-NO-SELLAR');
    expect(proc).toBeUndefined();
    // Y la reserva sigue retenida (ningun ciclo la libera ni crea un segundo pedido)
    const pedido = db.prepare('SELECT * FROM ordenes_ml_wc_pedidos WHERE ml_order_id = ?').get('ORD-NO-SELLAR');
    expect(pedido.wc_order_id).toBe(0);
    expect(pedido.retenido_en).toBeTruthy();
    const posts = wooFetch.mock.calls.filter(c => c[1] === '/orders' && c[2] === 'post');
    expect(posts).toHaveLength(1);
  }, 30000);

  // Hallazgo #5: un 4xx significa que Woo recibio y rechazo la request -> no hay pedido
  // creado, no hace falta verificar (ni pagar el costo de 4 intentos con backoff).
  it('POST rechazado con 4xx → libera la reserva sin verificar en Woo', async () => {
    const orden = ordenSimple('ORD-400');
    mlFetch.mockResolvedValue({ status: 200, data: { results: [orden] } });
    wooFetch.mockImplementation(async (cfg, path, method = 'get') => {
      if (path === '/orders' && method === 'post') throw new Error('WooCommerce API error 400');
      if (path.startsWith('/orders?')) return { data: [] };
      return { data: {} };
    });

    await syncMlToWc(db, CFG);

    const gets = wooFetch.mock.calls.filter(c => String(c[1]).startsWith('/orders?'));
    expect(gets).toHaveLength(0); // no se verifico
    expect(db.prepare('SELECT * FROM ordenes_ml_wc_pedidos WHERE ml_order_id = ?').get('ORD-400')).toBeUndefined();
  });

  // Hallazgo #4: un 200 con cuerpo que no es lista (HTML de un WAF) no es certeza de
  // inexistencia -> no concluyente -> fail-closed, no liberar.
  it('respuesta de Woo con forma inesperada → no concluyente, fail-closed', async () => {
    const orden = ordenSimple('ORD-WAF');
    mlFetch.mockResolvedValue({ status: 200, data: { results: [orden] } });
    wooFetch.mockImplementation(async (cfg, path, method = 'get') => {
      if (path === '/orders' && method === 'post') throw new Error('timeout of 20000ms exceeded');
      if (path.startsWith('/orders?')) return { data: '<html>Access denied</html>' };
      return { data: {} };
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await syncMlToWc(db, CFG);
    errSpy.mockRestore();

    const pedido = db.prepare('SELECT * FROM ordenes_ml_wc_pedidos WHERE ml_order_id = ?').get('ORD-WAF');
    expect(pedido.wc_order_id).toBe(0);
    expect(pedido.retenido_en).toBeTruthy();
  }, 30000);

  // Hallazgo #3: sin paginar, con >100 pedidos nuevos en la ventana el pedido creado no
  // aparecia en la unica pagina consultada -> falso negativo -> duplicado.
  it('pagina la verificacion: encuentra el pedido aunque este en la 2da pagina', async () => {
    const orden = ordenSimple('ORD-PAG');
    mlFetch.mockResolvedValue({ status: 200, data: { results: [orden] } });
    const pagina1 = Array.from({ length: 100 }, (_, k) => ({ id: 1000 + k, meta_data: [] }));
    wooFetch.mockImplementation(async (cfg, path, method = 'get') => {
      if (path === '/orders' && method === 'post') throw new Error('timeout of 20000ms exceeded');
      if (path.startsWith('/orders?')) {
        expect(path).toContain('after=');
        if (path.includes('&page=1&')) return { data: pagina1 };
        return { data: [{ id: 66543, meta_data: [{ key: '_ml_order_id', value: 'ORD-PAG' }] }] };
      }
      return { data: {} };
    });

    await syncMlToWc(db, CFG);

    const pedido = db.prepare('SELECT * FROM ordenes_ml_wc_pedidos WHERE ml_order_id = ?').get('ORD-PAG');
    expect(pedido.wc_order_id).toBe(66543);
    expect(pedido.retenido_en).toBeNull();
  }, 30000);
});

// ─── Tests agregados por tester (cobertura de casos borde del fix) ─────────────

describe('syncMlToWc — reserva atomica entre procesos concurrentes (sin candado en memoria)', () => {
  let db;

  beforeEach(() => {
    db = openDb(TEST_DB);
    seedMatcher(db);
    seedCatalogo(db);
    vi.clearAllMocks();
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  // El candado en memoria (_mlToWcEnCurso) solo protege corridas concurrentes DENTRO del
  // mismo proceso Node — ya cubierto por 'bug2' mas arriba. La protección real contra dos
  // PROCESOS Node distintos corriendo el cron a la vez (el incidente real del 2026-07-25) es
  // el INSERT atómico sobre la PK ml_order_id en ordenes_ml_wc_pedidos. Este test simula esa
  // situación abriendo una SEGUNDA conexión a la misma DB (como si fuera otro proceso, sin
  // el candado en memoria del primero) y disparando el mismo INSERT de reserva sin await
  // entre medio: solo una de las dos debe ganar la fila, la otra debe fallar por PK.
  it('dos "procesos" (dos conexiones) reservando la misma orden ML en simultaneo: solo uno gana, el otro falla por PK', async () => {
    const dbOtroProceso = openDb(TEST_DB);
    try {
      const ahora = new Date().toISOString();
      const insertar = () => db.prepare(`
        INSERT INTO ordenes_ml_wc_pedidos (ml_order_id, wc_order_id, comprador_json, creado_en)
        VALUES (?, 0, NULL, ?)
      `).run('ORD-RACE-DB', ahora);
      const insertarOtro = () => dbOtroProceso.prepare(`
        INSERT INTO ordenes_ml_wc_pedidos (ml_order_id, wc_order_id, comprador_json, creado_en)
        VALUES (?, 0, NULL, ?)
      `).run('ORD-RACE-DB', ahora);

      // Disparados "casi en simultaneo": sin ningun await entre ambos intentos (better-sqlite3
      // es sincrono, asi que esto reproduce fielmente la carrera real: el segundo INSERT
      // encuentra la fila ya reservada por el primero).
      let errorSegundo = null;
      insertar();
      try {
        insertarOtro();
      } catch (e) {
        errorSegundo = e;
      }

      expect(errorSegundo).toBeTruthy();
      expect(errorSegundo.message).toMatch(/UNIQUE|PRIMARY ?KEY/i);

      // Una sola fila de reserva para la orden, sin duplicado.
      const filas = db.prepare('SELECT COUNT(*) n FROM ordenes_ml_wc_pedidos WHERE ml_order_id = ?').get('ORD-RACE-DB');
      expect(filas.n).toBe(1);
    } finally {
      dbOtroProceso.close();
    }
  });

  // Reproduce el mismo escenario pero a través del flujo real completo: dos llamadas a
  // syncMlToWc para la MISMA orden, disparadas sin await entre ellas, sobre la misma DB.
  // El candado en memoria ya hace que la segunda salga con omitido:true (test 'bug2'); acá
  // se confirma además que, aunque el candado no existiera (dos procesos reales), la orden
  // termina con un solo pedido WC creado — nunca dos — porque wooFetch('/orders','post')
  // solo se llama una vez.
  it('dos llamadas a syncMlToWc sin await entre ellas para la misma orden: nunca se crea un pedido WC duplicado', async () => {
    const orden = {
      id: 'ORD-RACE-FLUJO',
      date_created: new Date().toISOString(),
      order_items: [{ item: { id: 'MLA100', variation_id: '' }, quantity: 1, unit_price: 100 }],
    };
    mlFetch.mockResolvedValue({ status: 200, data: { results: [orden] } });
    let resolvePost;
    const postGate = new Promise(r => { resolvePost = r; });
    wooFetch.mockImplementation(async (cfg, path, method = 'get') => {
      if (path === '/orders' && method === 'post') {
        await postGate;
        return { data: { id: 8123 } };
      }
      return { data: {} };
    });

    const p1 = syncMlToWc(db, CFG);
    const p2 = syncMlToWc(db, CFG); // disparada sin await entre p1 y p2
    resolvePost();
    await Promise.all([p1, p2]);

    const posts = wooFetch.mock.calls.filter(c => c[1] === '/orders' && c[2] === 'post');
    expect(posts).toHaveLength(1);
    const filas = db.prepare('SELECT COUNT(*) n FROM ordenes_ml_wc_pedidos WHERE ml_order_id = ?').get('ORD-RACE-FLUJO');
    expect(filas.n).toBe(1);
  }, 30000);
});

describe('syncMlToWc — recuperacion manual de una reserva retenida', () => {
  let db;

  beforeEach(() => {
    db = openDb(TEST_DB);
    seedMatcher(db);
    seedCatalogo(db);
    vi.clearAllMocks();
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  function ordenSimple(id) {
    return {
      id,
      date_created: new Date().toISOString(),
      order_items: [{ item: { id: 'MLA100', variation_id: '' }, quantity: 1, unit_price: 100 }],
    };
  }

  // Documentado en el propio código (comentario del catch de verificación): si NO existe el
  // pedido en Woo, la recuperación manual es borrar la fila retenida y dejar que el próximo
  // ciclo del cron reintente solo. Este test confirma que ese camino de recuperación funciona
  // de punta a punta: primero se retiene por fail-closed, un "operador" borra la fila, y el
  // siguiente ciclo reintenta y esta vez tiene éxito — sin que la orden haya quedado sellada
  // como 'ok' de forma prematura en ningún momento intermedio.
  it('operador borra la fila retenida a mano → el siguiente ciclo reintenta y esta vez tiene exito', async () => {
    const orden = ordenSimple('ORD-RECUPERA');
    mlFetch.mockResolvedValue({ status: 200, data: { results: [orden] } });

    // Ciclo 1: POST timeoutea, verificacion tambien falla → fail-closed, reserva retenida.
    wooFetch.mockImplementation(async (cfg, path, method = 'get') => {
      if (path === '/orders' && method === 'post') throw new Error('timeout of 20000ms exceeded');
      if (path.startsWith('/orders?')) throw new Error('ECONNREFUSED');
      return { data: {} };
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await syncMlToWc(db, CFG);
    errSpy.mockRestore();

    let pedido = db.prepare('SELECT * FROM ordenes_ml_wc_pedidos WHERE ml_order_id = ?').get('ORD-RECUPERA');
    expect(pedido.wc_order_id).toBe(0);
    expect(pedido.retenido_en).toBeTruthy();
    let proc = db.prepare('SELECT * FROM ordenes_ml_procesadas WHERE order_id = ?').get('ORD-RECUPERA');
    expect(proc).toBeUndefined(); // nunca sellada mientras esta retenida

    // Intervencion manual documentada: el operador confirmo que el pedido NO existe en Woo,
    // asi que borra la fila retenida (no hace falta tocar nada mas).
    db.prepare('DELETE FROM ordenes_ml_wc_pedidos WHERE ml_order_id = ?').run('ORD-RECUPERA');

    // Ciclo 2: ahora Woo responde bien al POST.
    wooFetch.mockReset();
    wooFetch.mockImplementation(async (cfg, path, method = 'get') => {
      if (path === '/orders' && method === 'post') return { data: { id: 9911 } };
      return { data: {} };
    });
    await syncMlToWc(db, CFG);

    pedido = db.prepare('SELECT * FROM ordenes_ml_wc_pedidos WHERE ml_order_id = ?').get('ORD-RECUPERA');
    expect(pedido.wc_order_id).toBe(9911);
    expect(pedido.retenido_en).toBeNull();
    proc = db.prepare('SELECT * FROM ordenes_ml_procesadas WHERE order_id = ?').get('ORD-RECUPERA');
    expect(proc.estado).toBe('ok');

    // Un solo pedido creado en Woo en total (el del segundo ciclo).
    const posts = wooFetch.mock.calls.filter(c => c[1] === '/orders' && c[2] === 'post');
    expect(posts).toHaveLength(1);
  }, 30000);

  // Camino alternativo documentado: el operador CONFIRMA que el pedido SI existe en Woo y
  // completa la reserva a mano (UPDATE wc_order_id=<id real>, retenido_en=NULL). Confirma que
  // luego de esa intervencion la orden queda visible como procesada 'ok' y el cron no la
  // vuelve a tocar (no reintenta, no crea un segundo pedido).
  it('operador confirma que el pedido SI existe en Woo y completa la reserva a mano → el cron no reintenta', async () => {
    const orden = ordenSimple('ORD-RECUPERA-EXISTE');
    mlFetch.mockResolvedValue({ status: 200, data: { results: [orden] } });
    wooFetch.mockImplementation(async (cfg, path, method = 'get') => {
      if (path === '/orders' && method === 'post') throw new Error('timeout of 20000ms exceeded');
      if (path.startsWith('/orders?')) throw new Error('ECONNREFUSED');
      return { data: {} };
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await syncMlToWc(db, CFG);
    errSpy.mockRestore();

    // Intervencion manual: el pedido SI existe (verificado por el operador fuera de banda).
    db.prepare(`
      UPDATE ordenes_ml_wc_pedidos SET wc_order_id = ?, retenido_en = NULL WHERE ml_order_id = ?
    `).run(7777, 'ORD-RECUPERA-EXISTE');
    wooFetch.mockClear();

    await syncMlToWc(db, CFG);

    // El cron no debe haber reintentado creando otro pedido.
    const posts = wooFetch.mock.calls.filter(c => c[1] === '/orders' && c[2] === 'post');
    expect(posts).toHaveLength(0);
    const pedido = db.prepare('SELECT * FROM ordenes_ml_wc_pedidos WHERE ml_order_id = ?').get('ORD-RECUPERA-EXISTE');
    expect(pedido.wc_order_id).toBe(7777);
  }, 30000);
});

describe('syncMlToWc — verificacion en Woo pagina hasta encontrar el pedido en paginas mas alla de la segunda', () => {
  let db;

  beforeEach(() => {
    db = openDb(TEST_DB);
    seedMatcher(db);
    seedCatalogo(db);
    vi.clearAllMocks();
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  function ordenSimple(id) {
    return {
      id,
      date_created: new Date().toISOString(),
      order_items: [{ item: { id: 'MLA100', variation_id: '' }, quantity: 1, unit_price: 100 }],
    };
  }

  // Hallazgo #3 del review probaba solo hasta la 2da pagina. Este test confirma que la
  // paginacion sigue funcionando cuando el pedido aparece recien en la 3ra pagina (2 paginas
  // llenas de 100 pedidos ajenos antes de encontrarlo) — no es un caso especial de "pagina
  // 1 vs pagina 2", el bucle debe seguir agotando paginas hasta VERIF_WC_MAX_PAGINAS.
  it('encuentra el pedido en la 3ra pagina de la busqueda por fecha', async () => {
    const orden = ordenSimple('ORD-PAG3');
    mlFetch.mockResolvedValue({ status: 200, data: { results: [orden] } });
    const paginaLlena = () => Array.from({ length: 100 }, (_, k) => ({ id: 2000 + k, meta_data: [] }));

    wooFetch.mockImplementation(async (cfg, path, method = 'get') => {
      if (path === '/orders' && method === 'post') throw new Error('timeout of 20000ms exceeded');
      if (path.startsWith('/orders?')) {
        if (path.includes('&page=1&')) return { data: paginaLlena() };
        if (path.includes('&page=2&')) return { data: paginaLlena() };
        if (path.includes('&page=3&')) {
          return { data: [{ id: 66777, meta_data: [{ key: '_ml_order_id', value: 'ORD-PAG3' }] }] };
        }
        return { data: [] };
      }
      return { data: {} };
    });

    await syncMlToWc(db, CFG);

    const pedido = db.prepare('SELECT * FROM ordenes_ml_wc_pedidos WHERE ml_order_id = ?').get('ORD-PAG3');
    expect(pedido.wc_order_id).toBe(66777);
    expect(pedido.retenido_en).toBeNull();

    // Se consultaron efectivamente las 3 paginas (no se corto antes de tiempo).
    const paginasConsultadas = new Set(
      wooFetch.mock.calls
        .filter(c => String(c[1]).startsWith('/orders?'))
        .map(c => new URLSearchParams(c[1].split('?')[1]).get('page'))
    );
    expect(paginasConsultadas).toEqual(new Set(['1', '2', '3']));

    // Orden marcada como procesada 'ok' (no queda pendiente pese a la paginacion).
    const proc = db.prepare('SELECT * FROM ordenes_ml_procesadas WHERE order_id = ?').get('ORD-PAG3');
    expect(proc.estado).toBe('ok');
  }, 30000);
});

describe('GET /api/sync/dashboard — pedidos.reservasRetenidas', () => {
  let db, app;

  beforeEach(async () => {
    db = openDb(TEST_DB);
    seedMatcher(db);
    seedCatalogo(db);
    vi.clearAllMocks();
    const [{ default: express }, { syncRouter }] = await Promise.all([
      import('express'),
      import('../routes/sync.js'),
    ]);
    app = express();
    app.use(express.json());
    app.use('/api/sync', syncRouter(db, CFG));
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  function reservar(db, mlOrderId, { wcOrderId = 0, retenidoEn = null } = {}) {
    db.prepare(`
      INSERT INTO ordenes_ml_wc_pedidos (ml_order_id, wc_order_id, comprador_json, creado_en, retenido_en)
      VALUES (?, ?, NULL, ?, ?)
    `).run(mlOrderId, wcOrderId, new Date().toISOString(), retenidoEn);
  }

  it('sin reservas retenidas → total 0 y lista vacia', async () => {
    const { default: request } = await import('supertest');
    const res = await request(app).get('/api/sync/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.pedidos.reservasRetenidas.total).toBe(0);
    expect(res.body.pedidos.reservasRetenidas.ordenes).toEqual([]);
  });

  it('una reserva retenida → total 1 y la incluye', async () => {
    const { default: request } = await import('supertest');
    reservar(db, 'ORD-DASH-1', { wcOrderId: 0, retenidoEn: new Date().toISOString() });

    const res = await request(app).get('/api/sync/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.pedidos.reservasRetenidas.total).toBe(1);
    expect(res.body.pedidos.reservasRetenidas.ordenes.map(o => o.ml_order_id)).toEqual(['ORD-DASH-1']);
  });

  it('varias reservas retenidas → cuenta todas', async () => {
    const { default: request } = await import('supertest');
    reservar(db, 'ORD-DASH-2', { wcOrderId: 0, retenidoEn: new Date(Date.now() - 1000).toISOString() });
    reservar(db, 'ORD-DASH-3', { wcOrderId: 0, retenidoEn: new Date().toISOString() });

    const res = await request(app).get('/api/sync/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.pedidos.reservasRetenidas.total).toBe(2);
    expect(res.body.pedidos.reservasRetenidas.ordenes.map(o => o.ml_order_id).sort())
      .toEqual(['ORD-DASH-2', 'ORD-DASH-3']);
  });

  it('NO cuenta una reserva normal en curso (wc_order_id=0 sin retenido_en)', async () => {
    const { default: request } = await import('supertest');
    reservar(db, 'ORD-DASH-EN-CURSO', { wcOrderId: 0, retenidoEn: null });

    const res = await request(app).get('/api/sync/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.pedidos.reservasRetenidas.total).toBe(0);
    expect(res.body.pedidos.reservasRetenidas.ordenes).toEqual([]);
  });

  it('NO cuenta un pedido ya completado (wc_order_id<>0), aunque alguna vez haya estado retenido', async () => {
    const { default: request } = await import('supertest');
    // Simula el estado final tras la recuperacion manual: wc_order_id real, retenido_en NULL.
    reservar(db, 'ORD-DASH-RESUELTA', { wcOrderId: 5555, retenidoEn: null });

    const res = await request(app).get('/api/sync/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.pedidos.reservasRetenidas.total).toBe(0);
  });
});
