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
import { createHash } from 'node:crypto';
import { openDb as openDbOriginal } from '../db/index.js';
import { syncMlToWc, syncOrdenMlPuntual, syncWcToMl, procesarReintentos, limpiarVariacionesMuertas } from '../routes/sync.js';

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
let currentTestId = 'setup';
const TEST_DB_PATHS = new Set();
beforeEach((ctx) => { currentTestId = ctx.task.id; });
function openTestDb() {
  const hash = createHash('sha256').update(currentTestId).digest('hex').slice(0, 16);
  const ruta = `${TEST_DB}.${process.pid}.${hash}.sqlite`;
  TEST_DB_PATHS.add(ruta);
  return openDb(ruta);
}
function openDb(ruta) { return ruta === TEST_DB ? openTestDb() : openDbOriginal(ruta); }

const CFG = {
  ml: { clientId: 'cid', clientSecret: 'cs', userId: '99999' },
  woo: { url: 'https://fusionbikes.com.ar', ck: 'ck_x', cs: 'cs_x' },
};

function seedMatcher(db) {
  const now = new Date().toISOString();
  db.prepare(
    'INSERT OR IGNORE INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en) VALUES (?, ?, ?, ?, ?)'
  ).run('MLA100|', 'BIKE-001', 'Bicicleta Simple', 'confirmar', now);
  db.prepare('UPDATE sku_matcher_decisiones SET sku = ?, wc_nombre = ?, accion = ?, actualizado_en = ? WHERE clave = ?')
    .run('BIKE-001', 'Bicicleta Simple', 'confirmar', now, 'MLA100|');
  db.prepare(
    'INSERT OR IGNORE INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en) VALUES (?, ?, ?, ?, ?)'
  ).run('MLA200|987', 'CASCO-L', 'Casco L', 'asignar', now);
  db.prepare('UPDATE sku_matcher_decisiones SET sku = ?, wc_nombre = ?, accion = ?, actualizado_en = ? WHERE clave = ?')
    .run('CASCO-L', 'Casco L', 'asignar', now, 'MLA200|987');
}

// Por default, regularPrice = precio (sin oferta: LISTA y vigente coinciden), salvo que un
// test pase explícitamente otro valor (u null) para simular oferta o catálogo sin refrescar.
function seedCatalogo(db, { precio = 300, regularPrice } = {}) {
  const now = new Date().toISOString();
  const rp = regularPrice !== undefined ? regularPrice : precio;
  db.prepare(
    'INSERT OR IGNORE INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, precio, regular_price, actualizado_en) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(100, 'Bicicleta Simple', 'BIKE-001', 'simple', null, 5, precio, rp, now);
  db.prepare('UPDATE catalogo_cache SET nombre = ?, sku = ?, tipo = ?, id_padre = ?, stock = ?, precio = ?, regular_price = ?, actualizado_en = ? WHERE id_woo = ?')
    .run('Bicicleta Simple', 'BIKE-001', 'simple', null, 5, precio, rp, now, 100);
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

  it('happy path: orden pagada → crea pedido en WC con el precio de CONTADO del catálogo propio (no el de ML) y marca procesada', async () => {
    seedCatalogo(db, { precio: 300 }); // BIKE-001 → id_woo 100, precio de LISTA 300 → contado 200
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

    // El precio de línea es el de CONTADO del catálogo propio (200 = 2/3 de 300 de lista),
    // no el unit_price de ML (150) ni el catálogo Woo devuelto por el mock (999.99).
    const orderCall = wooFetch.mock.calls.find(c => c[1] === '/orders' && c[2] === 'post');
    expect(orderCall).toBeTruthy();
    expect(orderCall[3].line_items).toEqual([
      { quantity: 2, subtotal: '400.00', total: '400.00', product_id: 100 },
    ]);
    // El unit_price de ML queda como dato informativo en meta_data, nunca como precio de línea.
    expect(orderCall[3].meta_data.find(m => m.key === '_ml_precio_pagado_total').value).toBe('300.00');

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

  // Bug 1 (regla vigente desde 2026-08-03): el pedido WC debe grabar el precio de CONTADO
  // del catálogo propio, ignorando tanto el unit_price de ML como el catálogo Woo devuelto
  // por wooFetch en otras rutas (mock genérico) — la única fuente válida es catalogo_cache.
  it('bug1: usa precioContado(catalogo_cache.precio), ignora el unit_price de ML', async () => {
    seedCatalogo(db, { precio: 3352500 }); // precio de lista propio → contado 2235000
    const orden = {
      id: '2000017564338280',
      date_created: new Date().toISOString(),
      order_items: [{ item: { id: 'MLA100', variation_id: '' }, quantity: 1, unit_price: 2660000 }],
    };
    mlFetch.mockResolvedValue({ status: 200, data: { results: [orden] } });
    wooFetch.mockImplementation(async (cfg, path, method = 'get') => {
      if (path === '/orders' && method === 'post') return { data: { id: 66275 } };
      return { data: { price: '999999999' } }; // otra ruta de Woo — no debe usarse tampoco
    });

    const p = syncMlToWc(db, CFG);
    await vi.runAllTimersAsync();
    await p;

    const orderCall = wooFetch.mock.calls.find(c => c[1] === '/orders' && c[2] === 'post');
    expect(orderCall[3].line_items).toEqual([
      { quantity: 1, subtotal: '2235000.00', total: '2235000.00', product_id: 100 },
    ]);
  });

  // Bug 1, fail-open (decisión explícita del usuario 2026-08-03): si el SKU no tiene precio
  // en catalogo_cache, la venta NO se pierde — la línea se crea igual sin subtotal/total
  // (Woo aplica el precio que tenga registrado) y queda un aviso en el log.
  it('SKU sin precio en catalogo_cache → línea sin subtotal/total, pedido se crea igual, log de aviso', async () => {
    seedCatalogo(db, { precio: null });
    const orden = {
      id: 'ORD-NOPRICE',
      date_created: new Date().toISOString(),
      order_items: [{ item: { id: 'MLA100', variation_id: '' }, quantity: 1, unit_price: 999 }],
    };
    mlFetch.mockResolvedValue({ status: 200, data: { results: [orden] } });
    wooFetch.mockImplementation(async (cfg, path, method = 'get') => {
      if (path === '/orders' && method === 'post') return { data: { id: 5002 } };
      return { data: {} };
    });

    const p = syncMlToWc(db, CFG);
    await vi.runAllTimersAsync();
    await p;

    const log = db.prepare("SELECT * FROM sync_log WHERE estado = 'error' AND sku = 'BIKE-001'").get();
    expect(log).toBeTruthy();
    expect(log.error).toMatch(/sin precio de LISTA en catalogo_cache/);

    // La venta SÍ se crea: línea con product_id/quantity, sin subtotal/total, y NUNCA con
    // el unit_price de ML como precio.
    const orderCall = wooFetch.mock.calls.find(c => c[1] === '/orders' && c[2] === 'post');
    expect(orderCall).toBeTruthy();
    expect(orderCall[3].line_items).toEqual([{ quantity: 1, product_id: 100 }]);

    // algunSinMapeo NO debe marcarse por esto — la línea sí se creó.
    const proc = db.prepare('SELECT * FROM ordenes_ml_procesadas WHERE order_id = ?').get('ORD-NOPRICE');
    expect(proc.estado).toBe('ok');
  });

  // Hallazgo del revisor (2026-08-03): catalogo_cache.precio es el VIGENTE, que si el
  // producto está en oferta ya es el sale_price. El contado tiene que calcularse siempre
  // sobre regular_price (LISTA), no sobre precio, o el descuento de contado se "acumularía"
  // con el de la oferta.
  it('producto en oferta: usa precioContado(regular_price), no precioContado(precio de oferta)', async () => {
    // Lista $1.000.000, en oferta a $800.000 → contado correcto sobre LISTA: 666666.67 (no 533333.33)
    seedCatalogo(db, { precio: 800000, regularPrice: 1000000 });
    const orden = {
      id: 'ORD-OFERTA',
      date_created: new Date().toISOString(),
      order_items: [{ item: { id: 'MLA100', variation_id: '' }, quantity: 1, unit_price: 750000 }],
    };
    mlFetch.mockResolvedValue({ status: 200, data: { results: [orden] } });
    wooFetch.mockImplementation(async (cfg, path, method = 'get') => {
      if (path === '/orders' && method === 'post') return { data: { id: 5010 } };
      return { data: {} };
    });

    const p = syncMlToWc(db, CFG);
    await vi.runAllTimersAsync();
    await p;

    const orderCall = wooFetch.mock.calls.find(c => c[1] === '/orders' && c[2] === 'post');
    expect(orderCall[3].line_items).toEqual([
      { quantity: 1, subtotal: '666666.67', total: '666666.67', product_id: 100 },
    ]);
  });

  // 2da pasada del revisor (2026-08-03): el fallback `regular_price ?? precio` violaba en
  // silencio la regla "el contado se calcula sobre LISTA, nunca sobre el vigente" durante
  // toda la ventana de transición (catálogo sin refrescar todavía, o producto en oferta sin
  // regular_price cargado). Se sacó: sin regular_price, la línea cae en el MISMO fail-open
  // que "sin precio en catalogo_cache" — nunca aplica el descuento de contado sobre el
  // precio vigente, aunque este último exista y sea distinto de null.
  it('regular_price NULL (catálogo sin refrescar, o sin precio de lista cargado) → fail-open sin subtotal/total, NUNCA cae a `precio`', async () => {
    // precio (vigente) sí tiene un valor — si hubiera fallback, la línea saldría con
    // contado sobre 300 (200.00). Con el fix, debe salir SIN subtotal/total.
    seedCatalogo(db, { precio: 300, regularPrice: null });
    const orden = {
      id: 'ORD-SIN-REFRESH',
      date_created: new Date().toISOString(),
      order_items: [{ item: { id: 'MLA100', variation_id: '' }, quantity: 1, unit_price: 100 }],
    };
    mlFetch.mockResolvedValue({ status: 200, data: { results: [orden] } });
    wooFetch.mockImplementation(async (cfg, path, method = 'get') => {
      if (path === '/orders' && method === 'post') return { data: { id: 5011 } };
      return { data: {} };
    });

    const p = syncMlToWc(db, CFG);
    await vi.runAllTimersAsync();
    await p;

    const orderCall = wooFetch.mock.calls.find(c => c[1] === '/orders' && c[2] === 'post');
    expect(orderCall[3].line_items).toEqual([{ quantity: 1, product_id: 100 }]);

    const log = db.prepare("SELECT * FROM sync_log WHERE estado = 'error' AND sku = 'BIKE-001'").get();
    expect(log).toBeTruthy();
    expect(log.error).toMatch(/sin precio de LISTA en catalogo_cache/);
    expect(log.error).toMatch(/no se refrescó/);

    // La venta se crea igual, no se pierde (algunSinMapeo no se marca por esto).
    const proc = db.prepare('SELECT * FROM ordenes_ml_procesadas WHERE order_id = ?').get('ORD-SIN-REFRESH');
    expect(proc.estado).toBe('ok');
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

  // ── Anti-sobreventa: el SKU que trae la venta de ML (2026-08-15) ─────────────────
  // Sobreventa real: se vendió un "Casco Crazy Safety Azul" que no existe en el catálogo web.
  // La publicación tenía cargado FB-7245 —el SKU de OTRO casco, un "Rembrandt Tigre Blanco"
  // con stock 2— puesto a mano en ML, por fuera de la herramienta. Hasta acá el sync ignoraba
  // el seller_sku que la venta trae: marcaba sin_mapeo, no creaba el pedido en WC y el stock
  // nunca se descontaba. Medido sobre 60 días: 83 ventas sin mapear, 54 con SKU válido.
  it('venta sin vínculo propio pero con seller_sku válido → usa ese SKU y crea el pedido', async () => {
    db.prepare("INSERT INTO catalogo_cache (id_woo, id_padre, sku, tipo, nombre, stock, precio, regular_price, actualizado_en) VALUES (5001, NULL, 'FB-5001', 'simple', 'Cubierta Maxxis Ardent 29', 4, 90000, 90000, ?)").run(new Date().toISOString());
    const orden = {
      id: 'ORD-FALLBACK',
      date_created: new Date().toISOString(),
      order_items: [{
        item: { id: 'MLA5001', variation_id: '', title: 'Cubierta Maxxis Ardent 29 Mtb', seller_sku: 'FB-5001' },
        quantity: 1,
      }],
    };
    mlFetch.mockResolvedValue({ status: 200, data: { results: [orden] } });
    wooFetch.mockResolvedValue({ status: 201, data: { id: 9001, number: '9001' } });

    const p = syncMlToWc(db, CFG);
    await vi.runAllTimersAsync();
    await p;

    const proc = db.prepare('SELECT * FROM ordenes_ml_procesadas WHERE order_id = ?').get('ORD-FALLBACK');
    expect(proc.estado).toBe('ok');
    const post = wooFetch.mock.calls.find((c) => c[1] === '/orders' && c[2] === 'post');
    expect(post).toBeTruthy();
    expect(post[3].line_items[0].product_id).toBe(5001);
  });

  // La guarda que faltaba: sin ella, el fallback de arriba habría descontado el Rembrandt en
  // vez de avisar — cambiando una sobreventa por un descuento del producto equivocado, que es
  // peor porque no se nota. Umbral medido (0.57): el caso real da 0.537 y el vínculo correcto
  // más flojo de las 54 ventas da 0.602.
  it('seller_sku que apunta a otro producto → NO descuenta, avisa y deja la orden parcial', async () => {
    db.prepare("INSERT INTO catalogo_cache (id_woo, id_padre, sku, nombre, stock, precio, regular_price, actualizado_en) VALUES (7245, 1732, 'FB-7245', 'Casco Rembrandt Para Niños — Tigre Blanco', 2, 134846, 134846, ?)").run(new Date().toISOString());
    const orden = {
      id: 'ORD-INCOHERENTE',
      date_created: new Date().toISOString(),
      order_items: [{
        item: { id: 'MLA1685632164', variation_id: '', title: 'Casco Crazy Safety Azul Niños Bicicleta Skate Rollers Con Luz 49-55cm', seller_sku: 'FB-7245' },
        quantity: 1,
      }],
    };
    mlFetch.mockResolvedValue({ status: 200, data: { results: [orden] } });

    const p = syncMlToWc(db, CFG);
    await vi.runAllTimersAsync();
    await p;

    const proc = db.prepare('SELECT * FROM ordenes_ml_procesadas WHERE order_id = ?').get('ORD-INCOHERENTE');
    expect(proc.estado).toBe('parcial');
    const log = db.prepare("SELECT * FROM sync_log WHERE estado = 'sku_incoherente'").get();
    expect(log).toBeTruthy();
    expect(log.sku).toBe('FB-7245');
    // Lo que de verdad importa: no se creó pedido, así que no se descontó el producto equivocado.
    expect(wooFetch.mock.calls.find((c) => c[1] === '/orders' && c[2] === 'post')).toBeFalsy();
  });

  // CONTRASTE: sin este test, el de arriba pasaría igual si la guarda frenara TODO.
  it('la guarda no frena un vínculo correcto con redacción distinta', async () => {
    db.prepare("INSERT INTO catalogo_cache (id_woo, id_padre, sku, tipo, nombre, stock, precio, regular_price, actualizado_en) VALUES (43427, NULL, 'FB-43427', 'simple', 'Soporte Para Gps Frontal Delantero Igpsport M80', 8, 30000, 30000, ?)").run(new Date().toISOString());
    const orden = {
      id: 'ORD-REDACCION',
      date_created: new Date().toISOString(),
      order_items: [{
        item: { id: 'MLA43427', variation_id: '', title: 'Soporte Ciclocomputador Igpsport M80 Negro', seller_sku: 'FB-43427' },
        quantity: 1,
      }],
    };
    mlFetch.mockResolvedValue({ status: 200, data: { results: [orden] } });
    wooFetch.mockResolvedValue({ status: 201, data: { id: 9002, number: '9002' } });

    const p = syncMlToWc(db, CFG);
    await vi.runAllTimersAsync();
    await p;

    expect(db.prepare('SELECT * FROM ordenes_ml_procesadas WHERE order_id = ?').get('ORD-REDACCION').estado).toBe('ok');
  });

  // El vínculo propio (revisado por una persona) NO pasa por la guarda de coherencia: si
  // alguien decidió a mano que esa publicación es ese producto, se respeta.
  it('vínculo propio manda aunque el título no se parezca', async () => {
    db.prepare("INSERT INTO catalogo_cache (id_woo, id_padre, sku, tipo, nombre, stock, precio, regular_price, actualizado_en) VALUES (6001, NULL, 'FB-6001', 'simple', 'Producto Con Nombre Totalmente Distinto', 3, 50000, 50000, ?)").run(new Date().toISOString());
    db.prepare("INSERT INTO sku_matcher_decisiones (clave, sku, accion, actualizado_en) VALUES ('MLA6001|', 'FB-6001', 'confirmar', ?)").run(new Date().toISOString());
    const orden = {
      id: 'ORD-VINCULO-PROPIO',
      date_created: new Date().toISOString(),
      order_items: [{
        item: { id: 'MLA6001', variation_id: '', title: 'Xyz Abc Qwerty Zzz', seller_sku: '' },
        quantity: 1,
      }],
    };
    mlFetch.mockResolvedValue({ status: 200, data: { results: [orden] } });
    wooFetch.mockResolvedValue({ status: 201, data: { id: 9003, number: '9003' } });

    const p = syncMlToWc(db, CFG);
    await vi.runAllTimersAsync();
    await p;

    expect(db.prepare('SELECT * FROM ordenes_ml_procesadas WHERE order_id = ?').get('ORD-VINCULO-PROPIO').estado).toBe('ok');
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

// ─── Datos de envío/destinatario y meta informativa en el pedido WC ────────────
describe('syncMlToWc — envío/destinatario (fail-open) y meta informativa de la venta ML', () => {
  let db;

  beforeEach(() => {
    db = openDb(TEST_DB);
    seedMatcher(db);
    seedCatalogo(db, { precio: 300 }); // contado 200
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  function ordenConEnvio(id, shippingId) {
    return {
      id,
      date_created: '2026-08-01T12:00:00.000Z',
      buyer: { nickname: 'comprador123' },
      shipping: shippingId != null ? { id: shippingId } : undefined,
      order_items: [{
        item: { id: 'MLA100', variation_id: '' }, quantity: 1, unit_price: 250, sale_fee: 20,
      }],
    };
  }

  it('orden con shipping.id → consulta GET /shipments/{id} y vuelca destinatario+dirección+método de envío en el mismo POST', async () => {
    const orden = ordenConEnvio('ORD-SHIP-OK', 555);
    mlFetch.mockImplementation(async (d, cfg, method, path) => {
      if (path.startsWith('/orders/search')) return { status: 200, data: { results: [orden] } };
      if (path === '/shipments/555') {
        return {
          status: 200,
          data: {
            logistic_type: 'self_service',
            shipping_option: { name: 'Mercado Envíos Flex' },
            receiver_address: {
              receiver_name: 'Juan Pérez', street_name: 'Av Siempreviva', street_number: '742',
              floor: '3', apartment: 'B', city: { name: 'CABA' }, state: { name: 'Buenos Aires' },
              zip_code: '1000',
            },
          },
        };
      }
      return { status: 200, data: {} };
    });
    wooFetch.mockImplementation(async (cfg, path, method = 'get') => {
      if (path === '/orders' && method === 'post') return { data: { id: 6001 } };
      return { data: {} };
    });

    const p = syncMlToWc(db, CFG);
    await vi.runAllTimersAsync();
    await p;

    const orderCall = wooFetch.mock.calls.find(c => c[1] === '/orders' && c[2] === 'post');
    expect(orderCall).toBeTruthy();
    const body = orderCall[3];

    expect(body.shipping).toEqual({
      first_name: 'Juan',
      last_name: 'Pérez',
      address_1: 'Av Siempreviva 742',
      address_2: 'Piso 3 B',
      city: 'CABA',
      state: 'Buenos Aires',
      postcode: '1000',
      country: 'AR',
    });

    // La facturación replica el destinatario/dirección del envío (routes/sync.js llama a
    // billingWcDesdeOrdenMl(orden, shipping)): protege el cableado, no solo la función pura.
    expect(body.billing).toEqual({
      first_name: 'Juan',
      last_name: 'Pérez',
      address_1: 'Av Siempreviva 742',
      address_2: 'Piso 3 B',
      city: 'CABA',
      state: 'Buenos Aires',
      postcode: '1000',
      country: 'AR',
    });

    // Nº de orden ML, precio pagado y neto (sale_fee) como dato informativo — nunca como precio de línea.
    const meta = Object.fromEntries(body.meta_data.map(m => [m.key, m.value]));
    expect(meta._ml_order_id).toBe('ORD-SHIP-OK');
    expect(meta._ml_precio_pagado_total).toBe('250.00');
    expect(meta._ml_neto_estimado).toBe('230.00'); // 250 - sale_fee 20
    expect(meta._ml_metodo_envio).toBe('self_service');

    // La nota va PRIVADA (POST /orders/{id}/notes con customer_note:false), NO en el
    // customer_note del pedido (eso lo vería el cliente en la web/mails).
    expect(body.customer_note).toBeUndefined();
    const notaCall = wooFetch.mock.calls.find(c => c[1] === `/orders/6001/notes` && c[2] === 'post');
    expect(notaCall).toBeTruthy();
    expect(notaCall[3].customer_note).toBe(false);
    expect(notaCall[3].note).toContain('ORD-SHIP-OK');
    expect(notaCall[3].note).toContain('comprador123');
    expect(notaCall[3].note).toContain('https://www.mercadolibre.com.ar/ventas/ORD-SHIP-OK/detalle');
    // La fecha va formateada en local (es-AR), no como ISO crudo con milisegundos/Z.
    expect(notaCall[3].note).not.toContain('2026-08-01T12:00:00.000Z');

    // El precio de línea sigue siendo el de contado del catálogo propio, no el de ML.
    expect(body.line_items).toEqual([{ quantity: 1, subtotal: '200.00', total: '200.00', product_id: 100 }]);
  });

  it('la consulta de shipments falla → FAIL-OPEN: el pedido se crea igual, sin datos de envío, reserva no queda retenida ni liberada de más', async () => {
    const orden = ordenConEnvio('ORD-SHIP-FALLA', 999);
    mlFetch.mockImplementation(async (d, cfg, method, path) => {
      if (path.startsWith('/orders/search')) return { status: 200, data: { results: [orden] } };
      if (path === '/shipments/999') throw new Error('ML shipments 500');
      return { status: 200, data: {} };
    });
    wooFetch.mockImplementation(async (cfg, path, method = 'get') => {
      if (path === '/orders' && method === 'post') return { data: { id: 6002 } };
      return { data: {} };
    });

    const p = syncMlToWc(db, CFG);
    await vi.runAllTimersAsync();
    await p;

    // El pedido se crea igual, sin `shipping`
    const orderCall = wooFetch.mock.calls.find(c => c[1] === '/orders' && c[2] === 'post');
    expect(orderCall).toBeTruthy();
    expect(orderCall[3].shipping).toBeUndefined();

    // Sin datos de envío, `billing` cae al comportamiento anterior (nickname + 'MercadoLibre')
    // — este es el caso que protege la decisión fail-open en producción: si el cableado de
    // routes/sync.js dejara de pasar `shipping` a billingWcDesdeOrdenMl, este assert lo detecta.
    expect(orderCall[3].billing).toEqual({ first_name: 'comprador123', last_name: 'MercadoLibre' });

    // Reserva completada normalmente (no queda retenida ni se libera de más)
    const pedido = db.prepare('SELECT * FROM ordenes_ml_wc_pedidos WHERE ml_order_id = ?').get('ORD-SHIP-FALLA');
    expect(pedido.wc_order_id).toBe(6002);
    expect(pedido.retenido_en).toBeNull();

    // Aviso en el log, pero sin marcar la orden como error/parcial por esto
    const log = db.prepare("SELECT * FROM sync_log WHERE clave = 'ORD-SHIP-FALLA' AND estado = 'error'").get();
    expect(log).toBeTruthy();
    expect(log.error).toMatch(/envío ML/);
    const proc = db.prepare('SELECT * FROM ordenes_ml_procesadas WHERE order_id = ?').get('ORD-SHIP-FALLA');
    expect(proc.estado).toBe('ok');
  });

  // mlFetch usa validateStatus:()=>true (nunca lanza por status HTTP) — un 404/500 de ML
  // llega como respuesta normal, no como excepción. Sin el chequeo explícito de status esto
  // pasaría desapercibido: el pedido se crearía sin destinatario y sin ningún aviso en el log.
  it('la consulta de shipments devuelve 404 (sin lanzar, validateStatus:true) → FAIL-OPEN con aviso en el log', async () => {
    const orden = ordenConEnvio('ORD-SHIP-404', 4004);
    mlFetch.mockImplementation(async (d, cfg, method, path) => {
      if (path.startsWith('/orders/search')) return { status: 200, data: { results: [orden] } };
      if (path === '/shipments/4004') return { status: 404, data: { message: 'not_found' } };
      return { status: 200, data: {} };
    });
    wooFetch.mockImplementation(async (cfg, path, method = 'get') => {
      if (path === '/orders' && method === 'post') return { data: { id: 6009 } };
      return { data: {} };
    });

    const p = syncMlToWc(db, CFG);
    await vi.runAllTimersAsync();
    await p;

    const orderCall = wooFetch.mock.calls.find(c => c[1] === '/orders' && c[2] === 'post');
    expect(orderCall).toBeTruthy();
    expect(orderCall[3].shipping).toBeUndefined();

    const log = db.prepare("SELECT * FROM sync_log WHERE clave = 'ORD-SHIP-404' AND estado = 'error'").get();
    expect(log).toBeTruthy();
    expect(log.error).toMatch(/404/);

    const pedido = db.prepare('SELECT * FROM ordenes_ml_wc_pedidos WHERE ml_order_id = ?').get('ORD-SHIP-404');
    expect(pedido.wc_order_id).toBe(6009);
    expect(pedido.retenido_en).toBeNull();
  });

  it('la nota privada del pedido falla al crearla (POST /orders/{id}/notes) → FAIL-OPEN: el pedido queda creado igual, sin reintentar', async () => {
    const orden = ordenConEnvio('ORD-NOTA-FALLA', 5005);
    mlFetch.mockImplementation(async (d, cfg, method, path) => {
      if (path.startsWith('/orders/search')) return { status: 200, data: { results: [orden] } };
      if (path === '/shipments/5005') return { status: 200, data: { receiver_address: { receiver_name: 'Ana Diaz' } } };
      return { status: 200, data: {} };
    });
    wooFetch.mockImplementation(async (cfg, path, method = 'get') => {
      if (path === '/orders' && method === 'post') return { data: { id: 6010 } };
      if (path === '/orders/6010/notes' && method === 'post') throw new Error('WooCommerce API error 500');
      return { data: {} };
    });

    const p = syncMlToWc(db, CFG);
    await vi.runAllTimersAsync();
    await p;

    // El pedido queda creado y sellado como 'ok' — la nota es un dato accesorio posterior.
    const pedido = db.prepare('SELECT * FROM ordenes_ml_wc_pedidos WHERE ml_order_id = ?').get('ORD-NOTA-FALLA');
    expect(pedido.wc_order_id).toBe(6010);
    const proc = db.prepare('SELECT * FROM ordenes_ml_procesadas WHERE order_id = ?').get('ORD-NOTA-FALLA');
    expect(proc.estado).toBe('ok');

    // Un solo POST /orders — no se reintenta la creación por el fallo de la nota.
    const posts = wooFetch.mock.calls.filter(c => c[1] === '/orders' && c[2] === 'post');
    expect(posts).toHaveLength(1);

    const log = db.prepare("SELECT * FROM sync_log WHERE clave = 'ORD-NOTA-FALLA' AND estado = 'error'").get();
    expect(log).toBeTruthy();
    expect(log.error).toMatch(/nota privada/);
  });

  it('unit_price null en algún order_item → se omite _ml_precio_pagado_total (no se inventa un total parcial)', async () => {
    const orden = {
      id: 'ORD-SIN-UNITPRICE',
      date_created: new Date().toISOString(),
      buyer: { nickname: 'compradorY' },
      order_items: [
        { item: { id: 'MLA100', variation_id: '' }, quantity: 1, unit_price: 250 },
        { item: { id: 'MLA100', variation_id: '' }, quantity: 1, unit_price: null },
      ],
    };
    mlFetch.mockResolvedValue({ status: 200, data: { results: [orden] } });
    wooFetch.mockImplementation(async (cfg, path, method = 'get') => {
      if (path === '/orders' && method === 'post') return { data: { id: 6011 } };
      return { data: {} };
    });

    const p = syncMlToWc(db, CFG);
    await vi.runAllTimersAsync();
    await p;

    const orderCall = wooFetch.mock.calls.find(c => c[1] === '/orders' && c[2] === 'post');
    const meta = Object.fromEntries(orderCall[3].meta_data.map(m => [m.key, m.value]));
    expect(meta._ml_precio_pagado_total).toBeUndefined();
    expect(meta._ml_order_id).toBe('ORD-SIN-UNITPRICE');
  });

  // Hallazgo del revisor (2026-08-03): si falta la fecha o el nickname, la nota no debe
  // quedar con paréntesis vacíos ni frases a medias como "Venta MercadoLibre #X () — comprador: .".
  it('orden sin date_created ni nickname → la nota privada omite esas partes, sin paréntesis/frases vacías', async () => {
    const orden = {
      id: 'ORD-SIN-DATOS-NOTA',
      order_items: [{ item: { id: 'MLA100', variation_id: '' }, quantity: 1, unit_price: 100 }],
    };
    mlFetch.mockResolvedValue({ status: 200, data: { results: [orden] } });
    wooFetch.mockImplementation(async (cfg, path, method = 'get') => {
      if (path === '/orders' && method === 'post') return { data: { id: 6015 } };
      return { data: {} };
    });

    const p = syncMlToWc(db, CFG);
    await vi.runAllTimersAsync();
    await p;

    const notaCall = wooFetch.mock.calls.find(c => c[1] === '/orders/6015/notes' && c[2] === 'post');
    expect(notaCall).toBeTruthy();
    const note = notaCall[3].note;
    expect(note).toContain('ORD-SIN-DATOS-NOTA');
    expect(note).toContain('https://www.mercadolibre.com.ar/ventas/ORD-SIN-DATOS-NOTA/detalle');
    expect(note).not.toContain('()');
    expect(note).not.toMatch(/comprador:\s*\./);
  });

  it('orden sin shipping.id → no consulta /shipments, el pedido se crea igual sin datos de envío', async () => {
    const orden = ordenConEnvio('ORD-SIN-SHIP', undefined);
    mlFetch.mockImplementation(async (d, cfg, method, path) => {
      if (path.startsWith('/orders/search')) return { status: 200, data: { results: [orden] } };
      return { status: 200, data: {} };
    });
    wooFetch.mockImplementation(async (cfg, path, method = 'get') => {
      if (path === '/orders' && method === 'post') return { data: { id: 6003 } };
      return { data: {} };
    });

    const p = syncMlToWc(db, CFG);
    await vi.runAllTimersAsync();
    await p;

    expect(mlFetch.mock.calls.some(c => String(c[3]).startsWith('/shipments/'))).toBe(false);
    const orderCall = wooFetch.mock.calls.find(c => c[1] === '/orders' && c[2] === 'post');
    expect(orderCall[3].shipping).toBeUndefined();
  });

  // Hallazgo del revisor (2026-08-03): un receiver_address SIN nombre ni calle no debe volcarse
  // como `shipping` — dejaría al pedido con una dirección "declarada" pero en blanco, en vez
  // de reflejar claramente que el dato no está.
  it('receiver_address sin receiver_name ni street_name → NO manda shipping vacío', async () => {
    const orden = ordenConEnvio('ORD-SHIP-VACIO', 8181);
    mlFetch.mockImplementation(async (d, cfg, method, path) => {
      if (path.startsWith('/orders/search')) return { status: 200, data: { results: [orden] } };
      if (path === '/shipments/8181') {
        return { status: 200, data: { logistic_type: 'self_service', receiver_address: { city: { name: 'CABA' } } } };
      }
      return { status: 200, data: {} };
    });
    wooFetch.mockImplementation(async (cfg, path, method = 'get') => {
      if (path === '/orders' && method === 'post') return { data: { id: 6014 } };
      return { data: {} };
    });

    const p = syncMlToWc(db, CFG);
    await vi.runAllTimersAsync();
    await p;

    const orderCall = wooFetch.mock.calls.find(c => c[1] === '/orders' && c[2] === 'post');
    expect(orderCall[3].shipping).toBeUndefined();
    // El método de envío (dato aparte) sí se informa, aunque no haya dirección.
    const meta = Object.fromEntries(orderCall[3].meta_data.map(m => [m.key, m.value]));
    expect(meta._ml_metodo_envio).toBe('self_service');
  });

  // Hallazgo del tester: receiver_name de una sola palabra (sin espacio) → routes/sync.js
  // parte por el primer espacio y deja last_name = '' (no hay nada después). En `shipping`
  // eso se refleja tal cual (fiel a lo que dijo ML). En `billing`, como shipping.last_name
  // es '' (falsy), billingWcDesdeOrdenMl cae al fallback 'MercadoLibre' para el apellido,
  // aunque sí toma el first_name real del envío — mezcla nombre real + apellido de fallback,
  // nunca deja el apellido vacío en la facturación.
  it('receiver_name de una sola palabra → shipping.last_name vacío, billing usa first_name real + apellido de fallback', async () => {
    const orden = ordenConEnvio('ORD-SHIP-1PALABRA', 7001);
    mlFetch.mockImplementation(async (d, cfg, method, path) => {
      if (path.startsWith('/orders/search')) return { status: 200, data: { results: [orden] } };
      if (path === '/shipments/7001') {
        return {
          status: 200,
          data: {
            receiver_address: {
              receiver_name: 'Madonna', street_name: 'Av Colon', street_number: '100',
              city: { name: 'Cordoba' }, state: { name: 'Cordoba' }, zip_code: '5000',
            },
          },
        };
      }
      return { status: 200, data: {} };
    });
    wooFetch.mockImplementation(async (cfg, path, method = 'get') => {
      if (path === '/orders' && method === 'post') return { data: { id: 6020 } };
      return { data: {} };
    });

    const p = syncMlToWc(db, CFG);
    await vi.runAllTimersAsync();
    await p;

    const orderCall = wooFetch.mock.calls.find(c => c[1] === '/orders' && c[2] === 'post');
    // shipping refleja fielmente lo que dijo ML: nombre completo en first_name, last_name vacío.
    expect(orderCall[3].shipping.first_name).toBe('Madonna');
    expect(orderCall[3].shipping.last_name).toBe('');
    // billing toma el first_name real pero cae al apellido de fallback (nunca vacío).
    expect(orderCall[3].billing.first_name).toBe('Madonna');
    expect(orderCall[3].billing.last_name).toBe('MercadoLibre');
    expect(orderCall[3].billing.address_1).toBe('Av Colon 100');
  });

  // Hallazgo del tester: cuando comment/floor/apartment vienen todos vacíos/ausentes,
  // address_2 debe quedar en '' (string vacío), nunca undefined ni con espacios sueltos
  // por el .filter(Boolean).join(' ') de routes/sync.js.
  it('receiver_address sin comment/floor/apartment → address_2 queda en "" tanto en shipping como en billing', async () => {
    const orden = ordenConEnvio('ORD-SHIP-SINPISO', 7002);
    mlFetch.mockImplementation(async (d, cfg, method, path) => {
      if (path.startsWith('/orders/search')) return { status: 200, data: { results: [orden] } };
      if (path === '/shipments/7002') {
        return {
          status: 200,
          data: {
            receiver_address: {
              receiver_name: 'Ana Diaz', street_name: 'San Martin', street_number: '50',
              city: { name: 'Cordoba' }, state: { name: 'Cordoba' }, zip_code: '5000',
            },
          },
        };
      }
      return { status: 200, data: {} };
    });
    wooFetch.mockImplementation(async (cfg, path, method = 'get') => {
      if (path === '/orders' && method === 'post') return { data: { id: 6021 } };
      return { data: {} };
    });

    const p = syncMlToWc(db, CFG);
    await vi.runAllTimersAsync();
    await p;

    const orderCall = wooFetch.mock.calls.find(c => c[1] === '/orders' && c[2] === 'post');
    expect(orderCall[3].shipping.address_2).toBe('');
    expect(orderCall[3].billing.address_2).toBe('');
  });

  // Hallazgo del tester: una calle SIN receiver_name (nombre vacío) llegando desde ML no debe
  // pisar la dirección real en `billing` con el fallback — solo el nombre/apellido se
  // reemplazan, la dirección real del envío se conserva íntegra. El `shipping` del pedido
  // sigue reflejando fielmente el nombre vacío que dijo ML (no se "arregla").
  it('calle sin receiver_name → billing conserva la dirección real y solo reemplaza nombre/apellido', async () => {
    const orden = ordenConEnvio('ORD-SHIP-SINNOMBRE', 7003);
    mlFetch.mockImplementation(async (d, cfg, method, path) => {
      if (path.startsWith('/orders/search')) return { status: 200, data: { results: [orden] } };
      if (path === '/shipments/7003') {
        return {
          status: 200,
          data: {
            receiver_address: {
              street_name: 'Belgrano', street_number: '900',
              city: { name: 'Cordoba' }, state: { name: 'Cordoba' }, zip_code: '5000',
            },
          },
        };
      }
      return { status: 200, data: {} };
    });
    wooFetch.mockImplementation(async (cfg, path, method = 'get') => {
      if (path === '/orders' && method === 'post') return { data: { id: 6022 } };
      return { data: {} };
    });

    const p = syncMlToWc(db, CFG);
    await vi.runAllTimersAsync();
    await p;

    const orderCall = wooFetch.mock.calls.find(c => c[1] === '/orders' && c[2] === 'post');
    // shipping refleja fielmente el nombre vacío (nunca se "arregla" acá).
    expect(orderCall[3].shipping.first_name).toBe('');
    expect(orderCall[3].shipping.last_name).toBe('');
    expect(orderCall[3].shipping.address_1).toBe('Belgrano 900');
    // billing reemplaza SOLO nombre/apellido por el fallback, conserva la dirección real.
    expect(orderCall[3].billing.first_name).toBe('comprador123');
    expect(orderCall[3].billing.last_name).toBe('MercadoLibre');
    expect(orderCall[3].billing.address_1).toBe('Belgrano 900');
    expect(orderCall[3].billing.city).toBe('Cordoba');
  });

  it('orden sin shipping.id → no consulta /shipments, billing también cae al fallback de nickname', async () => {
    const orden = ordenConEnvio('ORD-SIN-SHIP-BILLING', undefined);
    mlFetch.mockImplementation(async (d, cfg, method, path) => {
      if (path.startsWith('/orders/search')) return { status: 200, data: { results: [orden] } };
      return { status: 200, data: {} };
    });
    wooFetch.mockImplementation(async (cfg, path, method = 'get') => {
      if (path === '/orders' && method === 'post') return { data: { id: 6023 } };
      return { data: {} };
    });

    const p = syncMlToWc(db, CFG);
    await vi.runAllTimersAsync();
    await p;

    expect(mlFetch.mock.calls.some(c => String(c[3]).startsWith('/shipments/'))).toBe(false);
    const orderCall = wooFetch.mock.calls.find(c => c[1] === '/orders' && c[2] === 'post');
    expect(orderCall[3].shipping).toBeUndefined();
    expect(orderCall[3].billing).toEqual({ first_name: 'comprador123', last_name: 'MercadoLibre' });
  });

  it('order_items sin sale_fee → no se estima/inventa el neto, se omite ese dato', async () => {
    const orden = {
      id: 'ORD-SIN-FEE',
      date_created: new Date().toISOString(),
      buyer: { nickname: 'compradorX' },
      order_items: [{ item: { id: 'MLA100', variation_id: '' }, quantity: 1, unit_price: 250 }], // sin sale_fee
    };
    mlFetch.mockResolvedValue({ status: 200, data: { results: [orden] } });
    wooFetch.mockImplementation(async (cfg, path, method = 'get') => {
      if (path === '/orders' && method === 'post') return { data: { id: 6004 } };
      return { data: {} };
    });

    const p = syncMlToWc(db, CFG);
    await vi.runAllTimersAsync();
    await p;

    const orderCall = wooFetch.mock.calls.find(c => c[1] === '/orders' && c[2] === 'post');
    const meta = Object.fromEntries(orderCall[3].meta_data.map(m => [m.key, m.value]));
    expect(meta._ml_neto_estimado).toBeUndefined();
    expect(meta._ml_precio_pagado_total).toBe('250.00');
  });

  // Hallazgo del revisor: no alcanza con que UN item tenga sale_fee — si solo algunos lo
  // traen, sumar bruto entero de los demás sobreestima el neto y lo presenta como dato real.
  it('solo algunos order_items traen sale_fee (no todos) → se omite el neto igual, no se mezcla', async () => {
    const orden = {
      id: 'ORD-FEE-PARCIAL',
      date_created: new Date().toISOString(),
      buyer: { nickname: 'compradorZ' },
      order_items: [
        { item: { id: 'MLA100', variation_id: '' }, quantity: 1, unit_price: 250, sale_fee: 20 },
        { item: { id: 'MLA100', variation_id: '' }, quantity: 1, unit_price: 300 }, // sin sale_fee
      ],
    };
    mlFetch.mockResolvedValue({ status: 200, data: { results: [orden] } });
    wooFetch.mockImplementation(async (cfg, path, method = 'get') => {
      if (path === '/orders' && method === 'post') return { data: { id: 6012 } };
      return { data: {} };
    });

    const p = syncMlToWc(db, CFG);
    await vi.runAllTimersAsync();
    await p;

    const orderCall = wooFetch.mock.calls.find(c => c[1] === '/orders' && c[2] === 'post');
    const meta = Object.fromEntries(orderCall[3].meta_data.map(m => [m.key, m.value]));
    expect(meta._ml_neto_estimado).toBeUndefined();
    expect(meta._ml_precio_pagado_total).toBe('550.00');
  });

  // 2da pasada del revisor (2026-08-03): no está confirmado si sale_fee es por unidad o ya
  // multiplicado por la cantidad. Con quantity>1 se omite el neto en vez de arriesgar un
  // dato falso (restar un solo sale_fee de un total ×quantity subestimaría la comisión).
  it('todos los items traen sale_fee pero alguno tiene quantity>1 → se omite el neto (semántica de sale_fee con cantidad no confirmada)', async () => {
    const orden = {
      id: 'ORD-FEE-CANTIDAD',
      date_created: new Date().toISOString(),
      buyer: { nickname: 'compradorW' },
      order_items: [
        { item: { id: 'MLA100', variation_id: '' }, quantity: 2, unit_price: 250, sale_fee: 20 },
      ],
    };
    mlFetch.mockResolvedValue({ status: 200, data: { results: [orden] } });
    wooFetch.mockImplementation(async (cfg, path, method = 'get') => {
      if (path === '/orders' && method === 'post') return { data: { id: 6013 } };
      return { data: {} };
    });

    const p = syncMlToWc(db, CFG);
    await vi.runAllTimersAsync();
    await p;

    const orderCall = wooFetch.mock.calls.find(c => c[1] === '/orders' && c[2] === 'post');
    const meta = Object.fromEntries(orderCall[3].meta_data.map(m => [m.key, m.value]));
    expect(meta._ml_neto_estimado).toBeUndefined();
    // El precio pagado total sí se informa (no depende de la duda sobre sale_fee).
    expect(meta._ml_precio_pagado_total).toBe('500.00');
  });

  it('en ningún caso se emite un PUT/PATCH sobre el pedido WC ya creado (solo el POST de creación)', async () => {
    const orden = ordenConEnvio('ORD-NO-PUT', 777);
    mlFetch.mockImplementation(async (d, cfg, method, path) => {
      if (path.startsWith('/orders/search')) return { status: 200, data: { results: [orden] } };
      if (path === '/shipments/777') return { status: 200, data: { receiver_address: { receiver_name: 'X' } } };
      return { status: 200, data: {} };
    });
    wooFetch.mockImplementation(async (cfg, path, method = 'get') => {
      if (path === '/orders' && method === 'post') return { data: { id: 6005 } };
      return { data: {} };
    });

    const p = syncMlToWc(db, CFG);
    await vi.runAllTimersAsync();
    await p;

    const noPost = wooFetch.mock.calls.filter(c => c[2] === 'put' || c[2] === 'patch');
    expect(noPost).toHaveLength(0);
  });
});

describe('syncMlToWc — casos borde de cobertura (tester, 2026-08-03)', () => {
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

  // Caso borde del plan: orden multi-ítem donde solo ALGUNOS SKU mapean. El pedido debe
  // crearse igual con la línea que sí mapea (precio de contado propio), la que no mapea
  // queda en sin_mapeo, y la orden se sella como 'parcial' (no 'ok', no se pierde la venta,
  // pero tampoco se declara completa).
  it('orden multi-ítem: un SKU mapea (usa precio de contado) y otro no mapea → pedido se crea con la línea válida, orden queda parcial', async () => {
    seedCatalogo(db, { precio: 300 }); // BIKE-001 (MLA100) → contado 200
    const orden = {
      id: 'ORD-MIXTA',
      date_created: new Date().toISOString(),
      order_items: [
        { item: { id: 'MLA100', variation_id: '' }, quantity: 1, unit_price: 150 },
        { item: { id: 'MLA999', variation_id: '' }, quantity: 1, unit_price: 999 }, // sin mapeo
      ],
    };
    mlFetch.mockResolvedValue({ status: 200, data: { results: [orden] } });
    wooFetch.mockImplementation(async (cfg, path, method = 'get') => {
      if (path === '/orders' && method === 'post') return { data: { id: 7001 } };
      return { data: {} };
    });

    const p = syncMlToWc(db, CFG);
    await vi.runAllTimersAsync();
    await p;

    const orderCall = wooFetch.mock.calls.find(c => c[1] === '/orders' && c[2] === 'post');
    expect(orderCall).toBeTruthy();
    // Solo la línea mapeada, con el precio de contado propio — nunca el unit_price de ML.
    expect(orderCall[3].line_items).toEqual([
      { quantity: 1, subtotal: '200.00', total: '200.00', product_id: 100 },
    ]);

    const logSinMapeo = db.prepare("SELECT * FROM sync_log WHERE estado = 'sin_mapeo'").get();
    expect(logSinMapeo).toBeTruthy();
    expect(logSinMapeo.clave).toBe('MLA999|');

    const proc = db.prepare('SELECT * FROM ordenes_ml_procesadas WHERE order_id = ?').get('ORD-MIXTA');
    expect(proc.estado).toBe('parcial');

    // Pedido igual quedó vinculado en ordenes_ml_wc_pedidos (no se perdió por el item sin mapeo).
    const pedido = db.prepare('SELECT * FROM ordenes_ml_wc_pedidos WHERE ml_order_id = ?').get('ORD-MIXTA');
    expect(pedido.wc_order_id).toBe(7001);
  });

  // Orden ML sin order_items (campo ausente): no debe explotar, no crea pedido (nada
  // mapeable), y libera la reserva para que el próximo ciclo pueda reintentar.
  it('orden ML sin order_items (campo ausente) → no crea pedido, no explota, libera la reserva', async () => {
    const orden = { id: 'ORD-SIN-ITEMS', date_created: new Date().toISOString() };
    mlFetch.mockResolvedValue({ status: 200, data: { results: [orden] } });

    const p = syncMlToWc(db, CFG);
    await vi.runAllTimersAsync();
    await p;

    expect(wooFetch).not.toHaveBeenCalled();
    const proc = db.prepare('SELECT * FROM ordenes_ml_procesadas WHERE order_id = ?').get('ORD-SIN-ITEMS');
    expect(proc.estado).toBe('parcial');
    // La reserva se liberó (no queda wc_order_id=0 colgada) — el próximo ciclo puede reintentar.
    const pedido = db.prepare('SELECT * FROM ordenes_ml_wc_pedidos WHERE ml_order_id = ?').get('ORD-SIN-ITEMS');
    expect(pedido).toBeUndefined();
  });

  // Regresión de redondeo único (fix del tester, 2026-08-03): precioContado() redondea el
  // UNITARIO a 2 decimales (666.67 = round(1000×2/3)); multiplicar ESE valor ya redondeado
  // por la cantidad y volver a aplicar toFixed(2) es un DOBLE redondeo que arrastra hasta un
  // centavo de diferencia frente al cálculo exacto (3 × 666.6666... = 2000.00, pero
  // 3 × 666.67 = 2000.01). El código ahora usa totalContado() (lib/mlPrecios.js), que
  // calcula sobre el precio de lista sin pasar por el unitario redondeado y redondea una
  // sola vez, al final — el total tiene que ser el exacto (2000.00), no 2000.01.
  it('cantidad=3 con precio de contado no exacto en centavos → el total es el EXACTO (2000.00), sin doble redondeo', async () => {
    seedCatalogo(db, { precio: 1000 }); // contado unitario 666.67 (ya redondeado) — total exacto: 2000.00
    const orden = {
      id: 'ORD-QTY3',
      date_created: new Date().toISOString(),
      order_items: [{ item: { id: 'MLA100', variation_id: '' }, quantity: 3, unit_price: 700 }],
    };
    mlFetch.mockResolvedValue({ status: 200, data: { results: [orden] } });
    wooFetch.mockImplementation(async (cfg, path, method = 'get') => {
      if (path === '/orders' && method === 'post') return { data: { id: 8003 } };
      return { data: {} };
    });

    const p = syncMlToWc(db, CFG);
    await vi.runAllTimersAsync();
    await p;

    const orderCall = wooFetch.mock.calls.find(c => c[1] === '/orders' && c[2] === 'post');
    expect(orderCall[3].line_items).toEqual([
      { quantity: 3, subtotal: '2000.00', total: '2000.00', product_id: 100 },
    ]);
  });

  // Segundo caso de doble redondeo (pedido del tester): cantidad alta con un precio de
  // lista que tampoco divide exacto en centavos al aplicar el 2/3. 7 × (999.99×2/3 exacto
  // 666.66) = 4666.62 exacto; con doble redondeo (unitario 666.66 redondeado × 7) daría el
  // mismo valor por casualidad en este caso puntual, así que se usa un precio donde el
  // redondeo del unitario SÍ desvía el total: regular_price=100 → unitario exacto
  // 66.6666... redondeado a 66.67; × 7 con doble redondeo = 466.69, exacto = 466.6666... → 466.67.
  it('cantidad=7 con regular_price=100 (2/3 no exacto) → el total es el exacto (466.67), no el de doble redondeo (466.69)', async () => {
    seedCatalogo(db, { precio: 100 });
    const orden = {
      id: 'ORD-QTY7',
      date_created: new Date().toISOString(),
      order_items: [{ item: { id: 'MLA100', variation_id: '' }, quantity: 7, unit_price: 90 }],
    };
    mlFetch.mockResolvedValue({ status: 200, data: { results: [orden] } });
    wooFetch.mockImplementation(async (cfg, path, method = 'get') => {
      if (path === '/orders' && method === 'post') return { data: { id: 8004 } };
      return { data: {} };
    });

    const p = syncMlToWc(db, CFG);
    await vi.runAllTimersAsync();
    await p;

    const orderCall = wooFetch.mock.calls.find(c => c[1] === '/orders' && c[2] === 'post');
    expect(orderCall[3].line_items).toEqual([
      { quantity: 7, subtotal: '466.67', total: '466.67', product_id: 100 },
    ]);
  });

  // Caso borde del plan: producto con regular_price EXPLÍCITAMENTE 0 (no null) — camino
  // distinto en el código al de "null" (mensaje de log diferente), debe seguir el mismo
  // fail-open: línea sin subtotal/total, venta no se pierde.
  it('regular_price = 0 (explícito, no null) → fail-open sin subtotal/total, log distingue el motivo', async () => {
    seedCatalogo(db, { precio: 300, regularPrice: 0 });
    const orden = {
      id: 'ORD-RP0',
      date_created: new Date().toISOString(),
      order_items: [{ item: { id: 'MLA100', variation_id: '' }, quantity: 1, unit_price: 150 }],
    };
    mlFetch.mockResolvedValue({ status: 200, data: { results: [orden] } });
    wooFetch.mockImplementation(async (cfg, path, method = 'get') => {
      if (path === '/orders' && method === 'post') return { data: { id: 9001 } };
      return { data: {} };
    });

    const p = syncMlToWc(db, CFG);
    await vi.runAllTimersAsync();
    await p;

    const orderCall = wooFetch.mock.calls.find(c => c[1] === '/orders' && c[2] === 'post');
    expect(orderCall).toBeTruthy();
    expect(orderCall[3].line_items).toEqual([{ quantity: 1, product_id: 100 }]);

    const log = db.prepare("SELECT * FROM sync_log WHERE sku = 'BIKE-001' AND estado = 'error'").get();
    expect(log.error).toMatch(/regular_price es 0\/inválido/);

    // No se pierde la venta: el pedido se creó y quedó vinculado.
    const pedido = db.prepare('SELECT * FROM ordenes_ml_wc_pedidos WHERE ml_order_id = ?').get('ORD-RP0');
    expect(pedido.wc_order_id).toBe(9001);
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

  it('tope SYNC_WC_ML_MAX_LLAMADAS_ML_POR_CORRIDA: con más diffs que el tope, procesa exactamente el tope y deja el resto para la corrida siguiente (M3, revisor; tope inyectado chico — m5, ronda 2 revisor)', async () => {
    // m5 (ronda 2 revisor): antes este test usaba 210 filas contra el tope real de 200
    // (~420 iteraciones entre las dos corridas) con un margen de timeout fijo de 30s — escala
    // con la carga de la suite y vuelve flaky. Ahora se prueba la MISMA propiedad con
    // opts.maxLlamadas inyectado chico (5) y pocas filas (7): el costo es de milisegundos, no
    // de wall-clock real, y documenta de paso que el tope es configurable.
    // Limpiar las decisiones/catálogo del seed genérico del describe (MLA100|/BIKE-001,
    // MLA200|987/CASCO-L) para que este test controle el universo de diffs con precisión.
    db.prepare("DELETE FROM sku_matcher_decisiones").run();
    db.prepare("DELETE FROM catalogo_cache").run();

    const TOPE = 5;
    const FILAS = 7;
    // 7 publicaciones con diff (> tope de 5) — ninguna con ml_stock_estado todavía, así que
    // las 7 son diffs (cantidad_ml IS NULL). Cada una tiene su propio sku/producto para no
    // chocar con el dedup de catalogo_cache.
    const now = new Date().toISOString();
    for (let i = 0; i < FILAS; i++) {
      const sku = `SKU-TOPE-${String(i).padStart(4, '0')}`;
      const clave = `MLATOPE${String(i).padStart(4, '0')}|`;
      db.prepare(
        'INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en) VALUES (?, ?, ?, ?, ?)'
      ).run(clave, sku, 'Producto tope', 'confirmar', now);
      db.prepare(
        'INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, actualizado_en) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(1000 + i, 'Producto tope', sku, 'simple', null, 1, now);
      db.prepare(
        'INSERT INTO ml_publicaciones_cache (clave, item_id, variation_id, status, actualizado_en) VALUES (?, ?, ?, ?, ?)'
      ).run(clave, `MLATOPE${String(i).padStart(4, '0')}`, '', 'active', now);
    }
    mlFetch.mockResolvedValue({ status: 200, data: {} });

    const p = syncWcToMl(db, CFG, { maxLlamadas: TOPE });
    await vi.runAllTimersAsync();
    await p;

    // Se procesaron exactamente el tope (5), no las 7. Cada diff procesado con éxito deja
    // fila en ml_stock_estado; las que quedaron fuera del tope, no.
    const procesadas = db.prepare("SELECT COUNT(*) n FROM ml_stock_estado WHERE clave LIKE 'MLATOPE%'").get().n;
    expect(procesadas).toBe(TOPE);

    // Las que quedaron sin ml_stock_estado (2 restantes) van primero en la próxima corrida:
    // el ORDER BY prioriza NULL/lo más viejo. Corremos una segunda vez y deben completarse.
    mlFetch.mockClear();
    mlFetch.mockResolvedValue({ status: 200, data: {} });
    const p2 = syncWcToMl(db, CFG, { maxLlamadas: TOPE });
    await vi.runAllTimersAsync();
    await p2;

    const procesadasFinal = db.prepare("SELECT COUNT(*) n FROM ml_stock_estado WHERE clave LIKE 'MLATOPE%'").get().n;
    expect(procesadasFinal).toBe(FILAS); // las 2 restantes se completaron en la corrida siguiente
  });

  it('B1 (ronda 2, revisor): un tope por filas leídas se puede clavar con publicaciones pausadas que nunca envejecen — el tope real es por llamadas a ML, así que una activa al final del lote igual se empuja en la misma corrida', async () => {
    // Reproduce el modo de falla mudo que describe el hallazgo: 250 publicaciones PAUSADAS
    // (status='paused' en ml_publicaciones_cache, sin ml_stock_estado, así que cantidad_ml
    // IS NULL y ml_stock_actualizado_en NULL → van TODAS primero en el ORDER BY, por encima
    // del tope de 200) + 1 publicación ACTIVA con diff al final de la cola. Con un LIMIT sobre
    // filas leídas, las 200 primeras (todas pausadas) agotarían el tope en `continue`
    // instantáneos y la activa jamás se alcanzaría. Con el tope por llamadas a ML, los skips
    // de las pausadas no cuestan nada y la activa sí se procesa en esta misma corrida.
    db.prepare("DELETE FROM sku_matcher_decisiones").run();
    db.prepare("DELETE FROM catalogo_cache").run();

    const now = new Date().toISOString();
    for (let i = 0; i < 250; i++) {
      const sku = `SKU-PAUSADA-${String(i).padStart(4, '0')}`;
      const clave = `MLAPAUSADA${String(i).padStart(4, '0')}|`;
      db.prepare(
        'INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en) VALUES (?, ?, ?, ?, ?)'
      ).run(clave, sku, 'Producto pausado', 'confirmar', now);
      db.prepare(
        'INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, actualizado_en) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(2000 + i, 'Producto pausado', sku, 'simple', null, 1, now);
      db.prepare(
        'INSERT INTO ml_publicaciones_cache (clave, item_id, variation_id, status, actualizado_en) VALUES (?, ?, ?, ?, ?)'
      ).run(clave, `MLAPAUSADA${String(i).padStart(4, '0')}`, '', 'paused', now);
    }
    // La activa al final del universo lexicográfico ('MLZ...' ordena después de 'MLAPAUSADA...').
    db.prepare(
      'INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en) VALUES (?, ?, ?, ?, ?)'
    ).run('MLZACTIVA|', 'SKU-ACTIVA', 'Producto activo', 'confirmar', now);
    db.prepare(
      'INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, actualizado_en) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(9999, 'Producto activo', 'SKU-ACTIVA', 'simple', null, 1, now);
    db.prepare(
      'INSERT INTO ml_publicaciones_cache (clave, item_id, variation_id, status, actualizado_en) VALUES (?, ?, ?, ?, ?)'
    ).run('MLZACTIVA|', 'MLZACTIVA', '', 'active', now);

    mlFetch.mockResolvedValue({ status: 200, data: {} });

    const p = syncWcToMl(db, CFG);
    await vi.runAllTimersAsync();
    await p;

    // La activa se empujó en esta misma corrida: quedó con fila en ml_stock_estado.
    const estadoActiva = db.prepare("SELECT * FROM ml_stock_estado WHERE clave = 'MLZACTIVA|'").get();
    expect(estadoActiva).toBeDefined();
    expect(estadoActiva.cantidad_ml).toBe(1);

    // Las pausadas no consumieron el tope de llamadas: solo se hizo 1 PUT (el de la activa),
    // ningún GET de status (todas ya tenían status en ml_publicaciones_cache).
    expect(mlFetch).toHaveBeenCalledTimes(1);

    // Ninguna pausada quedó dada de alta en ml_stock_estado (se saltearon, correcto).
    const pausadasConEstado = db.prepare("SELECT COUNT(*) n FROM ml_stock_estado WHERE clave LIKE 'MLAPAUSADA%'").get().n;
    expect(pausadasConEstado).toBe(0);
  }, 30000);

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

  // 2da pasada del revisor (2026-08-03): una orden con reserva RETENIDA nunca se sella, así
  // que el cron (cada 3min) la retoma en cada ciclo. Sin un corte local antes de shipments,
  // cada retoma gastaría una llamada a /shipments/{id} para siempre — este test confirma que
  // el segundo ciclo sobre una orden retenida sale ANTES de llamar a mlFetch de nuevo.
  it('reserva RETENIDA: el ciclo siguiente sale por el chequeo local, sin gastar una llamada a /shipments/{id}', async () => {
    const orden = {
      id: 'ORD-RETENIDA-SIN-SHIP',
      date_created: new Date().toISOString(),
      shipping: { id: 4242 }, // tiene envío asociado — si no hubiera corte, gastaría el GET
      order_items: [{ item: { id: 'MLA100', variation_id: '' }, quantity: 1, unit_price: 100 }],
    };
    mlFetch.mockResolvedValue({ status: 200, data: { results: [orden] } });
    wooFetch.mockImplementation(async (cfg, path, method = 'get') => {
      if (path === '/orders' && method === 'post') throw new Error('timeout of 20000ms exceeded');
      if (path.startsWith('/orders?')) throw new Error('ECONNREFUSED');
      return { data: {} };
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await syncMlToWc(db, CFG); // 1er ciclo: POST y verificación fallan → reserva RETENIDA
    const pedido = db.prepare('SELECT * FROM ordenes_ml_wc_pedidos WHERE ml_order_id = ?').get('ORD-RETENIDA-SIN-SHIP');
    expect(pedido.retenido_en).toBeTruthy();

    mlFetch.mockClear();
    await syncMlToWc(db, CFG); // 2do ciclo: el cron la retoma (nunca se sella)
    errSpy.mockRestore();

    // El chequeo local corta ANTES de llamar a mlFetch — ni /shipments/ ni /orders/search
    // (mlFetch no se llama en absoluto en este segundo ciclo para esta orden).
    expect(mlFetch).not.toHaveBeenCalledWith(db, CFG.ml, 'get', '/shipments/4242');
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

// Regresion del incidente 2026-07-29 (pedidos WC 66554/66555 para la orden ML
// 2000017646759842): `after` se mandaba en ISO UTC pero Woo lo interpretaba en hora LOCAL
// del sitio (UTC-3) -> el rango pedido quedaba en el futuro -> 0 pedidos -> falso negativo
// de inexistencia -> reserva liberada -> el cron creaba un pedido DUPLICADO.
describe('syncMlToWc — verificacion anti-duplicado: dates_are_gmt y reverificacion sin filtro de fecha', () => {
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

  it('la query de verificacion por fecha incluye dates_are_gmt=true', async () => {
    const orden = ordenSimple('ORD-GMT');
    mlFetch.mockResolvedValue({ status: 200, data: { results: [orden] } });
    wooFetch.mockImplementation(async (cfg, path, method = 'get') => {
      if (path === '/orders' && method === 'post') throw new Error('timeout of 20000ms exceeded');
      if (path.startsWith('/orders?') && path.includes('after=')) {
        return { data: [{ id: 77001, meta_data: [{ key: '_ml_order_id', value: 'ORD-GMT' }] }] };
      }
      return { data: {} };
    });

    await syncMlToWc(db, CFG);

    const consultasConFecha = wooFetch.mock.calls.filter(
      c => String(c[1]).startsWith('/orders?') && c[1].includes('after=')
    );
    expect(consultasConFecha.length).toBeGreaterThan(0);
    for (const c of consultasConFecha) {
      expect(c[1]).toContain('dates_are_gmt=true');
    }
  });

  it('el rango por fecha (pagina 1) vuelve vacio y el pedido SI existe en la reconsulta sin filtro de fecha → completa la reserva, no crea un duplicado', async () => {
    const orden = ordenSimple('ORD-REVERIF-EXISTE');
    mlFetch.mockResolvedValue({ status: 200, data: { results: [orden] } });

    wooFetch.mockImplementation(async (cfg, path, method = 'get') => {
      if (path === '/orders' && method === 'post') throw new Error('timeout of 20000ms exceeded');
      if (path.startsWith('/orders?')) {
        // El rango por fecha (con after= y dates_are_gmt=true) vuelve vacio, como en el
        // incidente real cuando el filtro quedaba mal interpretado.
        if (path.includes('after=')) return { data: [] };
        // Reconsulta sin filtro de fecha: el pedido SI esta.
        return {
          data: [{ id: 66554, meta_data: [{ key: '_ml_order_id', value: 'ORD-REVERIF-EXISTE' }] }],
        };
      }
      return { data: {} };
    });

    await syncMlToWc(db, CFG);

    // Un solo POST: no se creo un segundo pedido (el bug real habria creado el 66555).
    const posts = wooFetch.mock.calls.filter(c => c[1] === '/orders' && c[2] === 'post');
    expect(posts).toHaveLength(1);

    const pedido = db.prepare('SELECT * FROM ordenes_ml_wc_pedidos WHERE ml_order_id = ?').get('ORD-REVERIF-EXISTE');
    expect(pedido.wc_order_id).toBe(66554);
    expect(pedido.retenido_en).toBeNull();

    const proc = db.prepare('SELECT * FROM ordenes_ml_procesadas WHERE order_id = ?').get('ORD-REVERIF-EXISTE');
    expect(proc.estado).toBe('ok');
  });

  it('el rango por fecha vuelve vacio y la reconsulta sin filtro de fecha TAMPOCO lo encuentra → concluye inexistencia real, libera la reserva', async () => {
    const orden = ordenSimple('ORD-REVERIF-NO-EXISTE');
    mlFetch.mockResolvedValue({ status: 200, data: { results: [orden] } });

    wooFetch.mockImplementation(async (cfg, path, method = 'get') => {
      if (path === '/orders' && method === 'post') throw new Error('timeout of 20000ms exceeded');
      if (path.startsWith('/orders?')) {
        if (path.includes('after=')) return { data: [] };
        // Reconsulta sin filtro de fecha: tampoco aparece (otros pedidos, ninguno propio).
        return { data: [{ id: 1, meta_data: [] }] };
      }
      return { data: {} };
    });

    await syncMlToWc(db, CFG);

    const pedido = db.prepare('SELECT * FROM ordenes_ml_wc_pedidos WHERE ml_order_id = ?').get('ORD-REVERIF-NO-EXISTE');
    expect(pedido).toBeUndefined(); // reserva liberada: inexistencia confirmada
    const proc = db.prepare('SELECT * FROM ordenes_ml_procesadas WHERE order_id = ?').get('ORD-REVERIF-NO-EXISTE');
    expect(proc).toBeUndefined(); // reintentable en el proximo ciclo
  });

  it('la reconsulta sin filtro de fecha pide orderby=date&order=desc explicito (no confia en el default de Woo)', async () => {
    const orden = ordenSimple('ORD-ORDERBY');
    mlFetch.mockResolvedValue({ status: 200, data: { results: [orden] } });
    wooFetch.mockImplementation(async (cfg, path, method = 'get') => {
      if (path === '/orders' && method === 'post') throw new Error('timeout of 20000ms exceeded');
      if (path.startsWith('/orders?')) {
        if (path.includes('after=')) return { data: [] };
        return { data: [{ id: 55001, meta_data: [{ key: '_ml_order_id', value: 'ORD-ORDERBY' }] }] };
      }
      return { data: {} };
    });

    await syncMlToWc(db, CFG);

    const reconsultas = wooFetch.mock.calls.filter(
      c => String(c[1]).startsWith('/orders?') && !c[1].includes('after=')
    );
    expect(reconsultas.length).toBeGreaterThan(0);
    for (const c of reconsultas) {
      expect(c[1]).toContain('orderby=date&order=desc');
    }
  });

  // Hueco senalado por la revision: el bug no es solo "rango vacio". Un rango CON pedidos
  // legitimos (pero sin el nuestro) agotaba la ventana igual (pedidos.length < 100) y debe
  // disparar la misma reverificacion sin filtro de fecha antes de concluir inexistencia.
  it('el rango por fecha vuelve NO vacio (7 pedidos ajenos, ninguno propio) pero igual dispara la reverificacion y encuentra el pedido → no crea un duplicado', async () => {
    const orden = ordenSimple('ORD-RANGO-NO-VACIO');
    mlFetch.mockResolvedValue({ status: 200, data: { results: [orden] } });
    const pedidosAjenos = Array.from({ length: 7 }, (_, k) => ({ id: 3000 + k, meta_data: [] }));

    wooFetch.mockImplementation(async (cfg, path, method = 'get') => {
      if (path === '/orders' && method === 'post') throw new Error('timeout of 20000ms exceeded');
      if (path.startsWith('/orders?')) {
        // El rango acotado por fecha SI trae pedidos (7, legitimos), pero ninguno es el
        // nuestro: length < 100 agota la ventana igual, debe reverificar.
        if (path.includes('after=')) return { data: pedidosAjenos };
        return {
          data: [{ id: 66900, meta_data: [{ key: '_ml_order_id', value: 'ORD-RANGO-NO-VACIO' }] }],
        };
      }
      return { data: {} };
    });

    await syncMlToWc(db, CFG);

    // Un solo POST: no se creo un segundo pedido
    const posts = wooFetch.mock.calls.filter(c => c[1] === '/orders' && c[2] === 'post');
    expect(posts).toHaveLength(1);

    const pedido = db.prepare('SELECT * FROM ordenes_ml_wc_pedidos WHERE ml_order_id = ?').get('ORD-RANGO-NO-VACIO');
    expect(pedido.wc_order_id).toBe(66900);
    expect(pedido.retenido_en).toBeNull();
  });

  // `status=any` en Woo NO incluye `trash`: un duplicado que el operador mando a la papelera
  // no debe contar como inexistente, o el cron lo recrearia despues de cada limpieza.
  it('el pedido esta en la papelera (status=trash): status=any no lo encuentra pero la segunda consulta si → no lo recrea', async () => {
    const orden = ordenSimple('ORD-EN-PAPELERA');
    mlFetch.mockResolvedValue({ status: 200, data: { results: [orden] } });

    wooFetch.mockImplementation(async (cfg, path, method = 'get') => {
      if (path === '/orders' && method === 'post') throw new Error('timeout of 20000ms exceeded');
      if (path.startsWith('/orders?')) {
        if (path.includes('after=')) return { data: [] };
        if (path.includes('status=any')) return { data: [] }; // any NO incluye trash
        if (path.includes('status=trash')) {
          return {
            data: [{ id: 66601, meta_data: [{ key: '_ml_order_id', value: 'ORD-EN-PAPELERA' }] }],
          };
        }
        return { data: [] };
      }
      return { data: {} };
    });

    await syncMlToWc(db, CFG);

    // Ambas consultas (any y trash) se hicieron
    const statusConsultados = new Set(
      wooFetch.mock.calls
        .filter(c => String(c[1]).startsWith('/orders?') && !c[1].includes('after='))
        .map(c => new URLSearchParams(c[1].split('?')[1]).get('status'))
    );
    expect(statusConsultados).toEqual(new Set(['any', 'trash']));

    // Encontrado en papelera → NO se recrea (un solo POST, reserva completada con el id real)
    const posts = wooFetch.mock.calls.filter(c => c[1] === '/orders' && c[2] === 'post');
    expect(posts).toHaveLength(1);
    const pedido = db.prepare('SELECT * FROM ordenes_ml_wc_pedidos WHERE ml_order_id = ?').get('ORD-EN-PAPELERA');
    expect(pedido.wc_order_id).toBe(66601);
    expect(pedido.retenido_en).toBeNull();
  });

  // Inexistencia real: ni `status=any` ni `status=trash` lo encuentran → recien ahi se
  // confirma inexistencia y se libera la reserva.
  it('inexistencia confirmada en AMBAS consultas (any y trash) → libera la reserva de verdad', async () => {
    const orden = ordenSimple('ORD-INEXISTENTE-REAL');
    mlFetch.mockResolvedValue({ status: 200, data: { results: [orden] } });

    wooFetch.mockImplementation(async (cfg, path, method = 'get') => {
      if (path === '/orders' && method === 'post') throw new Error('timeout of 20000ms exceeded');
      if (path.startsWith('/orders?')) {
        if (path.includes('after=')) return { data: [] };
        return { data: [] }; // ni any ni trash lo tienen
      }
      return { data: {} };
    });

    await syncMlToWc(db, CFG);

    const statusConsultados = new Set(
      wooFetch.mock.calls
        .filter(c => String(c[1]).startsWith('/orders?') && !c[1].includes('after='))
        .map(c => new URLSearchParams(c[1].split('?')[1]).get('status'))
    );
    expect(statusConsultados).toEqual(new Set(['any', 'trash']));

    const pedido = db.prepare('SELECT * FROM ordenes_ml_wc_pedidos WHERE ml_order_id = ?').get('ORD-INEXISTENTE-REAL');
    expect(pedido).toBeUndefined(); // reserva liberada: inexistencia confirmada en ambos status
    const proc = db.prepare('SELECT * FROM ordenes_ml_procesadas WHERE order_id = ?').get('ORD-INEXISTENTE-REAL');
    expect(proc).toBeUndefined(); // reintentable en el proximo ciclo
  });

  it('la reconsulta sin filtro de fecha vuelve con forma inesperada → no concluyente, fail-closed', async () => {
    const orden = ordenSimple('ORD-REVERIF-WAF');
    mlFetch.mockResolvedValue({ status: 200, data: { results: [orden] } });

    wooFetch.mockImplementation(async (cfg, path, method = 'get') => {
      if (path === '/orders' && method === 'post') throw new Error('timeout of 20000ms exceeded');
      if (path.startsWith('/orders?')) {
        if (path.includes('after=')) return { data: [] };
        // Reconsulta sin filtro de fecha con cuerpo con forma inesperada (WAF, plugin roto).
        return { data: '<html>Access denied</html>' };
      }
      return { data: {} };
    });

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await syncMlToWc(db, CFG);
    errSpy.mockRestore();

    // Fail-closed: reserva NO liberada, queda retenida para intervencion manual.
    const pedido = db.prepare('SELECT * FROM ordenes_ml_wc_pedidos WHERE ml_order_id = ?').get('ORD-REVERIF-WAF');
    expect(pedido).toBeTruthy();
    expect(pedido.wc_order_id).toBe(0);
    expect(pedido.retenido_en).toBeTruthy();

    const log = db.prepare("SELECT * FROM sync_log WHERE clave = 'ORD-REVERIF-WAF'").get();
    expect(log.estado).toBe('error');
    expect(log.error).toMatch(/fail-closed/);
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

/**
 * REGLA DE NEGOCIO CRÍTICA (incidente 2026-08-04): el cursor de ventas de ML
 * NO debe avanzar cuando la consulta a ML falla.
 *
 * `_syncMlToWc` arranca desde `sync_estado.ultima_orden_ml` y pide las órdenes
 * con `date_created.from=<cursor>`. Si el cursor avanzara ante un fallo, las
 * ventas de esa ventana no se volverían a consultar nunca y NUNCA se crearía
 * el pedido en WooCommerce: ventas perdidas en silencio.
 *
 * Esto importa especialmente desde que `mlFetch` tiene cooldown global: durante
 * un cooldown devuelve un 429 *sintético* sin salir a la red, así que este
 * camino ahora se recorre de forma sistemática (hasta 10 min seguidos) y no
 * solo de forma esporádica como cuando el 429 venía de ML.
 *
 * El contraste con el caso 200 es deliberado: sin él, un test que solo afirma
 * "el cursor no cambió" pasaría igual aunque el cursor no se escribiera nunca.
 */
describe('syncMlToWc — el cursor de ventas no avanza si ML no responde (cooldown/429)', () => {
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

  // Nota: las fechas se calculan con Date.now() DESPUÉS de instalar los timers falsos.
  // Funciona porque vitest arranca el reloj falso en el tiempo real actual. Son relativas
  // a propósito: un cursor hardcodeado caduca solo con el paso del tiempo.
  function seedCursor(db, valor) {
    db.prepare(
      "INSERT INTO sync_estado (clave, valor, actualizado_en) VALUES ('ultima_orden_ml', ?, ?)"
    ).run(valor, new Date().toISOString());
  }

  function leerCursor(db) {
    return db.prepare("SELECT valor FROM sync_estado WHERE clave = 'ultima_orden_ml'").get()?.valor ?? null;
  }

  it('con cooldown activo (429 sintético de mlFetch) el cursor queda intacto', async () => {
    // Fecha relativa a Date.now(): un cursor hardcodeado caduca solo con el tiempo.
    const cursorPrevio = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
    seedCursor(db, cursorPrevio);

    // Forma exacta del 429 sintético que devuelve mlFetch durante un cooldown:
    // no sale a la red, data va en null.
    mlFetch.mockResolvedValue({ status: 429, headers: {}, data: null, __cooldownSintetico: true });

    const p = syncMlToWc(db, CFG);
    await vi.runAllTimersAsync();
    await p;

    expect(leerCursor(db)).toBe(cursorPrevio);
    // Y no se creó ningún pedido en Woo.
    expect(wooFetch).not.toHaveBeenCalled();
  });

  // Con mlFetch mockeado en este archivo, un 429 "real" y uno sintético son el mismo
  // objeto para _syncMlToWc: ese caso no agregaría cobertura. Lo que sí importa fijar
  // acá es que CUALQUIER no-200 preserva el cursor, no solo el 429.
  it('ante un 500 de ML el cursor tampoco avanza (vale para cualquier no-200)', async () => {
    const cursorPrevio = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
    seedCursor(db, cursorPrevio);

    mlFetch.mockResolvedValue({ status: 500, headers: {}, data: null });

    const p = syncMlToWc(db, CFG);
    await vi.runAllTimersAsync();
    await p;

    expect(leerCursor(db)).toBe(cursorPrevio);
  });

  it('CONTRASTE: con 200 y una orden nueva, el cursor SÍ avanza (si no, el test de arriba sería vacuo)', async () => {
    const cursorPrevio = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
    const fechaOrden = new Date(Date.now() - 60 * 1000).toISOString();
    seedCursor(db, cursorPrevio);
    seedCatalogo(db, { precio: 300 });

    const orden = {
      id: 'ORD-CURSOR-1',
      date_created: fechaOrden,
      order_items: [{ item: { id: 'MLA100', variation_id: '' }, quantity: 1, unit_price: 150 }],
    };
    // Primera página con la orden, siguientes vacías (corta la paginación).
    let llamada = 0;
    mlFetch.mockImplementation(async () => {
      llamada += 1;
      return llamada === 1
        ? { status: 200, data: { results: [orden] } }
        : { status: 200, data: { results: [] } };
    });
    wooFetch.mockImplementation(async (cfg, path, method = 'get') => {
      if (path === '/orders' && method === 'post') return { data: { id: 7001 } };
      return { data: {} };
    });

    const p = syncMlToWc(db, CFG);
    await vi.runAllTimersAsync();
    await p;

    expect(leerCursor(db)).toBe(fechaOrden);
  });
});

describe('syncOrdenMlPuntual (A.3)', () => {
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

  it('happy path: GET /orders/{id} puntual (no /orders/search) crea el pedido en WC', async () => {
    seedCatalogo(db, { precio: 300 });
    const orden = {
      id: 'ORD-PUNTUAL-1',
      status: 'paid',
      date_created: new Date().toISOString(),
      order_items: [{ item: { id: 'MLA100', variation_id: '' }, quantity: 1, unit_price: 150 }],
    };
    mlFetch.mockImplementation(async (db_, mlCfg, method, path) => {
      if (path === '/orders/ORD-PUNTUAL-1') {
        return { status: 200, data: orden };
      }
      // Aceptar otras llamadas desde syncSkuPuntual (resync de SKUs hermanos)
      return { status: 200, data: { results: [] } };
    });
    wooFetch.mockImplementation(async (cfg, path, method = 'get') => {
      if (path === '/orders' && method === 'post') return { data: { id: 8001 } };
      return { data: {} };
    });

    const p = syncOrdenMlPuntual(db, CFG, 'ORD-PUNTUAL-1');
    await vi.runAllTimersAsync();
    const result = await p;

    expect(result.omitido).toBe(false);
    // Se llama a mlFetch para la orden, más posiblemente para resync de SKUs hermanos
    const llamadasAOrden = mlFetch.mock.calls.filter(c => c[3] === '/orders/ORD-PUNTUAL-1');
    expect(llamadasAOrden.length).toBe(1);
    expect(db.prepare('SELECT 1 FROM ordenes_ml_procesadas WHERE order_id=?').get('ORD-PUNTUAL-1')).toBeTruthy();
    const pedido = db.prepare('SELECT wc_order_id FROM ordenes_ml_wc_pedidos WHERE ml_order_id=?').get('ORD-PUNTUAL-1');
    expect(pedido.wc_order_id).toBe(8001);
  });

  it('orden ya procesada: no llama a mlFetch, devuelve omitido', async () => {
    db.prepare(
      'INSERT INTO ordenes_ml_procesadas (order_id, fecha_orden, items_json, estado, procesado_en) VALUES (?,?,?,?,?)'
    ).run('ORD-YA-1', new Date().toISOString(), '[]', 'ok', new Date().toISOString());

    const result = await syncOrdenMlPuntual(db, CFG, 'ORD-YA-1');

    expect(result).toEqual({ omitido: true, motivo: 'ya_procesada' });
    expect(mlFetch).not.toHaveBeenCalled();
  });

  it('GET de ML falla (500): omitido, no tira, el cron la retoma', async () => {
    mlFetch.mockResolvedValue({ status: 500, data: null });

    const result = await syncOrdenMlPuntual(db, CFG, 'ORD-FALLA-1');

    expect(result).toEqual({ omitido: true, motivo: 'http_500' });
    expect(db.prepare('SELECT 1 FROM ordenes_ml_procesadas WHERE order_id=?').get('ORD-FALLA-1')).toBeFalsy();
  });

  it('excepción de red: omitido, no tira hacia el caller (webhook ya respondió 200)', async () => {
    mlFetch.mockRejectedValue(new Error('timeout'));

    const result = await syncOrdenMlPuntual(db, CFG, 'ORD-EXC-1');

    expect(result).toEqual({ omitido: true, motivo: 'excepcion' });
  });

  it('sin mlOrderId: omitido sin llamar a nada', async () => {
    const result = await syncOrdenMlPuntual(db, CFG, '');
    expect(result).toEqual({ omitido: true, motivo: 'sin_order_id' });
    expect(mlFetch).not.toHaveBeenCalled();
  });

  it('orden NO pagada (payment_in_process): omitido, NO crea pedido en Woo ni descuenta stock', async () => {
    seedCatalogo(db, { precio: 300 });
    mlFetch.mockResolvedValue({
      status: 200,
      data: {
        id: 'ORD-NOPAGA-1',
        status: 'payment_in_process',
        date_created: new Date().toISOString(),
        order_items: [{ item: { id: 'MLA100', variation_id: '' }, quantity: 1, unit_price: 150 }],
      },
    });
    wooFetch.mockImplementation(async () => { throw new Error('no debería llamarse — la orden no está paga'); });

    const result = await syncOrdenMlPuntual(db, CFG, 'ORD-NOPAGA-1');

    expect(result).toEqual({ omitido: true, motivo: 'status_payment_in_process' });
    // No queda sellada: cuando pase a 'paid' el cron (o un webhook posterior) la tiene que
    // poder reprocesar con los datos definitivos, no saltearla por "ya procesada".
    expect(db.prepare('SELECT 1 FROM ordenes_ml_procesadas WHERE order_id=?').get('ORD-NOPAGA-1')).toBeFalsy();
    expect(wooFetch).not.toHaveBeenCalled();
    // El cursor tampoco debe avanzar: sacaría esta orden de la ventana del barrido de
    // respaldo antes de que exista una chance real de reprocesarla como 'paid'.
    expect(db.prepare("SELECT valor FROM sync_estado WHERE clave='ultima_orden_ml'").get()).toBeFalsy();
  });

  it('avanza el cursor ultima_orden_ml al procesar OK, para que el barrido de respaldo no re-pagine una ventana cada vez más vieja', async () => {
    seedCatalogo(db, { precio: 300 });
    const fechaOrden = new Date().toISOString();
    mlFetch.mockResolvedValue({
      status: 200,
      data: {
        id: 'ORD-CURSOR-PUNTUAL-1',
        status: 'paid',
        date_created: fechaOrden,
        order_items: [{ item: { id: 'MLA100', variation_id: '' }, quantity: 1, unit_price: 150 }],
      },
    });
    wooFetch.mockImplementation(async (cfg, path, method = 'get') => {
      if (path === '/orders' && method === 'post') return { data: { id: 9101 } };
      return { data: {} };
    });

    await syncOrdenMlPuntual(db, CFG, 'ORD-CURSOR-PUNTUAL-1');

    const cursor = db.prepare("SELECT valor FROM sync_estado WHERE clave='ultima_orden_ml'").get();
    expect(cursor?.valor).toBe(fechaOrden);
  });

  // Nota (hallazgo del revisor): este test es secuencial, no ejercita una carrera real entre
  // el camino puntual y el barrido paginado — prueba que la idempotencia PREEXISTENTE de
  // _procesarOrden (el INSERT de reserva contra la PK ml_order_id) sigue funcionando cuando
  // la fila ya existe, no específicamente el interleaving async de un solapamiento real.
  // Sirve como red de seguridad de regresión, no como prueba de concurrencia.
  it('convive con syncMlToWc (barrido paginado) sin duplicar el pedido si ambos procesan la misma orden', async () => {
    seedCatalogo(db, { precio: 300 });
    const orden = {
      id: 'ORD-CONVIVE-1',
      date_created: new Date().toISOString(),
      order_items: [{ item: { id: 'MLA100', variation_id: '' }, quantity: 1, unit_price: 150 }],
    };
    // El puntual ya reservó/creó el pedido (simulado insertando la fila que _procesarOrden
    // dejaría) antes de que corra el barrido paginado con la misma orden en sus resultados.
    db.prepare(
      'INSERT INTO ordenes_ml_wc_pedidos (ml_order_id, wc_order_id, creado_en) VALUES (?,?,?)'
    ).run('ORD-CONVIVE-1', 9001, new Date().toISOString());

    mlFetch.mockResolvedValue({ status: 200, data: { results: [orden] } });
    wooFetch.mockImplementation(async () => { throw new Error('no debería llamarse — ya está reservada'); });

    const p = syncMlToWc(db, CFG);
    await vi.runAllTimersAsync();
    await p;

    // _procesarOrden corta temprano (línea ~514) al ver la reserva existente: no vuelve a
    // postear a Woo ni duplica ordenes_ml_wc_pedidos.
    const filas = db.prepare('SELECT COUNT(*) n FROM ordenes_ml_wc_pedidos WHERE ml_order_id=?').get('ORD-CONVIVE-1');
    expect(filas.n).toBe(1);
  });
});
