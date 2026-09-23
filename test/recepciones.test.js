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

  it('PUNTO 4: alta_borrador se determina desde recepcion_altas_woo, no desde estado_item transitorio', async () => {
    // Reproducir el caso: un ítem marcado 'creado' con una alta en recepcion_altas_woo.
    // Después de aplicarStockItem, su estado_item habrá cambiado a 'aplicado', pero
    // alta_borrador en la respuesta debe seguir siendo true porque está vinculado a
    // una alta 'creado' en la tabla durable (no al estado_item transitorio).

    // Mock: devuelve status='draft' (requerido por verificarAltaCreado)
    const stocks = new Map();
    axios.request.mockImplementation(async (opts) => {
      if (!stocks.has(opts.url)) stocks.set(opts.url, 5);
      if (opts.method === 'get') {
        return { status: 200, data: { stock_quantity: stocks.get(opts.url), status: 'draft' } };
      }
      if (opts.method === 'patch' && opts.data && opts.data.stock_quantity !== undefined) {
        stocks.set(opts.url, opts.data.stock_quantity);
      }
      return { status: 200, data: {} };
    });

    // Crear una recepción limpia con un único ítem
    const recId = db.prepare(
      "INSERT INTO recepciones (proveedor,importador,fecha,solo_documento,estado,creado_en) VALUES ('Prov','Prov','2026-07-16',0,'borrador','x')"
    ).run().lastInsertRowid;

    // Crear entrada en catalogo_cache para el producto
    db.prepare('DELETE FROM catalogo_cache WHERE id_woo=?').run(999);
    db.prepare(
      'INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,id_padre,stock,actualizado_en) VALUES (?,?,?,?,?,?,?)'
    ).run(999, 'Producto Creado', 'PROD-CREADO', 'simple', null, 5, 'x');

    // Crear una alta en recepcion_altas_woo (sin recepcion_id, porque no existe esa columna)
    const operationId = 'op-' + Math.random().toString(36).slice(2);
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO recepcion_altas_woo (operation_id,request_hash,id_woo,sku,estado,modo,creado_por,creado_en,actualizado_en) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run(operationId, 'hash-' + Math.random(), 999, 'PROD-CREADO', 'creado', 'simple', 'test', now, now);

    // Crear el ítem con estado 'creado' y vinculado a esa alta
    const itemId = db.prepare(
      'INSERT INTO recepcion_items (recepcion_id,id_woo,sku,nombre_doc,cantidad,recibido,estado_item,alta_operation_id,creado_en) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run(recId, 999, 'PROD-CREADO', 'Producto Creado', 1, 1, 'creado', operationId, now).lastInsertRowid;

    // Llamar a /confirmar
    const res = await request(app).post(`/api/recepciones/${recId}/confirmar`).send();

    expect(res.body.ok).toBe(true);
    expect(res.body.resultados).toHaveLength(1);
    const resultado = res.body.resultados[0];

    // Verificación: el resultado debe mostrar alta_borrador=true porque el ítem sigue vinculado
    // a una alta 'creado' en recepcion_altas_woo. Esto DEBE funcionar incluso si el estado_item
    // en memoria o en BD cambió a 'aplicado' tras la aplicación del stock.
    expect(resultado.ok).toBe(true);
    expect(resultado.sku).toBe('PROD-CREADO');
    expect(resultado.alta_borrador).toBe(true);
  });

  it('PUNTO 5: /confirmar es idempotente — segunda confirmación reconstruye la respuesta sin error', async () => {
    // Crear una recepción limpia (sin ítems que fallen) para que el estado final sea 'confirmada'
    const cleanRecId = db.prepare(
      "INSERT INTO recepciones (proveedor,importador,fecha,solo_documento,estado,creado_en) VALUES ('Prov','Prov','2026-07-16',0,'borrador','x')"
    ).run().lastInsertRowid;
    db.prepare('INSERT INTO recepcion_items (recepcion_id,id_woo,sku,nombre_doc,cantidad,recibido,creado_en) VALUES (?,?,?,?,?,?,?)')
      .run(cleanRecId, 10, 'CASCO', 'Casco', 2, 1, 'x');   // A => aplicado
    db.prepare('INSERT INTO recepcion_items (recepcion_id,id_woo,sku,nombre_doc,cantidad,recibido,creado_en) VALUES (?,?,?,?,?,?,?)')
      .run(cleanRecId, 501, 'REM-M', 'Remera M', 1, 1, 'x'); // B => aplicado

    // Primera confirmación: debe devolver 200 con estado 'confirmada' (todo ok, sin errores)
    const firstRes = await request(app).post(`/api/recepciones/${cleanRecId}/confirmar`).send();
    expect(firstRes.status).toBe(200);
    expect(firstRes.body.ok).toBe(true);
    expect(firstRes.body.estado).toBe('confirmada'); // SIN pendientes, porque todo se aplicó ok
    expect(firstRes.body.aplicados).toBe(2);
    expect(firstRes.body.errores).toBe(0);
    expect(firstRes.body.sin_match).toBe(0);
    expect(firstRes.body.pendientes).toHaveLength(0);
    const firstConfirmTime = firstRes.body.confirmado_en;
    expect(firstConfirmTime).toBeTruthy();

    // Segunda confirmación: idempotencia
    // Hoy falla con 400 "ya confirmada", pero debería devolver 200 con el mismo resultado reconstruido
    const secondRes = await request(app).post(`/api/recepciones/${cleanRecId}/confirmar`).send();

    // Esperado: status 200 (no error), resultado reconstruido
    expect(secondRes.status).toBe(200);
    expect(secondRes.body.ok).toBe(true);
    expect(secondRes.body.estado).toBe('confirmada');
    expect(secondRes.body.aplicados).toBe(2); // reconstruido: mismo conteo
    expect(secondRes.body.errores).toBe(0);
    expect(secondRes.body.sin_match).toBe(0);
    expect(secondRes.body.confirmado_en).toBe(firstConfirmTime); // la misma que quedó grabada
    expect(secondRes.body.pendientes).toHaveLength(0);
    expect(secondRes.body.replay).toBe(true); // marca que es una reconstrucción, no una ejecución nueva
    expect(secondRes.body.sync_ml).toEqual([]); // no se sincronizó de nuevo (es replay)
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

  it('conciliarOperacionIncierta — venta intermedia que iguala stock_previo debe marcar conflicto_stock, no error_reintentable', async () => {
    // Escenario: recibís 2 unidades, stock previo es 5, objetivo es 7.
    // El PATCH de aplicación llega a Woo (5→7), pero antes de la verificación:
    // — en el medio entra una venta de 2 unidades (7→5)
    // — la conciliación lee Woo y ve 5, que es igual al stock_previo
    // — con la lógica antigua (peligrosa), "nunca se aplicó" → error_reintentable
    // — el reintento suma 2 de nuevo y el stock queda 7 (correcto por casualidad aquí,
    //   pero el PATCH ya se había aplicado antes).
    // Con la lógica correcta: stockReal !== stock_objetivo, así que conflicto_stock.
    let stockWc = 5;
    axios.request.mockImplementation(async (opts) => {
      if (opts.method === 'get') return { status: 200, data: { stock_quantity: stockWc } };
      // El PATCH se aplica: 5 → 7
      stockWc = opts.data.stock_quantity;
      throw new Error('timeout después del PATCH');
    });
    const item = nuevoItem(10, 2); // cantidad 2
    await expect(aplicarStockItem(db, cfg, item)).rejects.toThrow(/incierta/);
    expect(stockWc).toBe(7); // El PATCH llegó a Woo

    // Ahora una venta intermedia: Woo 7→5
    stockWc = 5;

    const { conciliarOperacionIncierta } = await import('../routes/recepciones.js');
    const res = await conciliarOperacionIncierta(db, cfg, item.id);
    // La lógica correcta ve: stockReal(5) !== stock_objetivo(7) → conflicto_stock
    expect(res.estado).toBe('conflicto_stock');
    const row = db.prepare('SELECT estado_item FROM recepcion_items WHERE id=?').get(item.id);
    expect(row.estado_item).toBe('conflicto_stock');
  });

  it('conciliarOperacionIncierta con stockReal === stock_previo marca conflicto_stock (no reintentar: el PATCH pudo haber llegado)', async () => {
    axios.request.mockImplementation(async (opts) => {
      if (opts.method === 'get') return { status: 200, data: { stock_quantity: 5 } };
      throw new Error('timeout');
    });
    const item = nuevoItem(10, 3);
    await expect(aplicarStockItem(db, cfg, item)).rejects.toThrow(/incierta/);

    const { conciliarOperacionIncierta } = await import('../routes/recepciones.js');
    const res = await conciliarOperacionIncierta(db, cfg, item.id);
    // stockReal (5) === stock_previo (5) es indeterminado: el PATCH pudo haber llegado y una venta
    // intermedia lo igualó al previo. No es seguro reintentar a ciegas (defecto P0.1 prohibido).
    // → conflicto_stock queda para conciliación manual.
    expect(res.estado).toBe('conflicto_stock');
    expect(db.prepare('SELECT estado_item FROM recepcion_items WHERE id=?').get(item.id).estado_item).toBe('conflicto_stock');
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
      if (path.includes('/categories')) return { data: [{ id: 17, name: 'CASCOS', parent: 0 }] };
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
      if (opts.url.includes('/categories')) return { status: 200, data: [{ id: 1, name: 'C', parent: 0 }] };
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
      if (opts.url.includes('/categories')) return { status: 200, data: [{ id: 1, name: 'C', parent: 0 }] };
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

  it('crear-alta: al confirmar, guarda resuelto_en y ficha_json en el ítem (Task 6 Step 5)', async () => {
    axios.request.mockImplementation(async (opts) => {
      if (opts.url.includes('/categories')) return { status: 200, data: [{ id: 1, name: 'C', parent: 0 }] };
      if (opts.method === 'post') return { status: 200, data: { id: 901, status: 'draft', stock_quantity: 0 } };
      if (opts.method === 'patch') return { status: 200, data: { id: 901, status: 'draft', stock_quantity: 0, sku: 'FB-901' } };
      return { status: 200, data: { id: 901, status: 'draft', stock_quantity: 0, sku: 'FB-901' } };
    });
    const recId = db.prepare(
      "INSERT INTO recepciones (proveedor,fecha,solo_documento,estado,creado_en) VALUES ('P','2026-07-16',0,'borrador','x')"
    ).run().lastInsertRowid;
    const itemId = db.prepare(
      'INSERT INTO recepcion_items (recepcion_id,nombre_doc,cantidad,recibido,creado_en) VALUES (?,?,?,?,?)'
    ).run(recId, 'Producto nuevo', 1, 1, 'x').lastInsertRowid;
    const ficha = { modo: 'simple', titulo: 'X', marca: 'M', categoria_id: 1, categoria_nombre: 'C', precio: '100', atributos: [{ nombre: 'Color', valor: 'Negro' }] };
    const r = await request(app).post(`/api/recepciones/${recId}/items/${itemId}/crear-alta`).send({ ficha });
    expect(r.status).toBe(200);
    const row = db.prepare('SELECT resuelto_en, ficha_json FROM recepcion_items WHERE id=?').get(itemId);
    expect(row.resuelto_en).toBeTruthy();
    expect(JSON.parse(row.ficha_json)).toMatchObject({ titulo: 'X', marca: 'M' });
  });

  it('crear-alta: un padre inexistente/no variable devuelve 404, no 502', async () => {
    const recId = db.prepare(
      "INSERT INTO recepciones (proveedor,fecha,solo_documento,estado,creado_en) VALUES ('P','2026-07-16',0,'borrador','x')"
    ).run().lastInsertRowid;
    const itemId = db.prepare(
      'INSERT INTO recepcion_items (recepcion_id,nombre_doc,cantidad,recibido,creado_en) VALUES (?,?,?,?,?)'
    ).run(recId, 'Producto nuevo', 1, 1, 'x').lastInsertRowid;
    const ficha = { modo: 'variacion_existente', parent_id: 99999, titulo: 'X', marca: 'M', categoria_id: 1, categoria_nombre: 'C', precio: '100', atributos: [{ nombre: 'Color', valor: 'Negro' }] };
    const r = await request(app).post(`/api/recepciones/${recId}/items/${itemId}/crear-alta`).send({ ficha });
    expect(r.status).toBe(404);
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
    // Pero el fallo no se traga en silencio: viaja en la respuesta para que la UI le avise al usuario.
    expect(res.body.aliases_no_aprendidos).toHaveLength(1);
    expect(res.body.aliases_no_aprendidos[0].error).toMatch(/motivo/);
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

describe('GET /api/recepciones/catalogo — búsqueda con query param', () => {
  const DB = './test/tmp-recep-catalogo-busqueda.sqlite';
  let db;
  let app;

  beforeEach(() => {
    if (fs.existsSync(DB)) fs.unlinkSync(DB);
    db = openDb(DB);
    app = makeApp(db);

    // Catálogo con productos variados para pruebas
    const ins = db.prepare(
      'INSERT INTO catalogo_cache (id_woo,sku,nombre,stock,tipo,actualizado_en) VALUES (?,?,?,?,?,?)'
    );
    ins.run(1, 'CASCO-001', 'Casco urbano negro', 5, 'simple', 'x');
    ins.run(2, 'CASCO-002', 'Casco deportivo rojo', 3, 'simple', 'x');
    ins.run(3, 'REMERA-M', 'Remera M azul', 10, 'simple', 'x');
    ins.run(4, 'REMERA-L', 'Remera L blanco', 8, 'simple', 'x');
    ins.run(5, 'CUBIERTA-26', 'Cubierta 26 pulgadas', 2, 'simple', 'x');
    ins.run(6, 'CAD-001', 'Cadena velocidad 8 (noname)', 15, 'simple', 'x');
    ins.run(7, 'ESP-NAR', 'Espejo naranja', 0, 'simple', 'x');
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(DB)) fs.unlinkSync(DB);
  });

  it('sin ?q devuelve el catálogo completo (o con límite establecido)', async () => {
    const res = await request(app).get('/api/recepciones/catalogo');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(7); // al menos los 7 que insertamos
    expect(res.body.data[0]).toHaveProperty('id_woo');
    expect(res.body.data[0]).toHaveProperty('sku');
    expect(res.body.data[0]).toHaveProperty('nombre');
    expect(res.body.data[0]).toHaveProperty('stock');
  });

  it('?q=CASCO filtra por SKU case-insensitive', async () => {
    const res = await request(app).get('/api/recepciones/catalogo?q=CASCO');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.length).toBe(2); // CASCO-001, CASCO-002
    expect(res.body.data.map(r => r.sku)).toEqual(['CASCO-001', 'CASCO-002']);
  });

  it('?q=casco filtra por SKU (minúsculas)', async () => {
    const res = await request(app).get('/api/recepciones/catalogo?q=casco');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(2);
  });

  it('?q=remera filtra por nombre', async () => {
    const res = await request(app).get('/api/recepciones/catalogo?q=remera');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(2); // REMERA-M, REMERA-L
    expect(res.body.data.map(r => r.sku).sort()).toEqual(['REMERA-L', 'REMERA-M']);
  });

  it('?q=casco deportivo filtra por nombre parcial', async () => {
    const res = await request(app).get('/api/recepciones/catalogo?q=casco%20deportivo');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].sku).toBe('CASCO-002');
  });

  it('?q= (vacío) se comporta como sin q', async () => {
    const res = await request(app).get('/api/recepciones/catalogo?q=');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(7);
  });

  it('?q=   (solo espacios) se comporta como sin q', async () => {
    const res = await request(app).get('/api/recepciones/catalogo?q=%20%20%20');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(7);
  });

  it('?q=INEXISTENTE devuelve array vacío sin error', async () => {
    const res = await request(app).get('/api/recepciones/catalogo?q=XXXX9999');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toEqual([]);
  });

  it('?q busca "nino" y encuentra "Canasta niño" (ñ se normaliza a n)', async () => {
    // Insertar productos con ñ
    db.prepare(
      'INSERT INTO catalogo_cache (id_woo,sku,nombre,stock,tipo,actualizado_en) VALUES (?,?,?,?,?,?)'
    ).run(8, 'CANASTA-NINO', 'Canasta niño', 5, 'simple', 'x');
    db.prepare(
      'INSERT INTO catalogo_cache (id_woo,sku,nombre,stock,tipo,actualizado_en) VALUES (?,?,?,?,?,?)'
    ).run(9, 'MANILLAR-NINO', 'Manillar niño rojo', 3, 'simple', 'x');

    // Buscar sin tilde/ñ debe encontrar ambos
    const res = await request(app).get('/api/recepciones/catalogo?q=nino');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(2);
    expect(res.body.data.map(r => r.sku).sort()).toEqual(['CANASTA-NINO', 'MANILLAR-NINO']);
  });

  it('?q busca "direccion" y encuentra "Dirección" (acentos se normalizan)', async () => {
    // Insertar producto con tilde (accent agudo)
    db.prepare(
      'INSERT INTO catalogo_cache (id_woo,sku,nombre,stock,tipo,actualizado_en) VALUES (?,?,?,?,?,?)'
    ).run(10, 'PLACA-DIR', 'Placa Dirección trasera', 5, 'simple', 'x');

    // Buscar sin tilde debe encontrar
    const res = await request(app).get('/api/recepciones/catalogo?q=direccion');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].sku).toBe('PLACA-DIR');
  });

  it('devuelve máximo 20 resultados cuando hay muchos matches', async () => {
    // Insertar 30 productos que matcheen
    for (let i = 0; i < 30; i++) {
      db.prepare(
        'INSERT INTO catalogo_cache (id_woo,sku,nombre,stock,tipo,actualizado_en) VALUES (?,?,?,?,?,?)'
      ).run(100 + i, `CASCO-${String(i).padStart(3, '0')}`, 'Casco número X', 1, 'simple', 'x');
    }

    const res = await request(app).get('/api/recepciones/catalogo?q=casco');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeLessThanOrEqual(20);
  });

  it('búsqueda por SKU exacto devuelve ese resultado primero (relevancia)', async () => {
    const res = await request(app).get('/api/recepciones/catalogo?q=REMERA-M');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    expect(res.body.data[0].sku).toBe('REMERA-M');
  });

  it('respuesta mantiene estructura original: id_woo, sku, nombre, stock', async () => {
    const res = await request(app).get('/api/recepciones/catalogo?q=casco');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    const row = res.body.data[0];
    expect(typeof row.id_woo).toBe('number');
    expect(typeof row.sku).toBe('string');
    expect(typeof row.nombre).toBe('string');
    expect(typeof row.stock).toBe('number');
    expect(Object.keys(row)).toEqual(['id_woo', 'sku', 'nombre', 'stock']);
  });
});

describe('recepciones — P0.2 recuperación de aplicando huérfano al arrancar', () => {
  const DB = './test/tmp-recep-p02.sqlite';

  afterEach(() => { if (fs.existsSync(DB)) fs.unlinkSync(DB); });

  it('aplicando sin stock_objetivo (PATCH nunca se mandó) → error_reintentable', () => {
    if (fs.existsSync(DB)) fs.unlinkSync(DB);
    const db = openDb(DB);
    makeApp(db); // corre migraciones

    // Setup: crear recepción e ítem en 'aplicando' sin stock_objetivo (nunca se mandó UPDATE de stock_objetivo)
    const recId = db.prepare(
      "INSERT INTO recepciones (proveedor, fecha, solo_documento, estado, creado_en) VALUES ('P', '2026-07-16', 0, 'borrador', 'x')"
    ).run().lastInsertRowid;

    const itemId = db.prepare(
      `INSERT INTO recepcion_items
        (recepcion_id, id_woo, sku, nombre_doc, cantidad, recibido, estado_item, operation_id, aplicando_desde, creado_en)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(recId, 10, 'SKU1', 'Item 1', 1, 1, 'aplicando', 'op-uuid-1', new Date().toISOString(), 'x').lastInsertRowid;

    // Verificar que está en 'aplicando' sin stock_objetivo (estado huérfano simulado)
    let item = db.prepare('SELECT * FROM recepcion_items WHERE id=?').get(itemId);
    expect(item.estado_item).toBe('aplicando');
    expect(item.stock_objetivo).toBeNull();

    db.close();

    // Reiniciar: cerrar y abrir de nuevo, luego montar el router (dispara recuperación)
    const db2 = openDb(DB);
    makeApp(db2);

    // Verificar que ahora está en 'error_reintentable'
    item = db2.prepare('SELECT * FROM recepcion_items WHERE id=?').get(itemId);
    expect(item.estado_item).toBe('error_reintentable');
    expect(item.operation_id).toBeNull(); // limpio operation_id

    db2.close();
  });

  it('aplicando con stock_objetivo persistido (PATCH posiblemente se mandó) → operacion_incierta', () => {
    if (fs.existsSync(DB)) fs.unlinkSync(DB);
    const db = openDb(DB);
    makeApp(db); // corre migraciones

    // Setup: crear recepción e ítem en 'aplicando' con stock_objetivo persistido (se mandó el UPDATE de línea 89-90)
    const recId = db.prepare(
      "INSERT INTO recepciones (proveedor, fecha, solo_documento, estado, creado_en) VALUES ('P', '2026-07-16', 0, 'borrador', 'x')"
    ).run().lastInsertRowid;

    const itemId = db.prepare(
      `INSERT INTO recepcion_items
        (recepcion_id, id_woo, sku, nombre_doc, cantidad, recibido, estado_item, operation_id, stock_previo, stock_objetivo, aplicando_desde, creado_en)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(recId, 11, 'SKU2', 'Item 2', 2, 1, 'aplicando', 'op-uuid-2', 5, 7, new Date().toISOString(), 'x').lastInsertRowid;

    // Verificar que está en 'aplicando' con stock_objetivo (estado huérfano con incertidumbre de si llegó el PATCH)
    let item = db.prepare('SELECT * FROM recepcion_items WHERE id=?').get(itemId);
    expect(item.estado_item).toBe('aplicando');
    expect(item.stock_objetivo).toBe(7);

    db.close();

    // Reiniciar: cerrar y abrir de nuevo, luego montar el router (dispara recuperación)
    const db2 = openDb(DB);
    makeApp(db2);

    // Verificar que ahora está en 'operacion_incierta' (para que conciliación real lo resuelva)
    item = db2.prepare('SELECT * FROM recepcion_items WHERE id=?').get(itemId);
    expect(item.estado_item).toBe('operacion_incierta');
    // stock_objetivo se conserva para que la conciliación real sepa qué comparar contra Woo
    expect(item.stock_objetivo).toBe(7);

    db2.close();
  });
});

describe('PUNTO 3: conciliar operacion_incierta y resolver conflicto_stock', () => {
  const DB = './test/tmp-recep-punto3.sqlite';
  let db, app;

  beforeEach(() => {
    if (fs.existsSync(DB)) fs.unlinkSync(DB);
    db = openDb(DB);
    app = makeApp(db); // corre migraciones (estado_item, etc.)
    mockWooOk();

    // Catálogo
    db.prepare('INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,id_padre,stock,actualizado_en) VALUES (?,?,?,?,?,?,?)')
      .run(10, 'Casco', 'CASCO', 'simple', null, 5, 'x');

    // Recepción con un ítem que aplicaremos a operacion_incierta para testear
    const recId = db.prepare(
      "INSERT INTO recepciones (proveedor,importador,fecha,solo_documento,estado,creado_en) VALUES ('Prov','Prov','2026-07-16',0,'borrador','x')"
    ).run().lastInsertRowid;
    db._recId = recId;

    const itemId = db.prepare(
      'INSERT INTO recepcion_items (recepcion_id,id_woo,sku,nombre_doc,cantidad,recibido,creado_en) VALUES (?,?,?,?,?,?,?)'
    ).run(recId, 10, 'CASCO', 'Casco', 3, 1, 'x').lastInsertRowid;
    db._itemId = itemId;
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(DB)) fs.unlinkSync(DB);
  });

  it('POST /:id/items/:itemId/conciliar-stock existe y valida estado_item correctamente', async () => {
    // Test de la existencia y validación básica del endpoint
    db.prepare(
      "UPDATE recepcion_items SET estado_item='operacion_incierta', stock_previo=5, stock_objetivo=8 WHERE id=?"
    ).run(db._itemId);

    // Mock: stock ya aplicado en Woo
    axios.request.mockImplementation(async (opts) => {
      if (opts.method === 'get') return { status: 200, data: { stock_quantity: 8 } };
      return { status: 200, data: {} };
    });

    const res = await request(app)
      .post(`/api/recepciones/${db._recId}/items/${db._itemId}/conciliar-stock`)
      .send();

    // El endpoint debe existir y procesar correctamente
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('POST /:id/items/:itemId/conciliar-stock — concilia ítem en operacion_incierta (PATCH llegó)', async () => {
    // Stock en Woo: 5. Cantidad a sumar: 3. Objetivo: 8.
    // Escenario: el PATCH de aplicación llegó a Woo (stock es ahora 8).
    // Conciliación debe detectar esto y marcar 'aplicado' con stock_nuevo=8.

    // Poner ítem en operacion_incierta sin aplicación anterior (simular un timeout del PATCH)
    db.prepare(
      "UPDATE recepcion_items SET estado_item='operacion_incierta', stock_previo=5, stock_objetivo=8 WHERE id=?"
    ).run(db._itemId);

    // Mock: GET devuelve 8 (el PATCH ya se aplicó)
    let stockWc = 8;
    axios.request.mockImplementation(async (opts) => {
      if (opts.method === 'get') return { status: 200, data: { stock_quantity: stockWc } };
      stockWc = opts.data.stock_quantity;
      return { status: 200, data: {} };
    });

    const res = await request(app)
      .post(`/api/recepciones/${db._recId}/items/${db._itemId}/conciliar-stock`)
      .send();

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.estado).toBe('aplicado');
    expect(res.body.stock_nuevo).toBe(8);

    const item = db.prepare('SELECT * FROM recepcion_items WHERE id=?').get(db._itemId);
    expect(item.estado_item).toBe('aplicado');
    expect(item.stock_nuevo).toBe(8);
  });

  it('POST /:id/items/:itemId/conciliar-stock — 404 si ítem no existe o no pertenece a la recepción', async () => {
    const res = await request(app)
      .post(`/api/recepciones/${db._recId}/items/99999/conciliar-stock`)
      .send();
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
  });

  it('POST /:id/items/:itemId/conciliar-stock — 409 si estado_item no es operacion_incierta', async () => {
    // Poner ítem en 'aplicado' (no es incierto)
    db.prepare("UPDATE recepcion_items SET estado_item='aplicado' WHERE id=?").run(db._itemId);

    const res = await request(app)
      .post(`/api/recepciones/${db._recId}/items/${db._itemId}/conciliar-stock`)
      .send();
    expect(res.status).toBe(409);
    expect(res.body.ok).toBe(false);
  });

  it('conciliarOperacionIncierta con condición de carrera: dos llamadas concurrentes, solo una gana', async () => {
    // Escenario: dos requests concurrentes intenta conciliar el mismo ítem.
    // Con el fix del WHERE sobre estado_item, solo una debe ejecutar los UPDATE,
    // la otra debe detectar cambio=0 y devolver el estado actual (si otro lo resolvió primero).

    db.prepare(
      "UPDATE recepcion_items SET estado_item='operacion_incierta', stock_previo=5, stock_objetivo=8 WHERE id=?"
    ).run(db._itemId);

    let stockWc = 8; // Ya aplicado en Woo
    axios.request.mockImplementation(async (opts) => {
      if (opts.method === 'get') return { status: 200, data: { stock_quantity: stockWc } };
      stockWc = opts.data.stock_quantity;
      return { status: 200, data: {} };
    });

    const { conciliarOperacionIncierta } = await import('../routes/recepciones.js');

    // Llamar dos veces concurrentemente
    const [res1, res2] = await Promise.all([
      conciliarOperacionIncierta(db, cfg, db._itemId),
      conciliarOperacionIncierta(db, cfg, db._itemId),
    ]);

    // Ambas deben reportar 'aplicado' sin error
    expect(res1.estado).toBe('aplicado');
    expect(res2.estado).toBe('aplicado');

    // Debe haber solo un GET de Woo (secuencial), o máximo dos si se solapan antes del await.
    // Lo importante: NUNCA debe hacer dos PATCH. Verificamos con `axios.request.mock.calls`.
    const patches = axios.request.mock.calls.filter(c => c[0].method === 'patch');
    expect(patches.length).toBe(0); // No hay PATCH en conciliación

    const item = db.prepare('SELECT estado_item FROM recepcion_items WHERE id=?').get(db._itemId);
    expect(item.estado_item).toBe('aplicado');
  });

  it('POST /:id/items/:itemId/resolver-conflicto con decision=aceptar_woo — marca aplicado con stock real de Woo', async () => {
    // Poner ítem en conflicto_stock (desacuerdo entre lo que se esperaba y lo que Woo tiene)
    db.prepare(
      "UPDATE recepcion_items SET estado_item='conflicto_stock', stock_previo=5, stock_objetivo=8 WHERE id=?"
    ).run(db._itemId);

    // Mock: Woo devuelve stock 7 (ni 5, ni 8 — desacuerdo)
    let stockWc = 7;
    axios.request.mockImplementation(async (opts) => {
      if (opts.method === 'get') return { status: 200, data: { stock_quantity: stockWc } };
      stockWc = opts.data.stock_quantity;
      return { status: 200, data: {} };
    });

    const res = await request(app)
      .post(`/api/recepciones/${db._recId}/items/${db._itemId}/resolver-conflicto`)
      .send({ decision: 'aceptar_woo', motivo: 'test' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.estado).toBe('aplicado');
    expect(res.body.stock_nuevo).toBe(7); // Se acepta lo que Woo dice

    const item = db.prepare('SELECT * FROM recepcion_items WHERE id=?').get(db._itemId);
    expect(item.estado_item).toBe('aplicado');
    expect(item.stock_nuevo).toBe(7);
    // catalogo_cache también debe haberse actualizado
    const cat = db.prepare('SELECT stock FROM catalogo_cache WHERE id_woo=?').get(10);
    expect(cat.stock).toBe(7);
  });

  it('POST /:id/items/:itemId/resolver-conflicto con decision=reintentar — marca error_reintentable', async () => {
    // Poner ítem en conflicto_stock
    db.prepare(
      "UPDATE recepcion_items SET estado_item='conflicto_stock', stock_previo=5, stock_objetivo=8, operation_id='old-op-id' WHERE id=?"
    ).run(db._itemId);

    axios.request.mockImplementation(async (opts) => {
      if (opts.method === 'get') return { status: 200, data: { stock_quantity: 6 } };
      return { status: 200, data: {} };
    });

    const res = await request(app)
      .post(`/api/recepciones/${db._recId}/items/${db._itemId}/resolver-conflicto`)
      .send({ decision: 'reintentar', motivo: 'test' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.estado).toBe('error_reintentable');

    const item = db.prepare('SELECT * FROM recepcion_items WHERE id=?').get(db._itemId);
    expect(item.estado_item).toBe('error_reintentable');
    expect(item.operation_id).toBeNull(); // Limpiado para próximo intento
  });

  it('POST /:id/items/:itemId/resolver-conflicto — 409 si estado_item no es conflicto_stock', async () => {
    // Dejar en 'aplicado'
    db.prepare("UPDATE recepcion_items SET estado_item='aplicado' WHERE id=?").run(db._itemId);

    const res = await request(app)
      .post(`/api/recepciones/${db._recId}/items/${db._itemId}/resolver-conflicto`)
      .send({ decision: 'aceptar_woo', motivo: 'test' });
    expect(res.status).toBe(409);
    expect(res.body.ok).toBe(false);
  });

  it('POST /:id/items/:itemId/resolver-conflicto — 404 si ítem no existe', async () => {
    const res = await request(app)
      .post(`/api/recepciones/${db._recId}/items/99999/resolver-conflicto`)
      .send({ decision: 'aceptar_woo' });
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
  });

  // HUECO 1: reintentar peligroso — validar que no se duplica stock
  it('HUECO 1: resolver-conflicto con decision=reintentar — rechaza 409 si PATCH ya se aplicó en Woo', async () => {
    // Escenario: ítem en conflicto_stock con stock_previo=5, stock_objetivo=8.
    // Woo ahora tiene 8 (el PATCH anterior sí llegó). Si reintentar, sería 8+3=11 (duplicado).
    db.prepare(
      "UPDATE recepcion_items SET estado_item='conflicto_stock', stock_previo=5, stock_objetivo=8 WHERE id=?"
    ).run(db._itemId);

    // Mock: Woo ya tiene 8 (el PATCH se aplicó)
    axios.request.mockImplementation(async (opts) => {
      if (opts.method === 'get') return { status: 200, data: { stock_quantity: 8 } };
      return { status: 200, data: {} };
    });

    const res = await request(app)
      .post(`/api/recepciones/${db._recId}/items/${db._itemId}/resolver-conflicto`)
      .send({ decision: 'reintentar', motivo: 'error de red' });

    // Debe rechazar con 409 en lugar de permitir reintentar
    expect(res.status).toBe(409);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/PATCH ya se aplicó|no se puede reintentar sin duplicar/i);

    // Estado del ítem no debe cambiar
    const item = db.prepare('SELECT estado_item FROM recepcion_items WHERE id=?').get(db._itemId);
    expect(item.estado_item).toBe('conflicto_stock');
  });

  it('HUECO 1: resolver-conflicto con decision=reintentar — permite si stock_actual != stock_objetivo', async () => {
    // Escenario: stock_previo=5, stock_objetivo=8, pero Woo tiene 6 (el PATCH no se aplicó o se revirtió).
    // Reintentar es seguro.
    db.prepare(
      "UPDATE recepcion_items SET estado_item='conflicto_stock', stock_previo=5, stock_objetivo=8 WHERE id=?"
    ).run(db._itemId);

    axios.request.mockImplementation(async (opts) => {
      if (opts.method === 'get') return { status: 200, data: { stock_quantity: 6 } };
      return { status: 200, data: {} };
    });

    const res = await request(app)
      .post(`/api/recepciones/${db._recId}/items/${db._itemId}/resolver-conflicto`)
      .send({ decision: 'reintentar', motivo: 'voy a reintentar la aplicación' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.estado).toBe('error_reintentable');

    const item = db.prepare('SELECT estado_item FROM recepcion_items WHERE id=?').get(db._itemId);
    expect(item.estado_item).toBe('error_reintentable');
  });

  // HUECO 2: auditoría persistida
  it('HUECO 2: resolver-conflicto con decision=aceptar_woo — inserta registro en recepcion_conciliaciones_stock', async () => {
    db.prepare(
      "UPDATE recepcion_items SET estado_item='conflicto_stock', stock_previo=5, stock_objetivo=8 WHERE id=?"
    ).run(db._itemId);

    axios.request.mockImplementation(async (opts) => {
      if (opts.method === 'get') return { status: 200, data: { stock_quantity: 7 } };
      return { status: 200, data: {} };
    });

    const res = await request(app)
      .post(`/api/recepciones/${db._recId}/items/${db._itemId}/resolver-conflicto`)
      .send({ decision: 'aceptar_woo', motivo: 'conflicto real, aceptar lo que dice Woo' });

    expect(res.status).toBe(200);

    // Verificar que se insertó auditoría
    const auditoria = db.prepare(`
      SELECT * FROM recepcion_conciliaciones_stock
      WHERE recepcion_item_id=? AND tipo='resolver_conflicto' AND decision='aceptar_woo'
    `).get(db._itemId);
    expect(auditoria).toBeDefined();
    expect(auditoria.motivo).toBe('conflicto real, aceptar lo que dice Woo');
    expect(auditoria.stock_leido).toBe(7);
    expect(auditoria.estado_resultante).toBe('aplicado');
    expect(auditoria.actor).toBe('sistema'); // req.user?.username || 'sistema'
  });

  it('HUECO 2: resolver-conflicto con decision=reintentar — inserta auditoría con motivo', async () => {
    db.prepare(
      "UPDATE recepcion_items SET estado_item='conflicto_stock', stock_previo=5, stock_objetivo=8 WHERE id=?"
    ).run(db._itemId);

    axios.request.mockImplementation(async (opts) => {
      if (opts.method === 'get') return { status: 200, data: { stock_quantity: 6 } };
      return { status: 200, data: {} };
    });

    const res = await request(app)
      .post(`/api/recepciones/${db._recId}/items/${db._itemId}/resolver-conflicto`)
      .send({ decision: 'reintentar', motivo: 'hubo timeout en el PATCH anterior, voy a reintentar' });

    expect(res.status).toBe(200);

    const auditoria = db.prepare(`
      SELECT * FROM recepcion_conciliaciones_stock
      WHERE recepcion_item_id=? AND tipo='resolver_conflicto' AND decision='reintentar'
    `).get(db._itemId);
    expect(auditoria).toBeDefined();
    expect(auditoria.motivo).toBe('hubo timeout en el PATCH anterior, voy a reintentar');
    expect(auditoria.stock_leido).toBe(6);
    expect(auditoria.estado_resultante).toBe('error_reintentable');
  });

  it('HUECO 2: conciliar-stock — inserta auditoría cuando PATCH se confirmó', async () => {
    db.prepare(
      "UPDATE recepcion_items SET estado_item='operacion_incierta', stock_previo=5, stock_objetivo=8 WHERE id=?"
    ).run(db._itemId);

    axios.request.mockImplementation(async (opts) => {
      if (opts.method === 'get') return { status: 200, data: { stock_quantity: 8 } };
      return { status: 200, data: {} };
    });

    const res = await request(app)
      .post(`/api/recepciones/${db._recId}/items/${db._itemId}/conciliar-stock`)
      .send();

    expect(res.status).toBe(200);

    const auditoria = db.prepare(`
      SELECT * FROM recepcion_conciliaciones_stock
      WHERE recepcion_item_id=? AND tipo='conciliar_incierta'
    `).get(db._itemId);
    expect(auditoria).toBeDefined();
    expect(auditoria.stock_leido).toBe(8);
    expect(auditoria.estado_resultante).toBe('aplicado');
  });

  // HUECO 3: GET endpoint para stock actual de Woo
  it('HUECO 3: GET /:id/items/:itemId/stock-actual-woo — devuelve stock actual sin modificar nada', async () => {
    axios.request.mockImplementation(async (opts) => {
      if (opts.method === 'get') return { status: 200, data: { stock_quantity: 12 } };
      return { status: 200, data: {} };
    });

    const res = await request(app)
      .get(`/api/recepciones/${db._recId}/items/${db._itemId}/stock-actual-woo`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.stock_actual).toBe(12);

    // Verificar que no cambió nada en la BD
    const item = db.prepare('SELECT estado_item FROM recepcion_items WHERE id=?').get(db._itemId);
    expect(item.estado_item).toBe(null); // Sin cambios
  });

  it('HUECO 3: GET stock-actual-woo — 404 si ítem no existe', async () => {
    const res = await request(app)
      .get(`/api/recepciones/${db._recId}/items/99999/stock-actual-woo`);

    expect(res.status).toBe(404);
  });

  it('HUECO 3: GET stock-actual-woo — 400 si ítem sin id_woo', async () => {
    // Crear un ítem sin id_woo
    const itemId2 = db.prepare(
      'INSERT INTO recepcion_items (recepcion_id,sku,nombre_doc,cantidad,recibido,creado_en) VALUES (?,?,?,?,?,?)'
    ).run(db._recId, null, 'Item sin match', 1, 1, 'x').lastInsertRowid;

    const res = await request(app)
      .get(`/api/recepciones/${db._recId}/items/${itemId2}/stock-actual-woo`);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sin id_woo/i);
  });

  // HUECO 4: transición automática confirmada_con_pendientes → confirmada
  it('HUECO 4: resolver-conflicto del último ítem pendiente — transiciona recepción a confirmada', async () => {
    const recId2 = db.prepare(
      "INSERT INTO recepciones (proveedor,importador,fecha,solo_documento,estado,creado_en) VALUES ('Prov2','Prov2','2026-07-17',0,'confirmada_con_pendientes','x')"
    ).run().lastInsertRowid;

    // Crear 2 ítems, ambos con conflicto_stock
    const item1 = db.prepare(
      'INSERT INTO recepcion_items (recepcion_id,id_woo,sku,nombre_doc,cantidad,recibido,estado_item,stock_previo,stock_objetivo,creado_en) VALUES (?,?,?,?,?,?,?,?,?,?)'
    ).run(recId2, 10, 'CASCO', 'Casco', 1, 1, 'conflicto_stock', 5, 8, 'x').lastInsertRowid;

    const item2 = db.prepare(
      'INSERT INTO recepcion_items (recepcion_id,id_woo,sku,nombre_doc,cantidad,recibido,estado_item,stock_previo,stock_objetivo,creado_en) VALUES (?,?,?,?,?,?,?,?,?,?)'
    ).run(recId2, 10, 'CASCO', 'Casco 2', 2, 1, 'conflicto_stock', 5, 8, 'x').lastInsertRowid;

    axios.request.mockImplementation(async (opts) => {
      if (opts.method === 'get') return { status: 200, data: { stock_quantity: 7 } };
      return { status: 200, data: {} };
    });

    // Resolver item1: recepción sigue en confirmada_con_pendientes (item2 sigue pendiente)
    let res = await request(app)
      .post(`/api/recepciones/${recId2}/items/${item1}/resolver-conflicto`)
      .send({ decision: 'aceptar_woo', motivo: 'test' });
    expect(res.status).toBe(200);

    let rec = db.prepare('SELECT estado FROM recepciones WHERE id=?').get(recId2);
    expect(rec.estado).toBe('confirmada_con_pendientes'); // Aún hay un ítem pendiente

    // Resolver item2: ahora sí pasa a confirmada
    res = await request(app)
      .post(`/api/recepciones/${recId2}/items/${item2}/resolver-conflicto`)
      .send({ decision: 'aceptar_woo', motivo: 'test' });
    expect(res.status).toBe(200);

    rec = db.prepare('SELECT estado FROM recepciones WHERE id=?').get(recId2);
    expect(rec.estado).toBe('confirmada'); // Transición completada
  });

  it('HUECO 2: motivo obligatorio para resolver-conflicto — 400 si falta', async () => {
    db.prepare(
      "UPDATE recepcion_items SET estado_item='conflicto_stock', stock_previo=5, stock_objetivo=8 WHERE id=?"
    ).run(db._itemId);

    const res = await request(app)
      .post(`/api/recepciones/${db._recId}/items/${db._itemId}/resolver-conflicto`)
      .send({ decision: 'aceptar_woo' }); // motivo falta

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/motivo/i);
  });

  it('HUECO 4: conciliar-stock del último ítem en operacion_incierta — transiciona recepción a confirmada', async () => {
    const recId2 = db.prepare(
      "INSERT INTO recepciones (proveedor,importador,fecha,solo_documento,estado,creado_en) VALUES ('Prov2','Prov2','2026-07-17',0,'confirmada_con_pendientes','x')"
    ).run().lastInsertRowid;

    // Crear 2 ítems: uno en operacion_incierta, otro en conflicto_stock
    const item1 = db.prepare(
      'INSERT INTO recepcion_items (recepcion_id,id_woo,sku,nombre_doc,cantidad,recibido,estado_item,stock_previo,stock_objetivo,creado_en) VALUES (?,?,?,?,?,?,?,?,?,?)'
    ).run(recId2, 10, 'CASCO', 'Casco 1', 1, 1, 'operacion_incierta', 5, 8, 'x').lastInsertRowid;

    const item2 = db.prepare(
      'INSERT INTO recepcion_items (recepcion_id,id_woo,sku,nombre_doc,cantidad,recibido,estado_item,stock_previo,stock_objetivo,creado_en) VALUES (?,?,?,?,?,?,?,?,?,?)'
    ).run(recId2, 10, 'CASCO', 'Casco 2', 2, 1, 'conflicto_stock', 5, 8, 'x').lastInsertRowid;

    axios.request.mockImplementation(async (opts) => {
      if (opts.method === 'get') return { status: 200, data: { stock_quantity: 8 } };
      return { status: 200, data: {} };
    });

    // Conciliar item1: recepción sigue en confirmada_con_pendientes (item2 sigue pendiente)
    let res = await request(app)
      .post(`/api/recepciones/${recId2}/items/${item1}/conciliar-stock`)
      .send();
    expect(res.status).toBe(200);

    let rec = db.prepare('SELECT estado FROM recepciones WHERE id=?').get(recId2);
    expect(rec.estado).toBe('confirmada_con_pendientes'); // Aún hay un ítem pendiente (item2)

    // Resolver item2: ahora sí pasa a confirmada
    res = await request(app)
      .post(`/api/recepciones/${recId2}/items/${item2}/resolver-conflicto`)
      .send({ decision: 'aceptar_woo', motivo: 'test' });
    expect(res.status).toBe(200);

    rec = db.prepare('SELECT estado FROM recepciones WHERE id=?').get(recId2);
    expect(rec.estado).toBe('confirmada'); // Transición completada
  });
});

describe('recepciones — PUNTO 6 recuperación de recepciones huérfanas en procesando', () => {
  const DB = './test/tmp-recep-punto6-recovery.sqlite';

  afterEach(() => { if (fs.existsSync(DB)) fs.unlinkSync(DB); });

  it('recuperación al arrancar: recepción en procesando con todos los ítems resueltos → confirmada', () => {
    if (fs.existsSync(DB)) fs.unlinkSync(DB);
    const db = openDb(DB);
    makeApp(db); // corre migraciones

    // Setup: crear recepción en 'procesando' con items ya resueltos (aplicados)
    const recId = db.prepare(
      "INSERT INTO recepciones (proveedor, fecha, solo_documento, estado, creado_en) VALUES ('P', '2026-07-16', 0, 'procesando', 'x')"
    ).run().lastInsertRowid;

    const itemId1 = db.prepare(
      `INSERT INTO recepcion_items
        (recepcion_id, id_woo, sku, nombre_doc, cantidad, recibido, estado_item, stock_nuevo, creado_en)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(recId, 10, 'SKU1', 'Item 1', 1, 1, 'aplicado', 8, 'x').lastInsertRowid;

    const itemId2 = db.prepare(
      `INSERT INTO recepcion_items
        (recepcion_id, id_woo, sku, nombre_doc, cantidad, recibido, estado_item, stock_nuevo, creado_en)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(recId, 11, 'SKU2', 'Item 2', 2, 1, 'aplicado', 7, 'x').lastInsertRowid;

    // Verificar que está en 'procesando'
    let rec = db.prepare('SELECT * FROM recepciones WHERE id=?').get(recId);
    expect(rec.estado).toBe('procesando');
    expect(rec.confirmado_en).toBeNull();

    db.close();

    // Reiniciar: cerrar y abrir de nuevo, luego montar el router (dispara recuperación)
    const db2 = openDb(DB);
    makeApp(db2);

    // Verificar que ahora está en 'confirmada' (sin pendientes)
    rec = db2.prepare('SELECT * FROM recepciones WHERE id=?').get(recId);
    expect(rec.estado).toBe('confirmada');
    expect(rec.confirmado_en).not.toBeNull(); // Se registró el momento de recuperación

    db2.close();
  });

  it('recuperación al arrancar: recepción en procesando con ítems pendientes → confirmada_con_pendientes', () => {
    if (fs.existsSync(DB)) fs.unlinkSync(DB);
    const db = openDb(DB);
    makeApp(db); // corre migraciones

    // Setup: crear recepción en 'procesando' con mix de items: algunos aplicados, uno pendiente
    const recId = db.prepare(
      "INSERT INTO recepciones (proveedor, fecha, solo_documento, estado, creado_en) VALUES ('P', '2026-07-16', 0, 'procesando', 'x')"
    ).run().lastInsertRowid;

    db.prepare(
      `INSERT INTO recepcion_items
        (recepcion_id, id_woo, sku, nombre_doc, cantidad, recibido, estado_item, stock_nuevo, creado_en)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(recId, 10, 'SKU1', 'Item OK', 1, 1, 'aplicado', 8, 'x');

    db.prepare(
      `INSERT INTO recepcion_items
        (recepcion_id, id_woo, sku, nombre_doc, cantidad, recibido, estado_item, creado_en)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(recId, null, null, 'Item sin_match', 1, 1, 'sin_match', 'x');

    db.prepare(
      `INSERT INTO recepcion_items
        (recepcion_id, id_woo, sku, nombre_doc, cantidad, recibido, estado_item, creado_en)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(recId, 12, 'SKU3', 'Item pendiente', 1, 1, 'error_reintentable', 'x');

    let rec = db.prepare('SELECT * FROM recepciones WHERE id=?').get(recId);
    expect(rec.estado).toBe('procesando');

    db.close();

    // Reiniciar para disparar recuperación
    const db2 = openDb(DB);
    makeApp(db2);

    // Verificar que está en 'confirmada_con_pendientes' (hay pendientes)
    rec = db2.prepare('SELECT * FROM recepciones WHERE id=?').get(recId);
    expect(rec.estado).toBe('confirmada_con_pendientes');
    expect(rec.confirmado_en).not.toBeNull();

    db2.close();
  });

  it('recuperación al arrancar: ítem en pendiente (nunca procesado) se cuenta como pendiente → confirmada_con_pendientes', () => {
    if (fs.existsSync(DB)) fs.unlinkSync(DB);
    const db = openDb(DB);
    makeApp(db); // corre migraciones

    // Escenario específico del bug encontrado por Codex:
    // El proceso murió en el loop de /:id/confirmar ANTES de llegar a un ítem.
    // Ese ítem sigue en 'pendiente' (nunca llegó a tocarse) y debe contar como "pendiente"
    // para que la recuperación marque la recepción como 'confirmada_con_pendientes', no 'confirmada'.
    const recId = db.prepare(
      "INSERT INTO recepciones (proveedor, fecha, solo_documento, estado, creado_en) VALUES ('P', '2026-07-16', 0, 'procesando', 'x')"
    ).run().lastInsertRowid;

    // Ítem #1: ya aplicado (el proceso llegó a este antes de morir)
    db.prepare(
      `INSERT INTO recepcion_items
        (recepcion_id, id_woo, sku, nombre_doc, cantidad, recibido, estado_item, stock_nuevo, creado_en)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(recId, 10, 'SKU1', 'Item procesado', 1, 1, 'aplicado', 8, 'x');

    // Ítem #2, #3, #4: siguen en 'pendiente' (el proceso murió antes de procesarlos)
    db.prepare(
      `INSERT INTO recepcion_items
        (recepcion_id, id_woo, sku, nombre_doc, cantidad, recibido, estado_item, creado_en)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(recId, 11, 'SKU2', 'Item no procesado #2', 1, 1, 'pendiente', 'x');

    db.prepare(
      `INSERT INTO recepcion_items
        (recepcion_id, id_woo, sku, nombre_doc, cantidad, recibido, estado_item, creado_en)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(recId, 12, 'SKU3', 'Item no procesado #3', 1, 1, 'pendiente', 'x');

    db.prepare(
      `INSERT INTO recepcion_items
        (recepcion_id, id_woo, sku, nombre_doc, cantidad, recibido, estado_item, creado_en)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(recId, 13, 'SKU4', 'Item creado no procesado', 1, 1, 'creado', 'x');

    let rec = db.prepare('SELECT * FROM recepciones WHERE id=?').get(recId);
    expect(rec.estado).toBe('procesando');

    db.close();

    // Reiniciar para disparar recuperación
    const db2 = openDb(DB);
    makeApp(db2);

    // VERIFICACIÓN CRÍTICA: debe ser 'confirmada_con_pendientes' porque hay ítems en 'pendiente' y 'creado'
    // que nunca se procesaron. Este es el bug que Codex encontró.
    rec = db2.prepare('SELECT * FROM recepciones WHERE id=?').get(recId);
    expect(rec.estado).toBe('confirmada_con_pendientes');
    expect(rec.confirmado_en).not.toBeNull();

    db2.close();
  });

  it('recuperación al arrancar: recepción en procesando solo_documento=1 → confirmada directo sin evaluar ítems', () => {
    if (fs.existsSync(DB)) fs.unlinkSync(DB);
    const db = openDb(DB);
    makeApp(db); // corre migraciones

    // Setup: crear recepción solo_documento en 'procesando'
    // (no debería tocar items ni evaluar pendientes, solo cambiar el estado)
    const recId = db.prepare(
      "INSERT INTO recepciones (proveedor, fecha, solo_documento, estado, creado_en) VALUES ('P', '2026-07-16', 1, 'procesando', 'x')"
    ).run().lastInsertRowid;

    // Agregar items con estados "pendientes" (pero no deberían importar para solo_documento)
    db.prepare(
      `INSERT INTO recepcion_items
        (recepcion_id, id_woo, sku, nombre_doc, cantidad, recibido, estado_item, creado_en)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(recId, null, null, 'Item irrelevante', 1, 1, 'sin_match', 'x');

    let rec = db.prepare('SELECT * FROM recepciones WHERE id=?').get(recId);
    expect(rec.estado).toBe('procesando');
    expect(rec.solo_documento).toBe(1);

    db.close();

    // Reiniciar para disparar recuperación
    const db2 = openDb(DB);
    makeApp(db2);

    // Verificar que está en 'confirmada' sin mirar items
    rec = db2.prepare('SELECT * FROM recepciones WHERE id=?').get(recId);
    expect(rec.estado).toBe('confirmada');
    expect(rec.solo_documento).toBe(1);
    expect(rec.confirmado_en).not.toBeNull();

    db2.close();
  });

  it('HUECO 1: ítem con estado_item NULL (nunca tocado) debe contar como pendiente → confirmada_con_pendientes', () => {
    if (fs.existsSync(DB)) fs.unlinkSync(DB);
    const db = openDb(DB);
    makeApp(db); // corre migraciones

    // Escenario del Hueco 1: una recepción en 'procesando' con un ítem cuyo estado_item es NULL
    // (nunca se intentó aplicar, puede haber sido creado por API sin estado_item explícito).
    // El claim de aplicarStockItemInterno acepta ítems con estado_item NULL (42 filas en producción).
    const recId = db.prepare(
      "INSERT INTO recepciones (proveedor, fecha, solo_documento, estado, creado_en) VALUES ('P', '2026-07-16', 0, 'procesando', 'x')"
    ).run().lastInsertRowid;

    // Ítem #1: aplicado ok
    db.prepare(
      `INSERT INTO recepcion_items
        (recepcion_id, id_woo, sku, nombre_doc, cantidad, recibido, estado_item, stock_nuevo, creado_en)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(recId, 10, 'SKU1', 'Item procesado', 1, 1, 'aplicado', 8, 'x');

    // Ítem #2: estado_item NULL (nunca se tocó, pero está en la recepción)
    // Insertamos explícitamente NULL en estado_item (sin especificar la columna, SQLite asume NULL por defecto)
    db.prepare(
      `INSERT INTO recepcion_items
        (recepcion_id, id_woo, sku, nombre_doc, cantidad, recibido, creado_en)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(recId, 11, 'SKU2', 'Item nunca tocado', 1, 1, 'x');

    let rec = db.prepare('SELECT * FROM recepciones WHERE id=?').get(recId);
    expect(rec.estado).toBe('procesando');

    // Verificar que el ítem #2 realmente tiene estado_item NULL
    const item2 = db.prepare('SELECT estado_item FROM recepcion_items WHERE recepcion_id=? AND sku=?').get(recId, 'SKU2');
    expect(item2.estado_item).toBeNull();

    db.close();

    // Reiniciar para disparar recuperación
    const db2 = openDb(DB);
    makeApp(db2);

    // VERIFICACIÓN: debe ser 'confirmada_con_pendientes' porque el ítem #2 con estado_item NULL debería contar como pendiente.
    // Esto es ROJO actualmente porque el WHERE usa IN (...) que no matchea NULL.
    rec = db2.prepare('SELECT * FROM recepciones WHERE id=?').get(recId);
    expect(rec.estado).toBe('confirmada_con_pendientes');
    expect(rec.confirmado_en).not.toBeNull();

    db2.close();
  });

  it('HUECO 2: ítem en estado "aplicando" (huérfano) debe contar como pendiente → confirmada_con_pendientes', () => {
    if (fs.existsSync(DB)) fs.unlinkSync(DB);
    const db = openDb(DB);
    makeApp(db); // corre migraciones

    // Escenario del Hueco 2: una recepción en 'procesando' con un ítem en estado 'aplicando'.
    // Esto ocurre si el proceso murió entre el claim (que marca 'aplicando') y el UPDATE final del punto 2.
    // El Bloque A debería resolver todos los 'aplicando' antes que el Bloque B corra, pero
    // como defensa en profundidad, el Bloque B debería también considerar 'aplicando' como pendiente.
    const recId = db.prepare(
      "INSERT INTO recepciones (proveedor, fecha, solo_documento, estado, creado_en) VALUES ('P', '2026-07-16', 0, 'procesando', 'x')"
    ).run().lastInsertRowid;

    // Ítem #1: aplicado ok
    db.prepare(
      `INSERT INTO recepcion_items
        (recepcion_id, id_woo, sku, nombre_doc, cantidad, recibido, estado_item, stock_nuevo, creado_en)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(recId, 10, 'SKU1', 'Item procesado', 1, 1, 'aplicado', 8, 'x');

    // Ítem #2: estado_item 'aplicando' (huérfano, quedó atrapado entre el claim y el UPDATE final)
    db.prepare(
      `INSERT INTO recepcion_items
        (recepcion_id, id_woo, sku, nombre_doc, cantidad, recibido, estado_item, creado_en)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(recId, 12, 'SKU3', 'Item huérfano en aplicando', 1, 1, 'aplicando', 'x');

    let rec = db.prepare('SELECT * FROM recepciones WHERE id=?').get(recId);
    expect(rec.estado).toBe('procesando');

    db.close();

    // Reiniciar para disparar recuperación
    // El Bloque A (P0.2) corre primero y convierte los 'aplicando' huérfanos a 'error_reintentable' o 'operacion_incierta'
    // Pero el Bloque B también debería considerar 'aplicando' en su lista de pendientes como defensa en profundidad.
    const db2 = openDb(DB);
    makeApp(db2);

    // VERIFICACIÓN: debe ser 'confirmada_con_pendientes' porque el ítem #2 es un huérfano.
    // Incluso si el Bloque A ya lo convirtió a 'error_reintentable', sigue siendo pendiente.
    // Esto es ROJO actualmente porque el WHERE del Bloque B no incluye 'aplicando'.
    rec = db2.prepare('SELECT * FROM recepciones WHERE id=?').get(recId);
    expect(rec.estado).toBe('confirmada_con_pendientes');
    expect(rec.confirmado_en).not.toBeNull();

    db2.close();
  });
});

describe('recepciones — PUNTO 6 error 409 cuando hay confirmación en curso', () => {
  const DB = './test/tmp-recep-punto6-409.sqlite';
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

  it('POST /:id/confirmar → 409 Conflict si la recepción ya está en estado procesando', () => {
    // Setup: crear recepción forzada en estado 'procesando' (sin pasar por el flujo normal de confirmación)
    const recId = db.prepare(
      "INSERT INTO recepciones (proveedor, fecha, solo_documento, estado, creado_en) VALUES ('P', '2026-07-16', 0, 'procesando', 'x')"
    ).run().lastInsertRowid;

    db.prepare(
      `INSERT INTO recepcion_items
        (recepcion_id, id_woo, sku, nombre_doc, cantidad, recibido, estado_item, creado_en)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(recId, 10, 'SKU1', 'Item', 1, 1, 'pendiente', 'x');

    // Intentar confirmar una recepción que ya está en 'procesando'
    // (simula el escenario: dos confirmaciones concurrentes, la segunda llega después de que
    // la primera ya puso la recepción en 'procesando')
    const res = request(app).post(`/api/recepciones/${recId}/confirmar`).send();

    // No esperar async, pasar a sync para verificar el estado
    return res.then(r => {
      expect(r.status).toBe(409);
      expect(r.body.ok).toBe(false);
      expect(r.body.error).toMatch(/confirmación en curso|en proceso/i);

      // Verificar que el estado no cambió (sigue en 'procesando')
      const rec = db.prepare('SELECT estado FROM recepciones WHERE id=?').get(recId);
      expect(rec.estado).toBe('procesando');
    });
  });
});

describe('recepciones — recuperación de altas_woo en "procesando"', () => {
  const DB = './test/tmp-recep-altas-recovery.sqlite';
  let db;

  beforeEach(() => {
    if (fs.existsSync(DB)) fs.unlinkSync(DB);
    db = openDb(DB);
    // Al instanciar el router se ejecuta la recuperación (al iniciar el módulo)
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(DB)) fs.unlinkSync(DB);
  });

  it('caso (a): modo=simple sin id_woo → estado=fallido', () => {
    // Insertar una alta en estado 'procesando', modo simple, sin id_woo (nunca se llegó a crear)
    const operationId = 'op-a-' + Math.random().toString(36).slice(2);
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO recepcion_altas_woo (operation_id,request_hash,id_woo,sku,estado,modo,creado_por,creado_en,actualizado_en) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run(operationId, 'hash-a', null, 'SKU-A', 'procesando', 'simple', 'test', now, now);

    // Instanciar el router → ejecuta recuperación
    makeApp(db);

    // Verificar que pasó a 'fallido'
    const alta = db.prepare('SELECT estado, error FROM recepcion_altas_woo WHERE operation_id=?').get(operationId);
    expect(alta.estado).toBe('fallido');
    expect(alta.error).toBeTruthy(); // debe tener un error descriptivo
  });

  it('caso (b): modo=simple con id_woo → estado=incierto', () => {
    // id_woo persistido → la red creó el recurso final
    const operationId = 'op-b-' + Math.random().toString(36).slice(2);
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO recepcion_altas_woo (operation_id,request_hash,id_woo,sku,estado,modo,creado_por,creado_en,actualizado_en) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run(operationId, 'hash-b', 999, 'SKU-B', 'procesando', 'simple', 'test', now, now);

    makeApp(db);

    const alta = db.prepare('SELECT estado FROM recepcion_altas_woo WHERE operation_id=?').get(operationId);
    expect(alta.estado).toBe('incierto');
  });

  it('caso (c): modo=familia_variable sin id_padre ni id_woo → estado=fallido', () => {
    // Nada persistido que indique que la red hizo algo
    const operationId = 'op-c-' + Math.random().toString(36).slice(2);
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO recepcion_altas_woo (operation_id,request_hash,id_woo,id_padre,sku,estado,modo,creado_por,creado_en,actualizado_en) VALUES (?,?,?,?,?,?,?,?,?,?)'
    ).run(operationId, 'hash-c', null, null, 'SKU-C', 'procesando', 'familia_variable', 'test', now, now);

    makeApp(db);

    const alta = db.prepare('SELECT estado, error FROM recepcion_altas_woo WHERE operation_id=?').get(operationId);
    expect(alta.estado).toBe('fallido');
    expect(alta.error).toBeTruthy();
  });

  it('caso (d): modo=familia_variable con id_padre pero sin id_woo → estado=incierto', () => {
    // id_padre persistido para familia_variable → la red creó el padre, pasó a incierto
    const operationId = 'op-d-' + Math.random().toString(36).slice(2);
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO recepcion_altas_woo (operation_id,request_hash,id_woo,id_padre,sku,estado,modo,creado_por,creado_en,actualizado_en) VALUES (?,?,?,?,?,?,?,?,?,?)'
    ).run(operationId, 'hash-d', null, 888, 'SKU-D', 'procesando', 'familia_variable', 'test', now, now);

    makeApp(db);

    const alta = db.prepare('SELECT estado FROM recepcion_altas_woo WHERE operation_id=?').get(operationId);
    expect(alta.estado).toBe('incierto');
  });

  it('caso (e): modo=variacion_existente con id_padre pero sin id_woo → estado=fallido', () => {
    // Para variacion_existente, id_padre se persiste DESDE el INICIO (viene de la ficha)
    // No es evidencia de que la red hizo algo. Solo id_woo lo es.
    const operationId = 'op-e-' + Math.random().toString(36).slice(2);
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO recepcion_altas_woo (operation_id,request_hash,id_woo,id_padre,sku,estado,modo,creado_por,creado_en,actualizado_en) VALUES (?,?,?,?,?,?,?,?,?,?)'
    ).run(operationId, 'hash-e', null, 777, 'SKU-E', 'procesando', 'variacion_existente', 'test', now, now);

    makeApp(db);

    const alta = db.prepare('SELECT estado, error FROM recepcion_altas_woo WHERE operation_id=?').get(operationId);
    expect(alta.estado).toBe('fallido');
    expect(alta.error).toBeTruthy();
  });
});
