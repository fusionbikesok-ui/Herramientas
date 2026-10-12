// Fase E-1a: "las ventas ML no se pierden". Trabajo durable order.ml y stock.bolsa (único escritor de stock por eventos).
// Mismo patrón que stock-barrera.test.js: Woo y ML simulados; importa QUÉ se escribe y cuántas veces.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import { syncMlToWc, syncOrdenMlPuntual, procesarOrdenMl, procesarStockBolsa, procesarTrabajosRecurso, encolarBolsasDeSkus } from '../routes/sync.js';
import { encolarTrabajo, reclamarTrabajos, guardarContextoTrabajo } from '../lib/trabajosRecurso.js';
import { escribirStockMl } from '../lib/stockBarrera.js';

vi.mock('../lib/mlClient.js', async () => {
  const actual = await vi.importActual('../lib/mlClient.js');
  return { ...actual, mlFetch: vi.fn(), estadoCooldownMl: () => ({ activo: false }) };
});
vi.mock('../routes/woo.js', () => ({ wooFetch: vi.fn() }));
const preparacion = vi.hoisted(() => ({ syncPedidoMlPuntual: vi.fn(async () => undefined) }));
vi.mock('../routes/preparacion.js', async () => ({ ...(await vi.importActual('../routes/preparacion.js')), syncPedidoMlPuntual: preparacion.syncPedidoMlPuntual }));
import { mlFetch } from '../lib/mlClient.js';
import { wooFetch } from '../routes/woo.js';

const TEST_DB = `./test/tmp-orden-ml-trabajo.${process.pid}.sqlite`;
const CFG = {
  ml: { clientId: 'cid', clientSecret: 'cs', userId: '99999' },
  woo: { url: 'https://fusionbikes.com.ar', ck: 'ck_x', cs: 'cs_x' },
};
const NOMBRE = 'Bicicleta Simple';
const NOTA_ES = (nombre, d, h) => `Niveles de inventario reducidos: ${nombre} (${d}&amp;rarr;${h})`;

let db, woo, ml;
const limpiarDb = () => { for (const suf of ['', '-wal', '-shm', '-journal']) fs.rmSync(TEST_DB + suf, { force: true }); };

function seed(dbx, { stockCache = 5, userProductId = null } = {}) {
  const t = new Date().toISOString();
  dbx.prepare("INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en) VALUES ('MLA100|', 'BIKE-001', ?, 'confirmar', ?)").run(NOMBRE, t);
  dbx.prepare("INSERT INTO ml_publicaciones_cache (clave, item_id, variation_id, status, seller_sku, available_quantity, user_product_id, actualizado_en) VALUES ('MLA100|', 'MLA100', '', 'active', 'BIKE-001', ?, ?, ?)").run(stockCache, userProductId, t);
  dbx.prepare('INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, precio, regular_price, actualizado_en) VALUES (100, ?, ?, ?, NULL, ?, 300, 300, ?)').run(NOMBRE, 'BIKE-001', 'simple', stockCache, t);
  dbx.prepare("INSERT INTO ml_stock_estado (clave, sku, cantidad_ml, actualizado_en) VALUES ('MLA100|', 'BIKE-001', ?, ?)").run(stockCache, t);
}

const ordenMl = (id = 'ORD-1', status = 'paid') => ({ id, status, date_created: new Date().toISOString(), order_items: [{ item: { id: 'MLA100', variation_id: '' }, quantity: 1, unit_price: 150 }] });

function instalarMocks() {
  woo = { stock: { 100: 5 }, manage: {}, productPuts: [], putError: null, posts: 0, puts: [], nextId: 7001, pedidos: {}, notas: {}, postError: null, busquedaError: null, ordenes: [] };
  ml = { qty: 5, puts: [], orden: ordenMl(), ordenHttp: 200, usuario: { tags: [] }, usuarioHttp: 200, gets: [] };
  wooFetch.mockImplementation(async (cfg, p, method = 'get', body = null) => {
    if (p === '/orders' && method === 'post') {
      woo.posts++;
      if (woo.postError) throw woo.postError;
      const id = woo.nextId++;
      const antes = woo.stock[100];
      woo.stock[100] = antes - 1;
      const li = { id: 11, name: NOMBRE, sku: 'BIKE-001', product_id: 100, variation_id: 0, quantity: 1, meta_data: [{ key: '_reduced_stock', value: '1' }] };
      woo.pedidos[id] = { id, status: 'processing', line_items: [li], meta_data: body.meta_data };
      woo.ordenes.push(woo.pedidos[id]);
      woo.notas[id] = [{ note: NOTA_ES(NOMBRE, antes, antes - 1) }];
      return { status: 201, data: woo.pedidos[id], headers: {} };
    }
    let m;
    if ((m = /^\/orders\/(\d+)$/.exec(p)) && method === 'put') { woo.puts.push({ id: m[1], body }); woo.pedidos[m[1]].status = body.status; return { status: 200, data: woo.pedidos[m[1]], headers: {} }; }
    if (p === '/settings/products/woocommerce_manage_stock') return { status: 200, data: { value: 'yes' }, headers: {} };
    if ((m = /^\/products\/(\d+)$/.exec(p)) && method === 'put') {
      woo.productPuts.push({ id: m[1], body });
      if (woo.putError) throw woo.putError;
      woo.stock[m[1]] = body.stock_quantity;
      return { status: 200, data: {}, headers: {} };
    }
    if ((m = /^\/products\/(\d+)$/.exec(p))) return { status: 200, data: { manage_stock: woo.manage[m[1]] ?? true, stock_quantity: woo.manage[m[1]] === false ? null : woo.stock[m[1]] }, headers: {} };
    if ((m = /^\/products\/\d+\/variations\/(\d+)$/.exec(p))) return { status: 200, data: { manage_stock: woo.manage[m[1]] ?? true, stock_quantity: woo.stock[m[1]] }, headers: {} };
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
    ml.gets.push(p);
    if (method === 'put') { ml.puts.push({ p, body }); ml.qty = body.available_quantity; return { status: 200, data: {} }; }
    if (p.startsWith('/orders/search')) return { status: 200, data: { results: [ml.orden] } };
    if (/^\/orders\/[^/?]+$/.test(p)) return ml.ordenHttp === 200 ? { status: 200, data: ml.orden } : { status: ml.ordenHttp, data: null };
    if (p.startsWith('/users/')) return ml.usuarioHttp === 200 ? { status: 200, data: ml.usuario } : { status: ml.usuarioHttp, data: null };
    if (p.startsWith('/items/bulk')) return { status: 200, data: [{ code: 200, body: { id: 'MLA100', status: 'active', available_quantity: ml.qty } }] };
    return { status: 404, data: {} };
  });
}

beforeEach(() => {
  limpiarDb();
  db = openDb(TEST_DB);
  vi.clearAllMocks();
  preparacion.syncPedidoMlPuntual.mockReset();
  preparacion.syncPedidoMlPuntual.mockResolvedValue(undefined);
  process.env.STOCK_BARRERA_REINTENTOS_MS = '0';
  process.env.STOCK_LOCK_ESPERA_MS = '300';
  instalarMocks();
  seed(db);
});
afterEach(() => { db.close(); limpiarDb(); });

const trabajo = (tipo, recurso) => db.prepare('SELECT * FROM trabajos_recurso WHERE tipo = ? AND recurso = ?').get(tipo, recurso);
const reserva = (id) => db.prepare('SELECT * FROM ordenes_ml_wc_pedidos WHERE ml_order_id = ?').get(id);

describe('order.ml: orden pagada', () => {
  it('crea el pedido Woo UNA vez, avisa a Preparación y encola la bolsa; reprocesar no hace un segundo POST', async () => {
    const r1 = await procesarOrdenMl(db, CFG, 'ORD-1');
    expect(r1.estado).toBe('hecho');
    expect(woo.posts).toBe(1);
    expect(preparacion.syncPedidoMlPuntual).toHaveBeenCalledTimes(1);
    expect(trabajo('stock.bolsa', 'sku:BIKE-001')).toMatchObject({ estado: 'pendiente' });

    const r2 = await procesarOrdenMl(db, CFG, 'ORD-1'); // mismo aviso otra vez (orders + orders_v2)
    expect(r2.estado).toBe('hecho');
    expect(woo.posts).toBe(1);
  });

  it('con POST incierto la reserva queda en 0, se reencola y NUNCA se hace un segundo POST', async () => {
    woo.postError = new Error('socket hang up');
    woo.busquedaError = new Error('woo caído');
    const r1 = await procesarOrdenMl(db, CFG, 'ORD-1');
    expect(r1).toMatchObject({ estado: 'reencolar', motivo: 'pedido_woo_sin_confirmar' });
    expect(woo.posts).toBe(1);
    expect(reserva('ORD-1')?.wc_order_id).toBe(0);
    woo.postError = null;
    woo.busquedaError = null;
    await procesarOrdenMl(db, CFG, 'ORD-1');
    expect(woo.posts).toBe(1); // la reserva incierta bloquea el POST hasta resolverse
    expect(preparacion.syncPedidoMlPuntual).toHaveBeenCalled(); // Preparación es un efecto independiente: no espera a Woo
  });

  it('si ML no devuelve la orden se reencola sin tocar Woo', async () => {
    ml.ordenHttp = 500;
    const r = await procesarOrdenMl(db, CFG, 'ORD-1');
    expect(r).toMatchObject({ estado: 'reencolar', motivo: 'ml_orders_http_500' });
    expect(woo.posts).toBe(0);
  });
});

describe('order.ml: corte por fecha (aviso tardío de una orden vieja)', () => {
  const haceMs = (ms) => new Date(Date.now() - ms).toISOString();
  const DIA = 24 * 3600 * 1000;
  const conFecha = (ms, status = 'paid') => ({ ...ordenMl('ORD-1', status), date_created: haceMs(ms) });
  const incidenteVieja = () => db.prepare("SELECT severidad, mensaje_humano, contexto_json FROM incidentes_operativos WHERE tipo_error = 'orden_ml_vieja_sin_pedido_ORD-1'").get();
  afterEach(() => { delete process.env.ML_ORDEN_VENTANA_DIAS; });

  it('una orden de hace 4 días sin sellar: sin POST ni reserva, descuenta lo vendido, incidente por orden, trabajo hecho y Preparación sigue', async () => {
    ml.orden = conFecha(4 * DIA);
    encolarTrabajo(db, { tipo: 'order.ml', recurso: 'ORD-1' });
    await procesarTrabajosRecurso(db, CFG);
    expect(woo.posts).toBe(0);
    expect(reserva('ORD-1')).toBeUndefined();
    expect(trabajo('order.ml', 'ORD-1')).toMatchObject({ estado: 'hecho' });
    expect(preparacion.syncPedidoMlPuntual).toHaveBeenCalledTimes(1);
    expect(woo.productPuts).toEqual([{ id: '100', body: { stock_quantity: 4 } }]);
    const inc = incidenteVieja();
    expect(inc.severidad).toBe('critico');
    expect(JSON.parse(inc.contexto_json)).toMatchObject({ ml_order_id: 'ORD-1', estado: 'paid', descontado: true, lineas: [{ sku: 'BIKE-001', cantidad: 1, antes: 5, despues: 4, estado: 'descontada' }] });
  });

  it('una orden de hace 2 días se crea', async () => {
    ml.orden = conFecha(2 * DIA);
    expect((await procesarOrdenMl(db, CFG, 'ORD-1')).estado).toBe('hecho');
    expect(woo.posts).toBe(1);
    expect(incidenteVieja()).toBeUndefined();
  });

  it('borde de 3 días: un minuto antes crea, un minuto después no', async () => {
    ml.orden = conFecha(3 * DIA - 60_000);
    await procesarOrdenMl(db, CFG, 'ORD-1');
    expect(woo.posts).toBe(1);
    db.prepare('DELETE FROM ordenes_ml_wc_pedidos').run();
    db.prepare('DELETE FROM ordenes_ml_procesadas').run();
    db.prepare('DELETE FROM ordenes_ml_destino').run();
    ml.orden = conFecha(3 * DIA + 60_000);
    await procesarOrdenMl(db, CFG, 'ORD-1');
    expect(woo.posts).toBe(1); // no hubo un segundo POST
    expect(incidenteVieja()).toBeDefined();
  });

  it('la ventana es configurable (ML_ORDEN_VENTANA_DIAS)', async () => {
    process.env.ML_ORDEN_VENTANA_DIAS = '1';
    ml.orden = conFecha(2 * DIA);
    await procesarOrdenMl(db, CFG, 'ORD-1');
    expect(woo.posts).toBe(0);
    db.prepare('DELETE FROM ordenes_ml_destino').run();
    db.prepare('DELETE FROM ordenes_ml_descuento_sin_pedido').run(); // con la fila presente nunca se crea el pedido (anti doble descuento)
    process.env.ML_ORDEN_VENTANA_DIAS = '10';
    await procesarOrdenMl(db, CFG, 'ORD-1');
    expect(woo.posts).toBe(1);
  });

  it('una orden vieja ya sellada que llega cancelada se cancela como hoy', async () => {
    await procesarOrdenMl(db, CFG, 'ORD-1'); // fresca: crea el pedido 7001 y la sella
    ml.orden = conFecha(10 * DIA, 'cancelled');
    const r = await procesarOrdenMl(db, CFG, 'ORD-1');
    expect(r.estado).toBe('hecho');
    expect(woo.puts).toEqual([{ id: '7001', body: { status: 'cancelled' } }]);
    expect(incidenteVieja()).toBeUndefined();
  });

  it('una orden vieja ya sellada que llega pagada otra vez no abre incidente ni duplica', async () => {
    await procesarOrdenMl(db, CFG, 'ORD-1');
    ml.orden = conFecha(10 * DIA);
    await procesarOrdenMl(db, CFG, 'ORD-1');
    expect(woo.posts).toBe(1);
    expect(incidenteVieja()).toBeUndefined();
  });
});

describe('orden ML vieja sin pedido: descuento de lo vendido + aviso', () => {
  const DIA = 24 * 3600 * 1000;
  const vieja = (over = {}, status = 'paid') => ({ ...ordenMl('ORD-1', status), date_created: new Date(Date.now() - 20 * DIA).toISOString(), ...over });
  const fila = () => db.prepare("SELECT * FROM ordenes_ml_descuento_sin_pedido WHERE ml_order_id = 'ORD-1'").get();
  const inc = () => db.prepare("SELECT * FROM incidentes_operativos WHERE tipo_error = 'orden_ml_vieja_sin_pedido_ORD-1'").get();
  const outbox = () => db.prepare('SELECT o.* FROM incidentes_email_outbox o JOIN incidentes_operativos i ON i.id = o.incidente_id WHERE i.tipo_error = ?').all('orden_ml_vieja_sin_pedido_ORD-1');
  const conCantidad = (q) => vieja({ order_items: [{ item: { id: 'MLA100', variation_id: '', title: 'Bici Simple ML' }, quantity: q, unit_price: 150 }] });
  const seedVariacion = () => {
    const t = new Date().toISOString();
    db.prepare("INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en) VALUES ('MLA200|', 'VAR-1', 'Variación', 'confirmar', ?)").run(t);
    db.prepare("INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, precio, regular_price, actualizado_en) VALUES (101, 'Variación', 'VAR-1', 'variation', 100, 5, 300, 300, ?)").run(t);
  };
  const ordenVar = () => vieja({ order_items: [{ item: { id: 'MLA200', variation_id: '', title: 'Var ML' }, quantity: 1, unit_price: 150 }] });

  it('cantidad 2: descuenta 2 sobre el stock releído de Woo, sin POST, y encola stock.bolsa', async () => {
    ml.orden = conCantidad(2);
    const r = await procesarOrdenMl(db, CFG, 'ORD-1');
    expect(r).toMatchObject({ estado: 'hecho', motivo: 'orden_vieja_sin_pedido' });
    expect(woo.posts).toBe(0);
    expect(woo.productPuts).toEqual([{ id: '100', body: { stock_quantity: 3 } }]);
    expect(woo.stock[100]).toBe(3);
    expect(fila()).toMatchObject({ estado: 'completo', origen: 'job' });
    expect(trabajo('stock.bolsa', 'sku:BIKE-001')).toMatchObject({ estado: 'pendiente' });
    expect(reserva('ORD-1')).toBeUndefined();
  });

  it('idempotente: dos avisos de la misma orden descuentan UNA vez y el aviso no se repite', async () => {
    ml.orden = conCantidad(2);
    await procesarOrdenMl(db, CFG, 'ORD-1');
    const aviso = inc();
    await procesarOrdenMl(db, CFG, 'ORD-1'); // orders + orders_v2
    expect(woo.productPuts).toHaveLength(1);
    expect(woo.stock[100]).toBe(3);
    expect(outbox()).toHaveLength(1);
    expect(inc().ocurrencias ?? 1).toBe(aviso.ocurrencias ?? 1);
  });

  it('manage_stock=false: no toca nada, pero la orden queda tratada y se avisa que no se descontó', async () => {
    woo.manage[100] = false;
    ml.orden = conCantidad(1);
    await procesarOrdenMl(db, CFG, 'ORD-1');
    expect(woo.productPuts).toHaveLength(0);
    expect(fila().estado).toBe('completo');
    expect(inc().mensaje_humano).toMatch(/manage_stock=false/);
  });

  it('gestor padre (manage_stock=parent): descuenta en el producto padre, no en la variación', async () => {
    seedVariacion();
    woo.manage[101] = 'parent';
    ml.orden = ordenVar();
    await procesarOrdenMl(db, CFG, 'ORD-1');
    expect(woo.productPuts).toEqual([{ id: '100', body: { stock_quantity: 4 } }]);
  });

  it('Woo 5xx: reintenta con backoff, NO registra como hecho y el reintento descuenta una vez', async () => {
    woo.putError = Object.assign(new Error('Woo 503'), { status: 503 });
    ml.orden = conCantidad(1);
    encolarTrabajo(db, { tipo: 'order.ml', recurso: 'ORD-1' });
    await procesarTrabajosRecurso(db, CFG);
    // un 5xx pudo haberse aplicado: la línea queda incierta (nunca vuelve a pendiente) y el registro NO es completo
    expect(fila().estado).toBe('parcial');
    expect(JSON.parse(fila().lineas_json)[0].estado).toBe('incierta');
    expect(inc()).toBeUndefined(); // el aviso de la venta solo sale al completar
    expect(trabajo('order.ml', 'ORD-1')).toMatchObject({ estado: 'pendiente' });
    expect(trabajo('order.ml', 'ORD-1').intentos).toBeGreaterThan(0);
    woo.putError = null;
    db.prepare("UPDATE trabajos_recurso SET run_after = '2000-01-01T00:00:00.000Z' WHERE tipo = 'order.ml'").run();
    await procesarTrabajosRecurso(db, CFG);
    expect(woo.stock[100]).toBe(4);
    expect(fila().estado).toBe('completo');
  });

  it('varias líneas y fallo en la segunda: la primera no se vuelve a descontar al reintentar', async () => {
    seedVariacion();
    ml.orden = vieja({ order_items: [
      { item: { id: 'MLA100', variation_id: '', title: 'A' }, quantity: 1 },
      { item: { id: 'MLA200', variation_id: '', title: 'B' }, quantity: 1 },
    ] });
    woo.putError = null;
    woo.manage[101] = true;
    woo.stock[101] = 7;
    let n = 0;
    const base = wooFetch.getMockImplementation();
    wooFetch.mockImplementation(async (c, p, m, b) => {
      if (m === 'put' && p === '/products/100/variations/101' && n++ === 0) throw Object.assign(new Error('Woo 502'), { status: 502 });
      if (m === 'put' && p.startsWith('/products/100/variations/')) { woo.stock[101] = b.stock_quantity; return { status: 200, data: {}, headers: {} }; }
      return base(c, p, m, b);
    });
    const r1 = await procesarOrdenMl(db, CFG, 'ORD-1');
    expect(r1.estado).toBe('reencolar');
    expect(fila().estado).toBe('parcial');
    await procesarOrdenMl(db, CFG, 'ORD-1');
    expect(woo.stock[100]).toBe(4); // una sola vez
    expect(woo.stock[101]).toBe(6);
    expect(fila().estado).toBe('completo');
  });

  it('stock negativo: se escribe igual y el aviso lo marca', async () => {
    woo.stock[100] = 1;
    ml.orden = conCantidad(3);
    await procesarOrdenMl(db, CFG, 'ORD-1');
    expect(woo.stock[100]).toBe(-2);
    expect(inc().mensaje_humano).toMatch(/NEGATIVO/);
  });

  it('línea sin SKU resoluble: no se descuenta y va en el aviso', async () => {
    ml.orden = vieja({ order_items: [{ item: { id: 'MLA999', variation_id: '', title: 'Cosa rara' }, quantity: 1 }, { item: { id: 'MLA100', variation_id: '', title: 'Bici' }, quantity: 1 }] });
    await procesarOrdenMl(db, CFG, 'ORD-1');
    expect(woo.stock[100]).toBe(4);
    expect(inc().mensaje_humano).toMatch(/SIN SKU.*Cosa rara/);
  });

  it('orden cancelada: no descuenta (solo aviso) — vía la función directa', async () => {
    const { descontarOrdenViejaSinPedido } = await import('../routes/sync.js');
    const r = await descontarOrdenViejaSinPedido(db, CFG, vieja({}, 'cancelled'));
    expect(r.estado).toBe('no_aplica');
    expect(woo.productPuts).toHaveLength(0);
    expect(fila()).toMatchObject({ estado: 'completo' });
    expect(inc().mensaje_humano).toMatch(/cancelled.*NO se descontó/);
    const otra = await descontarOrdenViejaSinPedido(db, CFG, vieja({}, 'cancelled')); // otro orders_v2: sin reaviso
    expect(otra.estado).toBe('ya_descontada');
    expect(outbox()).toHaveLength(1);
  });

  it('no_pagada no cancelada (p. ej. payment_required) no graba fila ni avisa', async () => {
    const { descontarOrdenViejaSinPedido } = await import('../routes/sync.js');
    const r = await descontarOrdenViejaSinPedido(db, CFG, vieja({}, 'payment_required'));
    expect(r.estado).toBe('no_aplica');
    expect(fila()).toBeUndefined();
    expect(inc()).toBeUndefined();
  });

  it('DOBLE DESCUENTO: tras descontar, el polling legacy (syncMlToWc) no crea el pedido Woo', async () => {
    ml.orden = conCantidad(1);
    await procesarOrdenMl(db, CFG, 'ORD-1');
    expect(woo.stock[100]).toBe(4);
    await syncMlToWc(db, CFG);
    expect(woo.posts).toBe(0);
    expect(reserva('ORD-1')).toBeUndefined();
    expect(woo.stock[100]).toBe(4);
  });

  it('DOBLE DESCUENTO: tras descontar, el sync puntual tampoco crea el pedido Woo', async () => {
    ml.orden = conCantidad(1);
    await procesarOrdenMl(db, CFG, 'ORD-1');
    await syncOrdenMlPuntual(db, CFG, 'ORD-1', { orden: ml.orden });
    expect(woo.posts).toBe(0);
    expect(reserva('ORD-1')).toBeUndefined();
  });

  it('DOBLE DESCUENTO: con la fila en estado parcial el polling tampoco crea el pedido', async () => {
    db.prepare("INSERT INTO ordenes_ml_descuento_sin_pedido (ml_order_id, lineas_json, estado, creado_en, actualizado_en) VALUES ('ORD-1', '[]', 'parcial', 'x', 'x')").run();
    ml.orden = conCantidad(1);
    await syncMlToWc(db, CFG);
    expect(woo.posts).toBe(0);
  });

  it('línea incierta (error de red): si el stock sigue igual reescribe; si cambió va a ambigua sin escribir y avisa con antes/esperado/actual', async () => {
    ml.orden = conCantidad(1);
    let falla = true;
    const base = wooFetch.getMockImplementation();
    wooFetch.mockImplementation(async (c, p, m, b) => {
      if (m === 'put' && p === '/products/100' && falla) throw new Error('socket hang up'); // sin status: pudo haber salido
      return base(c, p, m, b);
    });
    const r1 = await procesarOrdenMl(db, CFG, 'ORD-1');
    expect(r1.estado).toBe('reencolar');
    expect(JSON.parse(fila().lineas_json)[0]).toMatchObject({ estado: 'incierta', antes: 5, despues: 4 });
    expect(db.prepare("SELECT 1 FROM incidentes_operativos WHERE tipo_error = 'orden_ml_descuento_parcial_ORD-1'").get()).toBeDefined();
    // el stock cambió por una venta web mientras tanto → nunca autorresuelve, ni siquiera si coincidiera con lo esperado
    woo.stock[100] = 4;
    falla = false;
    await procesarOrdenMl(db, CFG, 'ORD-1');
    expect(woo.productPuts).toHaveLength(0);
    expect(JSON.parse(fila().lineas_json)[0]).toMatchObject({ estado: 'ambigua', antes: 5, esperado: 4, actual: 4 });
    expect(inc().mensaje_humano).toMatch(/AMBIGUAS.*antes 5, esperado 4, actual 4/);
  });

  it('línea incierta con el stock igual que antes: reescribe una vez', async () => {
    ml.orden = conCantidad(1);
    let falla = true;
    const base = wooFetch.getMockImplementation();
    wooFetch.mockImplementation(async (c, p, m, b) => {
      if (m === 'put' && p === '/products/100' && falla) throw new Error('timeout');
      return base(c, p, m, b);
    });
    await procesarOrdenMl(db, CFG, 'ORD-1');
    falla = false;
    await procesarOrdenMl(db, CFG, 'ORD-1');
    expect(woo.stock[100]).toBe(4);
    expect(fila().estado).toBe('completo');
  });

  it('error de configuración (sin request enviado) es definitivo: no deja línea incierta', async () => {
    ml.orden = conCantidad(1);
    const base = wooFetch.getMockImplementation();
    wooFetch.mockImplementation(async (c, p, m, b) => {
      if (m === 'put' && p === '/products/100') throw Object.assign(new Error('WooCommerce URL debe usar HTTPS'), { categoria: 'config' });
      return base(c, p, m, b);
    });
    await procesarOrdenMl(db, CFG, 'ORD-1');
    expect(fila()).toBeUndefined();
  });

  it('carrera lectura→PUT: si al releer no está lo escrito, línea ambigua y aviso', async () => {
    ml.orden = conCantidad(1);
    const base = wooFetch.getMockImplementation();
    wooFetch.mockImplementation(async (c, p, m, b) => {
      const r = await base(c, p, m, b);
      if (m === 'put' && p === '/products/100') woo.stock[100] = 2; // una venta web pisó el valor
      return r;
    });
    await procesarOrdenMl(db, CFG, 'ORD-1');
    expect(JSON.parse(fila().lineas_json)[0]).toMatchObject({ estado: 'ambigua', esperado: 4, actual: 2 });
    expect(inc().mensaje_humano).toMatch(/AMBIGUAS/);
  });

  it('ALTO A: el polling legacy con una orden de 10 días NO crea pedido: descuenta una vez y avisa', async () => {
    ml.orden = vieja({ date_created: new Date(Date.now() - 10 * DIA).toISOString() });
    await syncMlToWc(db, CFG);
    await syncMlToWc(db, CFG); // otro ciclo del cron
    expect(woo.posts).toBe(0);
    expect(reserva('ORD-1')).toBeUndefined();
    expect(woo.productPuts).toHaveLength(1);
    expect(woo.stock[100]).toBe(4);
    expect(inc()).toBeDefined();
  });

  it('ALTO A: el sync puntual con una orden vieja tampoco crea pedido', async () => {
    ml.orden = vieja();
    await syncOrdenMlPuntual(db, CFG, 'ORD-1', { orden: ml.orden });
    expect(woo.posts).toBe(0);
    expect(woo.stock[100]).toBe(4);
  });

  it('fechas: con offset explícito, sin offset (se asume UTC) y ausente (fail-safe: ni pedido ni descuento, con aviso)', async () => {
    const hace = (ms) => new Date(Date.now() - ms);
    const conOffset = (d) => d.toISOString().replace('Z', '-03:00'); // mismo reloj de pared, corrido 3 h
    const sinOffset = (d) => d.toISOString().replace('Z', '');
    // 2 días 23 h según UTC → dentro; con offset -03:00 el instante real es 3 h MÁS TARDE → sigue dentro
    ml.orden = vieja({ date_created: conOffset(hace(2.9 * DIA)) });
    await procesarOrdenMl(db, CFG, 'ORD-1');
    expect(woo.posts).toBe(1);
    db.prepare('DELETE FROM ordenes_ml_wc_pedidos').run(); db.prepare('DELETE FROM ordenes_ml_procesadas').run(); db.prepare('DELETE FROM ordenes_ml_destino').run();
    ml.orden = vieja({ date_created: sinOffset(hace(3.1 * DIA)) });
    await procesarOrdenMl(db, CFG, 'ORD-1');
    expect(woo.posts).toBe(1); // 3,1 días UTC → fuera: descuenta
    expect(woo.stock[100]).toBeLessThan(5);
    db.prepare('DELETE FROM ordenes_ml_descuento_sin_pedido').run(); db.prepare('DELETE FROM ordenes_ml_destino').run();
    const antes = woo.stock[100];
    ml.orden = vieja({ date_created: undefined });
    const r = await procesarOrdenMl(db, CFG, 'ORD-1');
    expect(r.motivo).toBe('orden_sin_fecha');
    expect(woo.posts).toBe(1);
    expect(woo.stock[100]).toBe(antes);
    expect(db.prepare("SELECT severidad FROM incidentes_operativos WHERE tipo_error = 'orden_ml_sin_fecha_ORD-1'").get()).toMatchObject({ severidad: 'critico' });
  });

  it('ALTO B: si el pedido ya reservó, el descuento no corre; si el descuento reclamó, el pedido no se crea (mismo reclamo para el script)', async () => {
    const { descontarOrdenViejaSinPedido } = await import('../routes/sync.js');
    db.prepare("INSERT INTO ordenes_ml_destino (ml_order_id, destino, creado_en) VALUES ('ORD-1', 'pedido', 'x')").run();
    const r = await descontarOrdenViejaSinPedido(db, CFG, conCantidad(1), { origen: 'script' });
    expect(r.estado).toBe('no_aplica');
    expect(woo.productPuts).toHaveLength(0);
    expect(fila()).toBeUndefined();
    db.prepare('DELETE FROM ordenes_ml_destino').run();
    db.prepare("INSERT INTO ordenes_ml_wc_pedidos (ml_order_id, wc_order_id, comprador_json, creado_en) VALUES ('ORD-1', 0, NULL, 'x')").run(); // reserva en curso
    const r2 = await descontarOrdenViejaSinPedido(db, CFG, conCantidad(1));
    expect(r2.estado).toBe('no_aplica');
    expect(woo.productPuts).toHaveLength(0);
    db.prepare('DELETE FROM ordenes_ml_wc_pedidos').run();
    const r3 = await descontarOrdenViejaSinPedido(db, CFG, conCantidad(1)); // el descuento gana el reclamo
    expect(r3.estado).toBe('descontada');
    ml.orden = ordenMl('ORD-1'); // y ahora una ventana "fresca" no puede crear pedido
    await syncOrdenMlPuntual(db, CFG, 'ORD-1', { orden: ml.orden });
    expect(woo.posts).toBe(0);
  });

  it('ALTO C: write-ahead — si el proceso muere entre el PUT y el registro, el reintento no resta dos veces', async () => {
    ml.orden = conCantidad(1);
    const base = wooFetch.getMockImplementation();
    let muerto = true;
    wooFetch.mockImplementation(async (c, p, m, b) => {
      const r = await base(c, p, m, b);
      if (m === 'put' && p === '/products/100' && muerto) throw new Error('proceso muerto tras el PUT'); // el PUT sí se aplicó
      return r;
    });
    await procesarOrdenMl(db, CFG, 'ORD-1');
    expect(woo.stock[100]).toBe(4);
    expect(JSON.parse(fila().lineas_json)[0]).toMatchObject({ estado: 'incierta', antes: 5, despues: 4 });
    muerto = false;
    await procesarOrdenMl(db, CFG, 'ORD-1');
    expect(woo.stock[100]).toBe(4); // no volvió a restar
    expect(JSON.parse(fila().lineas_json)[0].estado).toBe('ambigua');
  });

  it('ALTO 1: el POST falla definitivo DENTRO de ventana → se libera y el reintento crea el pedido', async () => {
    ml.orden = ordenMl('ORD-1');
    woo.postError = Object.assign(new Error('Woo 400'), { status: 400 });
    await procesarOrdenMl(db, CFG, 'ORD-1');
    expect(reserva('ORD-1')).toBeUndefined(); // reserva liberada
    woo.postError = null;
    await procesarOrdenMl(db, CFG, 'ORD-1');
    expect(woo.posts).toBe(2);
    expect(reserva('ORD-1')?.wc_order_id).toBe(7001);
  });

  it('ALTO 1: el POST falla, se libera y la orden llega FUERA de ventana → descuenta (no se pierde)', async () => {
    ml.orden = ordenMl('ORD-1');
    woo.postError = Object.assign(new Error('Woo 400'), { status: 400 });
    await procesarOrdenMl(db, CFG, 'ORD-1');
    expect(reserva('ORD-1')).toBeUndefined();
    woo.postError = null;
    ml.orden = vieja();
    await procesarOrdenMl(db, CFG, 'ORD-1');
    expect(woo.posts).toBe(1);
    expect(woo.stock[100]).toBe(4);
    expect(fila().estado).toBe('completo');
  });

  it('ALTO 2: cancelación de una orden ya descontada → incidente crítico único, sin reponer stock', async () => {
    ml.orden = conCantidad(2);
    await procesarOrdenMl(db, CFG, 'ORD-1');
    expect(woo.stock[100]).toBe(3);
    ml.orden = { ...conCantidad(2), status: 'cancelled' };
    await procesarOrdenMl(db, CFG, 'ORD-1');
    await procesarOrdenMl(db, CFG, 'ORD-1'); // otro aviso: no se repite
    expect(woo.stock[100]).toBe(3); // NO se repone solo
    const c = db.prepare("SELECT severidad, mensaje_humano FROM incidentes_operativos WHERE tipo_error = 'orden_ml_descontada_cancelada_ORD-1'").all();
    expect(c).toHaveLength(1);
    expect(c[0].severidad).toBe('critico');
    expect(c[0].mensaje_humano).toMatch(/CANCELADA.*reponé a mano.*BIKE-001 x2 \(stock leído 5, escrito 3\)/);
    const mails = db.prepare("SELECT COUNT(*) n FROM incidentes_email_outbox o JOIN incidentes_operativos i ON i.id = o.incidente_id WHERE i.tipo_error = 'orden_ml_descontada_cancelada_ORD-1'").get().n;
    expect(mails).toBe(1);
  });

  it('ALTO 2b: cancelación con descuento a medias → avisa lo hecho y lo pendiente, y frena el resto', async () => {
    seedVariacion();
    woo.manage[101] = true;
    woo.stock[101] = 7;
    const items = [{ item: { id: 'MLA100', variation_id: '', title: 'A' }, quantity: 1 }, { item: { id: 'MLA200', variation_id: '', title: 'B' }, quantity: 1 }];
    ml.orden = vieja({ order_items: items });
    const base = wooFetch.getMockImplementation();
    wooFetch.mockImplementation(async (c, p, m, b) => {
      if (m === 'put' && p.startsWith('/products/100/variations/')) throw Object.assign(new Error('Woo 400'), { status: 400 });
      return base(c, p, m, b);
    });
    await procesarOrdenMl(db, CFG, 'ORD-1'); // BIKE-001 descontada, VAR-1 pendiente
    ml.orden = vieja({ order_items: items }, 'cancelled');
    await procesarOrdenMl(db, CFG, 'ORD-1');
    const c = db.prepare("SELECT mensaje_humano FROM incidentes_operativos WHERE tipo_error = 'orden_ml_descontada_cancelada_ORD-1'").get();
    expect(c.mensaje_humano).toMatch(/BIKE-001 x1.*NO se descontó.*VAR-1 x1/);
    expect(fila().estado).toBe('completo');
    wooFetch.mockImplementation(base);
    ml.orden = vieja({ order_items: items });
    await procesarOrdenMl(db, CFG, 'ORD-1'); // un aviso viejo "paid" no sigue restando
    expect(woo.stock[101]).toBe(7);
  });

  it('ALTO carrera: la cancelación cierra la fila entre el GET y el PUT del descuento → 0 PUT, fila completo y aviso correcto', async () => {
    const { cerrarYAvisarCancelacion } = await import('../lib/descuentoOrdenVieja.js');
    seedVariacion();
    woo.manage[101] = true;
    woo.stock[101] = 7;
    const items = [{ item: { id: 'MLA100', variation_id: '', title: 'A' }, quantity: 1 }, { item: { id: 'MLA200', variation_id: '', title: 'B' }, quantity: 1 }];
    ml.orden = vieja({ order_items: items });
    const base = wooFetch.getMockImplementation();
    let modo = 'falla';
    wooFetch.mockImplementation(async (c, p, m, b) => {
      if (modo === 'falla' && m === 'put' && p.startsWith('/products/100/variations/')) throw Object.assign(new Error('Woo 400'), { status: 400 });
      const r = await base(c, p, m, b);
      if (modo === 'carrera' && (m === undefined || m === 'get') && p.startsWith('/products/100/variations/')) cerrarYAvisarCancelacion(db, { id: 'ORD-1' }); // cancelación entre GET y PUT
      return r;
    });
    await procesarOrdenMl(db, CFG, 'ORD-1'); // BIKE-001 descontada, VAR-1 pendiente
    modo = 'carrera';
    const putsAntes = woo.productPuts.length;
    const r = await procesarOrdenMl(db, CFG, 'ORD-1');
    expect(woo.productPuts.length).toBe(putsAntes); // 0 PUT nuevos
    expect(woo.stock[101]).toBe(7);
    expect(fila().estado).toBe('completo');
    expect(JSON.parse(fila().lineas_json).find((l) => l.sku === 'VAR-1').estado).toBe('omitida');
    expect(r.estado).toBe('hecho');
    expect(db.prepare("SELECT mensaje_humano FROM incidentes_operativos WHERE tipo_error = 'orden_ml_descontada_cancelada_ORD-1'").get().mensaje_humano).toMatch(/BIKE-001 x1.*NO se descontó.*VAR-1 x1/);
    expect(inc()).toBeUndefined(); // y no sale el aviso de "descuento completado"
  });

  it('una lápida grabada por fuera (entre el GET y el PUT) frena el PUT del descuento → 0 PUT, lápida completo y sin aviso', async () => {
    const { cerrarYAvisarCancelacion } = await import('../lib/descuentoOrdenVieja.js');
    const { descontarOrdenViejaSinPedido } = await import('../routes/sync.js');
    const base = wooFetch.getMockImplementation();
    wooFetch.mockImplementation(async (c, p, m, b) => {
      const r = await base(c, p, m, b);
      if ((m === undefined || m === 'get') && p === '/products/100') cerrarYAvisarCancelacion(db, { id: 'ORD-1' }); // cancelación real, aún sin fila
      return r;
    });
    const r = await descontarOrdenViejaSinPedido(db, CFG, conCantidad(1), { origen: 'script' });
    expect(r.estado).toBe('cancelada');
    expect(woo.productPuts).toHaveLength(0);
    expect(woo.stock[100]).toBe(5);
    expect(fila()).toMatchObject({ estado: 'completo', origen: 'cancelada', lineas_json: '[]' });
    expect(inc()).toBeUndefined();
  });

  it('ALTO lápida: cancelación procesada ANTES de que el descuento (script) tome el reclamo → 0 PUT', async () => {
    const { descontarOrdenViejaSinPedido } = await import('../routes/sync.js');
    ml.orden = vieja({}, 'cancelled');
    await procesarOrdenMl(db, CFG, 'ORD-1');
    expect(fila()).toMatchObject({ estado: 'completo', origen: 'cancelada' });
    const r = await descontarOrdenViejaSinPedido(db, CFG, conCantidad(1), { origen: 'script' }); // leyó 'paid' antes
    expect(['ya_descontada', 'cancelada']).toContain(r.estado);
    expect(woo.productPuts).toHaveLength(0);
  });

  it('exclusión real: con los candados tomados, la cancelación devuelve ocupado (fila intacta) y el job se reencola', async () => {
    const { avisarCancelacionDescontada } = await import('../lib/descuentoOrdenVieja.js');
    const { tomarCandados, liberarCandados } = await import('../lib/stockBarrera.js');
    ml.orden = conCantidad(1);
    await procesarOrdenMl(db, CFG, 'ORD-1');
    const antes = fila();
    const c = tomarCandados(db, ['BIKE-001']);
    try {
      expect(await avisarCancelacionDescontada(db, { id: 'ORD-1' })).toBe('ocupado');
      expect(fila()).toEqual(antes);
      ml.orden = { ...conCantidad(1), status: 'cancelled' };
      expect(await procesarOrdenMl(db, CFG, 'ORD-1')).toMatchObject({ estado: 'reencolar', diferido: true, motivo: 'descuento_en_curso' });
    } finally { liberarCandados(db, c.token); }
    expect(await procesarOrdenMl(db, CFG, 'ORD-1')).toMatchObject({ estado: 'hecho' }); // sin candados ocupados avisa
  });

  it('MEDIO: lápida y la orden vuelve paid → incidente crítico único, sin pedido ni descuento (polling y job)', async () => {
    ml.orden = vieja({}, 'cancelled');
    await procesarOrdenMl(db, CFG, 'ORD-1');
    ml.orden = conCantidad(1); // vuelve paid
    await procesarOrdenMl(db, CFG, 'ORD-1');
    await syncMlToWc(db, CFG);
    await syncMlToWc(db, CFG);
    expect(woo.posts).toBe(0);
    expect(woo.productPuts).toHaveLength(0);
    const i = db.prepare("SELECT severidad FROM incidentes_operativos WHERE tipo_error = 'orden_ml_cancelada_luego_pagada_ORD-1'").all();
    expect(i).toEqual([{ severidad: 'critico' }]);
    const mails = db.prepare("SELECT COUNT(*) n FROM incidentes_email_outbox o JOIN incidentes_operativos i ON i.id = o.incidente_id WHERE i.tipo_error = 'orden_ml_cancelada_luego_pagada_ORD-1'").get().n;
    expect(mails).toBe(1);
  });

  it('MEDIO: cancelada por el script (descontarOrdenViejaSinPedido) y luego paid → 1 incidente, 0 POST, 0 PUT', async () => {
    const { descontarOrdenViejaSinPedido } = await import('../routes/sync.js');
    const r = await descontarOrdenViejaSinPedido(db, CFG, vieja({}, 'cancelled'), { origen: 'script' });
    expect(r.estado).toBe('no_aplica');
    expect(fila()).toMatchObject({ estado: 'completo', origen: 'script' });
    expect(fila().cancelada_en).toBeTruthy();
    ml.orden = conCantidad(1); // vuelve paid
    await procesarOrdenMl(db, CFG, 'ORD-1');
    await syncMlToWc(db, CFG);
    expect(woo.posts).toBe(0);
    expect(woo.productPuts).toHaveLength(0);
    expect(db.prepare("SELECT COUNT(*) n FROM incidentes_operativos WHERE tipo_error = 'orden_ml_cancelada_luego_pagada_ORD-1'").get().n).toBe(1);
  });

  it('MEDIO: descuento a medias cerrado por la cancelación (job) y luego paid → también avisa', async () => {
    const { cerrarYAvisarCancelacion } = await import('../lib/descuentoOrdenVieja.js');
    ml.orden = conCantidad(1);
    woo.putError = Object.assign(new Error('Woo 503'), { status: 503 });
    await procesarOrdenMl(db, CFG, 'ORD-1'); // línea incierta, fila parcial
    cerrarYAvisarCancelacion(db, { id: 'ORD-1' });
    expect(fila().cancelada_en).toBeTruthy();
    woo.putError = null;
    await procesarOrdenMl(db, CFG, 'ORD-1');
    expect(woo.productPuts.length).toBeLessThanOrEqual(1); // no reescribe
    expect(db.prepare("SELECT COUNT(*) n FROM incidentes_operativos WHERE tipo_error = 'orden_ml_cancelada_luego_pagada_ORD-1'").get().n).toBe(1);
  });

  it('MEDIO: descuento completo → cancelación (1 reposición) → paid (1 cancelada_luego_pagada), 0 PUT y 0 POST nuevos', async () => {
    ml.orden = conCantidad(1);
    await procesarOrdenMl(db, CFG, 'ORD-1');
    const putsAntes = woo.productPuts.length;
    ml.orden = { ...conCantidad(1), status: 'cancelled' };
    await procesarOrdenMl(db, CFG, 'ORD-1');
    expect(db.prepare("SELECT COUNT(*) n FROM incidentes_operativos WHERE tipo_error = 'orden_ml_descontada_cancelada_ORD-1'").get().n).toBe(1);
    expect(fila().cancelada_en).toBeTruthy();
    expect(fila().estado).toBe('completo');
    ml.orden = conCantidad(1);
    await procesarOrdenMl(db, CFG, 'ORD-1');
    await syncMlToWc(db, CFG);
    expect(db.prepare("SELECT COUNT(*) n FROM incidentes_operativos WHERE tipo_error = 'orden_ml_cancelada_luego_pagada_ORD-1'").get().n).toBe(1);
    expect(woo.productPuts.length).toBe(putsAntes);
    expect(woo.posts).toBe(0);
  });

  it('si el aviso cancelada-luego-pagada lanza, el flujo no se corta (job hecho, polling sigue)', async () => {
    const { cerrarYAvisarCancelacion } = await import('../lib/descuentoOrdenVieja.js');
    cerrarYAvisarCancelacion(db, { id: 'ORD-1' });
    db.prepare('DROP TABLE incidentes_operativos').run(); // fuerza el error dentro del aviso
    ml.orden = conCantidad(1);
    await expect(procesarOrdenMl(db, CFG, 'ORD-1')).resolves.toMatchObject({ estado: 'hecho' });
    await expect(syncMlToWc(db, CFG)).resolves.toBeDefined();
    expect(db.prepare("SELECT 1 FROM sync_log WHERE estado = 'aviso_cancelada_luego_pagada_fallo'").get()).toBeDefined();
  });

  it('BAJO: cancelación de una orden sin ningún SKU resoluble (lista vacía de candados) graba la lápida sin colgarse', async () => {
    const { avisarCancelacionDescontada } = await import('../lib/descuentoOrdenVieja.js');
    const huerfana = { id: 'ORD-1', status: 'cancelled', order_items: [{ item: { id: 'MLA-NADA', variation_id: '' }, quantity: 1 }] };
    expect(await avisarCancelacionDescontada(db, huerfana)).toBe(false);
    expect(fila()).toMatchObject({ estado: 'completo', origen: 'cancelada' });
  });

  it('MEDIO: una cancelación sobre una fila completo no la reescribe ni reavisa', async () => {
    const { avisarCancelacionDescontada } = await import('../lib/descuentoOrdenVieja.js');
    ml.orden = conCantidad(1);
    await procesarOrdenMl(db, CFG, 'ORD-1');
    expect(await avisarCancelacionDescontada(db, { id: 'ORD-1' })).toBe(true); // primera cancelación: avisa
    const antes = fila();
    expect(await avisarCancelacionDescontada(db, { id: 'ORD-1' })).toBe(false);
    expect(fila()).toEqual(antes);
    expect(db.prepare("SELECT COUNT(*) n FROM incidentes_operativos WHERE tipo_error = 'orden_ml_descontada_cancelada_ORD-1'").get().n).toBe(1);
  });

  it('B2: un 4xx en el PUT es definitivo (vuelve a pendiente y no deja fila); un 408 queda incierta', async () => {
    ml.orden = conCantidad(1);
    const base = wooFetch.getMockImplementation();
    let status = 400;
    wooFetch.mockImplementation(async (c, p, m, b) => {
      if (m === 'put' && p === '/products/100') throw Object.assign(new Error(`Woo ${status}`), { status });
      return base(c, p, m, b);
    });
    await procesarOrdenMl(db, CFG, 'ORD-1');
    expect(fila()).toBeUndefined();
    status = 408;
    await procesarOrdenMl(db, CFG, 'ORD-1');
    expect(JSON.parse(fila().lineas_json)[0].estado).toBe('incierta');
  });

  it('B1: el polling que deja un descuento a medias encola un job order.ml para terminarlo', async () => {
    ml.orden = conCantidad(1);
    woo.putError = Object.assign(new Error('Woo 503'), { status: 503 });
    await syncMlToWc(db, CFG);
    expect(trabajo('order.ml', 'ORD-1')).toMatchObject({ estado: 'pendiente' });
  });

  it('fila parcial sin job (caída antes de encolar): una pasada del polling encola el order.ml; una completa no', async () => {
    db.prepare("INSERT INTO ordenes_ml_descuento_sin_pedido (ml_order_id, lineas_json, estado, creado_en, actualizado_en) VALUES ('ORD-1', '[]', 'parcial', 'x', 'x')").run();
    ml.orden = conCantidad(1);
    expect(trabajo('order.ml', 'ORD-1')).toBeUndefined();
    await syncMlToWc(db, CFG);
    expect(trabajo('order.ml', 'ORD-1')).toMatchObject({ estado: 'pendiente' });
    db.prepare('DELETE FROM trabajos_recurso').run();
    db.prepare("UPDATE ordenes_ml_descuento_sin_pedido SET estado = 'completo'").run();
    await syncMlToWc(db, CFG);
    expect(trabajo('order.ml', 'ORD-1')).toBeUndefined();
  });

  it('fila parcial que no avanza: incidente crítico con lo descontado y lo pendiente, y encola la bolsa de lo ya descontado', async () => {
    seedVariacion();
    woo.manage[101] = true;
    woo.stock[101] = 7;
    ml.orden = vieja({ order_items: [
      { item: { id: 'MLA100', variation_id: '', title: 'A' }, quantity: 1 },
      { item: { id: 'MLA200', variation_id: '', title: 'B' }, quantity: 1 },
    ] });
    const base = wooFetch.getMockImplementation();
    wooFetch.mockImplementation(async (c, p, m, b) => {
      if (m === 'put' && p.startsWith('/products/100/variations/')) throw Object.assign(new Error('Woo 502'), { status: 502 });
      return base(c, p, m, b);
    });
    await procesarOrdenMl(db, CFG, 'ORD-1');
    const parcial = db.prepare("SELECT mensaje_humano, severidad FROM incidentes_operativos WHERE tipo_error = 'orden_ml_descuento_parcial_ORD-1'").get();
    expect(parcial.severidad).toBe('critico');
    expect(parcial.mensaje_humano).toMatch(/A MEDIAS.*BIKE-001 x1 \(5 → 4\).*VAR-1 x1/);
    expect(trabajo('stock.bolsa', 'sku:BIKE-001')).toBeDefined();
  });

  it('dry-run: calcula antes → después, no escribe nada, no registra ni avisa', async () => {
    const { descontarOrdenViejaSinPedido } = await import('../routes/sync.js');
    const r = await descontarOrdenViejaSinPedido(db, CFG, conCantidad(2), { dryRun: true });
    expect(r.estado).toBe('simulado');
    expect(r.lineas[0]).toMatchObject({ sku: 'BIKE-001', antes: 5, despues: 3 });
    expect(woo.productPuts).toHaveLength(0);
    expect(fila()).toBeUndefined();
    expect(inc()).toBeUndefined();
    expect(trabajo('stock.bolsa', 'sku:BIKE-001')).toBeUndefined();
  });

  it('aviso: crítico, un solo mail en el outbox, con orden, fecha, producto, antes → después y motivo; el script usa la misma función', async () => {
    const { descontarOrdenViejaSinPedido } = await import('../routes/sync.js');
    const o = conCantidad(2);
    const r = await descontarOrdenViejaSinPedido(db, CFG, o, { origen: 'script', actor: 'script:descontar-ordenes-viejas' });
    expect(r.estado).toBe('descontada');
    const i = inc();
    expect(i.severidad).toBe('critico');
    for (const frag of ['ORD-1', o.date_created.slice(0, 10), 'BIKE-001', 'x2', 'leído 5, escrito 3, releído 3', 'NO se creó']) expect(i.mensaje_humano).toContain(frag);
    expect(outbox()).toHaveLength(1);
    expect(fila()).toMatchObject({ origen: 'script', actor: 'script:descontar-ordenes-viejas' });
    const otra = await descontarOrdenViejaSinPedido(db, CFG, o); // el job después: nada
    expect(otra.estado).toBe('ya_descontada');
    expect(woo.productPuts).toHaveLength(1);
    expect(outbox()).toHaveLength(1);
  });
});

describe('order.ml: otros estados', () => {
  it('una orden no pagada solo pasa por Preparación', async () => {
    ml.orden = ordenMl('ORD-1', 'payment_required');
    const r = await procesarOrdenMl(db, CFG, 'ORD-1');
    expect(r.estado).toBe('hecho');
    expect(woo.posts).toBe(0);
    expect(preparacion.syncPedidoMlPuntual).toHaveBeenCalledTimes(1);
  });

  it('una orden cancelada cancela el pedido Woo UNA vez (idempotente) y encola la bolsa', async () => {
    await procesarOrdenMl(db, CFG, 'ORD-1');
    ml.orden = ordenMl('ORD-1', 'cancelled');
    const r1 = await procesarOrdenMl(db, CFG, 'ORD-1');
    expect(r1.estado).toBe('hecho');
    expect(woo.puts).toEqual([{ id: '7001', body: { status: 'cancelled' } }]);
    const r2 = await procesarOrdenMl(db, CFG, 'ORD-1');
    expect(r2.estado).toBe('hecho');
    expect(woo.puts).toHaveLength(1);
  });

  it('cancelada con reserva en curso (POST incierto): se reencola sin cancelar ni abrir nada', async () => {
    woo.postError = new Error('timeout');
    woo.busquedaError = new Error('woo caído');
    await procesarOrdenMl(db, CFG, 'ORD-1');
    ml.orden = ordenMl('ORD-1', 'cancelled');
    const r = await procesarOrdenMl(db, CFG, 'ORD-1');
    expect(r).toMatchObject({ estado: 'reencolar', motivo: 'reserva_en_curso' });
    expect(woo.puts).toHaveLength(0);
  });
});

describe('stock.bolsa: único escritor de stock por eventos', () => {
  it('empuja a ML el stock de Woo cuando difiere', async () => {
    woo.stock[100] = 3; // Woo manda
    const r = await procesarStockBolsa(db, CFG, 'BIKE-001');
    expect(r.estado).toBe('hecho');
    expect(ml.puts).toHaveLength(1);
    expect(ml.puts[0].body).toMatchObject({ available_quantity: 3 });
  });

  it('con una venta ML todavía sin procesar no escribe y se reencola', async () => {
    woo.stock[100] = 3;
    encolarTrabajo(db, { tipo: 'order.ml', recurso: 'ORD-9' });
    const r = await procesarStockBolsa(db, CFG, 'BIKE-001');
    expect(r).toMatchObject({ estado: 'reencolar', motivo: 'orden_ml_pendiente' });
    expect(ml.puts).toHaveLength(0);
  });

  it('con una reserva wc_order_id=0 de ESA bolsa (su order.ml sigue pendiente) no escribe', async () => {
    woo.stock[100] = 3;
    woo.postError = new Error('timeout');
    woo.busquedaError = new Error('woo caído');
    encolarTrabajo(db, { tipo: 'order.ml', recurso: 'ORD-1' });
    await procesarTrabajosRecurso(db, CFG); // order.ml queda diferido con la reserva incierta; el contexto guarda sus SKUs
    expect(reserva('ORD-1')?.wc_order_id).toBe(0);
    ml.puts.length = 0;
    const r = await procesarStockBolsa(db, CFG, 'BIKE-001');
    expect(r.motivo).toBe('orden_ml_pendiente');
    expect(ml.puts).toHaveLength(0);
  });

  it('un order.ml AJENO en backoff (otro SKU) no frena la conciliación de esta bolsa', async () => {
    woo.stock[100] = 3;
    encolarTrabajo(db, { tipo: 'order.ml', recurso: 'ORD-AJENA' });
    const [t] = reclamarTrabajos(db, ['order.ml']);
    guardarContextoTrabajo(db, 'order.ml', 'ORD-AJENA', { skus: ['OTRO-SKU'] });
    db.prepare("UPDATE trabajos_recurso SET estado = 'pendiente', lease_token = NULL, intentos = 2 WHERE tipo = 'order.ml' AND recurso = ?").run(t.recurso);
    const r = await procesarStockBolsa(db, CFG, 'BIKE-001');
    expect(r.estado).toBe('hecho');
    expect(ml.puts).toHaveLength(1);
  });

  it('un vínculo con acción "asignar" también resuelve el SKU de la orden y frena su bolsa', async () => {
    woo.stock[100] = 3;
    db.prepare("UPDATE sku_matcher_decisiones SET accion = 'asignar' WHERE clave = 'MLA100|'").run();
    encolarTrabajo(db, { tipo: 'order.ml', recurso: 'ORD-1' });
    ml.orden = ordenMl('ORD-1', 'payment_required');
    preparacion.syncPedidoMlPuntual.mockRejectedValueOnce(new Error('falla transitoria'));
    await procesarTrabajosRecurso(db, CFG); // lee la orden, guarda sus SKUs y falla: queda en backoff con intentos > 0
    expect(JSON.parse(trabajo('order.ml', 'ORD-1').contexto_json)).toEqual({ skus: ['BIKE-001'] });
    expect((await procesarStockBolsa(db, CFG, 'BIKE-001')).motivo).toBe('orden_ml_pendiente');
    expect(ml.puts).toHaveLength(0);
  });

  it('un order.ml en backoff cuyos SKUs no se pudieron leer tampoco frena bolsas ajenas; uno recién llegado sí', async () => {
    woo.stock[100] = 3;
    encolarTrabajo(db, { tipo: 'order.ml', recurso: 'ORD-VIEJA' });
    expect((await procesarStockBolsa(db, CFG, 'BIKE-001')).motivo).toBe('orden_ml_pendiente'); // todavía no se leyó
    db.prepare("UPDATE trabajos_recurso SET intentos = 3 WHERE tipo = 'order.ml'").run();       // ya intentada y fallando
    expect((await procesarStockBolsa(db, CFG, 'BIKE-001')).estado).toBe('hecho');
  });

  it('con una barrera de E-0 abierta no escribe y se reencola', async () => {
    woo.stock[100] = 3;
    const t = new Date().toISOString();
    db.prepare("INSERT INTO stock_refresco_pendiente (sku, ml_order_id, vendido_en, lineas_json, woo_confirmado, estado, creado_en, actualizado_en) VALUES ('BIKE-001', 'X-1', ?, '[]', 0, 'bloqueante', ?, ?)").run(t, t, t);
    const r = await procesarStockBolsa(db, CFG, 'BIKE-001');
    expect(r).toMatchObject({ estado: 'reencolar', motivo: 'barrera' });
    expect(ml.puts).toHaveLength(0);
  });

  it('SKUs distintos en una bolsa son una contradicción: no escribe y abre incidente', async () => {
    const t = new Date().toISOString();
    db.prepare("UPDATE ml_publicaciones_cache SET user_product_id = 'UP1' WHERE clave = 'MLA100|'").run();
    db.prepare("INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en) VALUES ('MLA200|', 'OTRO-SKU', 'x', 'confirmar', ?)").run(t);
    db.prepare("INSERT INTO ml_publicaciones_cache (clave, item_id, variation_id, status, user_product_id, actualizado_en) VALUES ('MLA200|', 'MLA200', '', 'active', 'UP1', ?)").run(t);
    woo.stock[100] = 3;
    const r = await procesarStockBolsa(db, CFG, 'BIKE-001');
    expect(r.motivo).toBe('contradiccion_skus');
    expect(ml.puts).toHaveLength(0);
    expect(db.prepare("SELECT COUNT(*) n FROM incidentes_operativos WHERE tipo_error LIKE 'bolsa_con_skus_distintos_%'").get().n).toBe(1);
  });

  it('encolarBolsasDeSkus coalesce los SKUs de una misma bolsa en un solo trabajo', () => {
    expect(encolarBolsasDeSkus(db, ['BIKE-001', 'BIKE-001'])).toEqual(['sku:BIKE-001']);
    expect(db.prepare("SELECT COUNT(*) n FROM trabajos_recurso WHERE tipo = 'stock.bolsa'").get().n).toBe(1);
  });
});

describe('worker procesarTrabajosRecurso', () => {
  it('procesa order.ml y después la bolsa: ML queda con el stock real de Woo', async () => {
    encolarTrabajo(db, { tipo: 'order.ml', recurso: 'ORD-1' });
    const r = await procesarTrabajosRecurso(db, CFG);
    // Pasada 1: la orden (descuenta 1 en Woo) y, ya sin ventas en vuelo, la bolsa que ella encoló.
    expect(r.procesados).toBe(2);
    expect(trabajo('order.ml', 'ORD-1')).toMatchObject({ estado: 'hecho' });
    expect(trabajo('stock.bolsa', 'sku:BIKE-001')).toMatchObject({ estado: 'hecho' });
    expect(ml.puts.map((x) => x.body.available_quantity)).toEqual([4]); // ML queda con el stock real de Woo
  });

  it('un resultado incierto deja el trabajo pendiente con el motivo, nunca hecho', async () => {
    ml.ordenHttp = 429;
    encolarTrabajo(db, { tipo: 'order.ml', recurso: 'ORD-1' });
    await procesarTrabajosRecurso(db, CFG);
    expect(trabajo('order.ml', 'ORD-1')).toMatchObject({ estado: 'pendiente', ultimo_error: 'ml_orders_http_429' });
  });
});

describe('worker: job muerto y esperas largas', () => {
  const incidenteCritico = (tipo) => db.prepare("SELECT severidad FROM incidentes_operativos WHERE tipo_error LIKE ?").get(tipo);
  const vencer = () => db.prepare("UPDATE trabajos_recurso SET run_after = '2000-01-01T00:00:00.000Z' WHERE estado = 'pendiente'").run();

  it('un job que muere por EXCEPCIÓN abre el incidente crítico trabajo_muerto_* (no queda muerto en silencio)', async () => {
    preparacion.syncPedidoMlPuntual.mockRejectedValue(new Error('Preparación caída'));
    ml.orden = ordenMl('ORD-1', 'payment_required');
    encolarTrabajo(db, { tipo: 'order.ml', recurso: 'ORD-1' });
    for (let i = 0; i < 12; i++) { vencer(); await procesarTrabajosRecurso(db, CFG); }
    expect(trabajo('order.ml', 'ORD-1')).toMatchObject({ estado: 'muerto', ultimo_error: 'Preparación caída' });
    expect(incidenteCritico('trabajo_muerto_order.ml_ORD-1')).toMatchObject({ severidad: 'critico' });
    preparacion.syncPedidoMlPuntual.mockResolvedValue(undefined);
  });

  it('los incidentes de espera larga y de job muerto se cierran cuando el recurso se completa', async () => {
    const activo = (tipo) => db.prepare("SELECT estado FROM incidentes_operativos WHERE tipo_error = ? ORDER BY id DESC").get(tipo)?.estado;
    // 1) muerto por excepción
    preparacion.syncPedidoMlPuntual.mockRejectedValue(new Error('Preparación caída'));
    ml.orden = ordenMl('ORD-1', 'payment_required');
    encolarTrabajo(db, { tipo: 'order.ml', recurso: 'ORD-1' });
    for (let i = 0; i < 12; i++) { vencer(); await procesarTrabajosRecurso(db, CFG); }
    expect(activo('trabajo_muerto_order.ml_ORD-1')).toBe('activo');
    // 2) espera larga abierta a mano sobre el mismo recurso
    preparacion.syncPedidoMlPuntual.mockResolvedValue(undefined);
    db.prepare("UPDATE trabajos_recurso SET diferido_desde = ?, estado = 'pendiente', intentos = 0, run_after = '2000-01-01T00:00:00.000Z' WHERE tipo = 'order.ml'").run(new Date(Date.now() - 3 * 3600 * 1000).toISOString());
    woo.postError = new Error('timeout'); woo.busquedaError = new Error('woo caído');
    ml.orden = ordenMl('ORD-1', 'paid');
    await procesarTrabajosRecurso(db, CFG);
    expect(activo('trabajo_diferido_largo_order.ml_ORD-1')).toBe('activo');
    // 3) el recurso vuelve a encolarse y se completa: ambos incidentes se resuelven
    preparacion.syncPedidoMlPuntual.mockResolvedValue(undefined);
    db.prepare('DELETE FROM ordenes_ml_wc_pedidos').run();
    woo.postError = null; woo.busquedaError = null;
    encolarTrabajo(db, { tipo: 'order.ml', recurso: 'ORD-1' });
    vencer();
    await procesarTrabajosRecurso(db, CFG);
    expect(trabajo('order.ml', 'ORD-1').estado).toBe('hecho');
    expect(activo('trabajo_muerto_order.ml_ORD-1')).not.toBe('activo');
    expect(activo('trabajo_diferido_largo_order.ml_ORD-1')).not.toBe('activo');
  });

  it('una reserva en curso durante mucho más de 6 minutos NO mata el job: sigue pendiente, sin sumar intentos', async () => {
    woo.postError = new Error('timeout');
    woo.busquedaError = new Error('woo caído');
    encolarTrabajo(db, { tipo: 'order.ml', recurso: 'ORD-1' });
    for (let i = 0; i < 40; i++) { vencer(); await procesarTrabajosRecurso(db, CFG); }
    const t = trabajo('order.ml', 'ORD-1');
    expect(t.estado).toBe('pendiente');
    expect(t.intentos).toBeLessThanOrEqual(1);
    expect(t.diferidos).toBeGreaterThanOrEqual(39);
    expect(woo.posts).toBe(1); // y nunca un segundo POST
  });

  it('el backoff de las esperas crece hasta un tope de 10 min', async () => {
    woo.postError = new Error('timeout');
    woo.busquedaError = new Error('woo caído');
    encolarTrabajo(db, { tipo: 'order.ml', recurso: 'ORD-1' });
    for (let i = 0; i < 12; i++) { vencer(); await procesarTrabajosRecurso(db, CFG); }
    const espera = new Date(trabajo('order.ml', 'ORD-1').run_after).getTime() - Date.now();
    expect(espera).toBeGreaterThan(9 * 60 * 1000);
    expect(espera).toBeLessThanOrEqual(10 * 60 * 1000);
  });

  it('una espera de más de 2 h abre un incidente visible en vez de matar el job', async () => {
    woo.postError = new Error('timeout');
    woo.busquedaError = new Error('woo caído');
    encolarTrabajo(db, { tipo: 'order.ml', recurso: 'ORD-1' });
    await procesarTrabajosRecurso(db, CFG);
    db.prepare("UPDATE trabajos_recurso SET diferido_desde = ? WHERE tipo = 'order.ml'").run(new Date(Date.now() - 3 * 3600 * 1000).toISOString());
    vencer();
    await procesarTrabajosRecurso(db, CFG);
    expect(trabajo('order.ml', 'ORD-1').estado).toBe('pendiente');
    expect(incidenteCritico('trabajo_diferido_largo_order.ml_ORD-1')).toMatchObject({ severidad: 'critico' });
  });
});

describe('guarda de multiorigen en escribirStockMl', () => {
  beforeEach(() => { process.env.ML_MULTIORIGEN_VERIFICAR = '1'; });
  afterEach(() => { process.env.ML_MULTIORIGEN_VERIFICAR = '0'; });
  const escribir = () => escribirStockMl(db, CFG.ml, { clave: 'MLA100|', sku: 'BIKE-001', cantidad: 3 });

  it('sin el tag warehouse_management escribe y recuerda la comprobación (una sola lectura por hora)', async () => {
    expect((await escribir()).omitido).toBe(false);
    await escribir();
    expect(ml.puts).toHaveLength(2);
    expect(ml.gets.filter((p) => p.startsWith('/users/'))).toHaveLength(1);
  });

  it('single-flight: pushes simultáneos comparten UN solo GET /users/{id}', async () => {
    const base = mlFetch.getMockImplementation();
    mlFetch.mockImplementation(async (dbx, cfg, method, p, body) => {
      if (p.startsWith('/users/')) await new Promise((r) => setTimeout(r, 30));
      return base(dbx, cfg, method, p, body);
    });
    const rs = await Promise.all([escribir(), escribir(), escribir()]);
    expect(rs.every((r) => r.omitido === false)).toBe(true);
    expect(ml.gets.filter((p) => p.startsWith('/users/'))).toHaveLength(1);
  });

  it('con el tag warehouse_management frena TODA escritura y abre un incidente crítico', async () => {
    ml.usuario = { tags: ['warehouse_management'] };
    const r = await escribir();
    expect(r).toMatchObject({ omitido: true, motivo: 'multiorigen' });
    expect(ml.puts).toHaveLength(0);
    expect(db.prepare("SELECT severidad FROM incidentes_operativos WHERE tipo_error = 'multiorigen_detectado'").get()).toMatchObject({ severidad: 'critico' });
    expect((await escribir()).motivo).toBe('multiorigen'); // el estado persiste: no se reescribe sin releer
  });

  it('si no se puede verificar (fail-closed) no escribe y abre el incidente de verificación', async () => {
    ml.usuarioHttp = 500;
    const r = await escribir();
    expect(r).toMatchObject({ omitido: true, motivo: 'multiorigen_no_verificado' });
    expect(ml.puts).toHaveLength(0);
    expect(db.prepare("SELECT COUNT(*) n FROM incidentes_operativos WHERE tipo_error = 'multiorigen_no_verificado'").get().n).toBe(1);
  });
});
