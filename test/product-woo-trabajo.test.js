// Fase E-1c: trabajo durable `catalog.woo_product_sync` (producto Woo creado/modificado/borrado/restaurado). Woo (axios) y ML simulados.
// Importa QUÉ se borra, QUÉ se lleva a 0 y cuándo NO: el topic solo dispara; decide la relectura vigente.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import axios from 'axios';
import { openDb } from '../db/index.js';
import { procesarProductoWoo, procesarStockBolsa, procesarTrabajosRecurso, encolarProductoWoo } from '../routes/sync.js';
import { registrarWebhookWooProducto } from '../lib/workerIntegrationJobs.js';
import { skusConBajaWoo, levantarBajasReaparecidas } from '../lib/wooBajas.js';

vi.mock('axios');
vi.mock('../lib/mlClient.js', async () => {
  const actual = await vi.importActual('../lib/mlClient.js');
  return { ...actual, mlFetch: vi.fn(), estadoCooldownMl: () => ({ activo: false }) };
});
import { mlFetch } from '../lib/mlClient.js';

const TEST_DB = `./test/tmp-product-woo-trabajo.${process.pid}.sqlite`;
const CFG = { ml: { clientId: 'cid', clientSecret: 'cs', userId: '99999' }, woo: { url: 'https://fusionbikes.com.ar', ck: 'ck_x', cs: 'cs_x' } };
const limpiarDb = () => { for (const suf of ['', '-wal', '-shm', '-journal']) fs.rmSync(TEST_DB + suf, { force: true }); };

let db, woo, ml;
const ts = () => new Date().toISOString();

// Padre variable 1732 con dos variaciones, y un producto simple 500. Cada SKU tiene su publicación de ML (qty 5).
const SKUS = { 7247: 'FB-7247', 7248: 'FB-7248', 500: 'S-500' };
function seed() {
  const t = ts();
  const cat = db.prepare('INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, precio, regular_price, actualizado_en) VALUES (?, ?, ?, ?, ?, ?, 100, 100, ?)');
  cat.run(1732, 'Casco', 'FB-1732', 'variable', null, 0, t);
  cat.run(7247, 'Casco Halcón', 'FB-7247', 'variation', 1732, 5, t);
  cat.run(7248, 'Casco Búho', 'FB-7248', 'variation', 1732, 5, t);
  cat.run(500, 'Bomba', 'S-500', 'simple', null, 5, t);
  for (const [idw, sku] of Object.entries(SKUS)) {
    const clave = `MLA${idw}|`;
    db.prepare("INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en) VALUES (?, ?, 'x', 'confirmar', ?)").run(clave, sku, t);
    db.prepare("INSERT INTO ml_publicaciones_cache (clave, item_id, variation_id, status, seller_sku, available_quantity, actualizado_en) VALUES (?, ?, '', 'active', ?, 5, ?)").run(clave, `MLA${idw}`, sku, t);
    db.prepare('INSERT INTO ml_stock_estado (clave, sku, cantidad_ml, actualizado_en) VALUES (?, ?, 5, ?)').run(clave, sku, t);
  }
}

const respuestaError = (status, code) => ({ status, headers: {}, data: { code, message: 'x' } });
const productoWoo = (id, over = {}) => ({ id, name: `P${id}`, sku: SKUS[id] || `FB-${id}`, type: 'simple', status: 'publish', stock_quantity: 5, categories: [], attributes: [], images: [], brands: [], ...over });

function instalarMocks() {
  woo = {
    productos: { 1732: productoWoo(1732, { type: 'variable', sku: 'FB-1732', stock_quantity: null }), 500: productoWoo(500) },
    variaciones: { 1732: [{ id: 7247, sku: 'FB-7247', stock_quantity: 5, type: 'variation', attributes: [], image: null }, { id: 7248, sku: 'FB-7248', stock_quantity: 5, type: 'variation', attributes: [], image: null }] },
    error: {}, // path (sin query) → { status, code } para forzar errores
    llamadas: [],
  };
  ml = { qty: { MLA7247: 5, MLA7248: 5, MLA500: 5 }, puts: [] };
  axios.request.mockImplementation(async ({ url, method }) => {
    const p = url.replace('https://fusionbikes.com.ar/wp-json/wc/v3', '');
    woo.llamadas.push({ method, p });
    const sinQuery = p.split('?')[0];
    if (woo.error[sinQuery]) return respuestaError(woo.error[sinQuery].status, woo.error[sinQuery].code);
    let m;
    if ((m = /^\/products\/(\d+)\/variations$/.exec(sinQuery))) return { status: 200, headers: {}, data: woo.variaciones[m[1]] || [] };
    if ((m = /^\/products\/\d+\/variations\/(\d+)$/.exec(sinQuery))) {
      const v = woo.varDetalle && Number(m[1]) in woo.varDetalle ? woo.varDetalle[m[1]] : Object.values(woo.variaciones).flat().find((x) => x.id === Number(m[1]));
      return v ? { status: 200, headers: {}, data: v } : respuestaError(404, 'woocommerce_rest_product_variation_invalid_id');
    }
    if ((m = /^\/products\/(\d+)$/.exec(sinQuery))) {
      const prod = woo.productos[m[1]];
      return prod ? { status: 200, headers: {}, data: prod } : respuestaError(404, 'woocommerce_rest_product_invalid_id');
    }
    return { status: 200, headers: {}, data: {} };
  });
  mlFetch.mockImplementation(async (dbx, cfg, method, p, body) => {
    if (method === 'put') {
      const item = /\/items\/(MLA\d+)/.exec(p)[1];
      ml.puts.push({ item, cantidad: body.available_quantity });
      ml.qty[item] = body.available_quantity;
      return { status: 200, data: {} };
    }
    if (p.startsWith('/items/bulk')) {
      const ids = /ids=([^&]+)/.exec(p)[1].split(',');
      return { status: 200, data: ids.map((id) => ({ code: 200, body: { id, status: 'active', available_quantity: ml.qty[id] } })) };
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
  seed();
});
afterEach(() => { db.close(); limpiarDb(); });

const trabajo = (recurso) => db.prepare("SELECT * FROM trabajos_recurso WHERE tipo = 'catalog.woo_product_sync' AND recurso = ?").get(String(recurso));
const bolsas = () => db.prepare("SELECT recurso FROM trabajos_recurso WHERE tipo = 'stock.bolsa' ORDER BY recurso").all().map((r) => r.recurso);
const enCache = (id) => Boolean(db.prepare('SELECT 1 FROM catalogo_cache WHERE id_woo = ?').get(id));
const bajas = () => db.prepare('SELECT sku FROM woo_bajas_confirmadas ORDER BY sku').all().map((r) => r.sku);
const casosWoo = () => db.prepare("SELECT ml_key FROM identidad_casos WHERE direccion = 'woo_ml' AND resuelto_en IS NULL ORDER BY ml_key").all().map((r) => r.ml_key);
const escrituraWoo = () => woo.llamadas.filter((l) => l.method && l.method !== 'get');
const correr = async () => procesarTrabajosRecurso(db, CFG);

describe('catalog.woo_product_sync: producto vigente (created/updated/restored)', () => {
  it('relee el padre y sus variaciones, refresca el caché y encola la bolsa de cada SKU; la bolsa empuja el stock nuevo a ML', async () => {
    woo.productos[1732] = productoWoo(1732, { type: 'variable', sku: 'FB-1732', stock_quantity: null });
    woo.variaciones[1732] = [{ id: 7247, sku: 'FB-7247', stock_quantity: 2, type: 'variation', attributes: [], image: null }, { id: 7248, sku: 'FB-7248', stock_quantity: 5, type: 'variation', attributes: [], image: null }];
    encolarProductoWoo(db, { productoId: 7247, parentId: 1732 });
    await correr();
    expect(db.prepare('SELECT stock FROM catalogo_cache WHERE id_woo = 7247').get().stock).toBe(2);
    expect(trabajo(1732)).toMatchObject({ estado: 'hecho' });
    expect(bolsas()).toEqual(expect.arrayContaining(['sku:FB-1732', 'sku:FB-7247', 'sku:FB-7248']));
    expect(ml.puts).toEqual([{ item: 'MLA7247', cantidad: 2 }]); // solo difiere el 7247
    expect(bajas()).toEqual([]);
  });

  it('una baja nunca escribe en Woo: toda llamada a Woo es un GET', async () => {
    delete woo.variaciones[1732][1];
    woo.variaciones[1732] = woo.variaciones[1732].filter(Boolean);
    encolarProductoWoo(db, { productoId: 1732 });
    await correr();
    delete woo.productos[500];
    encolarProductoWoo(db, { productoId: 500 });
    await correr();
    expect(woo.llamadas.length).toBeGreaterThan(0);
    expect(escrituraWoo()).toEqual([]);
  });
});

describe('catalog.woo_product_sync: variación que desaparece del padre vigente', () => {
  it('borrar una variación de un padre vigente la protege y lleva ML a 0, también si llega solo como product.updated', async () => {
    woo.variaciones[1732] = [{ id: 7247, sku: 'FB-7247', stock_quantity: 5, type: 'variation', attributes: [], image: null }]; // el 7248 ya no está
    // el aviso es un product.updated del PADRE (no un deleted): el recibo real
    registrarWebhookWooProducto(db, { id: 1732 }, { topic: 'product.updated', deliveryId: 'u1' });
    expect(trabajo(1732)).toMatchObject({ estado: 'pendiente' });
    await correr();
    expect(enCache(7248)).toBe(false);
    expect(enCache(7247)).toBe(true);
    expect(bajas()).toEqual(['FB-7248']);
    expect(casosWoo()).toEqual(['MLA7248|']); // protegerPorBajaWoo abrió el caso urgente sobre su publicación
    expect(ml.puts).toEqual([{ item: 'MLA7248', cantidad: 0 }]); // y la bolsa la llevó a 0 aunque ya no esté en catalogo_cache
    expect(ml.qty.MLA7247).toBe(5);
  });

  it('también cuando el aviso es product.deleted de esa variación (parent_id en el aviso)', async () => {
    woo.variaciones[1732] = [{ id: 7247, sku: 'FB-7247', stock_quantity: 5, type: 'variation', attributes: [], image: null }];
    registrarWebhookWooProducto(db, { id: 7248, parent_id: 1732 }, { topic: 'product.deleted', deliveryId: 'd1' });
    await correr();
    expect(bajas()).toEqual(['FB-7248']);
    expect(ml.puts).toEqual([{ item: 'MLA7248', cantidad: 0 }]);
  });

  it('un padre que deja de ser variable da de baja a las hijas que ya no expone', async () => {
    woo.productos[1732] = productoWoo(1732, { type: 'simple', sku: 'FB-1732', stock_quantity: 3 });
    encolarProductoWoo(db, { productoId: 1732 });
    await correr();
    expect(bajas()).toEqual(['FB-7247', 'FB-7248']);
    expect(ml.puts.map((x) => x.item).sort()).toEqual(['MLA7247', 'MLA7248']);
  });
});

describe('catalog.woo_product_sync: product.deleted decide la relectura, no el topic', () => {
  it('un product.deleted atrasado sobre un producto restaurado (la relectura lo encuentra vigente) no lo borra ni lleva nada a 0', async () => {
    registrarWebhookWooProducto(db, { id: 500 }, { topic: 'product.deleted', deliveryId: 'tarde' });
    await correr();
    expect(enCache(500)).toBe(true);
    expect(bajas()).toEqual([]);
    expect(casosWoo()).toEqual([]);
    expect(ml.puts).toEqual([]);
    expect(trabajo(500)).toMatchObject({ estado: 'hecho' });
  });

  it('404 invalid_id confirma la baja: borra el producto, conserva el SKU, protege y lleva ML a 0 aunque ya no esté en catalogo_cache', async () => {
    delete woo.productos[500];
    registrarWebhookWooProducto(db, { id: 500 }, { topic: 'product.deleted', deliveryId: 'real' });
    await correr();
    expect(enCache(500)).toBe(false);
    expect(bajas()).toEqual(['S-500']);
    expect(casosWoo()).toEqual(['MLA500|']);
    expect(ml.puts).toEqual([{ item: 'MLA500', cantidad: 0 }]);
    expect(trabajo(500)).toMatchObject({ estado: 'hecho' });
  });

  it('baja del padre variable: se dan de baja el padre y todas sus variaciones', async () => {
    delete woo.productos[1732];
    registrarWebhookWooProducto(db, { id: 1732 }, { topic: 'product.deleted', deliveryId: 'padre' });
    await correr();
    expect([1732, 7247, 7248].some(enCache)).toBe(false);
    expect(bajas()).toEqual(['FB-1732', 'FB-7247', 'FB-7248']);
    expect(ml.puts.map((x) => x.item).sort()).toEqual(['MLA7247', 'MLA7248']);
  });

  it('status=trash también es baja confirmada', async () => {
    woo.productos[500] = productoWoo(500, { status: 'trash' });
    registrarWebhookWooProducto(db, { id: 500 }, { topic: 'product.deleted', deliveryId: 'trash' });
    await correr();
    expect(enCache(500)).toBe(false);
    expect(bajas()).toEqual(['S-500']);
    expect(ml.puts).toEqual([{ item: 'MLA500', cantidad: 0 }]);
  });

  it('una lectura con 5xx NO baja ni lleva a 0: reencola con backoff y el producto sigue', async () => {
    woo.error['/products/500'] = { status: 503, code: 'service_unavailable' };
    registrarWebhookWooProducto(db, { id: 500 }, { topic: 'product.deleted', deliveryId: '5xx' });
    await correr();
    expect(enCache(500)).toBe(true);
    expect(bajas()).toEqual([]);
    expect(casosWoo()).toEqual([]);
    expect(ml.puts).toEqual([]);
    expect(bolsas()).toEqual([]);
    expect(trabajo(500)).toMatchObject({ estado: 'pendiente', fallos_consecutivos: 1 });
  });

  it('un 404 genérico (sin invalid_id: ruta rota, plugin apagado) tampoco prueba la baja', async () => {
    woo.error['/products/500'] = { status: 404, code: 'rest_no_route' };
    registrarWebhookWooProducto(db, { id: 500 }, { topic: 'product.deleted', deliveryId: '404' });
    await correr();
    expect(enCache(500)).toBe(true);
    expect(bajas()).toEqual([]);
    expect(ml.puts).toEqual([]);
    expect(trabajo(500)).toMatchObject({ estado: 'pendiente' });
  });

  it('un error al leer las VARIACIONES del padre tampoco da de baja a nadie (el refresco aborta entero)', async () => {
    woo.error['/products/1732/variations'] = { status: 500, code: 'internal' };
    encolarProductoWoo(db, { productoId: 1732 });
    await correr();
    expect(enCache(7248)).toBe(true);
    expect(bajas()).toEqual([]);
    expect(ml.puts).toEqual([]);
  });
});

describe('stock.bolsa con una baja Woo confirmada', () => {
  beforeEach(() => {
    db.prepare("INSERT INTO woo_bajas_confirmadas (sku, id_woo, motivo, confirmada_en) VALUES ('S-500', 500, 'baja_woo', ?)").run(ts());
    db.prepare('DELETE FROM catalogo_cache WHERE id_woo = 500').run();
  });

  it('empuja 0 aun con el caso de identidad abierto y aunque el producto ya no esté en catalogo_cache', async () => {
    db.prepare(`INSERT INTO identidad_casos (direccion, ml_key, clasificacion, estado, severidad, evidencia_fingerprint, expected_version, primera_deteccion_en, ultima_deteccion_en)
      VALUES ('woo_ml', 'MLA500|', 'baja_woo', 'urgente', 'critica', 'fp', 1, ?, ?)`).run(ts(), ts());
    const r = await procesarStockBolsa(db, CFG, 'S-500');
    expect(r.estado).toBe('hecho');
    expect(ml.puts).toEqual([{ item: 'MLA500', cantidad: 0 }]);
  });

  it('si ML ya publica 0 no escribe de nuevo (idempotente)', async () => {
    ml.qty.MLA500 = 0;
    const r = await procesarStockBolsa(db, CFG, 'S-500');
    expect(r.estado).toBe('hecho');
    expect(ml.puts).toEqual([]);
  });

  it('una lectura de ML con 5xx no da nada por hecho (reencola)', async () => {
    mlFetch.mockImplementation(async (dbx, cfg, method, p) => (p.startsWith('/items/bulk') ? { status: 503, data: null } : { status: 404, data: {} }));
    const r = await procesarStockBolsa(db, CFG, 'S-500').catch((e) => ({ estado: 'excepcion', e }));
    expect(['reencolar', 'excepcion']).toContain(r.estado);
    expect(ml.puts).toEqual([]);
  });

  it('el producto restaurado (el SKU vuelve al catálogo) levanta la baja y ML vuelve al stock de Woo', async () => {
    ml.qty.MLA500 = 0;
    woo.productos[500] = productoWoo(500, { stock_quantity: 4 });
    registrarWebhookWooProducto(db, { id: 500 }, { topic: 'product.restored', deliveryId: 'rest' });
    await correr();
    expect(enCache(500)).toBe(true);
    expect(bajas()).toEqual([]);
    expect(ml.puts).toEqual([{ item: 'MLA500', cantidad: 4 }]);
    expect(casosWoo()).toEqual([]);
  });

  it('levantarBajasReaparecidas levanta (una query) las bajas cuyo SKU reapareció; skusConBajaWoo es lectura pura', () => {
    expect([...skusConBajaWoo(db, ['S-500', 'OTRO'])]).toEqual(['S-500']);
    expect([...skusConBajaWoo(db, ['S-500'])]).toEqual(['S-500']); // leer no levanta nada
    db.prepare("INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, stock, actualizado_en) VALUES (900, 'Nuevo', 'S-500', 'simple', 1, ?)").run(ts());
    expect(bajas()).toEqual(['S-500']);
    expect(levantarBajasReaparecidas(db)).toEqual(['S-500']);
    expect(bajas()).toEqual([]);
  });

  it('una publicación de ML con ese seller_sku pero SIN decisión de vínculo también se lleva a 0 (solo por baja confirmada)', async () => {
    db.prepare("INSERT INTO ml_publicaciones_cache (clave, item_id, variation_id, status, seller_sku, available_quantity, actualizado_en) VALUES ('MLA600|', 'MLA600', '', 'active', 'S-500', 5, ?)").run(ts());
    ml.qty.MLA600 = 5;
    ml.qty.MLA500 = 0;
    await procesarStockBolsa(db, CFG, 'S-500');
    expect(ml.puts).toEqual([{ item: 'MLA600', cantidad: 0 }]);
  });
});

describe('guarda contra una lista de variaciones anómala', () => {
  it('[] con variaciones previas NO da de baja ni encola un 0 si las lecturas individuales las encuentran vigentes', async () => {
    woo.variaciones[1732] = [];
    woo.varDetalle = { 7247: { id: 7247, sku: 'FB-7247', stock_quantity: 5, type: 'variation', attributes: [] }, 7248: { id: 7248, sku: 'FB-7248', stock_quantity: 5, type: 'variation', attributes: [] } };
    encolarProductoWoo(db, { productoId: 1732 });
    await correr();
    expect(enCache(7247) && enCache(7248)).toBe(true);
    expect(bajas()).toEqual([]);
    expect(casosWoo()).toEqual([]);
    expect(ml.puts).toEqual([]);
  });

  it('[] con previas y un error de lectura individual aborta: no borra ni baja, reencola', async () => {
    woo.variaciones[1732] = [];
    woo.error['/products/1732/variations/7247'] = { status: 500, code: 'internal' };
    encolarProductoWoo(db, { productoId: 1732 });
    await correr();
    expect(enCache(7247) && enCache(7248)).toBe(true);
    expect(bajas()).toEqual([]);
    expect(trabajo(1732)).toMatchObject({ estado: 'pendiente', fallos_consecutivos: 1 });
  });

  it('pérdida total confirmada por 404 invalid_id de cada variación sí da de baja', async () => {
    woo.variaciones[1732] = [];
    woo.varDetalle = { 7247: null, 7248: null };
    encolarProductoWoo(db, { productoId: 1732 });
    await correr();
    expect(bajas()).toEqual(['FB-7247', 'FB-7248']);
    expect(ml.puts.map((x) => x.item).sort()).toEqual(['MLA7247', 'MLA7248']);
  });

  it('pérdida de la mayoría (2 de 3): se confirma cada faltante; la que sigue vigente se conserva', async () => {
    db.prepare("INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, actualizado_en) VALUES (7249, 'Otra', 'FB-7249', 'variation', 1732, 1, ?)").run(ts());
    woo.variaciones[1732] = [{ id: 7247, sku: 'FB-7247', stock_quantity: 5, type: 'variation', attributes: [] }];
    woo.varDetalle = { 7248: null, 7249: { id: 7249, sku: 'FB-7249', stock_quantity: 1, type: 'variation', attributes: [] } };
    encolarProductoWoo(db, { productoId: 1732 });
    await correr();
    expect(bajas()).toEqual(['FB-7248']);
    expect(enCache(7249)).toBe(true);
  });

  it('una respuesta de variaciones que no es lista es un error reintentable, no «sin variaciones»', async () => {
    woo.variaciones[1732] = { code: 'raro' };
    encolarProductoWoo(db, { productoId: 1732 });
    await correr();
    expect(enCache(7247) && enCache(7248)).toBe(true);
    expect(bajas()).toEqual([]);
    expect(trabajo(1732)).toMatchObject({ estado: 'pendiente', fallos_consecutivos: 1 });
  });

  it('el padre que deja de ser variable da de baja las hijas sin segunda lectura', async () => {
    woo.productos[1732] = productoWoo(1732, { type: 'simple', sku: 'FB-1732', stock_quantity: 3 });
    encolarProductoWoo(db, { productoId: 1732 });
    await correr();
    expect(bajas()).toEqual(['FB-7247', 'FB-7248']);
    expect(woo.llamadas.some((l) => /variations\/\d+/.test(l.p))).toBe(false);
  });
});

describe('diff por SKU, no por id', () => {
  it('variación presente con SKU vacío: no es baja (su SKU no se lleva a 0)', async () => {
    woo.variaciones[1732] = [{ id: 7247, sku: 'FB-7247', stock_quantity: 5, type: 'variation', attributes: [] }, { id: 7248, sku: '', stock_quantity: 5, type: 'variation', attributes: [] }];
    encolarProductoWoo(db, { productoId: 1732 });
    await correr();
    expect(bajas()).toEqual([]);
    expect(casosWoo()).toEqual([]);
    expect(ml.puts).toEqual([]);
  });

  it('variación que cambia de SKU (mismo id): el SKU viejo, que ya no existe, queda como baja y su ML va a 0', async () => {
    woo.variaciones[1732] = [{ id: 7247, sku: 'FB-7247', stock_quantity: 5, type: 'variation', attributes: [] }, { id: 7248, sku: 'FB-7248-NUEVO', stock_quantity: 5, type: 'variation', attributes: [] }];
    encolarProductoWoo(db, { productoId: 1732 });
    await correr();
    expect(bajas()).toEqual(['FB-7248']);
    expect(ml.puts).toEqual([{ item: 'MLA7248', cantidad: 0 }]);
  });

  it('SKU que se mueve a otra variación (otro id): sigue vigente, no se protege ni se lleva a 0', async () => {
    woo.variaciones[1732] = [{ id: 7247, sku: 'FB-7247', stock_quantity: 5, type: 'variation', attributes: [] }, { id: 7250, sku: 'FB-7248', stock_quantity: 5, type: 'variation', attributes: [] }];
    encolarProductoWoo(db, { productoId: 1732 });
    await correr();
    expect(bajas()).toEqual([]);
    expect(casosWoo()).toEqual([]);
    expect(ml.puts).toEqual([]);
  });
});

describe('recibo → trabajo', () => {
  it('el recibo encola el trabajo en la misma transacción (antes del ACK) y marca el evento para que el job viejo no lo repita', () => {
    const r = registrarWebhookWooProducto(db, { id: 500 }, { topic: 'product.updated', deliveryId: 'x1' });
    expect(trabajo(500)).toMatchObject({ estado: 'pendiente', generacion: 1 });
    expect(JSON.parse(db.prepare('SELECT metadata_json FROM integration_events WHERE event_id = ?').get(r.eventId).metadata_json).trabajo_recurso).toBe(true);
    registrarWebhookWooProducto(db, { id: 500 }, { topic: 'product.updated', deliveryId: 'x1' }); // entrega repetida
    expect(trabajo(500).generacion).toBe(1);
  });

  it('un aviso durante el procesamiento deja el trabajo dirty y se repite (no se pierde)', async () => {
    registrarWebhookWooProducto(db, { id: 500 }, { topic: 'product.updated', deliveryId: 'a' });
    const llegaOtro = () => registrarWebhookWooProducto(db, { id: 500 }, { topic: 'product.updated', deliveryId: 'b' });
    axios.request.mockImplementationOnce(async () => { llegaOtro(); return { status: 200, headers: {}, data: productoWoo(500) }; });
    await correr();
    expect(trabajo(500)).toMatchObject({ estado: 'pendiente' }); // repite por el aviso nuevo
    await correr();
    expect(trabajo(500)).toMatchObject({ estado: 'hecho' });
  });

  it('procesarProductoWoo con id inválido se cierra sin reintentar para siempre', async () => {
    expect(await procesarProductoWoo(db, CFG, 'abc')).toMatchObject({ estado: 'hecho' });
  });
});
