import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import { skuDesdeMl, publicacionesDesdeWc } from '../lib/mlMapeo.js';
import { getAccessToken, bootstrapToken } from '../lib/mlClient.js';
import { getReactivablesRows, reactivarItems, syncRouter } from '../routes/sync.js';
import express from 'express';
import request from 'supertest';

// Mock axios para evitar llamadas reales a ML
vi.mock('axios', async () => {
  const actual = await vi.importActual('axios');
  return { default: { ...actual.default, post: vi.fn(), request: vi.fn() } };
});
import axios from 'axios';

const TEST_DB = './test/tmp-sync.sqlite';

function seedMatcher(db) {
  const stmt = db.prepare(
    'INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en) VALUES (?, ?, ?, ?, ?)'
  );
  const now = new Date().toISOString();
  // simple publicacion (sin variacion)
  stmt.run('MLA100|', 'BIKE-001', 'Bicicleta Rodado 26', 'confirmar', now);
  // publicacion con variacion
  stmt.run('MLA200|987654321', 'CASCO-L', 'Casco Talla L', 'asignar', now);
  // publicacion omitida (no debe sincronizarse)
  stmt.run('MLA300|', 'OMIT-001', 'Algo omitido', 'omitir', now);
  // mismo SKU en dos publicaciones ML
  stmt.run('MLA400|111', 'BIKE-001', 'Bicicleta var rojo', 'asignar', now);
  // variation_id con ".0" (formato float que puede venir de ML)
  stmt.run('MLA500|987654321', 'GUANTE-M', 'Guante M', 'confirmar', now);
}

describe('mlMapeo', () => {
  let db;

  beforeEach(() => {
    db = openDb(TEST_DB);
    seedMatcher(db);
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  describe('skuDesdeMl', () => {
    it('devuelve SKU para publicacion simple (variation_id vacío)', () => {
      expect(skuDesdeMl(db, 'MLA100', '')).toBe('BIKE-001');
    });

    it('devuelve SKU para publicacion con variation_id', () => {
      expect(skuDesdeMl(db, 'MLA200', '987654321')).toBe('CASCO-L');
    });

    it('normaliza variation_id con sufijo .0', () => {
      // ML a veces envía variation_id como float "987654321.0"
      expect(skuDesdeMl(db, 'MLA500', '987654321.0')).toBe('GUANTE-M');
    });

    it('devuelve null si la accion es omitir', () => {
      expect(skuDesdeMl(db, 'MLA300', '')).toBeNull();
    });

    it('devuelve null si la clave no existe', () => {
      expect(skuDesdeMl(db, 'MLA999', '')).toBeNull();
    });

    it('devuelve null si variation_id no coincide', () => {
      expect(skuDesdeMl(db, 'MLA200', '000000')).toBeNull();
    });
  });

  describe('publicacionesDesdeWc', () => {
    it('devuelve todas las publicaciones ML para un SKU', () => {
      const pubs = publicacionesDesdeWc(db, 'BIKE-001');
      expect(pubs).toHaveLength(2);
      const claves = pubs.map(p => p.clave).sort();
      expect(claves).toEqual(['MLA100|', 'MLA400|111']);
    });

    it('devuelve los campos itemId y variationId correctamente', () => {
      const pubs = publicacionesDesdeWc(db, 'CASCO-L');
      expect(pubs).toHaveLength(1);
      expect(pubs[0].itemId).toBe('MLA200');
      expect(pubs[0].variationId).toBe('987654321');
    });

    it('devuelve array vacío para SKU sin mapeo activo', () => {
      expect(publicacionesDesdeWc(db, 'OMIT-001')).toHaveLength(0);
    });

    it('devuelve array vacío para SKU inexistente', () => {
      expect(publicacionesDesdeWc(db, 'NOEXISTE')).toHaveLength(0);
    });

    it('devuelve array vacío si SKU es string vacío', () => {
      expect(publicacionesDesdeWc(db, '')).toHaveLength(0);
    });
  });
});

// ─── mlClient ────────────────────────────────────────────────────────────────

const ML_CFG = { clientId: 'client123', clientSecret: 'secret456', userId: '99999' };

function seedToken(db, { expiresInMs = 4 * 3600 * 1000 } = {}) {
  const expiresAt = new Date(Date.now() + expiresInMs).toISOString();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO ml_oauth_token (id, access_token, refresh_token, expires_at, actualizado_en)
    VALUES (1, 'tok-old', 'ref-old', ?, ?)
  `).run(expiresAt, now);
  return expiresAt;
}

describe('mlClient', () => {
  let db;

  beforeEach(() => {
    db = openDb(TEST_DB);
    vi.resetAllMocks();
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('getAccessToken: devuelve token vigente sin hacer refresh', async () => {
    seedToken(db);
    const token = await getAccessToken(db, ML_CFG);
    expect(token).toBe('tok-old');
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('getAccessToken: hace refresh si el token vence en < 60s', async () => {
    seedToken(db, { expiresInMs: 30 * 1000 }); // vence en 30s
    axios.post.mockResolvedValueOnce({
      status: 200,
      data: { access_token: 'tok-new', refresh_token: 'ref-new', expires_in: 21600 },
    });

    const token = await getAccessToken(db, ML_CFG);
    expect(token).toBe('tok-new');
    expect(axios.post).toHaveBeenCalledOnce();

    // verifica que el nuevo token quedó persistido en DB
    const row = db.prepare('SELECT access_token, refresh_token FROM ml_oauth_token WHERE id=1').get();
    expect(row.access_token).toBe('tok-new');
    expect(row.refresh_token).toBe('ref-new');
  });

  it('getAccessToken: lanza error si no hay token en DB', async () => {
    await expect(getAccessToken(db, ML_CFG)).rejects.toThrow('bootstrap');
  });

  it('getAccessToken: lanza error si no hay clientId', async () => {
    await expect(getAccessToken(db, {})).rejects.toThrow('ML_CLIENT_ID');
  });

  it('bootstrapToken: persiste tokens en DB y devuelve userId', async () => {
    axios.post.mockResolvedValueOnce({
      status: 200,
      data: { access_token: 'tok-boot', refresh_token: 'ref-boot', expires_in: 21600, user_id: 12345 },
    });

    const result = await bootstrapToken(db, ML_CFG, 'TT-CODE');
    expect(result.userId).toBe(12345);

    const row = db.prepare('SELECT access_token, refresh_token FROM ml_oauth_token WHERE id=1').get();
    expect(row.access_token).toBe('tok-boot');
    expect(row.refresh_token).toBe('ref-boot');
  });

  it('bootstrapToken: lanza error si ML responde con error', async () => {
    axios.post.mockResolvedValueOnce({
      status: 400,
      data: { message: 'invalid_code' },
    });
    await expect(bootstrapToken(db, ML_CFG, 'BAD-CODE')).rejects.toThrow('Bootstrap ML falló');
  });
});

// ─── reactivación de pausadas por falta de stock ────────────────────────────────

const ahora = () => new Date().toISOString();

function seedCatalogo(db, sku, stock, { tipo = 'variation', idWoo = 1, idPadre = 10 } = {}) {
  db.prepare(
    'INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, actualizado_en) VALUES (?,?,?,?,?,?,?)'
  ).run(idWoo, 'Prod ' + sku, sku, tipo, idPadre, stock, ahora());
}

function seedDecision(db, clave, sku, accion = 'confirmar') {
  db.prepare(
    'INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en) VALUES (?,?,?,?,?)'
  ).run(clave, sku, 'WC ' + sku, accion, ahora());
}

function seedPublicacion(db, { clave, itemId, varId = '', status, subStatus = '', titulo = 'Pub' }) {
  db.prepare(`
    INSERT INTO ml_publicaciones_cache
      (clave, item_id, variation_id, titulo, status, sub_status, es_variante, color, talle, seller_sku, variations_texto, actualizado_en)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(clave, itemId, varId, titulo, status, subStatus, varId ? 1 : 0, '', '', '', '', ahora());
}

describe('reactivación de pausadas por falta de stock', () => {
  let db;
  beforeEach(() => { db = openDb(TEST_DB); vi.resetAllMocks(); });
  afterEach(() => { db.close(); if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('getReactivablesRows: incluye pausada out_of_stock con stock web', () => {
    seedCatalogo(db, 'FB-1', 5);
    seedDecision(db, 'MLA1|v1', 'FB-1');
    seedPublicacion(db, { clave: 'MLA1|v1', itemId: 'MLA1', varId: 'v1', status: 'paused', subStatus: 'out_of_stock' });
    const rows = getReactivablesRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].item_id).toBe('MLA1');
    expect(rows[0].stock_disponible_ml).toBe(5);
  });

  it('getReactivablesRows: excluye pausada manual (sin out_of_stock)', () => {
    seedCatalogo(db, 'FB-2', 5);
    seedDecision(db, 'MLA2|v1', 'FB-2');
    seedPublicacion(db, { clave: 'MLA2|v1', itemId: 'MLA2', varId: 'v1', status: 'paused', subStatus: '' });
    expect(getReactivablesRows(db)).toHaveLength(0);
  });

  it('getReactivablesRows: excluye out_of_stock que además es paused_by_seller (pausa manual)', () => {
    seedCatalogo(db, 'FB-2b', 5);
    seedDecision(db, 'MLA2b|v1', 'FB-2b');
    seedPublicacion(db, { clave: 'MLA2b|v1', itemId: 'MLA2b', varId: 'v1', status: 'paused', subStatus: 'out_of_stock,paused_by_seller' });
    expect(getReactivablesRows(db)).toHaveLength(0);
  });

  it('getReactivablesRows: excluye out_of_stock sin stock web', () => {
    seedCatalogo(db, 'FB-3', 0);
    seedDecision(db, 'MLA3|v1', 'FB-3');
    seedPublicacion(db, { clave: 'MLA3|v1', itemId: 'MLA3', varId: 'v1', status: 'paused', subStatus: 'out_of_stock' });
    expect(getReactivablesRows(db)).toHaveLength(0);
  });

  it('getReactivablesRows: excluye publicación activa', () => {
    seedCatalogo(db, 'FB-4', 5);
    seedDecision(db, 'MLA4|v1', 'FB-4');
    seedPublicacion(db, { clave: 'MLA4|v1', itemId: 'MLA4', varId: 'v1', status: 'active', subStatus: '' });
    expect(getReactivablesRows(db)).toHaveLength(0);
  });

  it('getReactivablesRows: respeta reserva de skus_config_ml', () => {
    seedCatalogo(db, 'FB-5', 3);
    seedDecision(db, 'MLA5|v1', 'FB-5');
    seedPublicacion(db, { clave: 'MLA5|v1', itemId: 'MLA5', varId: 'v1', status: 'paused', subStatus: 'out_of_stock' });
    db.prepare("INSERT INTO skus_config_ml (sku, nombre, modo, reserva, actualizado_en) VALUES ('FB-5','x','reserva',2,?)").run(ahora());
    const rows = getReactivablesRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].stock_disponible_ml).toBe(1); // 3 - 2 reservadas
  });

  it('reactivarItems: empuja stock, activa en ML y persiste estado', async () => {
    seedToken(db);
    seedCatalogo(db, 'FB-9', 7);
    db.prepare("UPDATE catalogo_cache SET precio=1350 WHERE sku='FB-9'").run(); // lista 1350 → contado 900
    seedDecision(db, 'MLA9|v9', 'FB-9');
    seedPublicacion(db, { clave: 'MLA9|v9', itemId: 'MLA9', varId: 'v9', status: 'paused', subStatus: 'out_of_stock' });
    // GET item (precio 1000, sin envío gratis) + comisión 50 → neto 950 vs contado 900 (dentro de
    // tolerancia, no bloquea) + PUT stock -> 200 + PUT status active -> 200
    axios.request.mockImplementation((cfg) => {
      const url = cfg.url || '';
      if (url.includes('/listing_prices')) return { status: 200, data: { sale_fee_amount: 50 }, headers: {} };
      if (/\/items\/MLA9\?/.test(url)) return { status: 200, data: { id: 'MLA9', price: 1000, category_id: 'MLA1', listing_type_id: 'gold_special', shipping: { free_shipping: false }, variations: [] }, headers: {} };
      return { status: 200, data: {}, headers: {} };
    });

    const r = await reactivarItems(db, ML_CFG, ['MLA9']);
    expect(r.procesados).toBe(1);
    expect(r.resultados[0].ok).toBe(true);

    // status en cache pasó a active
    const pub = db.prepare('SELECT status, sub_status FROM ml_publicaciones_cache WHERE clave=?').get('MLA9|v9');
    expect(pub.status).toBe('active');
    // estado de stock persistido
    const est = db.prepare('SELECT cantidad_ml FROM ml_stock_estado WHERE clave=?').get('MLA9|v9');
    expect(est.cantidad_ml).toBe(7);
    // log 'reactivada'
    const log = db.prepare("SELECT COUNT(*) n FROM sync_log WHERE estado='reactivada' AND clave='MLA9|v9'").get();
    expect(log.n).toBe(1);
  });

  it('reactivarItems: si ML rechaza la activación, registra error y no marca activo', async () => {
    seedToken(db);
    seedCatalogo(db, 'FB-10', 4);
    db.prepare("UPDATE catalogo_cache SET precio=1350 WHERE sku='FB-10'").run(); // lista 1350 → contado 900
    seedDecision(db, 'MLA10|v10', 'FB-10');
    seedPublicacion(db, { clave: 'MLA10|v10', itemId: 'MLA10', varId: 'v10', status: 'paused', subStatus: 'out_of_stock' });
    // chequeo de neto OK (precio 1000, comisión 50, sin envío gratis → neto 950 vs contado 900, no bloquea)
    // + PUT stock OK + PUT activar falla
    axios.request.mockImplementation((cfg) => {
      const url = cfg.url || '';
      const method = (cfg.method || '').toLowerCase();
      if (url.includes('/listing_prices')) return { status: 200, data: { sale_fee_amount: 50 }, headers: {} };
      if (/\/items\/MLA10\?/.test(url)) return { status: 200, data: { id: 'MLA10', price: 1000, category_id: 'MLA1', listing_type_id: 'gold_special', shipping: { free_shipping: false }, variations: [] }, headers: {} };
      if (method === 'put' && /\/items\/MLA10\/variations\/v10$/.test(url)) return { status: 200, data: {}, headers: {} };
      if (method === 'put' && /\/items\/MLA10$/.test(url)) return { status: 400, data: { message: 'no se puede activar' }, headers: {} };
      return { status: 404, data: {}, headers: {} };
    });

    const r = await reactivarItems(db, ML_CFG, ['MLA10']);
    expect(r.resultados[0].ok).toBe(false);
    expect(r.resultados[0].bloqueado).toBeUndefined(); // no es un bloqueo por neto: ML rechazó la activación
    const pub = db.prepare('SELECT status FROM ml_publicaciones_cache WHERE clave=?').get('MLA10|v10');
    expect(pub.status).toBe('paused'); // sigue pausada
  });

  it('reactivarItems: bloquea si el neto ML queda >5% por debajo del precio web', async () => {
    seedToken(db);
    seedCatalogo(db, 'FB-11', 6);
    db.prepare("UPDATE catalogo_cache SET precio=1350 WHERE sku='FB-11'").run(); // lista 1350 → contado 900
    seedDecision(db, 'MLA11|v11', 'FB-11');
    seedPublicacion(db, { clave: 'MLA11|v11', itemId: 'MLA11', varId: 'v11', status: 'paused', subStatus: 'out_of_stock' });
    // GET item (precio 1000) + comisión 100 + envío 50 → neto 850 vs contado 900 (~5.6% debajo → bloqueado)
    axios.request.mockImplementation((cfg) => {
      const url = cfg.url || '';
      if (url.includes('/listing_prices')) return { status: 200, data: { sale_fee_amount: 100 }, headers: {} };
      if (url.includes('/shipping_options/free')) return { status: 200, data: { coverage: { all_country: { list_cost: 50 } } }, headers: {} };
      if (/\/items\/MLA11/.test(url)) return { status: 200, data: { id: 'MLA11', price: 1000, category_id: 'MLA1', listing_type_id: 'gold_special', shipping: { free_shipping: true }, variations: [] }, headers: {} };
      return { status: 200, data: {}, headers: {} };
    });

    const r = await reactivarItems(db, ML_CFG, ['MLA11']);
    expect(r.resultados[0].bloqueado).toBe(true);
    expect(r.resultados[0].neto).toBe(850);
    // No se reactivó: sigue pausada, sin estado de stock ni log de reactivada
    expect(db.prepare('SELECT status FROM ml_publicaciones_cache WHERE clave=?').get('MLA11|v11').status).toBe('paused');
    expect(db.prepare("SELECT COUNT(*) n FROM ml_stock_estado WHERE clave='MLA11|v11'").get().n).toBe(0);
    expect(db.prepare("SELECT COUNT(*) n FROM sync_log WHERE estado='reactivada' AND clave='MLA11|v11'").get().n).toBe(0);
  });

  it('reactivarItems: bloquea (fail-closed) si no hay precio web mapeado para comparar', async () => {
    seedToken(db);
    seedCatalogo(db, 'FB-12', 5); // sin precio seteado en catalogo_cache
    seedDecision(db, 'MLA12|v12', 'FB-12');
    seedPublicacion(db, { clave: 'MLA12|v12', itemId: 'MLA12', varId: 'v12', status: 'paused', subStatus: 'out_of_stock' });
    axios.request.mockImplementation((cfg) => {
      const url = cfg.url || '';
      if (/\/items\/MLA12/.test(url)) return { status: 200, data: { id: 'MLA12', price: 1000, category_id: 'MLA1', listing_type_id: 'gold_special', shipping: { free_shipping: false }, variations: [] }, headers: {} };
      return { status: 200, data: {}, headers: {} };
    });

    const r = await reactivarItems(db, ML_CFG, ['MLA12']);
    expect(r.resultados[0].ok).toBe(false);
    expect(r.resultados[0].bloqueado).toBe(true);
    expect(db.prepare('SELECT status FROM ml_publicaciones_cache WHERE clave=?').get('MLA12|v12').status).toBe('paused');
  });

  it('reactivarItems: bloquea (fail-closed) si no se pudo calcular la comisión en ML', async () => {
    seedToken(db);
    seedCatalogo(db, 'FB-14', 5);
    db.prepare("UPDATE catalogo_cache SET precio=1000 WHERE sku='FB-14'").run();
    seedDecision(db, 'MLA14|v14', 'FB-14');
    seedPublicacion(db, { clave: 'MLA14|v14', itemId: 'MLA14', varId: 'v14', status: 'paused', subStatus: 'out_of_stock' });
    // item OK y precio web mapeado, pero ML no devuelve la comisión (antes de este fix: 'sin_precio', no bloqueaba)
    axios.request.mockImplementation((cfg) => {
      const url = cfg.url || '';
      if (url.includes('/listing_prices')) return { status: 404, data: {}, headers: {} };
      if (/\/items\/MLA14/.test(url)) return { status: 200, data: { id: 'MLA14', price: 1000, category_id: 'MLA1', listing_type_id: 'gold_special', shipping: { free_shipping: false }, variations: [] }, headers: {} };
      return { status: 200, data: {}, headers: {} };
    });

    const r = await reactivarItems(db, ML_CFG, ['MLA14']);
    expect(r.resultados[0].ok).toBe(false);
    expect(r.resultados[0].bloqueado).toBe(true);
    expect(r.resultados[0].neto).toBeNull();
    expect(db.prepare('SELECT status FROM ml_publicaciones_cache WHERE clave=?').get('MLA14|v14').status).toBe('paused');
  });

  it('reactivarItems: bloquea (fail-closed) si falla la consulta del item en ML', async () => {
    seedToken(db);
    seedCatalogo(db, 'FB-13', 5);
    db.prepare("UPDATE catalogo_cache SET precio=1000 WHERE sku='FB-13'").run();
    seedDecision(db, 'MLA13|v13', 'FB-13');
    seedPublicacion(db, { clave: 'MLA13|v13', itemId: 'MLA13', varId: 'v13', status: 'paused', subStatus: 'out_of_stock' });
    axios.request.mockImplementation((cfg) => {
      const url = cfg.url || '';
      if (/\/items\/MLA13/.test(url)) return { status: 500, data: null, headers: {} };
      return { status: 200, data: {}, headers: {} };
    });

    const r = await reactivarItems(db, ML_CFG, ['MLA13']);
    expect(r.resultados[0].ok).toBe(false);
    expect(r.resultados[0].bloqueado).toBe(true);
    expect(db.prepare('SELECT status FROM ml_publicaciones_cache WHERE clave=?').get('MLA13|v13').status).toBe('paused');
  });
});

// ─── vista de detalle: atencion/:cat y reintentar-item ──────────────────────────

function seedLog(db, { clave, estado, error = null, sku = null }) {
  db.prepare(`
    INSERT INTO sync_log (direccion, clave, sku, estado, error, intentos, creado_en, actualizado_en)
    VALUES ('wc_ml', ?, ?, ?, ?, 0, ?, ?)
  `).run(clave, sku, estado, error, ahora(), ahora());
}

function buildSyncApp(db, cfg) {
  const app = express();
  app.use(express.json());
  app.use('/api/sync', syncRouter(db, cfg));
  return app;
}

describe('vista de detalle', () => {
  let db, app;
  beforeEach(() => {
    db = openDb(TEST_DB);
    vi.resetAllMocks();
    app = buildSyncApp(db, { ml: ML_CFG, woo: { url: 'https://x', ck: 'a', cs: 'b' } });
  });
  afterEach(() => { db.close(); if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('atencion/sin_mapeo: incluye no mapeados, excluye ya mapeados', async () => {
    seedLog(db, { clave: 'MLA1|', estado: 'sin_mapeo' });
    seedLog(db, { clave: 'MLA2|', estado: 'sin_mapeo' });
    seedDecision(db, 'MLA2|', 'FB-2', 'asignar'); // ya resuelto
    const res = await request(app).get('/api/sync/atencion/sin_mapeo');
    expect(res.status).toBe(200);
    expect(res.body.data.map(r => r.clave)).toEqual(['MLA1|']);
  });

  it('atencion/sin_mapeo: excluye lo descartado a mano', async () => {
    seedLog(db, { clave: 'MLA1|', estado: 'sin_mapeo' });
    db.prepare("INSERT INTO errores_descartados (clave, motivo, creado_en) VALUES ('MLA1|', null, ?)").run(ahora());
    const res = await request(app).get('/api/sync/atencion/sin_mapeo');
    expect(res.body.data).toEqual([]);
  });

  it('atencion/remapeo_requerido: una variación vieja que ya no existe en ML queda pendiente para siempre hasta que se descarta', async () => {
    // La variación vieja MLA6|v6-vieja fue reemplazada por v6-nueva; el usuario
    // ya mapeó la variación actual, pero la clave vieja del log nunca va a
    // aparecer en sku_matcher_decisiones con esa clave exacta.
    seedLog(db, { clave: 'MLA6|v6-vieja', estado: 'remapeo_requerido' });
    seedDecision(db, 'MLA6|v6-nueva', 'FB-6', 'asignar');

    let res = await request(app).get('/api/sync/atencion/remapeo_requerido');
    expect(res.body.data.map(r => r.clave)).toEqual(['MLA6|v6-vieja']);

    const desc = await request(app).post('/api/sync/descartar-error').send({ claves: ['MLA6|v6-vieja'] });
    expect(desc.body.ok).toBe(true);

    res = await request(app).get('/api/sync/atencion/remapeo_requerido');
    expect(res.body.data).toEqual([]);
  });

  it('dashboard: sin_mapeo y remapeo_requerido no cuentan lo descartado', async () => {
    seedLog(db, { clave: 'MLA7|', estado: 'sin_mapeo' });
    seedLog(db, { clave: 'MLA8|v8', estado: 'remapeo_requerido' });
    db.prepare("INSERT INTO errores_descartados (clave, motivo, creado_en) VALUES ('MLA7|', null, ?)").run(ahora());
    db.prepare("INSERT INTO errores_descartados (clave, motivo, creado_en) VALUES ('MLA8|v8', null, ?)").run(ahora());

    const res = await request(app).get('/api/sync/dashboard');
    expect(res.body.atencion.sin_mapeo).toBe(0);
    expect(res.body.atencion.remapeo_requerido).toBe(0);
  });

  it('atencion/errores: excluye los que ya están en ml_stock_estado', async () => {
    seedLog(db, { clave: 'MLA3|v3', estado: 'error', error: 'HTTP 400' });
    seedLog(db, { clave: 'MLA4|', estado: 'error', error: 'HTTP 500' });
    db.prepare("INSERT INTO ml_stock_estado (clave, sku, cantidad_ml, actualizado_en) VALUES ('MLA4|','FB-4',3,?)").run(ahora());
    const res = await request(app).get('/api/sync/atencion/errores');
    expect(res.body.data.map(r => r.clave)).toEqual(['MLA3|v3']);
  });

  it('atencion: categoría inválida → 400', async () => {
    const res = await request(app).get('/api/sync/atencion/cualquiera');
    expect(res.status).toBe(400);
  });

  it('reintentar-item: publicación activa → push de stock OK', async () => {
    seedToken(db);
    seedCatalogo(db, 'FB-20', 6);
    seedDecision(db, 'MLA20|v20', 'FB-20');
    seedPublicacion(db, { clave: 'MLA20|v20', itemId: 'MLA20', varId: 'v20', status: 'active' });
    axios.request.mockResolvedValue({ status: 200, data: {}, headers: {} });
    const res = await request(app).post('/api/sync/reintentar-item').send({ clave: 'MLA20|v20' });
    expect(res.body.ok).toBe(true);
    expect(res.body.cantidad).toBe(6);
    const est = db.prepare('SELECT cantidad_ml FROM ml_stock_estado WHERE clave=?').get('MLA20|v20');
    expect(est.cantidad_ml).toBe(6);
  });

  it('reintentar-item: publicación pausada → no reintenta, sugiere reactivar', async () => {
    seedToken(db);
    seedCatalogo(db, 'FB-21', 6);
    seedDecision(db, 'MLA21|v21', 'FB-21');
    seedPublicacion(db, { clave: 'MLA21|v21', itemId: 'MLA21', varId: 'v21', status: 'paused', subStatus: 'out_of_stock' });
    const res = await request(app).post('/api/sync/reintentar-item').send({ clave: 'MLA21|v21' });
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/reactiv/i);
  });

  it('reintentar-item: sin clave → 400', async () => {
    const res = await request(app).post('/api/sync/reintentar-item').send({});
    expect(res.status).toBe(400);
  });

  it('atencion: enriquece título + miniatura desde ML cuando faltan en cache', async () => {
    seedToken(db);
    seedLog(db, { clave: 'MLA50|v50', estado: 'error', error: 'HTTP 500' });
    // Publicación en cache pero sin miniatura (columna thumbnail NULL) → dispara enriquecimiento.
    seedPublicacion(db, { clave: 'MLA50|v50', itemId: 'MLA50', varId: 'v50', status: 'active', titulo: 'Pub 50' });
    axios.request.mockResolvedValue({
      status: 200,
      data: [{ code: 200, body: { id: 'MLA50', title: 'Título desde ML', secure_thumbnail: 'https://http2.mlstatic.com/x.jpg' } }],
      headers: {},
    });

    const res = await request(app).get('/api/sync/atencion/errores');
    expect(res.status).toBe(200);
    expect(res.body.data[0].thumbnail).toBe('https://http2.mlstatic.com/x.jpg');
    // Persistió en cache
    const pub = db.prepare('SELECT thumbnail FROM ml_publicaciones_cache WHERE item_id=?').get('MLA50');
    expect(pub.thumbnail).toBe('https://http2.mlstatic.com/x.jpg');
  });

  it('dashboard: cuenta publicaciones reactivables (excluye activas y paused_by_seller)', async () => {
    // Reactivable: pausada out_of_stock, mapeada, con stock web
    seedCatalogo(db, 'FB-30', 5, { idWoo: 30 });
    seedDecision(db, 'MLA30|v30', 'FB-30');
    seedPublicacion(db, { clave: 'MLA30|v30', itemId: 'MLA30', varId: 'v30', status: 'paused', subStatus: 'out_of_stock' });
    // No reactivable: pausa manual (paused_by_seller)
    seedCatalogo(db, 'FB-31', 5, { idWoo: 31 });
    seedDecision(db, 'MLA31|v31', 'FB-31');
    seedPublicacion(db, { clave: 'MLA31|v31', itemId: 'MLA31', varId: 'v31', status: 'paused', subStatus: 'out_of_stock,paused_by_seller' });
    // No reactivable: activa
    seedCatalogo(db, 'FB-32', 5, { idWoo: 32 });
    seedDecision(db, 'MLA32|v32', 'FB-32');
    seedPublicacion(db, { clave: 'MLA32|v32', itemId: 'MLA32', varId: 'v32', status: 'active' });

    const res = await request(app).get('/api/sync/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.reactivables).toBe(1);
  });

  // ─── Fase 2: triage de errores por diagnóstico ───
  function mockItem(body) {
    axios.request.mockImplementation((cfg) => {
      const url = cfg.url || '';
      if (url.includes('/items?ids=')) return { status: 200, data: [{ code: 200, body }], headers: {} };
      return { status: 200, data: {}, headers: {} };
    });
  }

  it('atencion/errores: diagnostica reactivable (pausada out_of_stock con stock web)', async () => {
    seedToken(db);
    seedCatalogo(db, 'FB-D1', 5, { idWoo: 401 });
    seedDecision(db, 'MLD1|v1', 'FB-D1');
    seedLog(db, { clave: 'MLD1|v1', estado: 'error', error: 'HTTP 400' });
    mockItem({ id: 'MLD1', title: 'Pub D1', status: 'paused', sub_status: ['out_of_stock'], variations: [{ id: 'v1' }] });
    const res = await request(app).get('/api/sync/atencion/errores');
    const row = res.body.data.find(r => r.clave === 'MLD1|v1');
    expect(row.diagnostico).toBe('reactivable');
    expect(row.accion).toBe('reactivar');
  });

  it('atencion/errores: diagnostica estructura_cambiada (activa, la variación no existe)', async () => {
    seedToken(db);
    seedCatalogo(db, 'FB-D2', 5, { idWoo: 402 });
    seedDecision(db, 'MLD2|v2', 'FB-D2');
    seedLog(db, { clave: 'MLD2|v2', estado: 'error', error: 'HTTP 400' });
    mockItem({ id: 'MLD2', title: 'Pub D2', status: 'active', sub_status: [], variations: [{ id: 'otra' }] });
    const res = await request(app).get('/api/sync/atencion/errores');
    const row = res.body.data.find(r => r.clave === 'MLD2|v2');
    expect(row.diagnostico).toBe('estructura_cambiada');
    expect(row.accion).toBe('desvincular');
  });

  it('descartar-error: la clave desaparece de errores y del contador del dashboard', async () => {
    seedLog(db, { clave: 'MLD3|v3', estado: 'error', error: 'HTTP 400' });
    // antes: cuenta como error
    let dash = await request(app).get('/api/sync/dashboard');
    expect(dash.body.atencion.errores_reales).toBe(1);
    // descartar
    const desc = await request(app).post('/api/sync/descartar-error').send({ claves: ['MLD3|v3'] });
    expect(desc.body.ok).toBe(true);
    // después: no está en la vista ni en el contador
    const list = await request(app).get('/api/sync/atencion/errores');
    expect(list.body.data.find(r => r.clave === 'MLD3|v3')).toBeUndefined();
    dash = await request(app).get('/api/sync/dashboard');
    expect(dash.body.atencion.errores_reales).toBe(0);
  });

  it('desvincular: borra el mapeo de la clave', async () => {
    seedDecision(db, 'MLD4|v4', 'FB-D4');
    const res = await request(app).post('/api/sync/desvincular').send({ clave: 'MLD4|v4' });
    expect(res.body.ok).toBe(true);
    expect(res.body.borradas).toBe(1);
    const dec = db.prepare('SELECT COUNT(*) n FROM sku_matcher_decisiones WHERE clave=?').get('MLD4|v4');
    expect(dec.n).toBe(0);
  });
});
