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
    vi.clearAllMocks();
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
  beforeEach(() => { db = openDb(TEST_DB); vi.clearAllMocks(); });
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
    seedDecision(db, 'MLA9|v9', 'FB-9');
    seedPublicacion(db, { clave: 'MLA9|v9', itemId: 'MLA9', varId: 'v9', status: 'paused', subStatus: 'out_of_stock' });
    // PUT stock -> 200, PUT status active -> 200
    axios.request.mockResolvedValue({ status: 200, data: {}, headers: {} });

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
    seedDecision(db, 'MLA10|v10', 'FB-10');
    seedPublicacion(db, { clave: 'MLA10|v10', itemId: 'MLA10', varId: 'v10', status: 'paused', subStatus: 'out_of_stock' });
    // primer PUT (stock) OK, segundo PUT (activar) falla
    axios.request
      .mockResolvedValueOnce({ status: 200, data: {}, headers: {} })
      .mockResolvedValueOnce({ status: 400, data: { message: 'no se puede activar' }, headers: {} });

    const r = await reactivarItems(db, ML_CFG, ['MLA10']);
    expect(r.resultados[0].ok).toBe(false);
    const pub = db.prepare('SELECT status FROM ml_publicaciones_cache WHERE clave=?').get('MLA10|v10');
    expect(pub.status).toBe('paused'); // sigue pausada
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
    vi.clearAllMocks();
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
});
