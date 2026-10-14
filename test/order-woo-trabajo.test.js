// Fase E-1b: trabajo durable `order.woo` (pedido Woo creado/modificado/borrado/restaurado). Woo y ML simulados.
// Importa QUÉ se encola, QUÉ se persiste y en qué momento: la unión de SKUs, la anulación/restauración y que un aviso
// durante el procesamiento no pise `woo_orden_skus`.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import { procesarOrdenWoo, procesarTrabajosRecurso, encolarOrdenWoo, skusPersistidosOrdenWoo } from '../routes/sync.js';
import { encolarTrabajo } from '../lib/trabajosRecurso.js';
import { crearPreparacion, preparacionRouter, ESTADO_ANULADO_EN_WOO } from '../routes/preparacion.js';

vi.mock('../lib/mlClient.js', async () => {
  const actual = await vi.importActual('../lib/mlClient.js');
  return { ...actual, mlFetch: vi.fn(), estadoCooldownMl: () => ({ activo: false }) };
});
vi.mock('../routes/woo.js', async () => ({ ...(await vi.importActual('../routes/woo.js')), wooFetch: vi.fn() }));
import { wooFetch } from '../routes/woo.js';

const TEST_DB = `./test/tmp-order-woo-trabajo.${process.pid}.sqlite`;
const CFG = { ml: { clientId: 'cid', clientSecret: 'cs', userId: '99999' }, woo: { url: 'https://fusionbikes.com.ar', ck: 'ck_x', cs: 'cs_x' } };
const limpiarDb = () => { for (const suf of ['', '-wal', '-shm', '-journal']) fs.rmSync(TEST_DB + suf, { force: true }); };

let db, orden, error;
const ord = (id, status, skus) => ({ id, status, number: String(id), billing: { first_name: 'Ana', last_name: 'Gómez' }, shipping: {}, line_items: skus.map((sku, i) => ({ id: i + 1, sku, name: `P ${sku}`, quantity: 1, product_id: 100 + i, variation_id: 0, meta_data: [] })) });
const bolsas = () => db.prepare("SELECT recurso FROM trabajos_recurso WHERE tipo = 'stock.bolsa' ORDER BY recurso").all().map((r) => r.recurso);
const trabajo = (id = '500') => db.prepare("SELECT * FROM trabajos_recurso WHERE tipo = 'order.woo' AND recurso = ?").get(id);
const clave = (id = 500) => `web:${id}`;
const sembrarCache = (id = 500) => db.prepare(`INSERT INTO pedidos_cache (clave, canal, wc_order_id, numero_pedido, comprador, fecha, estado_envio, items_json, actualizado_en)
  VALUES (?, 'web', ?, ?, 'Ana', '2026-10-14', 'pendiente', '[]', ?)`).run(clave(id), id, String(id), new Date().toISOString());
const prep = (id = 500) => db.prepare('SELECT * FROM preparaciones WHERE clave = ?').get(clave(id));
const eventos = (pid, tipo) => db.prepare('SELECT * FROM preparacion_eventos WHERE preparacion_id = ? AND tipo = ?').all(pid, tipo);

beforeEach(() => {
  limpiarDb();
  db = openDb(TEST_DB);
  preparacionRouter(db, CFG); // crea preparaciones / pedidos_cache / preparacion_eventos
  vi.clearAllMocks();
  orden = ord(500, 'lpaandreani', ['A-1', 'B-2']);
  error = null;
  wooFetch.mockImplementation(async (cfg, p) => {
    if (error) throw error;
    if (p === '/orders/500') return { status: 200, data: orden, headers: {} };
    return { status: 200, data: {}, headers: {} };
  });
});
afterEach(() => { db.close(); limpiarDb(); });

const corrida = async () => procesarTrabajosRecurso(db, CFG);
const soloOrdenWoo = async () => { // procesa únicamente los order.woo (el worker también tomaría las bolsas encoladas)
  const { reclamarTrabajos, cerrarTrabajo } = await import('../lib/trabajosRecurso.js');
  const [t] = reclamarTrabajos(db, ['order.woo'], { limit: 1 });
  const r = await procesarOrdenWoo(db, CFG, t.recurso);
  const c = r.estado === 'hecho'
    ? cerrarTrabajo(db, t, { enCierre: (d) => d.prepare('INSERT INTO woo_orden_skus (order_id, skus_json, actualizado_en) VALUES (?, ?, ?) ON CONFLICT(order_id) DO UPDATE SET skus_json = excluded.skus_json, actualizado_en = excluded.actualizado_en').run(t.recurso, JSON.stringify(r.skusActuales), 'x') })
    : null;
  return { r, c, t };
};

describe('order.woo: unión de SKUs y woo_orden_skus', () => {
  it('relee la orden, encola las bolsas de sus SKUs y persiste el conjunto al cerrar (para TODA orden, también las que no son de Preparación)', async () => {
    orden = ord(500, 'processing', ['A-1', 'B-2']); // estado que Preparación ignora
    encolarOrdenWoo(db, 500);
    await corrida();
    expect(trabajo()).toMatchObject({ estado: 'hecho' });
    expect(bolsas()).toEqual(['sku:A-1', 'sku:B-2']);
    expect(skusPersistidosOrdenWoo(db, 500)).toEqual(['A-1', 'B-2']);
  });

  it('una orden editada libera el stock de la línea quitada (unión del conjunto persistido con el actual), también tras un reinicio', async () => {
    encolarOrdenWoo(db, 500);
    await corrida();
    db.prepare("DELETE FROM trabajos_recurso WHERE tipo = 'stock.bolsa'").run(); // se atendieron las bolsas; "reinicio": solo queda woo_orden_skus
    orden = ord(500, 'lpaandreani', ['A-1']); // se quitó B-2
    encolarOrdenWoo(db, 500);
    await corrida();
    expect(bolsas()).toContain('sku:B-2'); // B-2 sigue en el conjunto persistido: su stock se refresca y se libera
    expect(skusPersistidosOrdenWoo(db, 500)).toEqual(['A-1']); // y recién ahora se reemplaza
  });

  it('un aviso que llega durante el procesamiento NO pisa woo_orden_skus: el trabajo se repite y conserva el conjunto anterior', async () => {
    encolarOrdenWoo(db, 500);
    await corrida();
    expect(skusPersistidosOrdenWoo(db, 500)).toEqual(['A-1', 'B-2']);
    orden = ord(500, 'lpaandreani', ['A-1']);
    encolarOrdenWoo(db, 500);
    // El aviso nuevo entra mientras Woo responde la lectura de la orden.
    wooFetch.mockImplementationOnce(async () => { encolarTrabajo(db, { tipo: 'order.woo', recurso: '500' }); return { status: 200, data: orden, headers: {} }; });
    await corrida();
    expect(skusPersistidosOrdenWoo(db, 500)).toEqual(['A-1', 'B-2']); // dirty: se conserva el anterior
    expect(trabajo()).toMatchObject({ estado: 'pendiente' });
    await corrida(); // la repetición procesa la lectura nueva
    expect(skusPersistidosOrdenWoo(db, 500)).toEqual(['A-1']);
    expect(trabajo()).toMatchObject({ estado: 'hecho' });
  });

  it('si Woo falla no se reemplaza el conjunto ni se cierra el trabajo', async () => {
    encolarOrdenWoo(db, 500);
    await corrida();
    error = Object.assign(new Error('WooCommerce API error 502'), { status: 502 });
    encolarOrdenWoo(db, 500);
    await corrida();
    expect(trabajo()).toMatchObject({ estado: 'pendiente' });
    expect(skusPersistidosOrdenWoo(db, 500)).toEqual(['A-1', 'B-2']);
  });
});

describe('order.woo: papelera y 404', () => {
  const sembrarPreparacion = (estado = 'en_preparacion') => {
    const id = crearPreparacion(db, { canal: 'web', wcOrderId: 500, numeroPedido: '500', comprador: 'Ana', items: [] });
    db.prepare('UPDATE preparaciones SET estado = ? WHERE id = ?').run(estado, id);
    return id;
  };
  const conjuntoPersistido = async () => { encolarOrdenWoo(db, 500); await corrida(); db.prepare("DELETE FROM trabajos_recurso WHERE tipo = 'stock.bolsa'").run(); };

  it('status=trash: el conjunto actual es vacío, se refrescan los SKUs persistidos, se retira de pedidos_cache y la preparación pasa a anulado_en_woo con su estado previo', async () => {
    sembrarCache();
    const pid = sembrarPreparacion('en_preparacion');
    await conjuntoPersistido();
    orden = ord(500, 'trash', ['A-1', 'B-2']);
    encolarOrdenWoo(db, 500);
    await corrida();
    expect(bolsas()).toEqual(['sku:A-1', 'sku:B-2']);
    expect(db.prepare('SELECT 1 FROM pedidos_cache WHERE clave = ?').get(clave())).toBeUndefined();
    expect(prep()).toMatchObject({ id: pid, estado: ESTADO_ANULADO_EN_WOO }); // NO se borra
    expect(JSON.parse(eventos(pid, 'anulado_en_woo')[0].detalle_json)).toMatchObject({ estado_previo: 'en_preparacion' });
    expect(skusPersistidosOrdenWoo(db, 500)).toEqual([]);
    expect(trabajo()).toMatchObject({ estado: 'hecho' });
  });

  it('404 de orden inexistente: igual que la papelera', async () => {
    sembrarCache();
    sembrarPreparacion('pendiente_deposito');
    await conjuntoPersistido();
    error = Object.assign(new Error('WooCommerce API error 404'), { status: 404, cuerpo: '{"code":"woocommerce_rest_shop_order_invalid_id","message":"ID no válido."}' });
    encolarOrdenWoo(db, 500);
    await corrida();
    expect(bolsas()).toEqual(['sku:A-1', 'sku:B-2']);
    expect(prep().estado).toBe(ESTADO_ANULADO_EN_WOO);
    expect(skusPersistidosOrdenWoo(db, 500)).toEqual([]);
  });

  it('un 404 que NO es de orden inexistente (ruta rota, plugin apagado) no anula nada y reintenta', async () => {
    sembrarCache();
    sembrarPreparacion();
    await conjuntoPersistido();
    error = Object.assign(new Error('WooCommerce API error 404'), { status: 404, cuerpo: '{"code":"rest_no_route","message":"No route"}' });
    encolarOrdenWoo(db, 500);
    await corrida();
    expect(prep().estado).toBe('en_preparacion');
    expect(db.prepare('SELECT 1 FROM pedidos_cache WHERE clave = ?').get(clave())).toBeDefined();
    expect(trabajo()).toMatchObject({ estado: 'pendiente' });
    expect(skusPersistidosOrdenWoo(db, 500)).toEqual(['A-1', 'B-2']);
  });

  it('sin fila en preparaciones solo se retira la orden de la cola (no se crea nada)', async () => {
    sembrarCache();
    await conjuntoPersistido();
    orden = ord(500, 'trash', ['A-1']);
    encolarOrdenWoo(db, 500);
    await corrida();
    expect(db.prepare('SELECT 1 FROM pedidos_cache WHERE clave = ?').get(clave())).toBeUndefined();
    expect(prep()).toBeUndefined();
  });

  it('las preparaciones con circuito propio de cancelación/devolución no se pisan', async () => {
    sembrarPreparacion('cancelada_pendiente_devolucion');
    await conjuntoPersistido();
    orden = ord(500, 'trash', ['A-1']);
    encolarOrdenWoo(db, 500);
    await corrida();
    expect(prep().estado).toBe('cancelada_pendiente_devolucion');
  });

  it('restauración tras anular: la preparación vuelve al estado previo del evento, se registra, y el stock se vuelve a refrescar (descuento)', async () => {
    sembrarPreparacion('pendiente_deposito');
    await conjuntoPersistido();
    orden = ord(500, 'trash', ['A-1', 'B-2']);
    encolarOrdenWoo(db, 500); await corrida();
    db.prepare("DELETE FROM trabajos_recurso WHERE tipo = 'stock.bolsa'").run();
    orden = ord(500, 'lpaandreani', ['A-1', 'B-2']); // restaurada
    encolarOrdenWoo(db, 500); await corrida();
    expect(prep().estado).toBe('pendiente_deposito');
    expect(eventos(prep().id, 'restaurado_en_woo')).toHaveLength(1);
    expect(bolsas()).toEqual(['sku:A-1', 'sku:B-2']); // papelera → restauración vuelve a descontar
    expect(skusPersistidosOrdenWoo(db, 500)).toEqual(['A-1', 'B-2']);
  });

  it('un order.deleted ATRASADO sobre una orden ya restaurada no la anula (decide la relectura vigente)', async () => {
    sembrarPreparacion('en_preparacion');
    await conjuntoPersistido();
    // llega un "deleted" pero Woo ya devuelve la orden vigente
    orden = ord(500, 'lpaandreani', ['A-1', 'B-2']);
    encolarOrdenWoo(db, 500); await corrida();
    expect(prep().estado).toBe('en_preparacion');
    expect(eventos(prep().id, 'anulado_en_woo')).toHaveLength(0);
  });

  it('anular dos veces es idempotente: un solo evento y el estado previo original', async () => {
    sembrarPreparacion('en_preparacion');
    await conjuntoPersistido();
    orden = ord(500, 'trash', ['A-1']);
    encolarOrdenWoo(db, 500); await corrida();
    encolarOrdenWoo(db, 500); await corrida();
    expect(eventos(prep().id, 'anulado_en_woo')).toHaveLength(1);
    expect(JSON.parse(eventos(prep().id, 'anulado_en_woo')[0].detalle_json).estado_previo).toBe('en_preparacion');
  });
});

describe('order.woo: orden anterior al deploy (woo_orden_skus vacía)', () => {
  const NO_EXISTE = () => Object.assign(new Error('WooCommerce API error 404'), { status: 404, cuerpo: '{"code":"woocommerce_rest_shop_order_invalid_id","message":"ID no válido."}' });
  const cacheConItems = (id, skus) => db.prepare(`INSERT INTO pedidos_cache (clave, canal, wc_order_id, numero_pedido, comprador, fecha, estado_envio, items_json, actualizado_en)
    VALUES (?, 'web', ?, ?, 'Ana', '2026-10-14', 'pendiente', ?, ?)`).run(clave(id), id, String(id), JSON.stringify(skus.map((sku) => ({ sku }))), new Date().toISOString());

  it('sembrar desde pedidos_cache y preparaciones es idempotente y no pisa una fila de un trabajo verificado', async () => {
    const { sembrarWooOrdenSkus } = await import('../lib/wooOrdenSkus.js');
    cacheConItems(500, ['A-1', 'B-2']);
    cacheConItems(501, ['C-3']);
    crearPreparacion(db, { canal: 'web', wcOrderId: 502, numeroPedido: '502', comprador: 'X', items: [{ sku: 'D-4', nombre: 'D', cantidad_esperada: 1 }] });
    db.prepare("INSERT INTO woo_orden_skus (order_id, skus_json, actualizado_en) VALUES ('501', '[\"VERIFICADO\"]', 'x')").run();
    expect(sembrarWooOrdenSkus(db)).toBe(2);
    expect(skusPersistidosOrdenWoo(db, 500).sort()).toEqual(['A-1', 'B-2']);
    expect(skusPersistidosOrdenWoo(db, 501)).toEqual(['VERIFICADO']);
    expect(skusPersistidosOrdenWoo(db, 502)).toEqual(['D-4']);
    expect(sembrarWooOrdenSkus(db)).toBe(0);
  });

  it('primer aviso deleted (404) de una orden previa sin sembrar: usa la cola de Preparación y encola sus bolsas', async () => {
    cacheConItems(500, ['A-1', 'B-2']);
    error = NO_EXISTE();
    encolarOrdenWoo(db, 500); await corrida();
    expect(bolsas()).toEqual(['sku:A-1', 'sku:B-2']);
    expect(db.prepare("SELECT 1 FROM incidentes_operativos WHERE tipo_error = 'order_woo_sin_skus_500'").get()).toBeUndefined();
  });

  it('la siembra corre UNA sola vez (marca en sync_estado): un segundo arranque no vuelve a recorrer el historial', async () => {
    const { sembrarWooOrdenSkus, MARCA_SIEMBRA } = await import('../lib/wooOrdenSkus.js');
    cacheConItems(500, ['A-1']);
    expect(sembrarWooOrdenSkus(db)).toBe(1);
    expect(db.prepare('SELECT 1 FROM sync_estado WHERE clave = ?').get(MARCA_SIEMBRA)).toBeDefined();
    cacheConItems(501, ['B-2']); // aparece después: no se siembra (lo cubre la unión en ejecución)
    expect(sembrarWooOrdenSkus(db)).toBe(0);
    expect(skusPersistidosOrdenWoo(db, 501)).toEqual([]);
  });

  it('un error SQL de lectura aborta la siembra: sin marca, sin filas a medias, y el próximo arranque la completa', async () => {
    const { sembrarWooOrdenSkus, MARCA_SIEMBRA } = await import('../lib/wooOrdenSkus.js');
    cacheConItems(500, ['A-1']);
    const roto = { prepare: (q) => { if (/FROM pedidos_cache/.test(q)) throw new Error('database disk image is malformed'); return db.prepare(q); }, transaction: (f) => db.transaction(f) };
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try { expect(sembrarWooOrdenSkus(roto)).toBe(0); } finally { log.mockRestore(); }
    expect(db.prepare('SELECT 1 FROM sync_estado WHERE clave = ?').get(MARCA_SIEMBRA)).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) n FROM woo_orden_skus').get().n).toBe(0);
    expect(sembrarWooOrdenSkus(db)).toBe(1);
  });

  it('items_json ilegible en una fila se saltea y se loguea UNA sola vez con el total; la marca se graba', async () => {
    const { sembrarWooOrdenSkus, MARCA_SIEMBRA } = await import('../lib/wooOrdenSkus.js');
    cacheConItems(500, ['A-1']);
    for (const id of [601, 602, 603]) db.prepare(`INSERT INTO pedidos_cache (clave, canal, wc_order_id, numero_pedido, comprador, fecha, estado_envio, items_json, actualizado_en)
      VALUES (?, 'web', ?, ?, 'X', '2026-10-14', 'pendiente', 'no-es-json', 'x')`).run(clave(id), id, String(id));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try { expect(sembrarWooOrdenSkus(db)).toBe(1); expect(log).toHaveBeenCalledTimes(1); expect(String(log.mock.calls[0][0])).toMatch(/3 fila/); } finally { log.mockRestore(); }
    expect(db.prepare('SELECT 1 FROM sync_estado WHERE clave = ?').get(MARCA_SIEMBRA)).toBeDefined();
  });

  it('una fila persistida desactualizada NO pierde un SKU que Preparación conoce: la unión incluye siempre los conocidos', async () => {
    db.prepare("INSERT INTO woo_orden_skus (order_id, skus_json, actualizado_en) VALUES ('500', '[\"A-1\"]', 'x')").run();
    cacheConItems(500, ['A-1', 'NUEVO-9']);
    error = NO_EXISTE();
    encolarOrdenWoo(db, 500); await corrida();
    expect(bolsas()).toEqual(['sku:A-1', 'sku:NUEVO-9']);
  });

  it('primer aviso en la papelera sin nada persistido: usa las líneas que Woo devuelve', async () => {
    orden = ord(500, 'trash', ['A-1', 'B-2']);
    encolarOrdenWoo(db, 500); await corrida();
    expect(bolsas()).toEqual(['sku:A-1', 'sku:B-2']);
  });

  it('404 sin ninguna fuente de SKUs: incidente de advertencia order_woo_sin_skus_<id> y el trabajo cierra (no queda reintentando)', async () => {
    error = NO_EXISTE();
    encolarOrdenWoo(db, 500); await corrida();
    expect(bolsas()).toEqual([]);
    expect(db.prepare("SELECT severidad FROM incidentes_operativos WHERE tipo_error = 'order_woo_sin_skus_500'").get()).toMatchObject({ severidad: 'advertencia' });
    expect(trabajo()).toMatchObject({ estado: 'hecho' });
  });
});
