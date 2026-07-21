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

  it('happy path: orden pagada → crea pedido en WC y marca procesada', async () => {
    seedCatalogo(db); // BIKE-001 → id_woo 100
    const orden = {
      id: 'ORD-001',
      date_created: new Date().toISOString(),
      order_items: [{ item: { id: 'MLA100', variation_id: '' }, quantity: 2 }],
    };
    mlFetch.mockResolvedValue({ status: 200, data: { results: [orden] } });
    wooFetch.mockImplementation(async (cfg, path, method = 'get') => {
      if (path === '/orders' && method === 'post') return { data: { id: 5001 } };
      return { data: { price: '150.00' } }; // GET del producto para el precio
    });

    const p = syncMlToWc(db, CFG);
    await vi.runAllTimersAsync();
    await p;

    // Se creó el pedido en WC con el line item mapeado (precio 150 × qty 2 = 300)
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
    await p;

    expect(mlFetch).not.toHaveBeenCalled();
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
