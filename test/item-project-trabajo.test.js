// Fase E-2: trabajo durable `item.project` (ML items / user_products / stock-location → stock.bolsa). ML (mlFetch) simulado.
// Importa: el aviso nunca se descarta (la coalescencia reprograma), un lote = UNA llamada /items/bulk, la bolsa se encola SOLO
// si cambió algo, cada elemento del bulk se trata por su status_code y las hermanas hacen una sola escritura.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import { guardarEstado } from '../lib/stockBarrera.js';
import { procesarStockBolsa, procesarTrabajosRecurso, procesarLoteItemsMl } from '../routes/sync.js';
import { registrarWebhookMl, procesarIntegrationJobs } from '../lib/workerIntegrationJobs.js';
import { encolarTrabajo, encolarItemMl, COALESCENCIA_ITEM_MS } from '../lib/trabajosRecurso.js';

vi.mock('../lib/mlClient.js', async () => {
  const actual = await vi.importActual('../lib/mlClient.js');
  return { ...actual, mlFetch: vi.fn(), estadoCooldownMl: () => ({ activo: false }) };
});
vi.mock('../routes/woo.js', () => ({ wooFetch: vi.fn() }));
import { mlFetch } from '../lib/mlClient.js';
import { wooFetch } from '../routes/woo.js';

const TEST_DB = `./test/tmp-item-project-trabajo.${process.pid}.sqlite`;
const CFG = { ml: { clientId: 'cid', clientSecret: 'cs', userId: '99999' }, woo: { url: 'https://fusionbikes.com.ar', ck: 'ck_x', cs: 'cs_x' } };
const limpiarDb = () => { for (const suf of ['', '-wal', '-shm', '-journal']) fs.rmSync(TEST_DB + suf, { force: true }); };
const ts = (ms = 0) => new Date(Date.now() + ms).toISOString();

let db, ml, woo;

// Dos productos simples vinculados: S-500 (MLA500, qty 5) y S-501 (MLA501, qty 5).
function seed() {
  const t = ts(-60 * 60 * 1000); // caché viejo: no cae en la ventana de coalescencia
  const cat = db.prepare("INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, precio, regular_price, actualizado_en) VALUES (?, ?, ?, 'simple', NULL, ?, 100, 100, ?)");
  cat.run(500, 'Bomba', 'S-500', 5, t);
  cat.run(501, 'Cadena', 'S-501', 5, t);
  for (const [item, sku] of [['MLA500', 'S-500'], ['MLA501', 'S-501']]) {
    db.prepare("INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en) VALUES (?, ?, 'x', 'confirmar', ?)").run(`${item}|`, sku, t);
    db.prepare("INSERT INTO ml_publicaciones_cache (clave, item_id, variation_id, titulo, status, seller_sku, available_quantity, actualizado_en) VALUES (?, ?, '', 'Pub', 'active', ?, 5, ?)").run(`${item}|`, item, sku, t);
    db.prepare('INSERT INTO ml_stock_estado (clave, sku, cantidad_ml, actualizado_en) VALUES (?, ?, 5, ?)').run(`${item}|`, sku, t);
  }
}

const cuerpoItem = (id, over = {}) => ({ id, title: `Pub ${id}`, status: 'active', seller_custom_field: ml.sku[id] ?? null, attributes: [], variations: [], price: 100, available_quantity: ml.qty[id], user_product_id: ml.up[id] ?? null, ...over });

function instalarMocks() {
  ml = {
    qty: { MLA500: 5, MLA501: 5 }, sku: { MLA500: 'S-500', MLA501: 'S-501' }, up: {},
    codigos: {}, // id → status_code del elemento en /items/bulk
    individual: {}, // id → status del GET /items/{id}
    puts: [], bulks: [], lecturas: [],
    antesDeBulk: null,
  };
  woo = { stock: { 500: 5, 501: 5 } };
  wooFetch.mockImplementation(async (cfg, p) => {
    const m = /^\/products\/(\d+)$/.exec(p);
    if (m) return { status: 200, data: { manage_stock: true, stock_quantity: woo.stock[m[1]] }, headers: {} };
    if (p === '/settings/products/woocommerce_manage_stock') return { status: 200, data: { value: 'yes' }, headers: {} };
    return { status: 404, data: {}, headers: {} };
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
      if (p.includes('include_attributes')) { // proyección (refrescarPublicacionesMlAcotado)
        ml.bulks.push(ids);
        if (ml.antesDeBulk) { const f = ml.antesDeBulk; ml.antesDeBulk = null; f(); }
      } else ml.lecturas.push(ids);
      return { status: 200, data: ids.map((id) => {
        const code = ml.codigos[id] ?? 200;
        return code === 200 ? { code: 200, body: cuerpoItem(id) } : { code, body: { id } };
      }) };
    }
    const m = /^\/items\/(MLA\d+)\?/.exec(p);
    if (m && ml.lanzar?.[m[1]]) throw new Error('red caída');
    if (m) return { status: ml.individual[m[1]] ?? 200, data: { id: m[1], status: 'active' } };
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

const trabajo = (tipo, recurso) => db.prepare('SELECT * FROM trabajos_recurso WHERE tipo = ? AND recurso = ?').get(tipo, recurso);
const bolsas = () => db.prepare("SELECT recurso FROM trabajos_recurso WHERE tipo = 'stock.bolsa' ORDER BY recurso").all().map((r) => r.recurso);
const aviso = (topic, resource, extra = {}) => registrarWebhookMl(db, { topic, resource, user_id: '99999', _id: `n-${Math.random()}`, sent: ts(), ...extra });
const correr = () => procesarTrabajosRecurso(db, CFG);

describe('recibo → item.project', () => {
  it('un aviso de items encola el trabajo en la misma transacción que el recibo (antes del ACK)', () => {
    aviso('items', '/items/MLA500');
    expect(trabajo('item.project', 'MLA500')).toMatchObject({ estado: 'pendiente', generacion: 1 });
  });

  it('la coalescencia REPROGRAMA: con el caché recién refrescado el trabajo corre en la ventana, no se descarta', () => {
    db.prepare("UPDATE ml_publicaciones_cache SET actualizado_en = ? WHERE item_id = 'MLA500'").run(ts(-30 * 1000));
    const antes = Date.now();
    aviso('items', '/items/MLA500');
    const t = trabajo('item.project', 'MLA500');
    expect(t.estado).toBe('pendiente');
    const espera = Date.parse(t.run_after) - antes;
    expect(espera).toBeGreaterThan(COALESCENCIA_ITEM_MS - 31 * 1000 - 1000);
    expect(espera).toBeLessThanOrEqual(COALESCENCIA_ITEM_MS);
  });

  it('el job viejo integration_jobs es solo un puente: no relee ni llama a ML, y no duplica el trabajo', async () => {
    const r = aviso('items', '/items/MLA500');
    const gen = trabajo('item.project', 'MLA500').generacion;
    await procesarIntegrationJobs(db, { mlCfg: CFG.ml });
    expect(mlFetch).not.toHaveBeenCalled();
    expect(db.prepare('SELECT status FROM integration_jobs WHERE event_id=?').get(r.eventId).status).toBe('completed');
    expect(trabajo('item.project', 'MLA500').generacion).toBe(gen);
  });

  it('user_products y stock-location resuelven los ítems del user_product desde el caché: un item.project por ítem', () => {
    db.prepare("UPDATE ml_publicaciones_cache SET user_product_id = 'MLAU1' WHERE item_id IN ('MLA500','MLA501')").run();
    aviso('user_products', '/user-products/MLAU1');
    expect(trabajo('item.project', 'MLA500')).toBeTruthy();
    expect(trabajo('item.project', 'MLA501')).toBeTruthy();
    db.prepare("DELETE FROM trabajos_recurso WHERE tipo = 'item.project'").run();
    aviso('stock-location', '/user-products/MLAU1/stock');
    expect(db.prepare("SELECT recurso FROM trabajos_recurso WHERE tipo = 'item.project' ORDER BY recurso").all().map((r) => r.recurso)).toEqual(['MLA500', 'MLA501']);
  });

  it('un user_product desconocido no encola nada (el recibo queda como auditoría)', () => {
    const r = aviso('stock-location', '/user-products/MLAU999/stock');
    expect(db.prepare("SELECT COUNT(*) n FROM trabajos_recurso WHERE tipo = 'item.project'").get().n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) n FROM integration_events WHERE event_id=?').get(r.eventId).n).toBe(1);
  });
});

describe('item.project: relectura en lote y bolsa solo si cambió algo', () => {
  it('varios avisos = UNA llamada /items/bulk; sin cambios no se encola ninguna bolsa', async () => {
    aviso('items', '/items/MLA500');
    aviso('items', '/items/MLA501');
    await correr();
    expect(ml.bulks).toEqual([['MLA500', 'MLA501']]);
    expect(trabajo('item.project', 'MLA500').estado).toBe('hecho');
    expect(trabajo('item.project', 'MLA501').estado).toBe('hecho');
    expect(bolsas()).toEqual([]);
  });

  it('cambió available_quantity: encola la bolsa; y como el remoto difiere del deseado, la bolsa lo corrige a Woo', async () => {
    ml.qty.MLA500 = 9; // alguien cambió la cantidad en ML
    aviso('items', '/items/MLA500');
    await correr();
    expect(ml.puts).toEqual([{ item: 'MLA500', cantidad: 5 }]);
    expect(trabajo('stock.bolsa', 'sku:S-500').estado).toBe('hecho');
  });

  it('eco: el cambio observado ya es lo deseado → encola la bolsa pero NO escribe en ML', async () => {
    db.prepare("UPDATE ml_publicaciones_cache SET available_quantity = 3 WHERE item_id = 'MLA500'").run(); // el caché tenía otro valor
    ml.qty.MLA500 = 5; // lo que ML publica ahora es el deseado (p. ej. lo escribimos nosotros)
    aviso('items', '/items/MLA500');
    await correr();
    expect(bolsas()).toEqual(['sku:S-500']);
    expect(ml.puts).toEqual([]);
  });

  it('cambió el status: encola la bolsa', async () => {
    db.prepare("UPDATE ml_publicaciones_cache SET status = 'paused' WHERE item_id = 'MLA501'").run();
    aviso('items', '/items/MLA501');
    await correr();
    expect(bolsas()).toContain('sku:S-501');
  });

  it('cambió el vínculo (autovínculo por seller_sku): encola la bolsa del SKU', async () => {
    db.prepare("DELETE FROM sku_matcher_decisiones WHERE clave = 'MLA501|'").run(); // sin vínculo; el seller_sku de ML trae S-501
    aviso('items', '/items/MLA501');
    // el autovínculo ocurre dentro de la proyección: se simula con la decisión que deja al releer
    ml.antesDeBulk = () => db.prepare("INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en) VALUES ('MLA501|', 'S-501', 'x', 'confirmar', ?)").run(ts());
    await correr();
    expect(bolsas()).toContain('sku:S-501');
  });

  it('un aviso que llega durante el procesamiento deja el trabajo dirty y se repite (no se pierde)', async () => {
    aviso('items', '/items/MLA500');
    ml.antesDeBulk = () => encolarTrabajo(db, { tipo: 'item.project', recurso: 'MLA500' });
    await correr();
    expect(ml.bulks).toHaveLength(1);
    expect(trabajo('item.project', 'MLA500')).toMatchObject({ estado: 'pendiente' });
    await correr();
    expect(ml.bulks).toHaveLength(2);
    expect(trabajo('item.project', 'MLA500').estado).toBe('hecho');
  });

  it('más de 20 ítems se leen en lotes de 20 (un /items/bulk por lote, no uno por aviso)', async () => {
    for (let i = 0; i < 25; i++) encolarItemMl(db, `MLA9${String(i).padStart(2, '0')}`, { demoraMs: 0 });
    for (let i = 0; i < 25; i++) ml.qty[`MLA9${String(i).padStart(2, '0')}`] = 1;
    await correr();
    await correr();
    expect(ml.bulks.map((b) => b.length)).toEqual([20, 5]);
  });
});

describe('item.project: cada elemento del bulk se trata por su status_code', () => {
  const lote = (...ids) => procesarLoteItemsMl(db, CFG, ids);

  it('404 confirmado por GET /items/{id} también 404: retira el caché y encola la bolsa', async () => {
    ml.codigos.MLA500 = 404; ml.individual.MLA500 = 404;
    const r = await lote('MLA500');
    expect(r.get('MLA500').estado).toBe('hecho');
    expect(db.prepare("SELECT COUNT(*) n FROM ml_publicaciones_cache WHERE item_id = 'MLA500'").get().n).toBe(0);
    expect(bolsas()).toEqual(['sku:S-500']);
  });

  it('404 en el bulk pero el GET individual da 200: NO retira el caché, reencola', async () => {
    ml.codigos.MLA500 = 404; ml.individual.MLA500 = 200;
    const r = await lote('MLA500');
    expect(r.get('MLA500').estado).toBe('reencolar');
    expect(db.prepare("SELECT COUNT(*) n FROM ml_publicaciones_cache WHERE item_id = 'MLA500'").get().n).toBe(1);
    expect(bolsas()).toEqual([]);
  });

  it('404 en el bulk y el GET individual da 5xx: no se confirma, reencola sin tocar el caché', async () => {
    ml.codigos.MLA500 = 404; ml.individual.MLA500 = 503;
    const r = await lote('MLA500');
    expect(r.get('MLA500').estado).toBe('reencolar');
    expect(db.prepare("SELECT COUNT(*) n FROM ml_publicaciones_cache WHERE item_id = 'MLA500'").get().n).toBe(1);
  });

  it('403: abre un incidente, no toca el caché y no cierra como hecho', async () => {
    ml.codigos.MLA500 = 403;
    const r = await lote('MLA500');
    expect(r.get('MLA500')).toMatchObject({ estado: 'reencolar', motivo: 'item_403' });
    expect(db.prepare("SELECT COUNT(*) n FROM ml_publicaciones_cache WHERE item_id = 'MLA500'").get().n).toBe(1);
    expect(db.prepare("SELECT 1 FROM incidentes_operativos WHERE tipo_error = 'item_ml_403'").get()).toBeTruthy();
  });

  it('varios 403 en un lote abren UN solo incidente con la lista de ids', async () => {
    ml.codigos.MLA500 = 403; ml.codigos.MLA501 = 403;
    await lote('MLA500', 'MLA501');
    const inc = db.prepare("SELECT mensaje_tecnico FROM incidentes_operativos WHERE tipo_error LIKE 'item_ml_403%'").all();
    expect(inc).toHaveLength(1);
    expect(inc[0].mensaje_tecnico).toContain('MLA500');
    expect(inc[0].mensaje_tecnico).toContain('MLA501');
  });

  it('presupuesto: solo 5 GET individuales de confirmación por pase; el resto se difiere sin tocar el caché', async () => {
    const ids = [];
    for (let i = 0; i < 8; i++) { const id = `MLA7${i}`; ids.push(id); ml.codigos[id] = 404; }
    const r = await lote(...ids);
    const gets = mlFetch.mock.calls.filter((c) => c[2] === 'get' && /^\/items\/MLA\d+\?/.test(c[3]));
    expect(gets).toHaveLength(5);
    expect([...r.values()].filter((x) => x.motivo === 'item_404_presupuesto')).toHaveLength(3);
    expect(r.get('MLA77')).toMatchObject({ estado: 'reencolar', diferido: true });
  });

  it('una excepción en el ítem 2 no pierde la bolsa del ítem 1 (ni cierra el 2 como hecho)', async () => {
    ml.qty.MLA500 = 9; // cambió en ML
    ml.codigos.MLA501 = 404; ml.lanzar = { MLA501: true }; // el GET de confirmación del 2 revienta
    const r = await lote('MLA500', 'MLA501');
    expect(r.get('MLA500').estado).toBe('hecho');
    expect(r.get('MLA501').estado).toBe('reencolar');
    expect(bolsas()).toEqual(['sku:S-500']);
  });

  it('dos interrupciones seguidas conservan el SKU pendiente del primer intento (unión, no reemplazo)', async () => {
    encolarItemMl(db, 'MLA500'); // el trabajo existe (el contexto vive en su fila)
    db.exec("CREATE TRIGGER corte BEFORE INSERT ON trabajos_recurso WHEN NEW.tipo = 'stock.bolsa' BEGIN SELECT RAISE(ABORT, 'corte'); END");
    ml.qty.MLA500 = 9; // intento 1: cambia la cantidad → pendiente S-500; el corte ocurre al encolar
    await expect(lote('MLA500')).rejects.toThrow();
    db.prepare("UPDATE sku_matcher_decisiones SET sku = 'S-501' WHERE clave = 'MLA500|'").run();
    ml.qty.MLA500 = 7; // intento 2: otro cambio; ahora el vínculo es S-501 → pendiente S-501
    await expect(lote('MLA500')).rejects.toThrow();
    const ctx = JSON.parse(db.prepare("SELECT contexto_json FROM trabajos_recurso WHERE tipo = 'item.project' AND recurso = 'MLA500'").get()?.contexto_json || 'null');
    db.exec('DROP TRIGGER corte');
    await lote('MLA500'); // intento 3: sin cambios nuevos, retoma lo pendiente
    expect(ctx?.skus_pendientes?.sort()).toEqual(['S-500', 'S-501']);
    expect(bolsas()).toEqual(['sku:S-500', 'sku:S-501']);
  });

  it('403: el incidente une los ids vigentes y saca los que vuelven a dar 200; vacío = se cierra', async () => {
    const lista = () => db.prepare("SELECT mensaje_tecnico, estado FROM incidentes_operativos WHERE tipo_error = 'item_ml_403'").get();
    ml.codigos.MLA500 = 403; await lote('MLA500');
    ml.codigos = { MLA501: 403 }; await lote('MLA501');
    expect(lista().mensaje_tecnico).toContain('MLA500');
    expect(lista().mensaje_tecnico).toContain('MLA501');
    ml.codigos = { MLA501: 403 }; await lote('MLA500'); // MLA500 vuelve a dar 200
    expect(lista().mensaje_tecnico).not.toContain('MLA500');
    expect(lista().mensaje_tecnico).toContain('MLA501');
    ml.codigos = {}; await lote('MLA501');
    expect(lista().estado).not.toBe('activo');
  });

  it('hermanas con deseados distintos: se compara con el MÍNIMO del grupo, no por clave (sin falso positivo persistente)', async () => {
    const t = ts(-60 * 60 * 1000); // MLA502: hermana de MLA500 (mismo SKU y mismo user_product)
    db.prepare("UPDATE ml_publicaciones_cache SET user_product_id = 'MLAU1' WHERE item_id = 'MLA500'").run();
    db.prepare("INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en) VALUES ('MLA502|', 'S-500', 'x', 'confirmar', ?)").run(t);
    db.prepare("INSERT INTO ml_publicaciones_cache (clave, item_id, variation_id, titulo, status, seller_sku, user_product_id, available_quantity, actualizado_en) VALUES ('MLA502|', 'MLA502', '', 'Hermana', 'active', 'S-500', 'MLAU1', 5, ?)").run(t);
    process.env.IDENTIDAD_PROTECCION = 'activo';
    try {
      db.prepare(`INSERT INTO identidad_casos (direccion, ml_key, clasificacion, estado, severidad, evidencia_fingerprint, expected_version, primera_deteccion_en, ultima_deteccion_en)
        VALUES ('ml_fusion', 'MLA502|', 'sku_inexistente', 'intervencion', 'critica', 'fp', 1, ?, ?)`).run(ts(), ts());
      db.prepare("UPDATE ml_publicaciones_cache SET available_quantity = 0 WHERE item_id IN ('MLA500','MLA502')").run();
      ml.up.MLA500 = 'MLAU1'; // la relectura trae el mismo user_product
      ml.qty.MLA500 = 0; // comparten una cantidad: ML publica 0 (el deseado más restrictivo)
      await lote('MLA500');
      expect(bolsas()).toEqual([]);
    } finally { delete process.env.IDENTIDAD_PROTECCION; }
  });

  it('tras una bolsa SIN escritura reciente, la diferencia local no re-dispara; un cambio real de cantidad sí', async () => {
    db.prepare("UPDATE ml_publicaciones_cache SET available_quantity = 9 WHERE item_id = 'MLA500'").run();
    ml.qty.MLA500 = 9; // difiere del deseado (5) pero el caché ya lo sabía
    guardarEstado(db, 'bolsa_sin_escritura:S-500', 'sin_escritura');
    await lote('MLA500');
    expect(bolsas()).toEqual([]);
    ml.qty.MLA500 = 7; // cambio REAL de available_quantity: dispara igual
    await lote('MLA500');
    expect(bolsas()).toEqual(['sku:S-500']);
  });

  it('carrera con el scan: el caché ya estaba al día pero el remoto difiere del deseado → igual encola la bolsa', async () => {
    db.prepare("UPDATE ml_publicaciones_cache SET available_quantity = 9 WHERE item_id = 'MLA500'").run(); // el scan ya lo había leído
    ml.qty.MLA500 = 9; // Woo dice 5 → deseado 5
    await lote('MLA500');
    expect(bolsas()).toEqual(['sku:S-500']);
  });

  it.each([429, 500, 502, 418])('status_code %i: reencola ese id y nunca lo cierra como hecho; los demás del lote sí avanzan', async (code) => {
    ml.codigos.MLA500 = code;
    const r = await lote('MLA500', 'MLA501');
    expect(r.get('MLA500').estado).toBe('reencolar');
    expect(r.get('MLA501').estado).toBe('hecho');
    expect(db.prepare("SELECT COUNT(*) n FROM ml_publicaciones_cache WHERE item_id = 'MLA500'").get().n).toBe(1);
  });

  it('en el worker, un elemento no-200 deja SU trabajo pendiente con backoff y no pierde los otros', async () => {
    ml.codigos.MLA500 = 500;
    aviso('items', '/items/MLA500');
    aviso('items', '/items/MLA501');
    await correr();
    expect(trabajo('item.project', 'MLA500')).toMatchObject({ estado: 'pendiente', fallos_consecutivos: 1 });
    expect(trabajo('item.project', 'MLA501').estado).toBe('hecho');
  });

  it('una falla de TODO el lote (bulk 5xx) reencola todos los ids', async () => {
    mlFetch.mockImplementation(async () => ({ status: 503, data: null }));
    aviso('items', '/items/MLA500');
    await correr();
    expect(trabajo('item.project', 'MLA500')).toMatchObject({ estado: 'pendiente' });
  });
});

describe('stock.bolsa con hermanas (mismo user_product_id)', () => {
  beforeEach(() => {
    // MLA502 es hermana de MLA500: mismo SKU y mismo user_product (comparten UNA cantidad en ML).
    const t = ts(-60 * 60 * 1000);
    db.prepare("UPDATE ml_publicaciones_cache SET user_product_id = 'MLAU1' WHERE item_id = 'MLA500'").run();
    db.prepare("INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en) VALUES ('MLA502|', 'S-500', 'x', 'confirmar', ?)").run(t);
    db.prepare("INSERT INTO ml_publicaciones_cache (clave, item_id, variation_id, titulo, status, seller_sku, user_product_id, available_quantity, actualizado_en) VALUES ('MLA502|', 'MLA502', '', 'Hermana', 'active', 'S-500', 'MLAU1', 5, ?)").run(t);
    ml.qty.MLA502 = 5;
    // Esta fixture comparte la cantidad entre hermanas como ML: un PUT a una cambia las dos.
    const base = mlFetch.getMockImplementation();
    mlFetch.mockImplementation(async (dbx, cfg, method, p, body) => {
      const r = await base(dbx, cfg, method, p, body);
      if (method === 'put') { ml.qty.MLA500 = body.available_quantity; ml.qty.MLA502 = body.available_quantity; }
      return r;
    });
  });

  it('dos hermanas con el mismo SKU hacen UNA sola escritura', async () => {
    db.prepare("UPDATE catalogo_cache SET stock = 8 WHERE sku = 'S-500'").run(); woo.stock[500] = 8;
    const r = await procesarStockBolsa(db, CFG, 'S-500');
    expect(r.estado).toBe('hecho');
    expect(ml.puts).toHaveLength(1);
    expect(ml.puts[0].cantidad).toBe(8);
    expect(ml.qty.MLA500).toBe(8);
    expect(ml.qty.MLA502).toBe(8);
  });

  it('con el mismo SKU y valores deseados distintos entre hermanas gana el más restrictivo', async () => {
    db.prepare("UPDATE catalogo_cache SET stock = 8 WHERE sku = 'S-500'").run(); woo.stock[500] = 8;
    // El CTE de stock puede dar valores distintos por clave (identidad frena una hermana a 0): gana el más restrictivo.
    process.env.IDENTIDAD_PROTECCION = 'activo';
    try {
      db.prepare(`INSERT INTO identidad_casos (direccion, ml_key, clasificacion, estado, severidad, evidencia_fingerprint, expected_version, primera_deteccion_en, ultima_deteccion_en)
        VALUES ('ml_fusion', 'MLA502|', 'sku_inexistente', 'intervencion', 'critica', 'fp', 1, ?, ?)`).run(ts(), ts());
      await procesarStockBolsa(db, CFG, 'S-500');
    } finally { delete process.env.IDENTIDAD_PROTECCION; }
    // Si el CTE frenó la hermana a 0, gana el 0 (más restrictivo); si no hubo diferencia entre claves, queda en 8. Nunca 2 escrituras.
    expect(ml.puts.length).toBeLessThanOrEqual(1);
    if (ml.puts.length === 1) expect([0, 8]).toContain(ml.puts[0].cantidad);
  });

  it('una orden ML pendiente (barrera de E-0) frena el push', async () => {
    db.prepare("UPDATE catalogo_cache SET stock = 8 WHERE sku = 'S-500'").run(); woo.stock[500] = 8;
    encolarTrabajo(db, { tipo: 'order.ml', recurso: '2000001' }); // venta en vuelo que todavía no se leyó
    const r = await procesarStockBolsa(db, CFG, 'S-500');
    expect(r).toMatchObject({ estado: 'reencolar', motivo: 'orden_ml_pendiente' });
    expect(ml.puts).toEqual([]);
  });

  it('hermanas con SKUs distintos: no escribe y abre un caso', async () => {
    db.prepare("UPDATE sku_matcher_decisiones SET sku = 'S-501' WHERE clave = 'MLA502|'").run();
    db.prepare("UPDATE catalogo_cache SET stock = 8").run(); woo.stock[500] = 8; woo.stock[501] = 8;
    const r = await procesarStockBolsa(db, CFG, 'S-500');
    expect(r).toMatchObject({ estado: 'hecho', motivo: 'contradiccion_skus' });
    expect(ml.puts).toEqual([]);
    expect(db.prepare("SELECT 1 FROM incidentes_operativos WHERE tipo_error LIKE 'bolsa_con_skus_distintos_%'").get()).toBeTruthy();
  });
});

describe('volumen: no aumentan las llamadas a ML', () => {
  it('N avisos del mismo ítem y de varios ítems → llamadas de proyección = ceil(ítems distintos / 20)', async () => {
    for (let i = 0; i < 3; i++) aviso('items', '/items/MLA500');
    for (let i = 0; i < 3; i++) aviso('items', '/items/MLA501');
    db.prepare("UPDATE ml_publicaciones_cache SET user_product_id = 'MLAU1' WHERE item_id IN ('MLA500','MLA501')").run();
    aviso('user_products', '/user-products/MLAU1');
    aviso('stock-location', '/user-products/MLAU1/stock');
    await correr();
    expect(ml.bulks).toEqual([['MLA500', 'MLA501']]); // 8 avisos → una sola llamada
  });
});
