// Fase E-1a: "las ventas ML no se pierden". Trabajo durable order.ml y stock.bolsa (único escritor de stock por eventos).
// Mismo patrón que stock-barrera.test.js: Woo y ML simulados; importa QUÉ se escribe y cuántas veces.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import { procesarOrdenMl, procesarStockBolsa, procesarTrabajosRecurso, encolarBolsasDeSkus } from '../routes/sync.js';
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
  woo = { stock: { 100: 5 }, posts: 0, puts: [], nextId: 7001, pedidos: {}, notas: {}, postError: null, busquedaError: null, ordenes: [] };
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
    if ((m = /^\/products\/(\d+)$/.exec(p))) return { status: 200, data: { manage_stock: true, stock_quantity: woo.stock[m[1]] }, headers: {} };
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
