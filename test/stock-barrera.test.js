// Fase E-0: barrera de venta ML (spec 2026-10-11-fase-e-webhooks-design.md).
// Se prueba contra un Woo y un ML simulados: lo que importa es QUÉ se escribe en ML y cuándo.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { openDb } from '../db/index.js';
import {
  syncMlToWc, syncSkuPuntual, syncWcToMl, procesarBarreraVentas, chequearReservasConBarrera,
} from '../routes/sync.js';
import {
  tomarCandados, liberarCandados, renovarCandados, resolverBolsa, evaluarBarrera, escribirStockMl, idBarrera,
  limpiarNota, entradasDeNota, evaluarEvidencia, confirmarDescuentoLinea, verificarManageStockWoo, intentarLiberarFila,
} from '../lib/stockBarrera.js';

vi.mock('../lib/mlClient.js', async () => {
  const actual = await vi.importActual('../lib/mlClient.js');
  return { ...actual, mlFetch: vi.fn(), estadoCooldownMl: () => ({ activo: false }) };
});
vi.mock('../routes/woo.js', () => ({ wooFetch: vi.fn() }));
import { mlFetch } from '../lib/mlClient.js';
import { wooFetch } from '../routes/woo.js';

const TEST_DB = `./test/tmp-stock-barrera.${process.pid}.sqlite`;
const CFG = {
  ml: { clientId: 'cid', clientSecret: 'cs', userId: '99999' },
  woo: { url: 'https://fusionbikes.com.ar', ck: 'ck_x', cs: 'cs_x' },
};
const NOMBRE = 'Bicicleta Simple';
const NOTA_ES = (nombre, d, h) => `Niveles de inventario reducidos: ${nombre} (${d}&amp;rarr;${h})`;

let db;
let woo; // estado del Woo simulado
let ml; // estado del ML simulado

function limpiarDb() {
  for (const suf of ['', '-wal', '-shm', '-journal']) fs.rmSync(TEST_DB + suf, { force: true });
}

function seed(dbx, { stockCache = 5, userProductId = null } = {}) {
  const t = new Date().toISOString();
  dbx.prepare("INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en) VALUES ('MLA100|', 'BIKE-001', ?, 'confirmar', ?)").run(NOMBRE, t);
  dbx.prepare("INSERT INTO ml_publicaciones_cache (clave, item_id, variation_id, status, seller_sku, available_quantity, user_product_id, actualizado_en) VALUES ('MLA100|', 'MLA100', '', 'active', 'BIKE-001', ?, ?, ?)").run(stockCache, userProductId, t);
  dbx.prepare('INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, precio, regular_price, actualizado_en) VALUES (100, ?, ?, ?, NULL, ?, 300, 300, ?)').run(NOMBRE, 'BIKE-001', 'simple', stockCache, t);
  dbx.prepare("INSERT INTO ml_stock_estado (clave, sku, cantidad_ml, actualizado_en) VALUES ('MLA100|', 'BIKE-001', ?, ?)").run(stockCache, t);
}

function ordenMl(id = 'ORD-1', qty = 1) {
  return { id, date_created: new Date().toISOString(), order_items: [{ item: { id: 'MLA100', variation_id: '' }, quantity: qty, unit_price: 150 }] };
}

function nuevoWoo() {
  return {
    stock: { 100: 5 }, manageStock: true, manageStockSetting: 'yes',
    descuenta: true, postError: null, busquedaError: null, ordenes: [], notas: {}, pedidos: {},
    posts: 0, nextId: 7001, nombreEnNota: NOMBRE, reducedMeta: 1,
  };
}

function instalarMocks() {
  woo = nuevoWoo();
  ml = { qty: 5, status: 'active', puts: [], bulkError: false, ordenes: [] };
  wooFetch.mockImplementation(async (cfg, p, method = 'get', body = null) => {
    if (p === '/orders' && method === 'post') {
      woo.posts++;
      if (woo.postError) throw woo.postError;
      const id = woo.nextId++;
      const qty = body.line_items[0].quantity;
      const li = { id: 11, name: NOMBRE, product_id: 100, variation_id: 0, quantity: qty, meta_data: woo.descuenta ? [{ key: '_reduced_stock', value: String(woo.reducedMeta ?? qty) }] : [] };
      woo.pedidos[id] = { id, line_items: [li], meta_data: body.meta_data };
      woo.ordenes.push(woo.pedidos[id]);
      woo.notas[id] = [];
      if (woo.descuenta) {
        const antes = woo.stock[100];
        woo.stock[100] = antes - qty;
        woo.notas[id].push({ note: NOTA_ES(woo.nombreEnNota, antes, antes - qty) });
      }
      return { status: 201, data: woo.pedidos[id], headers: {} };
    }
    if (p === '/settings/products/woocommerce_manage_stock') return { status: 200, data: { value: woo.manageStockSetting }, headers: {} };
    let m;
    if ((m = /^\/products\/(\d+)$/.exec(p))) return { status: 200, data: { manage_stock: woo.manageStock, stock_quantity: woo.stock[m[1]] }, headers: {} };
    if ((m = /^\/orders\/(\d+)\/notes\?type=internal/.exec(p))) return { status: 200, data: woo.notas[m[1]] ?? [], headers: {} };
    if ((m = /^\/orders\/(\d+)\/notes$/.exec(p))) return { status: 201, data: {}, headers: {} };
    if ((m = /^\/orders\/(\d+)$/.exec(p))) return { status: 200, data: woo.pedidos[m[1]], headers: {} };
    if (p.startsWith('/orders?')) {
      if (woo.busquedaError) throw woo.busquedaError;
      return { status: 200, data: woo.ordenes, headers: {} };
    }
    return { status: 200, data: {}, headers: {} };
  });
  mlFetch.mockImplementation(async (dbx, cfg, method, p, body) => {
    if (method === 'put') { ml.puts.push({ p, body }); ml.qty = body.available_quantity; return { status: 200, data: {} }; }
    if (p.startsWith('/orders/search')) return { status: 200, data: { results: ml.ordenes } };
    if (p.startsWith('/items/bulk')) {
      if (ml.bulkError) return { status: 500, data: null };
      return { status: 200, data: [{ code: 200, body: { id: 'MLA100', status: ml.status, available_quantity: ml.qty } }] };
    }
    return { status: 404, data: {} };
  });
}

beforeEach(() => {
  limpiarDb();
  db = openDb(TEST_DB);
  vi.clearAllMocks();
  process.env.STOCK_BARRERA_REINTENTOS_MS = '0';
  process.env.STOCK_LOCK_ESPERA_MS = '300';
  instalarMocks();
});
afterEach(() => {
  db.close();
  limpiarDb();
});

const filas = () => db.prepare('SELECT * FROM stock_refresco_pendiente').all();
const reserva = (id = 'ORD-1') => db.prepare('SELECT * FROM ordenes_ml_wc_pedidos WHERE ml_order_id = ?').get(id);
async function vender(orden = ordenMl()) {
  ml.ordenes = [orden];
  await syncMlToWc(db, CFG);
  await new Promise((r) => setTimeout(r, 30)); // el job de liberación corre en segundo plano
}

describe('evidencia: la nota de descuento de Woo', () => {
  it('lee la nota real de la tienda ("Niveles de inventario reducidos", flecha doble codificada)', () => {
    const t = limpiarNota(`<p>${NOTA_ES('Caramañola Camelbak Podium 24oz (710ml) - Negro', 3, 2)}</p>`);
    expect(entradasDeNota(t)).toEqual([{ nombre: 'Caramañola Camelbak Podium 24oz (710ml) - Negro', desde: 3, hasta: 2 }]);
  });
  it('acepta la nota en inglés y varias entradas en una nota', () => {
    const t = limpiarNota('Stock levels reduced: Casco, azul (10→9), Guantes (4→2)');
    expect(entradasDeNota(t).map((e) => e.nombre)).toEqual(['Casco, azul', 'Guantes']);
  });
  it('N líneas con el mismo nombre exigen N entradas', () => {
    const lineas = [{ idx: 0, name: 'Cubierta', product_id: 1, variation_id: 0, manage_stock: 'true' }, { idx: 1, name: 'Cubierta', product_id: 1, variation_id: 0, manage_stock: 'true' }];
    const una = evaluarEvidencia({ lineas, lineItemsOrden: [{ name: 'Cubierta', product_id: 1 }], notas: ['Niveles de inventario reducidos: Cubierta (9→8)'] });
    expect(una.completo).toBe(false);
    const dos = evaluarEvidencia({ lineas, lineItemsOrden: [{ name: 'Cubierta', product_id: 1 }], notas: ['Niveles de inventario reducidos: Cubierta (9→8), Cubierta (8→7)'] });
    expect(dos.completo).toBe(true);
  });
  it('nombres que no identifican una sola línea (dos productos distintos) quedan ambiguos', () => {
    const lineas = [{ idx: 0, name: 'Cubierta', product_id: 1, variation_id: 0, manage_stock: 'true' }];
    const r = evaluarEvidencia({ lineas, lineItemsOrden: [{ name: 'Cubierta', product_id: 1 }, { name: 'Cubierta', product_id: 2 }], notas: ['Niveles de inventario reducidos: Cubierta (9→8)'] });
    expect(r.completo).toBe(false);
    expect(r.ambiguas).toHaveLength(1);
  });
  it('"Unable to reduce stock" bloquea esa línea', () => {
    const lineas = [{ idx: 0, name: 'Cubierta', product_id: 1, variation_id: 0, manage_stock: 'true' }];
    const r = evaluarEvidencia({ lineas, lineItemsOrden: [{ name: 'Cubierta', product_id: 1 }], notas: ['Unable to reduce stock for Cubierta'] });
    expect(r.fallos).toHaveLength(1);
  });
  it('manage_stock=false solo cuenta si la relectura posterior sigue en false; si cambió exige la nota', () => {
    const lineas = [{ idx: 0, name: 'Servicio', product_id: 9, variation_id: 0, manage_stock: 'false' }];
    const ok = evaluarEvidencia({ lineas, lineItemsOrden: [{ name: 'Servicio', product_id: 9 }], manageStockActual: new Map([['9:0', 'false']]) });
    expect(ok.completo).toBe(true);
    const cambio = evaluarEvidencia({ lineas, lineItemsOrden: [{ name: 'Servicio', product_id: 9 }], manageStockActual: new Map([['9:0', 'true']]) });
    expect(cambio.completo).toBe(false);
  });
  it('una línea manage_stock=false no libera a otra gestionada del mismo SKU', () => {
    const lineas = [
      { idx: 0, name: 'Servicio', product_id: 9, variation_id: 0, manage_stock: 'false' },
      { idx: 1, name: 'Cubierta', product_id: 1, variation_id: 0, manage_stock: 'true' },
    ];
    const r = evaluarEvidencia({ lineas, lineItemsOrden: [{ name: 'Servicio', product_id: 9 }, { name: 'Cubierta', product_id: 1 }], manageStockActual: new Map([['9:0', 'false']]) });
    expect(r.completo).toBe(false);
    expect(r.lineas.map((l) => !!l.evidencia)).toEqual([true, false]);
  });
});

describe('candados por SKU y bolsa', () => {
  it('un candado vivo no se toma; uno vencido sin renovar sí; solo el dueño libera', () => {
    const a = tomarCandados(db, ['B', 'A']);
    expect(a.skus).toEqual(['A', 'B']);
    expect(tomarCandados(db, ['A'])).toBeNull();
    liberarCandados(db, 'otro-token');
    expect(tomarCandados(db, ['A'])).toBeNull();
    db.prepare("UPDATE stock_lock SET vence = '2000-01-01T00:00:00.000Z'").run();
    expect(tomarCandados(db, ['A'])).not.toBeNull();
    renovarCandados(db, a.token);
  });
  it('la bolsa incluye hermanas con el mismo user_product_id aunque tengan otro SKU', () => {
    seed(db, { userProductId: 'UP1' });
    const t = new Date().toISOString();
    db.prepare("INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en) VALUES ('MLA200|', 'OTRO-SKU', 'x', 'confirmar', ?)").run(t);
    db.prepare("INSERT INTO ml_publicaciones_cache (clave, item_id, variation_id, status, user_product_id, actualizado_en) VALUES ('MLA200|', 'MLA200', '', 'active', 'UP1', ?)").run(t);
    const b = resolverBolsa(db, { skus: ['BIKE-001'] });
    expect(b.skus).toEqual(['BIKE-001', 'OTRO-SKU']);
    expect(b.claves).toEqual(['MLA100|', 'MLA200|']);
  });
});

describe('escribirStockMl: la puerta única', () => {
  const t = () => new Date().toISOString();
  function barrera(sku, estado, orden = 'X-1') {
    db.prepare("INSERT INTO stock_refresco_pendiente (sku, ml_order_id, vendido_en, lineas_json, woo_confirmado, estado, creado_en, actualizado_en) VALUES (?, ?, ?, '[]', 1, ?, ?, ?)").run(sku, orden, t(), estado, t(), t());
  }
  it('sin barrera escribe', async () => {
    seed(db);
    const r = await escribirStockMl(db, CFG.ml, { clave: 'MLA100|', sku: 'BIKE-001', cantidad: 3 });
    expect(r.omitido).toBe(false);
    expect(ml.puts).toHaveLength(1);
  });
  it('con una fila bloqueante no escribe', async () => {
    seed(db); barrera('BIKE-001', 'bloqueante');
    const r = await escribirStockMl(db, CFG.ml, { clave: 'MLA100|', sku: 'BIKE-001', cantidad: 3 });
    expect(r).toMatchObject({ omitido: true, motivo: 'barrera_bloqueante' });
    expect(ml.puts).toHaveLength(0);
  });
  it('una hermana con otro SKU y el mismo user_product_id no se escribe durante la barrera', async () => {
    seed(db, { userProductId: 'UP1' });
    db.prepare("INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en) VALUES ('MLA200|', 'OTRO-SKU', 'x', 'confirmar', ?)").run(t());
    db.prepare("INSERT INTO ml_publicaciones_cache (clave, item_id, variation_id, status, user_product_id, actualizado_en) VALUES ('MLA200|', 'MLA200', '', 'active', 'UP1', ?)").run(t());
    barrera('BIKE-001', 'bloqueante');
    const r = await escribirStockMl(db, CFG.ml, { clave: 'MLA200|', sku: 'OTRO-SKU', cantidad: 1 });
    expect(r.omitido).toBe(true);
    expect(ml.puts).toHaveLength(0);
  });
  it('una fila liberable solo la deja pasar a la llamada dueña (con su barrera_id)', async () => {
    seed(db); barrera('BIKE-001', 'liberable', 'X-9');
    expect((await escribirStockMl(db, CFG.ml, { clave: 'MLA100|', sku: 'BIKE-001', cantidad: 3 })).omitido).toBe(true);
    expect((await escribirStockMl(db, CFG.ml, { clave: 'MLA100|', sku: 'BIKE-001', cantidad: 3, barreraId: 'otra|id' })).omitido).toBe(true);
    const r = await escribirStockMl(db, CFG.ml, { clave: 'MLA100|', sku: 'BIKE-001', cantidad: 3, barreraId: idBarrera('BIKE-001', 'X-9') });
    expect(r.omitido).toBe(false);
    expect(evaluarBarrera(db, ['BIKE-001'], idBarrera('BIKE-001', 'X-9')).permitido).toBe(true);
  });
  it('la dueña no corre si otro SKU de la bolsa sigue bloqueante', async () => {
    seed(db, { userProductId: 'UP1' });
    db.prepare("INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en) VALUES ('MLA200|', 'OTRO-SKU', 'x', 'confirmar', ?)").run(t());
    db.prepare("INSERT INTO ml_publicaciones_cache (clave, item_id, variation_id, status, user_product_id, actualizado_en) VALUES ('MLA200|', 'MLA200', '', 'active', 'UP1', ?)").run(t());
    barrera('BIKE-001', 'liberable', 'X-9'); barrera('OTRO-SKU', 'bloqueante', 'X-8');
    const r = await escribirStockMl(db, CFG.ml, { clave: 'MLA100|', sku: 'BIKE-001', cantidad: 3, barreraId: idBarrera('BIKE-001', 'X-9') });
    expect(r.omitido).toBe(true);
  });
  it('con woocommerce_manage_stock=no pausa las escrituras y abre un incidente', async () => {
    seed(db);
    woo.manageStockSetting = 'no';
    await verificarManageStockWoo(db, CFG.woo, { forzar: true });
    expect(db.prepare("SELECT COUNT(*) n FROM incidentes_operativos WHERE tipo_error = 'manage_stock_desactivado' AND estado = 'activo'").get().n).toBe(1);
    const r = await escribirStockMl(db, CFG.ml, { clave: 'MLA100|', sku: 'BIKE-001', cantidad: 3 });
    expect(r).toMatchObject({ omitido: true, motivo: 'manage_stock_no' });
    woo.manageStockSetting = 'yes';
    await verificarManageStockWoo(db, CFG.woo, { forzar: true });
    expect((await escribirStockMl(db, CFG.ml, { clave: 'MLA100|', sku: 'BIKE-001', cantidad: 3 })).omitido).toBe(false);
  });
  it('un candado ocupado por otro dueño impide escribir (no hay PUT)', async () => {
    seed(db);
    tomarCandados(db, ['BIKE-001']);
    const r = await escribirStockMl(db, CFG.ml, { clave: 'MLA100|', sku: 'BIKE-001', cantidad: 3 }); // espera acotada por STOCK_LOCK_ESPERA_MS
    expect(r.omitido).toBe(true);
  });
});

describe('venta ML: la barrera evita empujar el stock anterior al descuento', () => {
  it('no reenvía a ML el stock previo a la venta; empuja el de Woo cuando hay evidencia', async () => {
    seed(db);
    await vender();
    // Woo descontó (5→4) y dejó la nota; la corrección dueña empujó 4, jamás 5.
    expect(ml.puts.map((x) => x.body.available_quantity)).toEqual([4]);
    expect(filas()).toHaveLength(0);
    expect(db.prepare("SELECT stock FROM catalogo_cache WHERE id_woo = 100").get().stock).toBe(4);
    expect(db.prepare("SELECT cantidad_ml FROM ml_stock_estado WHERE clave = 'MLA100|'").get().cantidad_ml).toBe(4);
  });

  it('mientras Woo no descuente, ninguna escritura (ni el cron ni el puntual) empuja ese SKU', async () => {
    seed(db);
    woo.descuenta = false;
    await vender();
    expect(filas()).toHaveLength(1);
    expect(filas()[0]).toMatchObject({ estado: 'bloqueante', woo_confirmado: 1 });
    await syncSkuPuntual(db, CFG, 'BIKE-001');
    await syncWcToMl(db, CFG);
    expect(ml.puts).toHaveLength(0);
  });

  it('si el refresco de Woo falla, la fila queda bloqueante y no se escribe nada', async () => {
    seed(db);
    await vender();
    ml.puts = [];
    db.prepare('UPDATE catalogo_cache SET stock = 3').run(); // un valor del caché que el cron empujaría si no hubiera barrera
    // venta nueva con Woo caído al leer el stock del gestor: la evidencia está pero la lectura falla
    db.prepare("INSERT INTO ordenes_ml_wc_pedidos (ml_order_id, wc_order_id, creado_en) VALUES ('ORD-2', 7002, ?)").run(new Date().toISOString());
    const t = new Date().toISOString();
    db.prepare("INSERT INTO stock_refresco_pendiente (sku, ml_order_id, vendido_en, lineas_json, woo_confirmado, estado, wc_order_id, creado_en, actualizado_en) VALUES ('BIKE-001', 'ORD-2', ?, ?, 1, 'bloqueante', 7002, ?, ?)")
      .run(t, JSON.stringify([{ idx: 0, sku: 'BIKE-001', product_id: 100, variation_id: 0, cantidad: 1, manage_stock: 'true', stock_gestor_id: 100, stock_gestor_padre: null, line_item_id: 11, name: NOMBRE }]), t, t);
    woo.pedidos[7002] = { id: 7002, line_items: [{ id: 11, name: NOMBRE, product_id: 100, meta_data: [] }] };
    woo.notas[7002] = [{ note: NOTA_ES(NOMBRE, 4, 3) }];
    const base = wooFetch.getMockImplementation();
    wooFetch.mockImplementation(async (cfg, p, ...r) => {
      if (p === '/products/100') throw new Error('WooCommerce API error 503');
      return base(cfg, p, ...r);
    });
    const fila = filas()[0];
    const res = await intentarLiberarFila(db, CFG.woo, fila);
    expect(res.estado).toBe('reintentar');
    expect(filas()[0].estado).toBe('bloqueante');
    await syncWcToMl(db, CFG);
    expect(ml.puts).toHaveLength(0);
  });

  it('sin la nota a los 30 min queda bloqueado con un incidente que dice qué hacer', async () => {
    seed(db);
    woo.descuenta = false;
    await vender();
    db.prepare("UPDATE stock_refresco_pendiente SET creado_en = ?").run(new Date(Date.now() - 31 * 60 * 1000).toISOString());
    const res = await intentarLiberarFila(db, CFG.woo, filas()[0]);
    expect(res).toMatchObject({ estado: 'bloqueada', motivo: 'sin_nota_30min' });
    const inc = db.prepare("SELECT * FROM incidentes_operativos WHERE proceso = 'barrera_stock' AND estado = 'activo'").get();
    expect(inc.mensaje_humano).toMatch(/Reducir niveles de stock/);
    expect(ml.puts).toHaveLength(0);
  });

  it('el nombre del pedido no coincide con la nota → no libera', async () => {
    seed(db);
    woo.nombreEnNota = 'Otro producto distinto';
    await vender();
    expect(filas()[0].estado).toBe('bloqueante');
    expect(ml.puts).toHaveLength(0);
  });

  it('renombrar el producto después de la venta no impide liberar (se usa el nombre guardado al confirmar)', async () => {
    seed(db);
    woo.descuenta = false;
    await vender();
    woo.pedidos[7001].line_items[0].name = NOMBRE; // el nombre de la línea queda fijo en el pedido
    db.prepare("UPDATE catalogo_cache SET nombre = 'Renombrado'").run();
    woo.notas[7001].push({ note: NOTA_ES(NOMBRE, 5, 4) });
    woo.stock[100] = 4;
    await procesarBarreraVentas(db, CFG);
    expect(filas()).toHaveLength(0);
    expect(ml.puts.map((x) => x.body.available_quantity)).toEqual([4]);
  });

  it('liberar a mano: con _reduced_stock igual a la cantidad y sin nota, "Confirmar descuento" libera; parcial no', async () => {
    seed(db);
    woo.descuenta = false;
    await vender();
    woo.stock[100] = 4;
    // sin _reduced_stock no se puede confirmar
    expect(await confirmarDescuentoLinea(db, CFG.woo, { sku: 'BIKE-001', mlOrderId: 'ORD-1', idx: 0, motivo: 'x', actor: 'admin' })).toMatchObject({ ok: false, code: 409 });
    // _reduced_stock parcial (distinto de la cantidad vendida) tampoco
    woo.pedidos[7001].line_items[0].meta_data = [{ key: '_reduced_stock', value: '2' }];
    expect((await confirmarDescuentoLinea(db, CFG.woo, { sku: 'BIKE-001', mlOrderId: 'ORD-1', idx: 0, motivo: 'x', actor: 'admin' })).ok).toBe(false);
    woo.pedidos[7001].line_items[0].meta_data = [{ key: '_reduced_stock', value: '1' }];
    expect((await confirmarDescuentoLinea(db, CFG.woo, { sku: 'BIKE-001', mlOrderId: 'ORD-1', idx: 0, motivo: '', actor: 'admin' })).ok).toBe(false); // motivo obligatorio
    expect((await confirmarDescuentoLinea(db, CFG.woo, { sku: 'BIKE-001', mlOrderId: 'ORD-1', idx: 0, motivo: 'nota con otro texto', actor: 'admin' })).ok).toBe(true);
    expect(filas()[0].estado).toBe('bloqueante'); // no se libera sola
    await procesarBarreraVentas(db, CFG);
    expect(filas()).toHaveLength(0);
    expect(ml.puts.map((x) => x.body.available_quantity)).toEqual([4]);
  });

  it('una escritura de ML con la corrección: relee ML y empuja aunque el caché ya coincida con lo deseado', async () => {
    seed(db);
    woo.descuenta = false;
    await vender();
    woo.notas[7001].push({ note: NOTA_ES(NOMBRE, 5, 4) });
    woo.stock[100] = 4;
    ml.qty = 5; // ML sigue publicando 5
    db.prepare("UPDATE ml_stock_estado SET cantidad_ml = 4").run(); // el caché dice 4 (= deseado)
    await procesarBarreraVentas(db, CFG);
    expect(ml.puts.map((x) => x.body.available_quantity)).toEqual([4]);
    expect(filas()).toHaveLength(0);
  });

  it('si la relectura de ML falla, no se cierra la barrera (reintenta)', async () => {
    seed(db);
    woo.descuenta = false;
    await vender();
    woo.notas[7001].push({ note: NOTA_ES(NOMBRE, 5, 4) });
    woo.stock[100] = 4;
    ml.bulkError = true;
    await procesarBarreraVentas(db, CFG);
    expect(filas()).toHaveLength(1);
    expect(filas()[0].estado).toBe('liberable');
    ml.bulkError = false;
    await procesarBarreraVentas(db, CFG);
    expect(filas()).toHaveLength(0);
  });
});

describe('POST incierto: nunca un segundo POST', () => {
  it('un 408 conserva la reserva y las filas; el siguiente ciclo no vuelve a postear', async () => {
    seed(db);
    woo.postError = Object.assign(new Error('WooCommerce API error 408'), { status: 408 });
    woo.busquedaError = new Error('Woo caído');
    await vender();
    expect(woo.posts).toBe(1);
    expect(reserva()).toMatchObject({ wc_order_id: 0 });
    expect(reserva().retenido_en).toBeTruthy();
    expect(filas()).toHaveLength(1);
    expect(filas()[0]).toMatchObject({ woo_confirmado: 0, estado: 'bloqueante' });
    await vender();
    expect(woo.posts).toBe(1);
    await syncWcToMl(db, CFG);
    expect(ml.puts).toHaveLength(0);
  });

  it('un 422 con cuerpo de validación de Woo es rechazo seguro: borra reserva y filas', async () => {
    seed(db);
    woo.postError = Object.assign(new Error('WooCommerce API error 422'), { status: 422, cuerpo: '{"code":"woocommerce_rest_invalid","message":"x"}' });
    await vender();
    expect(reserva()).toBeUndefined();
    expect(filas()).toHaveLength(0);
  });

  it('un 400 con cuerpo HTML (WAF) NO es certeza: conserva todo', async () => {
    seed(db);
    woo.postError = Object.assign(new Error('WooCommerce API error 400'), { status: 400, cuerpo: '<html>blocked</html>' });
    woo.busquedaError = new Error('Woo caído');
    await vender();
    expect(reserva()).toBeTruthy();
    expect(filas()).toHaveLength(1);
  });

  it('la limpieza de 60 min no borra una reserva con filas de barrera', async () => {
    seed(db);
    woo.postError = new Error('timeout of 20000ms exceeded');
    woo.busquedaError = new Error('Woo caído');
    await vender();
    db.prepare("UPDATE ordenes_ml_wc_pedidos SET creado_en = ?, retenido_en = NULL").run(new Date(Date.now() - 90 * 60 * 1000).toISOString());
    await vender();
    expect(reserva()).toBeTruthy();
    expect(woo.posts).toBe(1);
  });

  it('chequeo periódico: encuentra el pedido → completa reserva y barrera; luego se libera con la nota', async () => {
    seed(db);
    woo.postError = new Error('timeout of 20000ms exceeded');
    woo.busquedaError = new Error('Woo caído');
    await vender();
    // el POST sí había llegado a Woo y descontó
    const id = 7500;
    woo.pedidos[id] = { id, line_items: [{ id: 11, name: NOMBRE, product_id: 100, variation_id: 0, quantity: 1, meta_data: [{ key: '_reduced_stock', value: '1' }] }], meta_data: [{ key: '_ml_order_id', value: 'ORD-1' }] };
    woo.ordenes = [woo.pedidos[id]];
    woo.notas[id] = [{ note: NOTA_ES(NOMBRE, 5, 4) }];
    woo.stock[100] = 4;
    woo.busquedaError = null;
    db.prepare("UPDATE ordenes_ml_wc_pedidos SET creado_en = ?").run(new Date(Date.now() - 20 * 60 * 1000).toISOString());
    expect(await chequearReservasConBarrera(db, CFG.woo)).toMatchObject({ encontradas: 1 });
    expect(reserva()).toMatchObject({ wc_order_id: id, retenido_en: null });
    expect(filas()[0]).toMatchObject({ woo_confirmado: 1, wc_order_id: id });
    await procesarBarreraVentas(db, CFG);
    expect(filas()).toHaveLength(0);
    expect(ml.puts.map((x) => x.body.available_quantity)).toEqual([4]);
    expect(woo.posts).toBe(1);
  });

  it('chequeo periódico: inexistencia confirmada → borra reserva y barrera; Woo sin responder → no toca nada', async () => {
    seed(db);
    woo.postError = new Error('timeout of 20000ms exceeded');
    woo.busquedaError = new Error('Woo caído');
    await vender();
    db.prepare("UPDATE ordenes_ml_wc_pedidos SET creado_en = ?").run(new Date(Date.now() - 20 * 60 * 1000).toISOString());
    expect(await chequearReservasConBarrera(db, CFG.woo)).toMatchObject({ pendientes: 1 });
    expect(reserva()).toBeTruthy();
    woo.busquedaError = null; woo.ordenes = [];
    expect(await chequearReservasConBarrera(db, CFG.woo)).toMatchObject({ borradas: 1 });
    expect(reserva()).toBeUndefined();
    expect(filas()).toHaveLength(0);
  });

  it('la confirmación de inexistencia pagina hasta agotar el rango y, con 20 páginas sin agotarlo, no confirma', async () => {
    seed(db);
    woo.postError = new Error('timeout of 20000ms exceeded');
    woo.busquedaError = new Error('Woo caído');
    await vender();
    db.prepare("UPDATE ordenes_ml_wc_pedidos SET creado_en = ?").run(new Date(Date.now() - 20 * 60 * 1000).toISOString());
    woo.busquedaError = null;
    const reciente = (i) => ({ id: 9000 + i, date_created_gmt: new Date().toISOString().replace('Z', ''), meta_data: [] });
    const base = wooFetch.getMockImplementation();
    let consultadas = [];
    wooFetch.mockImplementation(async (cfg, p, ...r) => {
      if (p.startsWith('/orders?per_page=100&status=any&orderby=date')) { consultadas.push(p); return { status: 200, data: Array.from({ length: 100 }, (_, i) => reciente(i)) }; }
      if (p.startsWith('/orders?')) return { status: 200, data: [] };
      return base(cfg, p, ...r);
    });
    expect(await chequearReservasConBarrera(db, CFG.woo)).toMatchObject({ pendientes: 1 });
    expect(consultadas.length).toBeGreaterThanOrEqual(20);
    expect(consultadas.length % 20).toBe(0); // cada intento recorre exactamente 20 páginas y se rinde: no confirma
    expect(reserva()).toBeTruthy();
  });
});

describe('puerta única: ningún otro código escribe available_quantity a ML', () => {
  const raiz = path.resolve(import.meta.dirname, '..');
  const archivos = ['routes', 'lib'].flatMap((d) => fs.readdirSync(path.join(raiz, d)).filter((f) => f.endsWith('.js')).map((f) => path.join(d, f)));
  it('buildMlStockUpdate solo se usa dentro de lib/stockBarrera.js (y su re-export)', () => {
    const usos = archivos.filter((f) => /buildMlStockUpdate\s*\(/.test(fs.readFileSync(path.join(raiz, f), 'utf8')) && f !== path.join('lib', 'stockBarrera.js'));
    expect(usos).toEqual([]);
  });
  it('ningún mlFetch PUT lleva available_quantity fuera de lib/stockBarrera.js', () => {
    const malos = [];
    for (const f of archivos) {
      if (f === path.join('lib', 'stockBarrera.js')) continue;
      const src = fs.readFileSync(path.join(raiz, f), 'utf8');
      for (const m of src.matchAll(/mlFetch\([^;]*?'put'[^;]*?;/gs)) if (/available_quantity/.test(m[0])) malos.push(f);
    }
    expect(malos).toEqual([]);
  });
  it('el adaptador de Identidad (setStock) pasa por la puerta', () => {
    const src = fs.readFileSync(path.join(raiz, 'lib/identidadMl.js'), 'utf8');
    expect(src).toMatch(/escribirStockMl\(/);
    expect(src).not.toMatch(/escribir\(r\.stock/);
  });
});
