import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import axios from 'axios';
import { openDb } from '../db/index.js';
import { recepcionesRouter, aplicarStockItem } from '../routes/recepciones.js';
import { crearBorradorWoo } from '../lib/nuevosProductosWoo.js';
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

// Mock por defecto: GET/PATCH stateful por URL, arranca en stock 5. Necesario porque P0.1 hace un
// GET de verificación después del PATCH: un mock que siempre devuelve el mismo stock_quantity haría
// que esa verificación viera un valor desactualizado y todo terminara en 'conflicto_stock'.
// Los productos id 30 fallan (500) tanto en GET como en PATCH, para simular una falla de WC.
function mockWooOk() {
  const stocks = new Map();
  axios.request.mockImplementation(async (opts) => {
    if (opts.url.includes('/products/30')) return { status: 500, data: {} };
    if (!stocks.has(opts.url)) stocks.set(opts.url, 5);
    if (opts.method === 'get') return { status: 200, data: { stock_quantity: stocks.get(opts.url) } };
    if (opts.method === 'patch' && opts.data && opts.data.stock_quantity !== undefined) {
      stocks.set(opts.url, opts.data.stock_quantity);
    }
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
    // Falla en el GET, antes de cualquier PATCH: es reintentable, no incierta.
    expect(items[4].estado_item).toBe('error_reintentable');
    expect(items[4].error_wc).toBeTruthy();

    const rec = db.prepare('SELECT estado FROM recepciones WHERE id=?').get(db._recId);
    expect(rec.estado).toBe('confirmada_con_pendientes');
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
    // Stateful: la verificación posterior al PATCH tiene que ver el stock ya actualizado.
    let stockWc = '5';
    axios.request.mockImplementation(async (opts) => {
      if (opts.method === 'get') return { status: 200, data: { stock_quantity: stockWc } };
      stockWc = opts.data.stock_quantity;
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
    const stocks = new Map(); // stateful por URL: la verificación post-PATCH necesita ver lo ya escrito
    axios.request.mockImplementation(async (opts) => {
      if (!stocks.has(opts.url)) stocks.set(opts.url, 5);
      if (opts.method === 'get') {
        getsEnVuelo++;
        maxGetsSimultaneos = Math.max(maxGetsSimultaneos, getsEnVuelo);
        await new Promise(r => setTimeout(r, 15));
        getsEnVuelo--;
        return { status: 200, data: { stock_quantity: stocks.get(opts.url) } };
      }
      stocks.set(opts.url, opts.data.stock_quantity);
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

describe('aplicarStockItem — P0.1 máquina de estados durable (aplica exactamente una vez)', () => {
  const DB = './test/tmp-recep-p01.sqlite';
  let db;

  beforeEach(() => {
    if (fs.existsSync(DB)) fs.unlinkSync(DB);
    db = openDb(DB);
    makeApp(db); // corre migraciones (operation_id, stock_objetivo, aplicando_desde, etc.)
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

  it('un timeout justo después del PATCH deja el ítem en operacion_incierta, no en error_reintentable', async () => {
    let getStock = 5;
    axios.request.mockImplementation(async (opts) => {
      if (opts.method === 'get') return { status: 200, data: { stock_quantity: getStock } };
      // El PATCH "llega" a Woo (getStock se actualiza) pero la respuesta nunca vuelve al cliente.
      getStock = opts.data.stock_quantity;
      throw new Error('timeout');
    });
    const item = nuevoItem(10, 3);
    await expect(aplicarStockItem(db, cfg, item)).rejects.toThrow(/incierta/);
    const row = db.prepare('SELECT * FROM recepcion_items WHERE id=?').get(item.id);
    expect(row.estado_item).toBe('operacion_incierta');
    expect(row.stock_objetivo).toBe(8);
    expect(row.stock_previo).toBe(5);
  });

  it('un segundo intento sobre un ítem en operacion_incierta no dispara un segundo PATCH', async () => {
    let getStock = 5;
    let patches = 0;
    axios.request.mockImplementation(async (opts) => {
      if (opts.method === 'get') return { status: 200, data: { stock_quantity: getStock } };
      patches++;
      getStock = opts.data.stock_quantity;
      throw new Error('timeout');
    });
    const item = nuevoItem(10, 3);
    await expect(aplicarStockItem(db, cfg, item)).rejects.toThrow(/incierta/);
    expect(patches).toBe(1);

    const itemActualizado = db.prepare('SELECT * FROM recepcion_items WHERE id=?').get(item.id);
    await expect(aplicarStockItem(db, cfg, itemActualizado)).rejects.toThrow(/no se reintenta a ciegas/);
    expect(patches).toBe(1); // sigue en 1: no se reintentó a ciegas
    expect(db.prepare('SELECT estado_item FROM recepcion_items WHERE id=?').get(item.id).estado_item).toBe('operacion_incierta');
  });

  it('conciliarOperacionIncierta detecta que el PATCH sí llegó a aplicarse y marca aplicado sin PATCH nuevo', async () => {
    let getStock = 5;
    let patches = 0;
    axios.request.mockImplementation(async (opts) => {
      if (opts.method === 'get') return { status: 200, data: { stock_quantity: getStock } };
      patches++;
      getStock = opts.data.stock_quantity;
      throw new Error('timeout');
    });
    const item = nuevoItem(10, 3);
    await expect(aplicarStockItem(db, cfg, item)).rejects.toThrow(/incierta/);
    expect(patches).toBe(1);

    // Ahora Woo responde normal: el GET de conciliación va a ver que el stock YA es el objetivo (8).
    axios.request.mockImplementation(async (opts) => {
      if (opts.method === 'get') return { status: 200, data: { stock_quantity: getStock } };
      patches++;
      return { status: 200, data: {} };
    });
    const { conciliarOperacionIncierta } = await import('../routes/recepciones.js');
    const res = await conciliarOperacionIncierta(db, cfg, item.id);
    expect(res.estado).toBe('aplicado');
    expect(patches).toBe(1); // la conciliación NO hizo un segundo PATCH
    const row = db.prepare('SELECT * FROM recepcion_items WHERE id=?').get(item.id);
    expect(row.estado_item).toBe('aplicado');
    expect(row.stock_nuevo).toBe(8);
  });

  it('conciliarOperacionIncierta detecta que el PATCH nunca llegó y libera para reintento normal', async () => {
    axios.request.mockImplementation(async (opts) => {
      if (opts.method === 'get') return { status: 200, data: { stock_quantity: 5 } };
      throw new Error('timeout');
    });
    const item = nuevoItem(10, 3);
    await expect(aplicarStockItem(db, cfg, item)).rejects.toThrow(/incierta/);

    const { conciliarOperacionIncierta } = await import('../routes/recepciones.js');
    const res = await conciliarOperacionIncierta(db, cfg, item.id);
    expect(res.estado).toBe('error_reintentable');
    expect(db.prepare('SELECT estado_item FROM recepcion_items WHERE id=?').get(item.id).estado_item).toBe('error_reintentable');
  });

  it('dos confirmaciones concurrentes de la misma recepción aplican el stock exactamente una vez', async () => {
    let stockWc = 5;
    axios.request.mockImplementation(async (opts) => {
      if (opts.method === 'get') {
        await new Promise(r => setTimeout(r, 5));
        return { status: 200, data: { stock_quantity: stockWc } };
      }
      stockWc = opts.data.stock_quantity;
      return { status: 200, data: {} };
    });
    const item = nuevoItem(10, 3);
    const [rA, rB] = await Promise.all([
      aplicarStockItem(db, cfg, item),
      aplicarStockItem(db, cfg, item),
    ]);
    // Se aplica una sola vez: 5 → 8, nunca 5 → 8 → 11.
    expect(stockWc).toBe(8);
    expect([rA.stock_nuevo, rB.stock_nuevo]).toEqual([8, 8]);
  });

  it('una recepción repetida (ítem ya aplicado) devuelve el resultado conocido sin volver a tocar Woo', async () => {
    let patches = 0;
    axios.request.mockImplementation(async (opts) => {
      if (opts.method === 'get') return { status: 200, data: { stock_quantity: patches ? 8 : 5 } };
      patches++;
      return { status: 200, data: {} };
    });
    const item = nuevoItem(10, 3);
    const r1 = await aplicarStockItem(db, cfg, item);
    expect(r1.stock_nuevo).toBe(8);
    expect(patches).toBe(1);

    const itemAplicado = db.prepare('SELECT * FROM recepcion_items WHERE id=?').get(item.id);
    const r2 = await aplicarStockItem(db, cfg, itemAplicado);
    expect(r2.yaAplicado).toBe(true);
    expect(r2.stock_nuevo).toBe(8);
    expect(patches).toBe(1); // ningún PATCH nuevo
  });

  it('la verificación post-PATCH que no coincide (sin excepción) marca conflicto_stock, no aplicado', async () => {
    axios.request.mockImplementation(async (opts) => {
      if (opts.method === 'get') return { status: 200, data: { stock_quantity: 5 } };
      // El PATCH "responde ok" pero el GET de verificación ve otro valor (otro movimiento de por medio).
      return { status: 200, data: {} };
    });
    // Forzamos que la verificación (segundo GET) vea algo distinto del objetivo: usamos un contador.
    let gets = 0;
    axios.request.mockImplementation(async (opts) => {
      if (opts.method === 'get') {
        gets++;
        return { status: 200, data: { stock_quantity: gets === 1 ? 5 : 99 } };
      }
      return { status: 200, data: {} };
    });
    const item = nuevoItem(10, 3);
    await expect(aplicarStockItem(db, cfg, item)).rejects.toThrow(/conflicto_stock|GET posterior/i);
    const row = db.prepare('SELECT * FROM recepcion_items WHERE id=?').get(item.id);
    expect(row.estado_item).toBe('conflicto_stock');
    expect(row.stock_nuevo).toBeNull();
  });

  it('un ítem ya aplicado queda excluido de la selección de reintentables del confirm route', async () => {
    mockWooOk();
    const recId = db.prepare(
      "INSERT INTO recepciones (proveedor,fecha,solo_documento,estado,creado_en) VALUES ('P','2026-07-16',0,'confirmada_con_pendientes','x')"
    ).run().lastInsertRowid;
    db.prepare(
      'INSERT INTO recepcion_items (recepcion_id,id_woo,sku,nombre_doc,cantidad,recibido,estado_item,stock_previo,stock_objetivo,stock_nuevo,creado_en) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
    ).run(recId, 10, 'CASCO', 'Casco', 3, 1, 'aplicado', 5, 8, 8, 'x');

    const app = makeApp(db);
    const res = await request(app).post(`/api/recepciones/${recId}/confirmar`).send();
    // El único PATCH posible sería re-aplicar el ítem ya aplicado: no debe haber ocurrido.
    const patches = axios.request.mock.calls.filter(c => c[0].method === 'patch');
    expect(patches).toHaveLength(0);
    expect(db.prepare('SELECT stock_nuevo FROM recepcion_items WHERE recepcion_id=?').get(recId).stock_nuevo).toBe(8);
    // No basta con "no hubo PATCH": el ítem no debe ni siquiera entrar al loop de aplicación (whatever
    // pase ahí en el futuro — un log, una métrica, un evento — no debe dispararse sobre algo ya aplicado).
    // Si entrara, aplicarStockItemInterno igual devolvería {yaAplicado:true} sin tocar Woo, y quedaría
    // un resultado en la respuesta; si la selección lo excluye correctamente, no hay ningún resultado.
    expect(res.body.aplicados).toBe(0);
    expect(res.body.pendientes).toHaveLength(0);
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
    const i3 = insI.run(rec1, 20, 'fallo mudo', 1, null, 1, 'x').lastInsertRowid; // → operacion_incierta
    const i4 = insI.run(rec1, 30, 'no recibido', 1, null, 0, 'x').lastInsertRowid;// → no_recibido
    const i5 = insI.run(rec2, 40, 'en borrador', 1, null, 1, 'x').lastInsertRowid;// → pendiente
    const i6 = insI.run(rec3, 50, 'solo doc', 1, null, 1, 'x').lastInsertRowid;   // → NULL

    // Primera apertura del router: dispara ALTER + backfill
    recepcionesRouter(db, cfg);

    const estado = (id) => db.prepare('SELECT estado_item FROM recepcion_items WHERE id=?').get(id).estado_item;
    expect(estado(i1)).toBe('aplicado');
    expect(estado(i2)).toBe('sin_match');
    // Historia ambigua (¿el PATCH llegó a aplicarse?): conciliar, nunca reintentar a ciegas.
    expect(estado(i3)).toBe('operacion_incierta');
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

describe('P0.2 — integración: alta Woo confirmable sin esperar el sync', () => {
  const DB = './test/tmp-recep-p02-integracion.sqlite';
  let db, app;

  beforeEach(() => {
    if (fs.existsSync(DB)) fs.unlinkSync(DB);
    db = openDb(DB);
    app = makeApp(db); // corre migraciones (estado_item, operation_id, etc.)
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(DB)) fs.unlinkSync(DB);
  });

  const ficha = {
    modo: 'simple', titulo: 'Casco Nuevo', marca: 'Marca', categoria_id: 17, categoria_nombre: 'CASCOS',
    precio: '120000', descripcion: '', parent_id: null, atributos: [{ nombre: 'Color', valor: 'Negro' }],
  };

  it('crear → confirmar inmediatamente aplica el stock por el path Woo correcto, exactamente una vez', async () => {
    // 1) Alta: crearBorradorWoo (P0.2) hace GET/POST/PATCH/GET reales via fetchWoo y deja el
    //    upsert en catalogo_cache — sin esto, aplicarStockItem no sabría si es simple o variación.
    let stockWc = 0;
    const fetchWoo = async (_c, path, method = 'get', body) => {
      if (method === 'post') return { data: { id: 900, status: 'draft', stock_quantity: 0 } };
      if (method === 'patch') {
        if (body?.sku) { /* asignación de SKU */ }
        if (body?.stock_quantity !== undefined) stockWc = body.stock_quantity;
        return { data: { id: 900, status: 'draft', stock_quantity: stockWc, sku: 'FB-900' } };
      }
      return { data: { id: 900, status: 'draft', stock_quantity: stockWc, sku: 'FB-900' } };
    };
    const alta = await crearBorradorWoo({
      db, cfg, operationId: '550e8400-e29b-41d4-a716-446655440099', ficha, actor: 'test', fetchWoo,
    });
    expect(alta.sku).toBe('FB-900');
    // catalogo_cache ya tiene el producto sin esperar ningún sync.
    expect(db.prepare('SELECT * FROM catalogo_cache WHERE id_woo=?').get(alta.id_woo)).toBeTruthy();

    // 2) Recepción que referencia esa alta como ítem recién creado ('creado' → confirm route lo toma).
    //    alta_operation_id es lo que P0.3 usa para volver a verificar contra recepcion_altas_woo antes
    //    de aplicar stock: crearBorradorWoo ya dejó esa fila en 'creado' con este mismo id_woo.
    const recId = db.prepare(
      "INSERT INTO recepciones (proveedor,fecha,solo_documento,estado,creado_en) VALUES ('P','2026-07-16',0,'borrador','x')"
    ).run().lastInsertRowid;
    db.prepare(
      'INSERT INTO recepcion_items (recepcion_id,id_woo,sku,nombre_doc,cantidad,recibido,estado_item,alta_operation_id,creado_en) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run(recId, alta.id_woo, alta.sku, 'Casco Nuevo', 5, 1, 'creado', '550e8400-e29b-41d4-a716-446655440099', 'x');

    // 3) Confirmar: usa el mismo mock stateful de Woo (axios) para el GET/PATCH de stock.
    // También sirve para verificarAltaCreado (GET de status draft) — sigue siendo 'draft' porque el
    // mock de axios devuelve solo stock_quantity y ningún status, así que hay que agregarlo acá.
    axios.request.mockImplementation(async (opts) => {
      if (opts.method === 'get') return { status: 200, data: { stock_quantity: stockWc, status: 'draft' } };
      stockWc = opts.data.stock_quantity;
      return { status: 200, data: {} };
    });
    const res = await request(app).post(`/api/recepciones/${recId}/confirmar`).send();

    expect(res.body.aplicados).toBe(1);
    expect(res.body.errores).toBe(0);
    // Path correcto: simple → /products/{id}, nunca /variations/.
    const urls = axios.request.mock.calls.map(c => c[0].url);
    expect(urls.every(u => !u.includes('/variations/'))).toBe(true);
    expect(urls.some(u => u.includes(`/products/${alta.id_woo}`))).toBe(true);

    const item = db.prepare('SELECT * FROM recepcion_items WHERE recepcion_id=?').get(recId);
    expect(item.estado_item).toBe('aplicado');
    expect(item.stock_previo).toBe(0);
    expect(item.stock_nuevo).toBe(5); // 0 (alta) + 5 (recibido)

    // Exactamente un PATCH de stock — no doble aplicación.
    const patches = axios.request.mock.calls.filter(c => c[0].method === 'patch');
    expect(patches).toHaveLength(1);
    expect(patches[0][0].data.stock_quantity).toBe(5);
  });
});

describe('P0.3 — el servidor nunca confía en un id_woo/estado "creado" que manda el cliente', () => {
  const DB = './test/tmp-recep-p03.sqlite';
  let db, app;

  beforeEach(() => {
    if (fs.existsSync(DB)) fs.unlinkSync(DB);
    db = openDb(DB);
    app = makeApp(db);
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(DB)) fs.unlinkSync(DB);
  });

  it('POST / degrada a "pendiente" un ítem que dice estado_item:"creado" sin alta verificable', async () => {
    const res = await request(app).post('/api/recepciones').send({
      proveedor: 'P', fecha: '2026-07-16',
      items: [{ id_woo: 999, sku: 'FALSO', nombre_doc: 'x', cantidad: 1, estado_item: 'creado', alta_operation_id: 'no-existe' }],
    });
    const item = db.prepare('SELECT * FROM recepcion_items WHERE recepcion_id=?').get(res.body.id);
    expect(item.estado_item).toBe('pendiente'); // no 'creado': no hay alta real que lo respalde
    expect(item.alta_operation_id).toBeNull();
  });

  it('POST / degrada a "pendiente" incluso con un operation_id real si el id_woo no coincide', async () => {
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO recepcion_altas_woo (operation_id,request_hash,estado,modo,id_woo,sku,creado_por,creado_en,actualizado_en) VALUES (?,?,?,?,?,?,?,?,?)"
    ).run('op-real', 'hash', 'creado', 'simple', 55, 'FB-55', 'x', now, now);
    const res = await request(app).post('/api/recepciones').send({
      proveedor: 'P', fecha: '2026-07-16',
      // El cliente manda un id_woo DISTINTO al que la alta real tiene — no se le cree.
      items: [{ id_woo: 66, sku: 'OTRO', nombre_doc: 'x', cantidad: 1, estado_item: 'creado', alta_operation_id: 'op-real' }],
    });
    const item = db.prepare('SELECT * FROM recepcion_items WHERE recepcion_id=?').get(res.body.id);
    expect(item.estado_item).toBe('pendiente');
    expect(item.alta_operation_id).toBeNull();
  });

  it('POST / conserva "creado" cuando el alta_operation_id sí verifica contra recepcion_altas_woo', async () => {
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO recepcion_altas_woo (operation_id,request_hash,estado,modo,id_woo,sku,creado_por,creado_en,actualizado_en) VALUES (?,?,?,?,?,?,?,?,?)"
    ).run('op-real', 'hash', 'creado', 'simple', 55, 'FB-55', 'x', now, now);
    const res = await request(app).post('/api/recepciones').send({
      proveedor: 'P', fecha: '2026-07-16',
      items: [{ id_woo: 55, sku: 'FB-55', nombre_doc: 'x', cantidad: 1, estado_item: 'creado', alta_operation_id: 'op-real' }],
    });
    const item = db.prepare('SELECT * FROM recepcion_items WHERE recepcion_id=?').get(res.body.id);
    expect(item.estado_item).toBe('creado');
    expect(item.alta_operation_id).toBe('op-real');
  });

  it('el confirm route NUNCA llama a syncSkuPuntual (ML) para el primer stock de una alta', async () => {
    const now = new Date().toISOString();
    db.prepare('INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,id_padre,stock,actualizado_en) VALUES (?,?,?,?,?,?,?)')
      .run(55, 'Casco', 'FB-55', 'simple', null, 0, 'x');
    db.prepare(
      "INSERT INTO recepcion_altas_woo (operation_id,request_hash,estado,modo,id_woo,sku,creado_por,creado_en,actualizado_en) VALUES (?,?,?,?,?,?,?,?,?)"
    ).run('op-real', 'hash', 'creado', 'simple', 55, 'FB-55', 'x', now, now);
    const recId = db.prepare(
      "INSERT INTO recepciones (proveedor,fecha,solo_documento,estado,creado_en) VALUES ('P','2026-07-16',0,'borrador','x')"
    ).run().lastInsertRowid;
    db.prepare(
      'INSERT INTO recepcion_items (recepcion_id,id_woo,sku,nombre_doc,cantidad,recibido,estado_item,alta_operation_id,creado_en) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run(recId, 55, 'FB-55', 'Casco', 3, 1, 'creado', 'op-real', now);

    let stockWc = 0;
    axios.request.mockImplementation(async (opts) => {
      if (opts.method === 'get') return { status: 200, data: { stock_quantity: stockWc, status: 'draft' } };
      stockWc = opts.data.stock_quantity;
      return { status: 200, data: {} };
    });

    const res = await request(app).post(`/api/recepciones/${recId}/confirmar`).send();
    expect(res.body.aplicados).toBe(1);
    expect(syncModule.syncSkuPuntual).not.toHaveBeenCalled();
    // Evidencia explícita de la exclusión, no un silencio indistinguible de "no había nada que hacer".
    expect(res.body.sync_ml).toEqual([{ sku: 'FB-55', estado: 'excluido_alta', detalle: expect.stringContaining('Mercado Libre') }]);
  });

  it('si la alta no verifica contra recepcion_altas_woo al confirmar, no aplica stock ni llama a ML', async () => {
    // Sin fila en recepcion_altas_woo para este operation_id: la fabricó el cliente sin pasar por
    // crear-alta. Simula el caso de un POST / manipulado que igual hubiera degradado el estado (esto
    // prueba la segunda barrera, por si la primera fallara o el dato cambió entre guardar y confirmar).
    const now = new Date().toISOString();
    db.prepare('INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,id_padre,stock,actualizado_en) VALUES (?,?,?,?,?,?,?)')
      .run(77, 'Casco', 'FB-77', 'simple', null, 0, 'x');
    const recId = db.prepare(
      "INSERT INTO recepciones (proveedor,fecha,solo_documento,estado,creado_en) VALUES ('P','2026-07-16',0,'borrador','x')"
    ).run().lastInsertRowid;
    db.prepare(
      'INSERT INTO recepcion_items (recepcion_id,id_woo,sku,nombre_doc,cantidad,recibido,estado_item,alta_operation_id,creado_en) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run(recId, 77, 'FB-77', 'Casco', 3, 1, 'creado', 'op-inventado', now);

    axios.request.mockImplementation(async (opts) => {
      if (opts.method === 'get') return { status: 200, data: { stock_quantity: 0, status: 'draft' } };
      return { status: 200, data: {} };
    });

    const res = await request(app).post(`/api/recepciones/${recId}/confirmar`).send();
    expect(res.body.aplicados).toBe(0);
    expect(res.body.errores).toBe(1);
    expect(syncModule.syncSkuPuntual).not.toHaveBeenCalled();
    const patches = axios.request.mock.calls.filter(c => c[0].method === 'patch');
    expect(patches).toHaveLength(0);
  });

  it('crear-alta: dos llamadas concurrentes sobre el mismo ítem solo crean UNA alta', async () => {
    let posts = 0;
    axios.request.mockImplementation(async (opts) => {
      if (opts.method === 'post') { posts++; await new Promise(r => setTimeout(r, 5)); return { status: 200, data: { id: 900, status: 'draft', stock_quantity: 0 } }; }
      if (opts.method === 'patch') return { status: 200, data: { id: 900, status: 'draft', stock_quantity: 0, sku: 'FB-900' } };
      return { status: 200, data: { id: 900, status: 'draft', stock_quantity: 0, sku: 'FB-900' } };
    });
    const recId = db.prepare(
      "INSERT INTO recepciones (proveedor,fecha,solo_documento,estado,creado_en) VALUES ('P','2026-07-16',0,'borrador','x')"
    ).run().lastInsertRowid;
    const itemId = db.prepare(
      'INSERT INTO recepcion_items (recepcion_id,nombre_doc,cantidad,recibido,creado_en) VALUES (?,?,?,?,?)'
    ).run(recId, 'Producto nuevo', 1, 1, 'x').lastInsertRowid;

    const ficha = { modo: 'simple', titulo: 'X', marca: 'M', categoria_id: 1, categoria_nombre: 'C', precio: '100', atributos: [{ nombre: 'Color', valor: 'Negro' }] };
    const [r1, r2] = await Promise.all([
      request(app).post(`/api/recepciones/${recId}/items/${itemId}/crear-alta`).send({ ficha }),
      request(app).post(`/api/recepciones/${recId}/items/${itemId}/crear-alta`).send({ ficha }),
    ]);
    // Una gana (200), la otra se bloquea (409) — nunca las dos generan un producto en Woo.
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]);
    expect(posts).toBe(1);
  });

  it('el claim de crear-alta es un compare-and-swap real: dos lecturas "null" simultáneas, una sola escritura gana', () => {
    // Node es single-threaded y no hay await entre el SELECT y el claim UPDATE dentro de la ruta —
    // por eso una carrera real entre dos requests HTTP casi nunca se observa en un test (cada
    // prefijo síncrono corre entero antes de que el otro request arranque). Lo que sí hay que
    // garantizar, y este test lo hace sin depender del scheduling de Node, es que el WHERE del
    // UPDATE es un CAS de verdad: dos llamadas que leyeron el mismo valor viejo (null, como pasaría
    // si dos pestañas cargaron la página antes de que cualquiera disparara el alta) no pueden ganar
    // las dos.
    const recId = db.prepare(
      "INSERT INTO recepciones (proveedor,fecha,solo_documento,estado,creado_en) VALUES ('P','2026-07-16',0,'borrador','x')"
    ).run().lastInsertRowid;
    const itemId = db.prepare(
      'INSERT INTO recepcion_items (recepcion_id,nombre_doc,cantidad,recibido,creado_en) VALUES (?,?,?,?,?)'
    ).run(recId, 'Producto nuevo', 1, 1, 'x').lastInsertRowid;

    // Dos "callers" que leyeron el mismo item.alta_operation_id = null (la lectura previa al claim).
    const valorViejoLeidoPorAmbos = null;
    const claimA = db.prepare(
      'UPDATE recepcion_items SET alta_operation_id=? WHERE id=? AND (alta_operation_id IS NULL OR alta_operation_id=?)'
    ).run('op-A', itemId, valorViejoLeidoPorAmbos);
    const claimB = db.prepare(
      'UPDATE recepcion_items SET alta_operation_id=? WHERE id=? AND (alta_operation_id IS NULL OR alta_operation_id=?)'
    ).run('op-B', itemId, valorViejoLeidoPorAmbos);
    expect(claimA.changes + claimB.changes).toBe(1); // exactamente uno de los dos ganó
    expect(db.prepare('SELECT alta_operation_id FROM recepcion_items WHERE id=?').get(itemId).alta_operation_id).toBe('op-A');
  });

  it('crear-alta: un segundo intento sobre una alta ya "creado" devuelve el resultado conocido, sin volver a crear', async () => {
    let posts = 0;
    axios.request.mockImplementation(async (opts) => {
      if (opts.method === 'post') { posts++; return { status: 200, data: { id: 900, status: 'draft', stock_quantity: 0 } }; }
      if (opts.method === 'patch') return { status: 200, data: { id: 900, status: 'draft', stock_quantity: 0, sku: 'FB-900' } };
      return { status: 200, data: { id: 900, status: 'draft', stock_quantity: 0, sku: 'FB-900' } };
    });
    const recId = db.prepare(
      "INSERT INTO recepciones (proveedor,fecha,solo_documento,estado,creado_en) VALUES ('P','2026-07-16',0,'borrador','x')"
    ).run().lastInsertRowid;
    const itemId = db.prepare(
      'INSERT INTO recepcion_items (recepcion_id,nombre_doc,cantidad,recibido,creado_en) VALUES (?,?,?,?,?)'
    ).run(recId, 'Producto nuevo', 1, 1, 'x').lastInsertRowid;

    const ficha = { modo: 'simple', titulo: 'X', marca: 'M', categoria_id: 1, categoria_nombre: 'C', precio: '100', atributos: [{ nombre: 'Color', valor: 'Negro' }] };
    const r1 = await request(app).post(`/api/recepciones/${recId}/items/${itemId}/crear-alta`).send({ ficha });
    expect(r1.status).toBe(200);
    const r2 = await request(app).post(`/api/recepciones/${recId}/items/${itemId}/crear-alta`).send({ ficha });
    expect(r2.status).toBe(200);
    expect(r2.body.ya_creado).toBe(true);
    expect(r2.body.id_woo).toBe(r1.body.id_woo);
    expect(posts).toBe(1); // no se creó un segundo producto en Woo
  });
});

describe('P1 — POST / y /:id/actualizar aprenden alias si el ítem trae aprender:true', () => {
  const DB = './test/tmp-recep-aliases.sqlite';
  let db, app;
  beforeEach(() => {
    if (fs.existsSync(DB)) fs.unlinkSync(DB);
    db = openDb(DB);
    app = makeApp(db);
    db.prepare(
      'INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,id_padre,stock,actualizado_en) VALUES (10,?,?,?,?,?,?)'
    ).run('Casco', 'CASCO', 'simple', null, 5, 'x');
  });
  afterEach(() => {
    db.close();
    if (fs.existsSync(DB)) fs.unlinkSync(DB);
  });

  it('POST / con aprender:true persiste el alias de proveedor', async () => {
    const res = await request(app).post('/api/recepciones').send({
      proveedor: 'Bike Group', fecha: '2026-09-22',
      items: [{ nombre_doc: 'Casco', codigo_proveedor: 'BX-1', id_woo: 10, sku: 'CASCO', cantidad: 1, aprender_alias: true }],
    });
    expect(res.body.ok).toBe(true);
    const alias = db.prepare("SELECT * FROM recepcion_aliases_proveedor WHERE proveedor_norm='bike group' AND codigo_norm='bx 1' AND vigente_hasta IS NULL").get();
    expect(alias).toBeTruthy();
    expect(alias.id_woo).toBe(10);
    expect(alias.recepcion_item_id).toBe(db.prepare('SELECT id FROM recepcion_items WHERE recepcion_id=?').get(res.body.id).id);
  });

  it('POST / sin aprender (toggle desmarcado, default) no persiste ningún alias', async () => {
    const res = await request(app).post('/api/recepciones').send({
      proveedor: 'Bike Group', fecha: '2026-09-22',
      items: [{ nombre_doc: 'Casco', codigo_proveedor: 'BX-1', id_woo: 10, sku: 'CASCO', cantidad: 1 }],
    });
    expect(res.body.ok).toBe(true);
    expect(db.prepare('SELECT * FROM recepcion_aliases_proveedor').all()).toHaveLength(0);
  });

  it('un fallo al aprender el alias (motivo requerido para reasignar) no impide guardar la recepción', async () => {
    // Primero un alias real y vigente para esta clave, apuntando a otro id_woo.
    db.prepare('INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,id_padre,stock,actualizado_en) VALUES (11,?,?,?,?,?,?)').run('Casco B', 'CASCO-B', 'simple', null, 5, 'x');
    db.exec("INSERT INTO recepcion_aliases_proveedor (proveedor_norm,codigo_norm,descripcion_norm,variacion_norm,id_woo,sku,creado_por,vigente_desde) VALUES ('bike group','bx 1','casco','',11,'CASCO-B','j','x')");
    // El ítem intenta aprender el mismo código pero apuntando a otro id_woo, sin motivo: confirmarAlias tira.
    const res = await request(app).post('/api/recepciones').send({
      proveedor: 'Bike Group', fecha: '2026-09-22',
      items: [{ nombre_doc: 'Casco', codigo_proveedor: 'BX-1', id_woo: 10, sku: 'CASCO', cantidad: 1, aprender_alias: true }],
    });
    expect(res.body.ok).toBe(true); // la recepción se guarda igual
    expect(db.prepare('SELECT * FROM recepcion_items WHERE recepcion_id=?').all(res.body.id)).toHaveLength(1);
    // El alias original sigue vigente: no se aprendió el reemplazo por falta de motivo.
    const vigente = db.prepare("SELECT * FROM recepcion_aliases_proveedor WHERE proveedor_norm='bike group' AND codigo_norm='bx 1' AND vigente_hasta IS NULL").get();
    expect(vigente.id_woo).toBe(11);
  });

  it('POST /:id/actualizar con aprender:true también persiste el alias', async () => {
    const create = await request(app).post('/api/recepciones').send({
      proveedor: 'Bike Group', fecha: '2026-09-22',
      items: [{ nombre_doc: 'Casco', id_woo: null, cantidad: 1 }], // sin match al guardar
    });
    const res = await request(app).post(`/api/recepciones/${create.body.id}/actualizar`).send({
      items: [{ nombre_doc: 'Casco', codigo_proveedor: 'BX-1', id_woo: 10, sku_wc: 'CASCO', cantidad: 1, aprender_alias: true }],
    });
    expect(res.body.ok).toBe(true);
    const alias = db.prepare("SELECT * FROM recepcion_aliases_proveedor WHERE proveedor_norm='bike group' AND codigo_norm='bx 1' AND vigente_hasta IS NULL").get();
    expect(alias).toBeTruthy();
    expect(alias.id_woo).toBe(10);
  });
});
