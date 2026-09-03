import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import axios from 'axios';
import { openDb } from '../db/index.js';
import { recepcionesRouter, aplicarStockItem } from '../routes/recepciones.js';
import * as syncModule from '../routes/sync.js';

vi.mock('axios');
vi.mock('../routes/sync.js', async () => {
  const actual = await vi.importActual('../routes/sync.js');
  return {
    ...actual,
    syncSkuPuntual: vi.fn(),
  };
});

const cfg = { url: 'https://fusionbikes.com.ar', ck: 'ck', cs: 'cs' };

function makeApp(db) {
  const app = express();
  app.use(express.json());
  app.use('/api/recepciones', recepcionesRouter(db, cfg));
  return app;
}

// Mock por defecto: GET devuelve stock 5, PATCH ok. Los productos id 30 fallan (500).
function mockWooOk() {
  axios.request.mockImplementation(async (opts) => {
    if (opts.url.includes('/products/30')) return { status: 500, data: {} };
    if (opts.method === 'get') return { status: 200, data: { stock_quantity: 5 } };
    return { status: 200, data: {} };
  });
}

afterEach(() => {
  vi.resetAllMocks();
});

describe('recepciones — confirmar (esquema actual)', () => {
  const DB = './test/tmp-recep-confirm.sqlite';
  let db;

  let app;
  beforeEach(() => {
    if (fs.existsSync(DB)) fs.unlinkSync(DB);
    db = openDb(DB);
    app = makeApp(db); // construye el router → corre las migraciones (solo_documento, estado_item, ...)
    mockWooOk();

    // Catálogo: simple (10), variación (501 hija de 500)
    const insCat = db.prepare(
      'INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,id_padre,stock,actualizado_en) VALUES (?,?,?,?,?,?,?)'
    );
    insCat.run(10, 'Casco', 'CASCO', 'simple', null, 5, 'x');
    insCat.run(501, 'Remera M', 'REM-M', 'variation', 500, 5, 'x');

    // Recepción borrador con mix de ítems
    const recId = db.prepare(
      "INSERT INTO recepciones (proveedor,importador,fecha,solo_documento,estado,creado_en) VALUES ('Prov','Prov','2026-07-16',0,'borrador','x')"
    ).run().lastInsertRowid;
    const insItem = db.prepare(
      'INSERT INTO recepcion_items (recepcion_id,id_woo,sku,nombre_doc,cantidad,recibido,creado_en) VALUES (?,?,?,?,?,?,?)'
    );
    insItem.run(recId, 10, 'CASCO', 'Casco', 3, 1, 'x');   // A → aplicado (5+3)
    insItem.run(recId, 501, 'REM-M', 'Remera M', 2, 1, 'x'); // B → aplicado vía variación
    insItem.run(recId, null, null, 'Producto raro', 1, 1, 'x'); // C → sin_match
    insItem.run(recId, 20, 'X20', 'No recibido', 1, 0, 'x'); // D → no_recibido
    insItem.run(recId, 30, 'X30', 'Falla WC', 1, 1, 'x');   // E → error
    db._recId = recId;
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(DB)) fs.unlinkSync(DB);
  });

  it('aplica lo que matchea, marca el resto sin perder nada', async () => {
    const res = await request(app).post(`/api/recepciones/${db._recId}/confirmar`).send();

    expect(res.body.ok).toBe(true);
    expect(res.body.aplicados).toBe(2);
    expect(res.body.errores).toBe(1);
    expect(res.body.sin_match).toBe(1);
    expect(res.body.pendientes).toHaveLength(2); // sin_match + error

    const items = db.prepare('SELECT * FROM recepcion_items WHERE recepcion_id=? ORDER BY id').all(db._recId);
    expect(items[0].estado_item).toBe('aplicado');
    expect(items[0].stock_nuevo).toBe(8);        // 5 + 3
    expect(items[1].estado_item).toBe('aplicado'); // variación
    expect(items[2].estado_item).toBe('sin_match');
    expect(items[3].estado_item).toBe('no_recibido');
    expect(items[4].estado_item).toBe('error');
    expect(items[4].error_wc).toBeTruthy();

    const rec = db.prepare('SELECT estado FROM recepciones WHERE id=?').get(db._recId);
    expect(rec.estado).toBe('confirmada'); // confirma igual pese al error
  });

  it('usa el path de variación /products/{padre}/variations/{id}', async () => {
    await request(app).post(`/api/recepciones/${db._recId}/confirmar`).send();
    const urls = axios.request.mock.calls.map(c => c[0].url);
    expect(urls.some(u => u.includes('/products/500/variations/501'))).toBe(true);
  });
});

describe('recepciones — solo_documento no genera pendientes ni toca WC', () => {
  const DB = './test/tmp-recep-solodoc.sqlite';

  afterEach(() => { if (fs.existsSync(DB)) fs.unlinkSync(DB); });

  it('no llama a WooCommerce y pendientes vacío', async () => {
    if (fs.existsSync(DB)) fs.unlinkSync(DB);
    const db = openDb(DB);
    const app = makeApp(db); // corre migraciones antes de insertar
    mockWooOk();
    const recId = db.prepare(
      "INSERT INTO recepciones (proveedor,fecha,solo_documento,estado,creado_en) VALUES ('P','2026-07-16',1,'borrador','x')"
    ).run().lastInsertRowid;
    db.prepare('INSERT INTO recepcion_items (recepcion_id,id_woo,nombre_doc,cantidad,recibido,creado_en) VALUES (?,?,?,?,?,?)')
      .run(recId, 10, 'Casco', 1, 1, 'x');

    const res = await request(app).post(`/api/recepciones/${recId}/confirmar`).send();
    expect(res.body.ok).toBe(true);
    expect(res.body.solo_documento).toBe(true);
    expect(res.body.pendientes).toEqual([]);
    expect(axios.request).not.toHaveBeenCalled();
    db.close();
  });

  it('solo_documento no cambia el estado del pedido asociado', async () => {
    if (fs.existsSync(DB)) fs.unlinkSync(DB);
    const db = openDb(DB);
    const app = makeApp(db);
    mockWooOk();
    const pedidoId = db.prepare(
      "INSERT INTO pedidos (numero_pedido,importador,proveedor,estado,creado_en) VALUES ('P1','Prov','Prov','pendiente','x')"
    ).run().lastInsertRowid;
    const recId = db.prepare(
      "INSERT INTO recepciones (pedido_id,proveedor,fecha,solo_documento,estado,creado_en) VALUES (?,'P','2026-07-16',1,'borrador','x')"
    ).run(pedidoId).lastInsertRowid;
    db.prepare('INSERT INTO recepcion_items (recepcion_id,id_woo,nombre_doc,cantidad,recibido,creado_en) VALUES (?,?,?,?,?,?)')
      .run(recId, 10, 'Casco', 1, 1, 'x');

    await request(app).post(`/api/recepciones/${recId}/confirmar`).send();
    // El pedido NO debe inflarse a recibido_parcial por una recepción documento-only
    expect(db.prepare('SELECT estado FROM pedidos WHERE id=?').get(pedidoId).estado).toBe('pendiente');
    db.close();
  });
});

describe('aplicarStockItem — fallos visibles y serialización', () => {
  const DB = './test/tmp-recep-aplicar.sqlite';
  let db;

  beforeEach(() => {
    if (fs.existsSync(DB)) fs.unlinkSync(DB);
    db = openDb(DB);
    makeApp(db); // corre migraciones (crea columnas estado_item, etc.)
    db.prepare('INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,id_padre,stock,actualizado_en) VALUES (?,?,?,?,?,?,?)')
      .run(10, 'Casco', 'CASCO', 'simple', null, 5, 'x');
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(DB)) fs.unlinkSync(DB);
  });

  function nuevoItem(id_woo, cantidad) {
    const recId = db.prepare(
      "INSERT INTO recepciones (proveedor,fecha,solo_documento,estado,creado_en) VALUES ('P','2026-07-16',0,'borrador','x')"
    ).run().lastInsertRowid;
    const itemId = db.prepare(
      'INSERT INTO recepcion_items (recepcion_id,id_woo,nombre_doc,cantidad,recibido,creado_en) VALUES (?,?,?,?,?,?)'
    ).run(recId, id_woo, 'X', cantidad, 1, 'x').lastInsertRowid;
    return db.prepare('SELECT * FROM recepcion_items WHERE id=?').get(itemId);
  }

  it('lanza error explícito si el producto no está en catalogo_cache (no asume simple)', async () => {
    axios.request.mockResolvedValue({ status: 200, data: { stock_quantity: 5 } });
    const item = nuevoItem(999, 2); // 999 no está en cache
    await expect(aplicarStockItem(db, cfg, item)).rejects.toThrow(/catalogo_cache/);
    // No debe haber tocado WC
    expect(axios.request).not.toHaveBeenCalled();
  });

  it('lanza error explícito si WC devuelve stock_quantity null (no usa stock_previo viejo)', async () => {
    axios.request.mockResolvedValue({ status: 200, data: { stock_quantity: null } });
    const item = nuevoItem(10, 3);
    await expect(aplicarStockItem(db, cfg, item)).rejects.toThrow(/stock_quantity/);
    // No debe haber hecho PATCH (solo el GET)
    const patches = axios.request.mock.calls.filter(c => c[0].method === 'patch');
    expect(patches).toHaveLength(0);
    // catalogo_cache sin cambios
    expect(db.prepare('SELECT stock FROM catalogo_cache WHERE id_woo=10').get().stock).toBe(5);
  });

  it('normaliza stock_quantity string ("5") a número (no concatena: 5+3=8, no "53")', async () => {
    axios.request.mockImplementation(async (opts) => {
      if (opts.method === 'get') return { status: 200, data: { stock_quantity: '5' } };
      return { status: 200, data: {} };
    });
    const item = nuevoItem(10, 3);
    const res = await aplicarStockItem(db, cfg, item);
    // Resultado numérico, no concatenación de strings
    expect(res.stock_previo).toBe(5);
    expect(res.stock_nuevo).toBe(8);
    // El PATCH a Woo lleva el número correcto
    const patch = axios.request.mock.calls.find(c => c[0].method === 'patch');
    expect(patch[0].data.stock_quantity).toBe(8);
    // catalogo_cache guarda 8, no "53"
    expect(db.prepare('SELECT stock FROM catalogo_cache WHERE id_woo=10').get().stock).toBe(8);
  });

  it('serializa aplicaciones concurrentes sobre el mismo id_woo (no se pisan)', async () => {
    // Mock con estado: GET lee el stock actual, PATCH lo fija. GET con delay para
    // forzar el interleaving que rompería sin lock (ambos leerían 5).
    let stockWc = 5;
    axios.request.mockImplementation(async (opts) => {
      if (opts.method === 'get') {
        await new Promise(r => setTimeout(r, 10));
        return { status: 200, data: { stock_quantity: stockWc } };
      }
      stockWc = opts.data.stock_quantity;
      return { status: 200, data: {} };
    });

    const itemA = nuevoItem(10, 3);
    const itemB = nuevoItem(10, 2);
    const [rA, rB] = await Promise.all([
      aplicarStockItem(db, cfg, itemA),
      aplicarStockItem(db, cfg, itemB),
    ]);
    // Con serialización, la segunda parte de donde dejó la primera: 5 → 8 → 10
    expect(stockWc).toBe(10);
    const previos = [rA.stock_previo, rB.stock_previo].sort();
    expect(previos).toEqual([5, 8]);
  });

  it('NO serializa productos distintos: dos id_woo diferentes se procesan en paralelo', async () => {
    // Cada producto tiene su propio lock. Si el lock fuera global (por error de
    // implementación), este test tardaría ~20ms (secuencial); con locks por
    // id_woo, ambos GET con delay corren en simultáneo (~10ms totales).
    db.prepare('INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,id_padre,stock,actualizado_en) VALUES (?,?,?,?,?,?,?)')
      .run(11, 'Otro', 'OTRO', 'simple', null, 5, 'x');

    let getsEnVuelo = 0;
    let maxGetsSimultaneos = 0;
    axios.request.mockImplementation(async (opts) => {
      if (opts.method === 'get') {
        getsEnVuelo++;
        maxGetsSimultaneos = Math.max(maxGetsSimultaneos, getsEnVuelo);
        await new Promise(r => setTimeout(r, 15));
        getsEnVuelo--;
        return { status: 200, data: { stock_quantity: 5 } };
      }
      return { status: 200, data: {} };
    });

    const itemA = nuevoItem(10, 3); // producto 10
    const itemB = nuevoItem(11, 2); // producto 11, distinto de A
    const [rA, rB] = await Promise.all([
      aplicarStockItem(db, cfg, itemA),
      aplicarStockItem(db, cfg, itemB),
    ]);

    // Ambos GETs coincidieron en el tiempo: no se esperaron entre sí.
    expect(maxGetsSimultaneos).toBe(2);
    expect(rA.stock_previo).toBe(5);
    expect(rB.stock_previo).toBe(5);
  });
});

describe('recepciones — confirmar con sync_ml', () => {
  const DB = './test/tmp-recep-sync-ml.sqlite';
  let db;
  let app;

  beforeEach(() => {
    if (fs.existsSync(DB)) fs.unlinkSync(DB);
    db = openDb(DB);
    app = makeApp(db);
    mockWooOk();

    // Catálogo
    const insCat = db.prepare(
      'INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,id_padre,stock,actualizado_en) VALUES (?,?,?,?,?,?,?)'
    );
    insCat.run(10, 'Producto A', 'SKU-A', 'simple', null, 5, 'x');
    insCat.run(20, 'Producto B', 'SKU-B', 'simple', null, 5, 'x');

    // Matcher: vincular SKUs a ML
    const insMatcher = db.prepare(
      'INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en) VALUES (?,?,?,?,?)'
    );
    insMatcher.run('MLA100|', 'SKU-A', 'Producto A', 'confirmar', 'x');
    insMatcher.run('MLA200|', 'SKU-B', 'Producto B', 'confirmar', 'x');
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(DB)) fs.unlinkSync(DB);
    vi.clearAllMocks();
  });

  it('incluye sync_ml en la respuesta al confirmar recepción', async () => {
    const { syncSkuPuntual } = await import('../routes/sync.js');

    // Mock syncSkuPuntual para devolver resultados predefinidos
    syncSkuPuntual.mockImplementation(async (db, cfg, sku) => {
      if (sku === 'SKU-A') {
        return { sku: 'SKU-A', estado: 'sincronizado', detalle: 'Stock actualizado: 10' };
      }
      if (sku === 'SKU-B') {
        return { sku: 'SKU-B', estado: 'sin_cambios', detalle: 'Sin cambios pendientes en ML' };
      }
      return { sku, estado: 'error', detalle: 'Unknown SKU' };
    });

    // Crear recepción con 2 ítems
    const insRec = db.prepare(
      'INSERT INTO recepciones (pedido_id, importador, proveedor, numero_pedido, fecha, solo_documento, estado, creado_en) VALUES (?,?,?,?,?,?,?,?)'
    );
    const recId = insRec.run(null, 'Test', 'Provider', '001', '2026-08-26', 0, 'borrador', 'x').lastInsertRowid;

    const insItem = db.prepare(
      'INSERT INTO recepcion_items (recepcion_id, id_woo, sku, nombre_doc, codigo_proveedor, cantidad, recibido, creado_en) VALUES (?,?,?,?,?,?,?,?)'
    );
    insItem.run(recId, 10, 'SKU-A', 'Producto A', 'PROV-001', 5, 1, 'x');
    insItem.run(recId, 20, 'SKU-B', 'Producto B', 'PROV-002', 3, 1, 'x');

    const res = await request(app).post(`/api/recepciones/${recId}/confirmar`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.sync_ml).toBeDefined();
    expect(Array.isArray(res.body.sync_ml)).toBe(true);
    expect(res.body.sync_ml).toHaveLength(2);

    // Verificar el contenido de sync_ml
    const skuA = res.body.sync_ml.find(s => s.sku === 'SKU-A');
    expect(skuA).toBeTruthy();
    expect(skuA.estado).toBe('sincronizado');
    expect(skuA.detalle).toContain('Stock actualizado');

    const skuB = res.body.sync_ml.find(s => s.sku === 'SKU-B');
    expect(skuB).toBeTruthy();
    expect(skuB.estado).toBe('sin_cambios');

    // syncSkuPuntual debe haber sido llamado para ambos SKUs
    expect(syncSkuPuntual).toHaveBeenCalledTimes(2);
  });

  it('fail-open: si syncSkuPuntual rechaza, la recepción igual se confirma en 200', async () => {
    const { syncSkuPuntual } = await import('../routes/sync.js');
    syncSkuPuntual.mockRejectedValue(new Error('ML caído'));

    const insRec = db.prepare(
      'INSERT INTO recepciones (pedido_id, importador, proveedor, numero_pedido, fecha, solo_documento, estado, creado_en) VALUES (?,?,?,?,?,?,?,?)'
    );
    const recId = insRec.run(null, 'Test', 'Provider', '001', '2026-08-26', 0, 'borrador', 'x').lastInsertRowid;
    const insItem = db.prepare(
      'INSERT INTO recepcion_items (recepcion_id, id_woo, sku, nombre_doc, codigo_proveedor, cantidad, recibido, creado_en) VALUES (?,?,?,?,?,?,?,?)'
    );
    insItem.run(recId, 10, 'SKU-A', 'Producto A', 'PROV-001', 5, 1, 'x');

    const res = await request(app).post(`/api/recepciones/${recId}/confirmar`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.resultados[0].ok).toBe(true);
  });

  it('dos ítems con el mismo SKU en la recepción: un solo push a ML (no uno por ítem)', async () => {
    const { syncSkuPuntual } = await import('../routes/sync.js');
    syncSkuPuntual.mockClear();
    syncSkuPuntual.mockResolvedValue({ sku: 'SKU-A', estado: 'sincronizado', detalle: 'ok' });

    const insRec = db.prepare(
      'INSERT INTO recepciones (pedido_id, importador, proveedor, numero_pedido, fecha, solo_documento, estado, creado_en) VALUES (?,?,?,?,?,?,?,?)'
    );
    const recId = insRec.run(null, 'Test', 'Provider', '001', '2026-08-26', 0, 'borrador', 'x').lastInsertRowid;
    const insItem = db.prepare(
      'INSERT INTO recepcion_items (recepcion_id, id_woo, sku, nombre_doc, codigo_proveedor, cantidad, recibido, creado_en) VALUES (?,?,?,?,?,?,?,?)'
    );
    // Dos renglones del documento apuntan al mismo producto (id_woo=10, SKU-A) — pasa
    // seguido cuando el remito lista el mismo artículo en dos líneas distintas.
    insItem.run(recId, 10, 'SKU-A', 'Producto A', 'PROV-001', 3, 1, 'x');
    insItem.run(recId, 10, 'SKU-A', 'Producto A', 'PROV-001b', 2, 1, 'x');

    const res = await request(app).post(`/api/recepciones/${recId}/confirmar`);

    expect(res.status).toBe(200);
    expect(syncSkuPuntual).toHaveBeenCalledTimes(1);
    expect(res.body.sync_ml).toHaveLength(1);
  });

  it('NO llama a syncSkuPuntual para un ítem cuyo aplicarStockItem falló', async () => {
    const { syncSkuPuntual } = await import('../routes/sync.js');
    syncSkuPuntual.mockClear();
    // Forzar fallo de Woo: sin mockWooOk activo, wooFetch real intentará pegarle a axios sin mock -> rechaza
    axios.request.mockRejectedValue(new Error('WC caído'));

    const insRec = db.prepare(
      'INSERT INTO recepciones (pedido_id, importador, proveedor, numero_pedido, fecha, solo_documento, estado, creado_en) VALUES (?,?,?,?,?,?,?,?)'
    );
    const recId = insRec.run(null, 'Test', 'Provider', '001', '2026-08-26', 0, 'borrador', 'x').lastInsertRowid;
    const insItem = db.prepare(
      'INSERT INTO recepcion_items (recepcion_id, id_woo, sku, nombre_doc, codigo_proveedor, cantidad, recibido, creado_en) VALUES (?,?,?,?,?,?,?,?)'
    );
    insItem.run(recId, 10, 'SKU-A', 'Producto A', 'PROV-001', 5, 1, 'x');

    const res = await request(app).post(`/api/recepciones/${recId}/confirmar`);

    expect(res.body.resultados[0].ok).toBe(false);
    expect(syncSkuPuntual).not.toHaveBeenCalled();
  });
});

describe('recepciones — backfill de estado_item (migración de DB vieja)', () => {
  const DB = './test/tmp-recep-backfill.sqlite';

  afterEach(() => { if (fs.existsSync(DB)) fs.unlinkSync(DB); });

  // Crea un esquema "viejo" de recepcion_items SIN la columna estado_item,
  // para ejercitar el ALTER + backfill del router tal como corre en producción.
  function oldSchemaDb() {
    if (fs.existsSync(DB)) fs.unlinkSync(DB);
    const db = new Database(DB);
    db.exec(`
      CREATE TABLE recepciones (
        id INTEGER PRIMARY KEY AUTOINCREMENT, pedido_id INTEGER, proveedor TEXT,
        importador TEXT, numero_pedido TEXT, fecha TEXT, notas TEXT,
        solo_documento INTEGER DEFAULT 0, estado TEXT, creado_en TEXT, confirmado_en TEXT
      );
      CREATE TABLE recepcion_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT, recepcion_id INTEGER, id_woo INTEGER,
        sku TEXT, nombre_doc TEXT, codigo_proveedor TEXT, cantidad INTEGER,
        precio_unitario REAL, stock_previo INTEGER, stock_nuevo INTEGER,
        recibido INTEGER DEFAULT 1, creado_en TEXT
      );
      CREATE TABLE catalogo_cache (id_woo INTEGER PRIMARY KEY, stock INTEGER, actualizado_en TEXT);
    `);
    return db;
  }

  it('clasifica históricos y es idempotente', () => {
    const db = oldSchemaDb();
    const insR = db.prepare("INSERT INTO recepciones (solo_documento,estado,creado_en) VALUES (?,?,'x')");
    const rec1 = insR.run(0, 'confirmada').lastInsertRowid;   // confirmada
    const rec2 = insR.run(0, 'borrador').lastInsertRowid;     // borrador
    const rec3 = insR.run(1, 'confirmada').lastInsertRowid;   // solo_documento

    const insI = db.prepare(
      'INSERT INTO recepcion_items (recepcion_id,id_woo,nombre_doc,cantidad,stock_nuevo,recibido,creado_en) VALUES (?,?,?,?,?,?,?)'
    );
    const i1 = insI.run(rec1, 10, 'aplicado ok', 1, 8, 1, 'x').lastInsertRowid;   // → aplicado
    const i2 = insI.run(rec1, null, 'perdido', 1, null, 1, 'x').lastInsertRowid;  // → sin_match
    const i3 = insI.run(rec1, 20, 'fallo mudo', 1, null, 1, 'x').lastInsertRowid; // → error
    const i4 = insI.run(rec1, 30, 'no recibido', 1, null, 0, 'x').lastInsertRowid;// → no_recibido
    const i5 = insI.run(rec2, 40, 'en borrador', 1, null, 1, 'x').lastInsertRowid;// → pendiente
    const i6 = insI.run(rec3, 50, 'solo doc', 1, null, 1, 'x').lastInsertRowid;   // → NULL

    // Primera apertura del router: dispara ALTER + backfill
    recepcionesRouter(db, cfg);

    const estado = (id) => db.prepare('SELECT estado_item FROM recepcion_items WHERE id=?').get(id).estado_item;
    expect(estado(i1)).toBe('aplicado');
    expect(estado(i2)).toBe('sin_match');
    expect(estado(i3)).toBe('error');
    expect(estado(i4)).toBe('no_recibido');
    expect(estado(i5)).toBe('pendiente');
    expect(estado(i6)).toBe(null); // solo_documento no participa

    // Simula una resolución posterior y reabre: el backfill NO debe volver a correr
    db.prepare("UPDATE recepcion_items SET estado_item='aplicado' WHERE id=?").run(i2);
    recepcionesRouter(db, cfg);
    expect(estado(i2)).toBe('aplicado'); // se conserva, no se re-clasifica a sin_match

    db.close();
  });
});
